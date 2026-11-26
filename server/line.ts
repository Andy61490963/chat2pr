import { splitQueryAnswer } from "../shared/query-answer.js";
import { z } from "zod";
import { Database, type DbClient } from "./db.js";
import { secrets } from "./config.js";
import { pairAdmin } from "./admin-pairing.js";
import type { DiscordChatPlatform } from "./discord-platform.js";
import { flushDiscordNotifications } from "./discord-notifications.js";
import { AppError, containsCredential, redact } from "./policy.js";
import { fetchLine } from "./line-http.js";
import type { ChatReplyMessage, ChatReplyResult } from "./chat-platform.js";
import { LineChatPlatform, lineReplyLimit } from "./line-platform.js";
import { isProgressCommand, isTaskCommand } from "../shared/chat.js";
import { flushLineGroups } from "./line-group-push.js";
import { flushLinePrivate } from "./line-private.js";
import {
  linePrivateDefaults,
  linePrivateQuotaHold,
  linePrivateQuotaNotes,
} from "../shared/line-private.js";
import { invalidateMessageSources } from "./message-sources.js";
import { readChatImage } from "./chat-image.js";
import { documentName } from "./document-text.js";
import {
  commandAck,
  disabledAck,
  followupAck,
  answerAck,
  answerHeldAck,
  credentialAnswerAck,
  detailRequest,
  lineChunks,
  groupText,
  groupRepliesOn,
  ackFor,
  claimPendingGroupReplies,
  claimingNote,
  lockGroupReplyClaim,
  progressMoreNote,
  progressSummary,
  progressTasks,
  reclaimStaleClaims,
  replyFailedNote,
  replyGaveUpNote,
  replyRejected,
  REPLY_FAILURE_LIMIT,
  staleAnswerAck,
  type GroupReplyClaim,
} from "./group-replies.js";
import { subscriptionGateName } from "./subscription-gate.js";
import { LINE_QUOTA } from "../shared/line-quota.js";
import {
  answerByPostback,
  answerPostback,
  applyAnswer,
  questionByQuote,
} from "./answers.js";
import {
  lineQuotaBlocked,
  lineQuotaUsage,
  markQuotaExhausted,
  saveQuotaUsage,
  withLinePushLock,
} from "./line-quota.js";
import {
  isMonthlyLimit,
  quotaRemaining,
  quotaUsageOf,
  quotaTestBlocked,
} from "../shared/line-quota.js";
function withUncertainHint(messages: ChatReplyMessage[], uncertain: number) {
  if (!messages.length || !uncertain) return messages;
  const hint = `\n\n有 ${uncertain} 則回覆不確定是否送達，需要時輸入 /進度 取回`;
  const last = messages[messages.length - 1];
  const text = groupText(typeof last === "string" ? last : last.text, 5000 - hint.length) + hint;
  return [...messages.slice(0, -1), typeof last === "string" ? text : { ...last, text }];
}

const Event = z
  .object({
    webhookEventId: z.string(),
    type: z.string(),
    replyToken: z.string().max(200).optional(),
    timestamp: z.number().optional(),
    deliveryContext: z.object({ isRedelivery: z.boolean() }).optional(),
    source: z
      .object({
        type: z.string(),
        groupId: z.string().optional(),
        roomId: z.string().optional(),
        userId: z.string().optional(),
      })
      .optional(),
    message: z
      .object({
        id: z.string(),
        type: z.string(),
        text: z.string().optional(),
        fileName: z.string().optional(),
        fileSize: z.number().int().nonnegative().optional(),
        quotedMessageId: z.string().optional(),
        // 指令模式下 @機器人 也算提出需求；isSelf 表示提及的是本機器人。
        mention: z
          .object({
            mentionees: z
              .array(z.object({ isSelf: z.boolean().optional() }).passthrough())
              .max(100),
          })
          .passthrough()
          .optional(),
      })
      .optional(),
    unsend: z.object({ messageId: z.string() }).optional(),
    postback: z.object({ data: z.string().max(300) }).optional(),
  })
  .passthrough();
export const LinePayload = z.object({ events: z.array(Event).max(100) });
interface Ack {
  token: string;
  messages: ChatReplyMessage[];
  expiresAt: number;
  group?: string;
  /** 第一則是進度摘要，其後每則訊息依序對應 claim.ids。 */
  claim?: GroupReplyClaim;
}
export class Line {
  private readonly unusedReplies = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private db: Database,
    private discord?: DiscordChatPlatform | (() => DiscordChatPlatform | undefined),
  ) {}
  async ingest(body: unknown) {
    const payload = LinePayload.parse(body);
    const receivedAt = Date.now();
    const adoptions: Array<{ task: string; version: number; index: number }> =
      [];
    // 「/任務」的立即回覆：交易完成後才送，失敗不影響收訊。
    const acks: Ack[] = [];
    for (const e of payload.events)
      await this.db.transaction(async (c) => {
        const inserted = await c.query(
          "INSERT INTO events(id,provider) VALUES($1,'line') ON CONFLICT DO NOTHING RETURNING id",
          [e.webhookEventId],
        );
        if (!inserted.rowCount) return;
        const group = e.source?.groupId ?? e.source?.roomId;
        if (!group && e.type === "postback" && e.source?.userId) {
          // 只接受已配對管理者在私訊點的快速回覆；群組成員或其他人無法核准。
          const m = /^adopt:([0-9a-f-]{36}):(\d+):([0-2])$/.exec(
            e.postback?.data ?? "",
          );
          const admin = (
            await c.query("SELECT value->>'admin_line_id' AS id FROM settings")
          ).rows[0]?.id;
          if (m && admin && admin === e.source.userId)
            adoptions.push({
              task: m[1],
              version: Number(m[2]),
              index: Number(m[3]),
            });
          return;
        }
        if (!group) {
          if (e.message?.type === "text" && e.source?.userId)
            await pairAdmin(this.db, c, "line", e.source.userId, e.message.text ?? "");
          return;
        }
        if (e.type === "leave") {
          // 機器人被移出群組：標記離開並通知管理者，不再只是默默停用。沒見過的群組不必建立。
          const left = await c.query(
            "UPDATE groups SET enabled=false,left_at=now() WHERE id=$1 AND platform='line' AND left_at IS NULL RETURNING name",
            [group],
          );
          if (left.rowCount)
            await c.query(
              "INSERT INTO notifications(kind,dedupe_key,text) VALUES('group_left',$1,$2) ON CONFLICT DO NOTHING",
              [
                `group_left:${e.webhookEventId}`,
                `機器人已離開群組「${left.rows[0].name}」，這個群組不再接收需求。重新邀請機器人加入後，再到群組頁啟用。`,
              ],
            );
          return;
        }
        await c.query(
          "INSERT INTO groups(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [group, `群組 ${group.slice(-6)}`],
        );
        // 還收得到這個群組的事件，代表機器人已經回來；維持停用，等管理者確認後再啟用。
        const back = await c.query(
          "UPDATE groups SET left_at=NULL,announced_at=COALESCE(announced_at,now()) WHERE id=$1 AND platform='line' AND left_at IS NOT NULL RETURNING name",
          [group],
        );
        if (back.rowCount)
          await c.query(
            "INSERT INTO notifications(kind,dedupe_key,text) VALUES('group_new',$1,$2) ON CONFLICT DO NOTHING",
            [
              `group_back:${e.webhookEventId}`,
              `機器人已回到群組「${back.rows[0].name}」，目前仍是停用。請到群組頁確認專案後啟用。`,
            ],
          );
        // 與群組設定使用同一把鎖，收訊不會跨過切換模式的邊界。
        const settings = (
          await c.query(
            `SELECT enabled,left_at,trigger_mode,reply_mode,${groupRepliesOn} AS replies FROM groups WHERE id=$1 AND platform='line' FOR UPDATE`,
            [group],
          )
        ).rows[0];
        // 其他平台的群組留給各自的收訊入口，也不會領取 LINE 的 /進度 補送。
        if (!settings) return;
        // 一分鐘從收到 webhook 起算；重送還受原事件發生後二十分鐘的期限限制。
        const expiresAt = e.deliveryContext?.isRedelivery
          ? Math.min(receivedAt + 60_000, (e.timestamp ?? 0) + 20 * 60_000)
          : receivedAt + 60_000;
        const replyOn = !!e.replyToken && expiresAt > Date.now() &&
          settings.reply_mode !== "off" && settings.replies;
        // 群組成員點了補問的常見答案按鈕：比照用「回覆」作答，只在任務仍在等這一版回答時收下。
        // 重複點擊由上方 events 去重與版本比對擋下（作答後版本 +1，舊按鈕不再符合）。
        if (e.type === "postback") {
          const data = e.postback?.data ?? "";
          if (
            !settings?.enabled ||
            settings.left_at ||
            !answerPostback.test(data)
          )
            return;
          const t = await answerByPostback(
            this.db,
            c,
            group,
            data,
            e.webhookEventId,
          );
          if (replyOn) {
            const { uncertain } = await claimPendingGroupReplies(c, group, 0, "line", null, "important");
            acks.push({
              token: e.replyToken!,
              expiresAt,
              messages: withUncertainHint([
                !t
                  ? staleAnswerAck
                  : t.status === "queued"
                    ? answerAck
                    : answerHeldAck,
              ], uncertain),
            });
          }
          return;
        }
        if (e.type === "unsend" && e.unsend) {
          await c.query(
            "INSERT INTO messages(id,group_id,type,revoked,processed) VALUES($1,$2,'unsend',true,true) ON CONFLICT(id) DO UPDATE SET text=NULL,image=NULL,image_mime=NULL,document_name=NULL,document_size=NULL,document_url=NULL,document_error=NULL,user_id=NULL,revoked=true,processed=true",
            [e.unsend.messageId, group],
          );
          await invalidateMessageSources(this.db, c, group, [e.unsend.messageId], e.webhookEventId, "撤回");
          return;
        }
        if (e.type === "message" && e.message) {
          const queueReply = (messages: ChatReplyMessage[] = []) => {
            if (!replyOn || !e.replyToken) return;
            acks.push({
              token: e.replyToken,
              expiresAt,
              messages,
              group: settings.enabled && !settings.left_at ? group : undefined,
            });
          };
          // 「/進度」：用不耗推播額度的 reply token 回本群組的需求狀態與先前沒送到的回覆。
          // 不建任務、不送判讀、不呼叫模型；在判斷補問回答與指令之前處理，引用補問打 /進度 也不會被當成回答。
          if (e.message.type === "text" && isProgressCommand(e.message.text)) {
            const saved = await c.query(
              "INSERT INTO messages(id,group_id,user_id,type,text,quoted_id,trigger_mode,processed) VALUES($1,$2,$3,'text',$4,$5,'chat',true) ON CONFLICT DO NOTHING RETURNING id",
              [
                e.message.id,
                group,
                e.source?.userId ?? null,
                e.message.text,
                e.message.quotedMessageId ?? null,
              ],
            );
            if (!saved.rowCount || !replyOn) return;
            if (!settings.enabled) {
              acks.push({ token: e.replyToken!, expiresAt, messages: [disabledAck] });
              return;
            }
            const { tasks, total } = await progressTasks(c, group);
            const { replies, remaining, claim, uncertain } =
              await claimPendingGroupReplies(c, group, lineReplyLimit - 1);
            const notes: ChatReplyMessage[] = replies.map((r, i) => ({
              text:
                remaining && i === replies.length - 1
                  ? `${r.text}\n\n${progressMoreNote(remaining)}`
                  : r.text,
              quick: r.quick_replies,
            }));
            acks.push({
              token: e.replyToken!,
              expiresAt,
              messages: withUncertainHint([
                progressSummary(tasks, total, replies.length, "群組", replies.some((r) => r.unconfirmed)),
                ...notes,
              ], uncertain),
              claim,
            });
            return;
          }
          // 「回覆」機器人的補問就是回答：直接併進需求，不用等判讀，也不再呼叫模型。
          const answerText = e.message.text?.trim() ?? "";
          const sensitiveReply =
            e.message.type === "text" &&
            !!e.message.quotedMessageId &&
            containsCredential(answerText);
          const asked =
            settings.enabled &&
            group &&
            e.message.type === "text" &&
            e.message.quotedMessageId &&
            answerText &&
            !sensitiveReply
              ? await questionByQuote(c, group, e.message.quotedMessageId)
              : undefined;
          if (asked && group) {
            const saved = await c.query(
              "INSERT INTO messages(id,group_id,user_id,type,text,quoted_id,trigger_mode,processed,bot_reply) VALUES($1,$2,$3,'text',$4,$5,'command',true,true) ON CONFLICT DO NOTHING RETURNING id",
              [
                e.message.id,
                group,
                e.source?.userId ?? null,
                e.message.text,
                e.message.quotedMessageId,
              ],
            );
            if (!saved.rowCount) return;
            const t = await applyAnswer(
              this.db,
              c,
              asked,
              answerText,
              "群組成員（LINE）",
              false,
              e.message.id,
            );
            queueReply([t.status === "queued" ? answerAck : answerHeldAck]);
            return;
          }
          // 回答補問卻含憑證格式：明確拒收。不存原文、不排判讀，也不能落到追問路徑回「收到」，
          // 即使群組停用或提問已過期，仍不能把這則回答當成一般聊天而保存原文。
          if (
            sensitiveReply &&
            (
              await c.query(
                "SELECT 1 FROM notifications n JOIN tasks t ON t.id=n.task_id WHERE n.sent_message_id=$1 AND n.group_id=$2 AND t.group_id=$2 AND n.kind='group_question' LIMIT 1",
                [e.message.quotedMessageId, group],
              )
            ).rowCount
          ) {
            const saved = await c.query(
              "INSERT INTO messages(id,group_id,user_id,type,text,quoted_id,trigger_mode,processed,bot_reply) VALUES($1,$2,$3,'text',$4,$5,'chat',true,false) ON CONFLICT DO NOTHING RETURNING id",
              [
                e.message.id,
                group,
                e.source?.userId ?? null,
                "[已略過含憑證的回答]",
                e.message.quotedMessageId,
              ],
            );
            if (saved.rowCount)
              queueReply([settings.enabled ? credentialAnswerAck : disabledAck]);
            return;
          }
          // 引用機器人的查詢回答打「詳細」：用 reply token 分段送出完整內容，不建任務、不呼叫模型。
          if (
            group &&
            e.message.type === "text" &&
            e.message.quotedMessageId &&
            detailRequest.test(e.message.text ?? "")
          ) {
            const full = (
              await c.query<{ answer: string }>(
                "SELECT t.answer FROM notifications n JOIN tasks t ON t.id=n.task_id WHERE n.sent_message_id=$1 AND n.group_id=$2 AND t.group_id=$2 AND n.kind='group_answered' AND t.answer IS NOT NULL LIMIT 1",
                [e.message.quotedMessageId, group],
              )
            ).rows[0];
            if (full) {
              const saved = await c.query(
                "INSERT INTO messages(id,group_id,user_id,type,text,quoted_id,trigger_mode,processed) VALUES($1,$2,$3,'text',$4,$5,'chat',true) ON CONFLICT DO NOTHING RETURNING id",
                [
                  e.message.id,
                  group,
                  e.source?.userId ?? null,
                  e.message.text,
                  e.message.quotedMessageId,
                ],
              );
              if (saved.rowCount)
                queueReply(lineChunks(splitQueryAnswer(full.answer).body, lineReplyLimit));
              return;
            }
          }
          const command =
            e.message.type === "text" &&
            (isTaskCommand(e.message.text) ||
              !!e.message.mention?.mentionees.some((m) => m.isSelf));
          const botReply =
            e.message.type === "text" &&
            !!e.message.quotedMessageId &&
            !!(
              await c.query(
                "SELECT 1 FROM notifications n JOIN tasks t ON t.id=n.task_id WHERE n.sent_message_id=$1 AND n.group_id=$2 AND t.group_id=$2 LIMIT 1",
                [e.message.quotedMessageId, group],
              )
            ).rowCount;
          const eligible =
            settings.enabled &&
            (settings.trigger_mode === "auto" || command || botReply);
          const isFile = e.message.type === "file";
          const saved = await c.query(
            `INSERT INTO messages(id,group_id,user_id,type,text,quoted_id,trigger_mode,processed,bot_reply,document_name,document_size)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
            [
              e.message.id,
              group,
              e.source?.userId ?? null,
              isFile ? "document" : e.message.type,
              isFile ? null : e.message.text ?? null,
              e.message.quotedMessageId ?? null,
              eligible ? (command || botReply ? "command" : "auto") : "chat",
              !eligible,
              botReply,
              isFile ? redact(documentName(e.message.fileName ?? "")) || "未命名檔案" : null,
              isFile ? e.message.fileSize ?? null : null,
            ],
          );
          if (saved.rowCount && replyOn) {
            if (command || botReply) {
              const base = botReply ? await this.followupAck(c, group, e.message.quotedMessageId) : commandAck;
              queueReply([eligible ? await this.honestAck(c, group, base) : disabledAck]);
            } else if (settings.enabled) queueReply();
          }
          if (eligible && saved.rowCount)
            await c.query(
              "UPDATE groups SET first_pending_at=COALESCE(first_pending_at,now()),last_pending_at=now() WHERE id=$1",
              [group],
            );
        }
      });
    for (const a of acks) {
      if (a.group) await this.replyWithPending(a.group, a.token, a.expiresAt, a.messages);
      else await this.sendAck(a);
    }
    for (const a of adoptions) {
      const reply =
        "這個按鈕已改為看板確認流程。請先到看板檢視目標專案與方案，再確認執行。";
      await this.notify(
        a.task,
        "adopt",
        `adopt:${a.task}:${a.version}:${a.index}`,
        reply,
      );
    }
  }
  async content(id: string): Promise<Response> {
    const access = secrets().lineToken;
    if (!access) throw new AppError(503, "LINE Access Token 尚未設定");
    return fetchLine(
      `https://api-data.line.me/v2/bot/message/${encodeURIComponent(id)}/content`,
      {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      },
    );
  }
  async image(id: string) {
    return readChatImage(await this.content(id));
  }
  async notify(taskId: string | null, kind: string, key: string, text: string) {
    // 同一任務 30 分鐘內只通知一次失敗；錯誤仍完整寫進稽核紀錄。
    await this.db.query(
      "INSERT INTO notifications(task_id,kind,dedupe_key,text) SELECT $1,$2,$3,$4 WHERE NOT ($2='failed' AND $1::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM notifications WHERE task_id=$1::uuid AND kind='failed' AND created_at>now()-interval '30 minutes')) ON CONFLICT DO NOTHING",
      [taskId, kind, key, text],
    );
  }
  /**
   * 引用追問的「收到」：上一題是查詢時，附上同專案最近 20 次查詢的耗時中位數；沒有紀錄就不寫時間。
   */
  private async followupAck(
    c: { query: Database["pool"]["query"] },
    group: string | undefined,
    quotedId: string | undefined,
  ) {
    if (!group || !quotedId) return followupAck;
    const r = (
      await c.query(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.completed_at-r.started_at)) AS seconds
         FROM (SELECT r.completed_at,r.started_at FROM runs r JOIN tasks t ON t.id=r.task_id
           WHERE t.mode='query' AND t.status='answered' AND r.completed_at IS NOT NULL AND t.project_id=(
             SELECT q.project_id FROM notifications n JOIN tasks q ON q.id=n.task_id
             WHERE n.sent_message_id=$1 AND n.group_id=$2 AND q.mode='query' LIMIT 1)
           ORDER BY r.completed_at DESC LIMIT 20) r`,
        [quotedId, group],
      )
    ).rows[0] as { seconds: number | null } | undefined;
    if (!r?.seconds) return followupAck;
    const minutes = Math.ceil(Number(r.seconds) / 60);
    return followupAck.replace(
      /。$/,
      minutes <= 1 ? "，大約 1 分鐘。" : `，大約 ${minutes} 分鐘。`,
    );
  }
  /**
   * 「收到」依收訊當下的系統狀態說實話（只改文字，不改審核、派工、判讀規則）：
   * 系統或判讀暫停、本群組判讀連續失敗停止、群組沒有可用專案（條件同 triage-window.ts）、訂閱模式的 Codex 額度關卡關閉。
   */
  private async honestAck(c: DbClient, group: string, base: string) {
    const s = (
      await c.query<{
        paused: boolean;
        triage_stopped: boolean;
        ai_out: boolean;
        no_project: boolean;
      }>(
        `SELECT COALESCE((s.value->>'paused')::boolean,false) OR COALESCE((s.value->>'triage_paused')::boolean,false) AS paused,
           COALESCE((SELECT g.triage_failures>=3 FROM groups g WHERE g.id=$1),false) AS triage_stopped,
           COALESCE(s.value->>'ai_mode','')='subscription' AND COALESCE((SELECT NOT ok FROM service_health WHERE name=$2),false) AS ai_out,
           NOT EXISTS(SELECT 1 FROM group_projects gp JOIN projects p ON p.id=gp.project_id WHERE gp.group_id=$1 AND p.enabled AND p.validated_at IS NOT NULL) AS no_project
         FROM settings s WHERE s.id=1`,
        [group, subscriptionGateName],
      )
    ).rows[0];
    return ackFor({
      base,
      paused: !!s?.paused,
      triageStopped: !!s?.triage_stopped,
      noProject: !!s?.no_project,
      aiQuotaOut: !!s?.ai_out,
    });
  }
  private async replyWithPending(
    group: string,
    token: string,
    expiresAt: number,
    messages: ChatReplyMessage[],
    freshEvent = true,
  ) {
    if (expiresAt <= Date.now()) return;
    const slots = lineReplyLimit - messages.length;
    const pending = await this.db.transaction(async (c) => {
      const { rows: [quota] } = await c.query<{ ok: boolean; detail: string }>(
        "SELECT ok,detail FROM service_health WHERE name=$1", [LINE_QUOTA],
      );
      const exhausted = quota?.ok === false || quotaRemaining(quotaUsageOf(quota?.detail)) === 0;
      return claimPendingGroupReplies(c, group, slots, "line", null, exhausted ? "important" : "all", freshEvent);
    });
    if (!pending.claim) {
      if (expiresAt <= Date.now()) return;
      if (messages.length) await this.reply(token, withUncertainHint(messages, pending.uncertain));
      else if (expiresAt > (this.unusedReplies.get(group)?.expiresAt ?? 0))
        this.unusedReplies.set(group, { token, expiresAt });
      return;
    }
    const unlisted = pending.remaining - pending.summaries.length;
    const more = pending.remaining
      ? `\n\n其餘待送通知：\n${pending.summaries.join("\n")}${unlisted ? `\n另有 ${unlisted} 則未列出。` : ""}\n可以輸入 /進度 取回待送的任務結果。`
      : "";
    const notices = pending.replies.map((notice, i) => {
      const suffix = i === pending.replies.length - 1 ? more : "";
      const prefix = notice.unconfirmed ? "（補送：先前可能沒送到，看過可略過）\n" : "";
      return { text: prefix + groupText(redact(notice.text), 4900 - suffix.length - prefix.length) + suffix, quick: notice.quick_replies };
    });
    const result = expiresAt > Date.now()
      ? await this.reply(token, withUncertainHint([...messages, ...notices], pending.uncertain))
      : { ids: null, status: null };
    const claim = pending.claim;
    await this.db.transaction((c) => this.settleClaimed(c, claim, result, messages.length));
    // LINE 明確拒收內容時，原指令回覆仍可單獨嘗試。連線中斷或權杖失效時不能重送。
    if (messages.length && expiresAt > Date.now() && result.status === 400 &&
        typeof result.message === "string" && /request body|invalid message|messages?\[\d+\]/i.test(result.message) &&
        replyRejected(result.status, result.message)) {
      await this.reply(token, withUncertainHint(messages, pending.uncertain));
    }
  }
  private async flushRecentReplies() {
    for (const [group, reply] of [...this.unusedReplies]) {
      if (this.unusedReplies.get(group) !== reply) continue;
      this.unusedReplies.delete(group);
      await this.replyWithPending(group, reply.token, reply.expiresAt, [], false);
    }
  }
  private async sendAck({ token, expiresAt, messages, claim }: Ack) {
    if (!claim) {
      if (expiresAt > Date.now()) await this.reply(token, messages);
      return;
    }
    const renewed = await this.db.transaction(async (c) => {
      // 同批 webhook 可能已排隊一段時間。送出前續領兩分鐘，涵蓋 LINE 最多五秒的等待。
      const rows = await lockGroupReplyClaim(c, claim);
      if (rows.length !== claim.ids.length || rows.some((r) => !r.valid)) {
        // 摘要和通知共用一個 reply token。整批已變更時，只歸還此交易仍持有的列。
        if (rows.length)
          await c.query(
            "UPDATE notifications SET sent_at=NULL,last_error=$2 WHERE id=ANY($1::uuid[])",
            [rows.map((r) => r.id), replyFailedNote],
          );
        return;
      }
      const { rows: [stamp] } = await c.query<{ claimed_at: string }>(
        "UPDATE notifications SET sent_at=statement_timestamp() WHERE id=ANY($1::uuid[]) RETURNING sent_at::text AS claimed_at",
        [claim.ids],
      );
      return { ids: claim.ids, claimedAt: stamp.claimed_at };
    });
    if (!renewed) {
      if (expiresAt > Date.now()) await this.reply(token, [
        "這批群組回覆已更新，請再輸入 /進度 查看最新進度。",
      ]);
      return;
    }
    const result = expiresAt > Date.now() ? await this.reply(token, messages) : { ids: null, status: null };
    await this.db.transaction((c) => this.settleClaimed(c, renewed, result, 1));
  }
  /**
   * 核對領取時間後依回覆順序寫回訊息 ID，讓「詳細」、引用追問與作答能接續。
   * 未確認 LINE 是否收件時保留給 /進度，重要通知冷卻後可再用一次免費回覆。
   * LINE 以內容問題拒收（replyRejected）時，這批每則 reply_failures+1；到 REPLY_FAILURE_LIMIT 次就改寫成
   * replyGaveUpNote、不再被 /進度 取回，之後的 /進度 至少能回摘要。限流、5xx、逾時、沒有權杖不計。
   */
  private async settleClaimed(
    c: DbClient,
    claim: GroupReplyClaim,
    result: ChatReplyResult,
    firstNotice: number,
  ) {
    const { ids } = result;
    if (!ids) {
      const blamed = replyRejected(result.status, result.message) ? 1 : 0;
      await c.query(
        `UPDATE notifications SET sent_at=NULL,reply_failures=reply_failures+$3,
           line_reply_policy=CASE WHEN $8 THEN 'manual' ELSE line_reply_policy END,
           line_reply_uncertain_at=CASE WHEN $8 THEN now() ELSE line_reply_uncertain_at END,
           last_error=CASE WHEN reply_failures+$3>=$4 THEN $5 ELSE $2 END
         WHERE id=ANY($1::uuid[]) AND sent_at=$6 AND last_error=$7 AND sent_message_id IS NULL`,
        [
          claim.ids,
          replyFailedNote,
          blamed,
          REPLY_FAILURE_LIMIT,
          replyGaveUpNote,
          claim.claimedAt,
          claimingNote,
          result.possiblyDelivered === true,
        ],
      );
      return;
    }
    for (const [i, id] of claim.ids.entries())
      await c.query(
        "UPDATE notifications SET sent_message_id=$2,last_error=NULL,line_reply_policy=NULL WHERE id=$1 AND sent_at=$3 AND last_error=$4",
        [id, ids[i + firstNotice] ?? null, claim.claimedAt, claimingNote],
      );
  }
  /**
   * 用 reply token 回覆群組；不計入推播額度，送不出去也不影響收訊。
   * 成功時 ids 依索引放 LINE 給每則訊息的 ID；沒送出時 ids 為 null，status 是 LINE 的狀態碼
   * （沒有權杖、逾時或連不上時為 null），message 是 LINE 回應的錯誤說明，讓呼叫端分辨是不是內容被拒收。
   */
  private reply(
    token: string,
    messages: ChatReplyMessage[],
  ): Promise<ChatReplyResult> {
    return new LineChatPlatform(secrets().lineToken).replyToMessage(
      { replyToken: token },
      messages,
    );
  }
  /** 立即送一則測試私訊，讓管理者確認配對與權杖都正常；不進通知佇列。 */
  async sendTest() {
    const sent = await withLinePushLock(this.db, async () => {
      await this.sendTestPush();
      return true;
    });
    if (!sent) throw new AppError(409, "LINE 正在處理推播，請稍後再送測試通知。");
  }

  private async sendTestPush() {
    const s = await this.db.settings(),
      access = secrets().lineToken;
    if (!access) throw new AppError(409, "尚未設定 LINE 權杖");
    if (!s.admin_line_id) throw new AppError(409, "請先完成 LINE 配對");
    // 額度用完時每按一次都會白打一次推播；直接說明原因，不叫管理者去檢查權杖。
    if (await lineQuotaBlocked(this.db))
      throw new AppError(409, quotaTestBlocked);
    const usage = await lineQuotaUsage(this.db);
    const hold = linePrivateQuotaHold(
      usage,
      s.line_group_reserve_percent ?? linePrivateDefaults.line_group_reserve_percent,
    );
    if (hold) throw new AppError(409, linePrivateQuotaNotes[hold]);
    if (quotaRemaining(usage) === 0) throw new AppError(409, quotaTestBlocked);
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: s.admin_line_id,
        messages: [
          {
            type: "text",
            text: "你已收到 chat2pr 的測試通知，代表 LINE 私訊通知運作正常。",
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (response && !response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      if (isMonthlyLimit(response.status, body?.message)) {
        await markQuotaExhausted(this.db, null, access);
        throw new AppError(409, quotaTestBlocked);
      }
      if (response.status === 429)
        throw new AppError(409, "LINE 推播太頻繁，請稍後再試（429）");
    }
    if (!response?.ok)
      // 用 409 回覆，看板才會顯示這段可以照著處理的說明（5xx 一律只顯示通用訊息）。
      throw new AppError(
        409,
        `LINE 沒有收下測試通知（${response?.status ?? "無法連線"}）。請確認權杖有效，而且你已把機器人加為好友。`,
      );
    if (usage) await saveQuotaUsage(this.db, { ...usage, used: usage.used + 1 });
  }
  async flushNotifications() {
    // LINE 與 Discord 停在「補送中」且已逾時的通知都放回待送。LINE 額度用完時也要回收。
    await reclaimStaleClaims(this.db);
    const discord = typeof this.discord === "function" ? this.discord() : this.discord;
    const results = await Promise.allSettled([
      withLinePushLock(this.db, async () => {
        const access = secrets().lineToken;
        if (!access) {
          this.unusedReplies.clear();
          return;
        }
        await this.flushRecentReplies();
        await flushLineGroups(this.db, access);
        if (!(await lineQuotaBlocked(this.db))) await flushLinePrivate(this.db, access);
      }),
      discord && flushDiscordNotifications(this.db, discord),
    ]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error("部分聊天通知未能完成，請檢查資料庫與服務設定。");
  }
}
