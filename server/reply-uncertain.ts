import type { DbClient } from "./db.js";
import { importantLineGroupNotice } from "./line-quota.js";
import { redact } from "./policy.js";
import { claimingNote } from "../shared/group-delivery.js";

/** 管理者提醒跟著原通知解除；正在用免費回覆取回時，等 LINE 回應後再判定。 */
export const groupReplyStillUncertain = `EXISTS (SELECT 1 FROM notifications source
  WHERE 'reply_uncertain:'||source.id=n.dedupe_key AND source.line_reply_policy='manual'
    AND (source.sent_at IS NULL OR source.last_error='${claimingNote}'))`;

export async function queueUncertainReplyAlerts(c: DbClient, ids?: string[]) {
  const { rows } = await c.query<{ id: string; task_id: string | null; group_name: string }>(
    `SELECT n.id,n.task_id,g.name AS group_name FROM notifications n JOIN groups g ON g.id=n.group_id
     WHERE g.platform='line' AND n.sent_at IS NULL AND n.line_reply_policy='manual' AND ${importantLineGroupNotice}
       AND ($1::uuid[] IS NULL OR n.id=ANY($1))
       AND NOT EXISTS (SELECT 1 FROM notifications a WHERE a.dedupe_key='reply_uncertain:'||n.id)`,
    [ids ?? null],
  );
  for (const notice of rows) {
    const text = `LINE 未確認重要回覆是否送達「${redact(notice.group_name)}」。請到群組聊天室查看，必要時代為轉達。`;
    await c.query(
      `INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES($1,'reply_uncertain',$2,$3)
       ON CONFLICT(dedupe_key) DO NOTHING`,
      [notice.task_id, `reply_uncertain:${notice.id}`, text],
    );
  }
}
