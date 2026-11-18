import { z } from "zod";
import { Database, type DbClient } from "./db.js";
import { secrets, config } from "./config.js";
import { hash } from "./auth.js";
import { AppError, redact } from "./policy.js";
import { isProgressCommand, isTaskCommand } from "../shared/chat.js";
import { notificationView } from "../shared/notifications.js";
import {
  commandAck,
  disabledAck,
  followupAck,
  answerAck,
  answerHeldAck,
  credentialAnswerAck,
  detailRequest,
  lineChunks,
  groupRepliesOn,
  ackFor,
  claimPendingGroupReplies,
  pendingGroupReplies,
  progressMoreNote,
  progressSummary,
  progressTasks,
  replyFailedNote,
  staleAnswerAck,
  type QuickReply,
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
  LineQuotaExhausted,
  lineQuotaBlocked,
  markQuotaExhausted,
} from "./line-quota.js";
import {
  isMonthlyLimit,
  quotaExhaustedDetail,
  quotaTestBlocked,
} from "../shared/line-quota.js";
const Event = z
  .object({
    webhookEventId: z.string(),
    type: z.string(),
    replyToken: z.string().max(200).optional(),
    timestamp: z.number().optional(),
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
/** reply token 一次最多送 5 則；同一個 token 只能用一次，所有內容要合併成一個陣列。 */
const REPLY_LIMIT = 5;
type ReplyMessage = string | { text: string; quick?: QuickReply[] | null };
interface Ack {
  token: string;
  messages: ReplyMessage[];
  /** messages[i] 是補送的哪一則通知（沒有則為 null）：送出後依索引寫回 sent_message_id。 */
  notices?: (string | null)[];
}
const lineText = (m: ReplyMessage) => {
  const text = typeof m === "string" ? m : m.text;
  const quick = typeof m === "string" ? null : m.quick;
  return {
    type: "text",
    text,
    ...(quick?.length
      ? {
          quickReply: {
            items: quick.slice(0, 13).map((q) => ({
              type: "action",
              action: {
                type: "postback",
                label: q.label,
                data: q.data,
                displayText: q.displayText,
              },
            })),
          },
        }
      : {}),
  };
};
export class Line {
  constructor(private db: Database) {}
  async ingest(body: unknown) {
    const payload = LinePayload.parse(body);
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
          if (e.message?.type === "text" && e.source?.userId) {
            const m = /^配對\s+([a-f0-9]{16})$/i.exec(e.message.text ?? "");
            if (m) {
              const found = await c.query(
                "UPDATE pairing_codes SET consumed_at=now() WHERE code_hash=$1 AND expires_at>now() AND consumed_at IS NULL RETURNING code_hash",
                [hash(m[1])],
              );
              if (found.rowCount) {
                await c.query(
                  "UPDATE settings SET value=jsonb_set(value,'{admin_line_id}',to_jsonb($1::text)) WHERE id=1",
                  [e.source.userId],
                );
                await this.db.audit(
                  null,
                  "pairing",
                  "管理者 LINE 通知身分已綁定",
                  c,
                );
              }
            }
          }
          return;
        }
        if (e.type === "leave") {
          // 機器人被移出群組：標記離開並通知管理者，不再只是默默停用。沒見過的群組不必建立。
          const left = await c.query(
            "UPDATE groups SET enabled=false,left_at=now() WHERE id=$1 AND left_at IS NULL RETURNING name",
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
          "UPDATE groups SET left_at=NULL,announced_at=COALESCE(announced_at,now()) WHERE id=$1 AND left_at IS NOT NULL RETURNING name",
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
            `SELECT enabled,left_at,trigger_mode,reply_mode,${groupRepliesOn} AS replies FROM groups WHERE id=$1 FOR UPDATE`,
            [group],
          )
        ).rows[0];
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
          const replyOn =
            !!e.replyToken && settings.reply_mode !== "off" && settings.replies;
          const t = await answerByPostback(
            this.db,
            c,
            group,
            data,
            e.webhookEventId,
          );
          if (replyOn)
            acks.push({
              token: e.replyToken!,
              messages: [
                !t
                  ? staleAnswerAck
                  : t.status === "queued"
                    ? answerAck
                    : answerHeldAck,
              ],
            });
          return;
        }
        if (e.type === "unsend" && e.unsend) {
          await c.query(
            "INSERT INTO messages(id,group_id,type,revoked,processed) VALUES($1,$2,'unsend',true,true) ON CONFLICT(id) DO UPDATE SET text=NULL,image=NULL,image_mime=NULL,user_id=NULL,revoked=true,processed=true",
            [e.unsend.messageId, group],
          );
          const affected = (
            await c.query(
              "SELECT * FROM tasks WHERE group_id=$1 AND $2=ANY(source_ids) FOR UPDATE",
              [group, e.unsend.messageId],
            )
          ).rows;
          for (const t of affected) {
            if (
              ["queued", "budget_wait", "awaiting_approval", "failed"].includes(
                t.status,
              )
            )
              await c.query(
                "UPDATE tasks SET status='awaiting_approval',approved_version=NULL,version=version+1,base_sha=NULL,branch=NULL,pr_number=NULL,pr_url=NULL,approved_paths='{}',missing=missing || '[\"來源訊息已撤回，請重新確認需求\"]'::jsonb,updated_at=now() WHERE id=$1",
                [t.id],
              );
            if (["running", "reviewing"].includes(t.status))
              await c.query(
                "UPDATE tasks SET status='awaiting_approval',approved_version=NULL,version=version+1,base_sha=NULL,branch=NULL,pr_number=NULL,pr_url=NULL,approved_paths='{}',missing=missing || '[\"來源訊息已撤回，請重新確認需求\"]'::jsonb,last_error='來源已撤回，執行中止並待重新審核',updated_at=now() WHERE id=$1",
                [t.id],
              );
            await this.db.audit(
              t.id,
              "unsend",
              "來源訊息已撤回；請確認已整理需求及既有 PR",
              c,
            );
            await c.query(
              "INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES($1,'unsend',$2,'需求來源已撤回，請查看看板確認處理方式。') ON CONFLICT DO NOTHING",
              [t.id, `unsend:${e.webhookEventId}:${t.id}`],
            );
          }
          return;
        }
        if (e.type === "message" && e.message) {
          const replyOn =
            !!e.replyToken && settings.reply_mode !== "off" && settings.replies;
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
              acks.push({ token: e.replyToken!, messages: [disabledAck] });
              return;
            }
            const { tasks, total } = await progressTasks(c, group);
            const { replies, remaining } = await claimPendingGroupReplies(
              c,
              group,
              REPLY_LIMIT - 1,
            );
            const notes: ReplyMessage[] = replies.map((r, i) => ({
              text:
                remaining && i === replies.length - 1
                  ? `${r.text}\n\n${progressMoreNote(remaining)}`
                  : r.text,
              quick: r.quick_replies,
            }));
            acks.push({
              token: e.replyToken!,
              messages: [
                progressSummary(tasks, total, replies.length),
                ...notes,
              ],
              notices: [null, ...replies.map((r) => r.id)],
            });
            return;
          }
          // 「回覆」機器人的補問就是回答：直接併進需求，不用等判讀，也不再呼叫模型。
          // 含常見憑證格式的回答不收，改走一般流程，避免機密寫進需求。
          const answerText = e.message.text?.trim() ?? "";
          const asked =
            settings.enabled &&
            group &&
            e.message.type === "text" &&
            e.message.quotedMessageId &&
            answerText &&
            redact(answerText) === answerText
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
            if (replyOn)
              acks.push({
                token: e.replyToken!,
                messages: [t.status === "queued" ? answerAck : answerHeldAck],
              });
            return;
          }
          // 回答補問卻含憑證格式：明確拒收。不存原文、不排判讀，也不能落到追問路徑回「收到」，
          // 否則成員以為已收下，原文還會以追問身分交給判讀模型。過期的補問不在此處理，照舊當補充。
          if (
            settings.enabled &&
            e.message.type === "text" &&
            e.message.quotedMessageId &&
            answerText &&
            redact(answerText) !== answerText &&
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
                redact(answerText),
                e.message.quotedMessageId,
              ],
            );
            if (saved.rowCount && replyOn)
              acks.push({
                token: e.replyToken!,
                messages: [credentialAnswerAck],
              });
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
              if (saved.rowCount && replyOn)
                acks.push({
                  token: e.replyToken!,
                  messages: lineChunks(full.answer, REPLY_LIMIT),
                });
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
          const saved = await c.query(
            "INSERT INTO messages(id,group_id,user_id,type,text,quoted_id,trigger_mode,processed,bot_reply) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id",
            [
              e.message.id,
              group,
              e.source?.userId ?? null,
              e.message.type,
              e.message.text ?? null,
              e.message.quotedMessageId ?? null,
              eligible ? (command || botReply ? "command" : "auto") : "chat",
              !eligible,
              botReply,
            ],
          );
          if ((command || botReply) && saved.rowCount && replyOn)
            acks.push({
              token: e.replyToken!,
              messages: [
                eligible
                  ? await this.honestAck(
                      c,
                      group,
                      botReply
                        ? await this.followupAck(
                            c,
                            group,
                            e.message.quotedMessageId,
                          )
                        : commandAck,
                    )
                  : disabledAck,
              ],
            });
          if (eligible && saved.rowCount)
            await c.query(
              "UPDATE groups SET first_pending_at=COALESCE(first_pending_at,now()),last_pending_at=now() WHERE id=$1",
              [group],
            );
        }
      });
    for (const a of acks) {
      const ids = await this.reply(a.token, a.messages);
      if (a.notices) await this.settleClaimed(a.notices, ids);
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
  async image(id: string) {
    const access = secrets().lineToken;
    if (!access) throw new AppError(503, "LINE Access Token 尚未設定");
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${encodeURIComponent(id)}/content`,
      {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok)
      throw new AppError(502, `無法取得圖片（${response.status}）`);
    const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime))
      throw new AppError(422, "不支援此圖片格式");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body! as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024)
        throw new AppError(413, "圖片超過 10 MB，請人工確認");
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const { validateImageContent } = await import("./image-content.js");
    await validateImageContent(data, mime);
    return { data, mime };
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
   * 推播額度用完或本群組有推播失敗的回覆時，再提醒可以打 /進度 取回，但不附完整內容。
   */
  private async honestAck(c: DbClient, group: string, base: string) {
    const s = (
      await c.query<{
        paused: boolean;
        triage_stopped: boolean;
        ai_out: boolean;
        no_project: boolean;
        push_out: boolean;
      }>(
        `SELECT COALESCE((s.value->>'paused')::boolean,false) OR COALESCE((s.value->>'triage_paused')::boolean,false) AS paused,
           COALESCE((SELECT g.triage_failures>=3 FROM groups g WHERE g.id=$1),false) AS triage_stopped,
           COALESCE(s.value->>'ai_mode','')='subscription' AND COALESCE((SELECT NOT ok FROM service_health WHERE name=$2),false) AS ai_out,
           NOT EXISTS(SELECT 1 FROM group_projects gp JOIN projects p ON p.id=gp.project_id WHERE gp.group_id=$1 AND p.enabled AND p.validated_at IS NOT NULL) AS no_project,
           COALESCE((SELECT NOT ok FROM service_health WHERE name=$3),false) AS push_out
         FROM settings s WHERE s.id=1`,
        [group, subscriptionGateName, LINE_QUOTA],
      )
    ).rows[0];
    const pending = await pendingGroupReplies(c, group);
    return ackFor({
      base,
      paused: !!s?.paused,
      triageStopped: !!s?.triage_stopped,
      noProject: !!s?.no_project,
      aiQuotaOut: !!s?.ai_out,
      undelivered: s?.push_out || pending.failed ? pending.count : 0,
    });
  }
  /**
   * /進度 補送的通知：reply 成功就依索引寫回 sent_message_id（之後「詳細」、引用追問、引用作答才接得上）；
   * 失敗或逾時就把佔住的列還原成未送出，下次 /進度 或正常推播可以再試。
   */
  private async settleClaimed(
    notices: (string | null)[],
    ids: (string | null)[] | null,
  ) {
    const claimed = notices.flatMap((id, i) => (id ? [{ id, i }] : []));
    if (!claimed.length) return;
    if (!ids) {
      await this.db.query(
        "UPDATE notifications SET sent_at=NULL,last_error=$2 WHERE id=ANY($1::uuid[]) AND sent_message_id IS NULL",
        [claimed.map((n) => n.id), replyFailedNote],
      );
      return;
    }
    for (const n of claimed)
      await this.db.query(
        "UPDATE notifications SET sent_message_id=$2,last_error=NULL WHERE id=$1",
        [n.id, ids[n.i] ?? null],
      );
  }
  /**
   * 用 reply token 回覆群組；不計入推播額度，送不出去也不影響收訊。
   * 成功時依索引回傳 LINE 給每則訊息的 ID；沒送出（沒有權杖、逾時、非 2xx）時回傳 null。
   */
  private async reply(
    token: string,
    messages: ReplyMessage[],
  ): Promise<(string | null)[] | null> {
    const access = secrets().lineToken;
    if (!access) return null;
    const sent = messages.slice(0, REPLY_LIMIT);
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken: token, messages: sent.map(lineText) }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      sentMessages?: { id?: unknown }[];
    } | null;
    return sent.map((_, i) => {
      const id = body?.sentMessages?.[i]?.id;
      return typeof id === "string" ? id : null;
    });
  }
  /** 立即送一則測試私訊，讓管理者確認配對與權杖都正常；不進通知佇列。 */
  async sendTest() {
    const s = await this.db.settings(),
      access = secrets().lineToken;
    if (!access) throw new AppError(409, "尚未設定 LINE 權杖");
    if (!s.admin_line_id) throw new AppError(409, "請先完成 LINE 配對");
    // 額度用完時每按一次都會白打一次推播；直接說明原因，不叫管理者去檢查權杖。
    if (await lineQuotaBlocked(this.db))
      throw new AppError(409, quotaTestBlocked);
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
            text: "這是 AgentFlow 的測試通知。收到這則訊息，代表 LINE 私訊通知運作正常。",
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
        await markQuotaExhausted(this.db);
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
  }
  async flushNotifications() {
    const s = await this.db.settings(),
      access = secrets().lineToken;
    if (!access) return;
    // 總開關關閉後，還沒送出的群組訊息不再送；之後重新開啟也不補發舊訊息。
    if (s.group_replies === false)
      await this.db.query(
        "UPDATE notifications SET sent_at=now(),last_error='群組回覆已關閉，未送出' WHERE group_id IS NOT NULL AND sent_at IS NULL",
      );
    // 每月額度用完時不呼叫推播；由連線檢查查到有剩餘額度才解除（server/line-quota.ts）。
    if (await lineQuotaBlocked(this.db)) return;
    // 撈取與送出在同一交易、鎖住這批通知：其他補送流程可以用 SKIP LOCKED 略過正在推送的列。
    await this.db.transaction(async (c) => {
      const notifications = (
        await c.query<{
          id: string;
          task_id: string | null;
          group_id: string | null;
          kind: string;
          text: string;
          quick_replies: QuickReply[] | null;
        }>(
          "SELECT * FROM notifications WHERE sent_at IS NULL AND attempts<3 AND (group_id IS NOT NULL OR $1::text IS NOT NULL) ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED",
          [s.admin_line_id ?? null],
        )
      ).rows;
      for (const n of notifications) {
        // 每則各自一個 savepoint：某則寫入失敗只退回那一則，不會讓整批已送出的紀錄一起被撤銷。
        await c.query("SAVEPOINT push");
        try {
          const response = await fetch(
            "https://api.line.me/v2/bot/message/push",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${access}`,
                "Content-Type": "application/json",
                "X-Line-Retry-Key": n.id,
              },
              body: JSON.stringify({
                // 群組成員沒有看板帳號，群組訊息不附看板連結。
                to: n.group_id ?? s.admin_line_id,
                // 群組補問附常見答案按鈕（quickReply）；管理者私訊不帶按鈕。
                messages: [
                  n.group_id
                    ? lineText({ text: n.text, quick: n.quick_replies })
                    : {
                        type: "text",
                        text: `${n.text}\n${config().publicUrl}/${n.task_id ? `tasks?task=${n.task_id}` : (notificationView(n.kind) ?? "")}`,
                      },
                ],
              }),
              signal: AbortSignal.timeout(10000),
            },
          );
          if (
            !response.ok &&
            !(
              response.status === 409 &&
              response.headers.get("x-line-accepted-request-id")
            )
          ) {
            const body = (await response.json().catch(() => null)) as {
              message?: unknown;
            } | null;
            // 每月額度用完和一般限流都是 429，只能看回應訊息分辨。
            if (isMonthlyLimit(response.status, body?.message))
              throw new LineQuotaExhausted();
            throw new Error(
              response.status === 429
                ? "LINE 推播太頻繁，稍後會再送（429）"
                : `LINE 通知失敗（${response.status}）`,
            );
          }
          // 記下 LINE 給這則訊息的 ID：之後有人「回覆」引用它，就知道是在接續哪個任務。
          const sent = response.ok
            ? ((await response.json().catch(() => null)) as {
                sentMessages?: { id?: string }[];
              } | null)
            : null;
          await c.query(
            "UPDATE notifications SET sent_at=now(),attempts=attempts+1,last_error=NULL,sent_message_id=$2 WHERE id=$1",
            [n.id, sent?.sentMessages?.[0]?.id ?? null],
          );
          await this.db.query(
            "INSERT INTO service_health(name,ok,detail) VALUES('notifications',true,'最近一次 LINE 通知已送達') ON CONFLICT(name) DO UPDATE SET ok=true,detail=EXCLUDED.detail,checked_at=now()",
          );
          await c.query("RELEASE SAVEPOINT push");
        } catch (e) {
          await c.query("ROLLBACK TO SAVEPOINT push");
          if (e instanceof LineQuotaExhausted) {
            // 額度用完不是這則通知的問題：不算失敗次數、不把 notifications 寫成連線失敗，
            // 本輪立即停止，不再逐則撞 429。
            await c.query(
              "UPDATE notifications SET last_error=$2 WHERE id=$1",
              [n.id, quotaExhaustedDetail],
            );
            await markQuotaExhausted(this.db);
            break;
          }
          await c.query(
            "UPDATE notifications SET attempts=attempts+1,last_error=$2 WHERE id=$1",
            [n.id, redact(String(e))],
          );
          await this.db.query(
            "INSERT INTO service_health(name,ok,detail) VALUES('notifications',false,$1) ON CONFLICT(name) DO UPDATE SET ok=false,detail=$1,checked_at=now()",
            [redact(String(e))],
          );
        }
      }
    });
  }
}
