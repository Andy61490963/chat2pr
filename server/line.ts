import { z } from "zod";
import { Database } from "./db.js";
import { secrets, config } from "./config.js";
import { hash } from "./auth.js";
import { AppError, redact } from "./policy.js";
import { isTaskCommand } from "../shared/chat.js";
import { notificationView } from "../shared/notifications.js";
import { commandAck, disabledAck, groupRepliesOn } from "./group-replies.js";
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
      })
      .optional(),
    unsend: z.object({ messageId: z.string() }).optional(),
    postback: z.object({ data: z.string().max(300) }).optional(),
  })
  .passthrough();
export const LinePayload = z.object({ events: z.array(Event).max(100) });
export class Line {
  constructor(private db: Database) {}
  async ingest(body: unknown) {
    const payload = LinePayload.parse(body);
    const adoptions: Array<{ task: string; version: number; index: number }> =
      [];
    // 「/任務」的立即回覆：交易完成後才送，失敗不影響收訊。
    const acks: { token: string; text: string }[] = [];
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
            `SELECT enabled,trigger_mode,reply_mode,${groupRepliesOn} AS replies FROM groups WHERE id=$1 FOR UPDATE`,
            [group],
          )
        ).rows[0];
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
          const command =
            e.message.type === "text" && isTaskCommand(e.message.text);
          const eligible =
            settings.enabled && (settings.trigger_mode === "auto" || command);
          const saved = await c.query(
            "INSERT INTO messages(id,group_id,user_id,type,text,quoted_id,trigger_mode,processed) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
            [
              e.message.id,
              group,
              e.source?.userId ?? null,
              e.message.type,
              e.message.text ?? null,
              e.message.quotedMessageId ?? null,
              eligible ? (command ? "command" : "auto") : "chat",
              !eligible,
            ],
          );
          if (
            command &&
            saved.rowCount &&
            e.replyToken &&
            settings.reply_mode !== "off" &&
            settings.replies
          )
            acks.push({
              token: e.replyToken,
              text: eligible ? commandAck : disabledAck,
            });
          if (eligible && saved.rowCount)
            await c.query(
              "UPDATE groups SET first_pending_at=COALESCE(first_pending_at,now()),last_pending_at=now() WHERE id=$1",
              [group],
            );
        }
      });
    for (const a of acks) await this.reply(a.token, a.text);
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
  /** 用 reply token 回覆群組；不計入推播額度，送不出去也不影響收訊。 */
  private async reply(token: string, text: string) {
    const access = secrets().lineToken;
    if (!access) return;
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        replyToken: token,
        messages: [{ type: "text", text }],
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
  }
  /** 立即送一則測試私訊，讓管理者確認配對與權杖都正常；不進通知佇列。 */
  async sendTest() {
    const s = await this.db.settings(),
      access = secrets().lineToken;
    if (!access) throw new AppError(409, "尚未設定 LINE 權杖");
    if (!s.admin_line_id) throw new AppError(409, "請先完成 LINE 配對");
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
    const notifications = await this.db.query<{
      id: string;
      task_id: string | null;
      group_id: string | null;
      kind: string;
      text: string;
      quick_replies:
        { label: string; data: string; displayText: string }[] | null;
    }>(
      "SELECT * FROM notifications WHERE sent_at IS NULL AND attempts<3 AND (group_id IS NOT NULL OR $1::text IS NOT NULL) ORDER BY created_at LIMIT 10",
      [s.admin_line_id ?? null],
    );
    for (const n of notifications) {
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
              messages: [
                {
                  type: "text",
                  text: n.group_id
                    ? n.text
                    : `${n.text}\n${config().publicUrl}/${n.task_id ? `tasks?task=${n.task_id}` : (notificationView(n.kind) ?? "")}`,
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
        )
          throw new Error(`LINE 通知失敗（${response.status}）`);
        await this.db.query(
          "UPDATE notifications SET sent_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1",
          [n.id],
        );
        await this.db.query(
          "INSERT INTO service_health(name,ok,detail) VALUES('notifications',true,'最近一次 LINE 通知已送達') ON CONFLICT(name) DO UPDATE SET ok=true,detail=EXCLUDED.detail,checked_at=now()",
        );
      } catch (e) {
        await this.db.query(
          "UPDATE notifications SET attempts=attempts+1,last_error=$2 WHERE id=$1",
          [n.id, redact(String(e))],
        );
        await this.db.query(
          "INSERT INTO service_health(name,ok,detail) VALUES('notifications',false,$1) ON CONFLICT(name) DO UPDATE SET ok=false,detail=$1,checked_at=now()",
          [redact(String(e))],
        );
      }
    }
  }
}
