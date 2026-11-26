import { groupKindLabels } from "../shared/group-delivery.js";
import type { DbClient } from "./db.js";
import { pendingGroupRepliesFrom } from "./group-replies.js";
import { importantLineGroupNotice } from "./line-quota.js";
import { redact } from "./policy.js";

/** 同批仍有可取回或正在取回的來源時，提醒才需要管理者處理。 */
export const groupReplyStillUncertain = `n.id IN (SELECT n.line_reply_alert_id ${pendingGroupRepliesFrom(false, true)}
  AND n.line_reply_alert_id IS NOT NULL AND n.line_reply_policy='manual')`;

export async function queueUncertainReplyAlerts(c: DbClient, ids: string[]) {
  const { rows } = await c.query<{ id: string; task_id: string | null; name: string; kind: string; summary: string }>(
    `SELECT n.id,n.task_id,g.name,n.kind,COALESCE(t.title,n.text) AS summary
     FROM notifications n JOIN groups g ON g.id=n.group_id LEFT JOIN tasks t ON t.id=n.task_id
     WHERE n.id=ANY($1::uuid[]) AND n.line_reply_alert_id IS NULL AND ${importantLineGroupNotice}
     ORDER BY n.created_at,n.id`, [ids],
  );
  if (!rows.length) return;
  const summaries = rows.map((r) => `${groupKindLabels[r.kind] ?? "指令判讀"}：${Array.from(redact(r.summary).replace(/\s+/g, " ")).slice(0, 60).join("")}`);
  const text = `LINE 未確認「${redact(rows[0].name)}」的 ${rows.length} 則重要回覆是否送達。請到群組聊天室查看，必要時代為轉達。\n${summaries.join("\n")}`;
  const { rows: [alert] } = await c.query<{ id: string }>(
    `INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES($1,'reply_uncertain',$2,$3) RETURNING id`,
    [rows.length === 1 ? rows[0].task_id : null, `reply_uncertain:${rows[0].id}`, text],
  );
  await c.query("UPDATE notifications SET line_reply_alert_id=$1 WHERE id=ANY($2::uuid[])", [alert.id, rows.map((r) => r.id)]);
}
