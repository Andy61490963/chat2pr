import { randomUUID } from "node:crypto";
import {
  expiredNote,
  lineQuotaLow,
  pushCost,
  quotaExhaustedDetail,
  quotaRemaining,
  quotaShortForGroup,
} from "../shared/line-quota.js";
import { splitQueryAnswer } from "../shared/query-answer.js";
import { groupDeliveryText } from "../shared/status-glossary.js";
import type { ChatButton } from "./chat-platform.js";
import type { Database } from "./db.js";
import { LineChatPlatform, lineReplyLimit } from "./line-platform.js";
import {
  expireQuotaHeld,
  fetchLineQuota,
  groupMemberCount,
  importantLineGroupNotice,
  LinePushRejected,
  LineQuotaExhausted,
  lineQuotaBlocked,
  lineQuotaUsage,
  markGroupTooLarge,
  markQuotaExhausted,
  recordLinePush,
  saveQuotaUsage,
  staleNotification,
} from "./line-quota.js";
import { redact } from "./policy.js";

type Notice = {
  id: string;
  kind: string;
  text: string;
  quick_replies: ChatButton[] | null;
  line_digest_id: string | null;
};

const pending = "n.sent_at IS NULL AND n.attempts<3";
const rejectedContent = String(new LinePushRejected(400));

/** 在送出前提交名單與重試鍵。程序重開時先取回原批次，避免已收件的重試鍵被拿去送不同內容。 */
async function claimBatch(db: Database, group: string, importantOnly: boolean) {
  return db.transaction(async (c) => {
    // 收件或重試期間，任務可能已結束、配額可能已降低。名單有變就必須換鍵。
    await c.query(
      `UPDATE notifications u SET sent_at=now(),last_error=x.reason
       FROM (SELECT n.id,CASE WHEN ${staleNotification} THEN $2::text
           WHEN $4 AND NOT ${importantLineGroupNotice} THEN $3::text END AS reason
         FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id WHERE n.group_id=$1 AND ${pending}) x
       WHERE u.id=x.id AND u.sent_at IS NULL AND x.reason IS NOT NULL`,
      [group, expiredNote, groupDeliveryText.quotaPriority, importantOnly],
    );
    await c.query(
      `UPDATE notifications n SET line_digest_id=NULL WHERE n.group_id=$1 AND ${pending}
       AND n.line_digest_id IN (SELECT p.line_digest_id FROM notifications p WHERE p.group_id=$1 AND p.sent_at IS NOT NULL
         AND p.line_digest_id IS NOT NULL AND p.last_error IS NOT NULL)`,
      [group],
    );
    const { rows } = await c.query<Notice>(
      `WITH anchor AS (
         SELECT n.id,n.line_digest_id,n.attempts,n.last_error FROM notifications n JOIN groups g ON g.id=n.group_id
         WHERE n.group_id=$1 AND ${pending} AND g.enabled AND g.left_at IS NULL AND g.reply_mode<>'off'
           AND COALESCE((SELECT (value->>'group_replies')::boolean FROM settings WHERE id=1),true)
           AND (n.line_digest_id IS NOT NULL OR NOT $2 OR ${importantLineGroupNotice})
         ORDER BY n.line_digest_id IS NULL,n.created_at,n.id LIMIT 1
       )
       SELECT n.id,n.kind,n.text,n.quick_replies,n.line_digest_id FROM notifications n CROSS JOIN anchor a
       WHERE n.group_id=$1 AND ${pending} AND n.attempts=a.attempts AND n.line_digest_id IS NOT DISTINCT FROM a.line_digest_id
         AND (n.id=a.id OR (n.last_error IS DISTINCT FROM $4 AND a.last_error IS DISTINCT FROM $4))
         AND (n.line_digest_id IS NOT NULL OR NOT $2 OR ${importantLineGroupNotice})
       ORDER BY n.created_at,n.id LIMIT $3 FOR UPDATE OF n SKIP LOCKED`,
      [group, importantOnly, lineReplyLimit, rejectedContent],
    );
    if (!rows.length) return;
    // LINE 只顯示最後一則的快速回覆按鈕。把下一題留到下一批，兩題都能在自己的訊息下作答。
    const question = rows.findIndex((n) => n.quick_replies?.length);
    const notices = question < 0 ? rows : rows.slice(0, question + 1);
    const ids = notices.map((n) => n.id);
    const key = notices[0].line_digest_id ?? randomUUID();
    if (!notices[0].line_digest_id)
      await c.query(
        "UPDATE notifications SET line_digest_id=$2 WHERE id=ANY($1::uuid[])",
        [ids, key],
      );
    return {
      ids,
      key,
      messages: notices.map((n) => ({
        text: redact(
          n.kind === "group_answered" ? splitQueryAnswer(n.text).body : n.text,
        ),
        quick: n.quick_replies,
      })),
    };
  });
}

async function skipOptional(db: Database) {
  await db.query(
    `UPDATE notifications u SET sent_at=now(),last_error=$1
     FROM (SELECT n.id FROM notifications n JOIN groups g ON g.id=n.group_id
       WHERE g.platform='line' AND ${pending} AND n.line_digest_id IS NULL AND NOT ${importantLineGroupNotice}
       FOR UPDATE OF n SKIP LOCKED) skipped WHERE u.id=skipped.id`,
    [groupDeliveryText.quotaPriority],
  );
}

/** 呼叫端持有 LINE 推播鎖。每群首批立即送，後續兩分鐘的通知累積成同一個推播請求。 */
export async function flushLineGroups(db: Database, access: string) {
  const off = (await db.settings()).group_replies === false;
  await db.query(
    `UPDATE notifications n SET sent_at=now(),last_error='群組回覆已關閉，未送出',line_digest_id=NULL
     FROM groups g WHERE n.group_id=g.id AND g.platform='line' AND n.sent_at IS NULL
       AND ($1 OR NOT g.enabled OR g.left_at IS NOT NULL OR g.reply_mode='off')`,
    [off],
  );
  if (off) return;
  if (await lineQuotaBlocked(db)) return;
  let usage = await lineQuotaUsage(db);
  if (lineQuotaLow(usage)) await skipOptional(db);
  const groups = await db.query<{ group_id: string }>(
    `SELECT n.group_id FROM notifications n JOIN groups g ON g.id=n.group_id
     WHERE g.platform='line' AND ${pending} AND NOT EXISTS (
       SELECT 1 FROM notifications p WHERE p.group_id=n.group_id AND p.line_digest_id IS NOT NULL
         AND p.last_error IS NULL AND p.sent_at>now()-interval '2 minutes')
     GROUP BY n.group_id,g.member_count,g.member_count_at
     ORDER BY COALESCE(g.member_count_at>now()-interval '24 hours' AND g.member_count>$1,false),
       min(n.created_at),n.group_id LIMIT 50`,
    [
      Number.isFinite(quotaRemaining(usage) ?? Infinity)
        ? quotaRemaining(usage)
        : null,
    ],
  );
  const platform = new LineChatPlatform(access);
  let requests = 0;
  for (const { group_id } of groups) {
    const left = quotaRemaining(usage);
    const count = Number.isFinite(left ?? Infinity)
      ? await groupMemberCount(db, group_id, access)
      : null;
    if (left !== null && left < pushCost(count)) {
      await db.query(
        `UPDATE notifications n SET last_error=$2,line_digest_id=NULL WHERE n.group_id=$1 AND ${pending}`,
        [group_id, quotaShortForGroup(left, count)],
      );
      continue;
    }
    await expireQuotaHeld(db.pool, group_id);
    const batch = await claimBatch(db, group_id, lineQuotaLow(usage, pushCost(count)));
    if (!batch) continue;
    let result: Awaited<ReturnType<typeof platform.pushGroupBatch>> | undefined;
    try {
      result = await platform.pushGroupBatch(
        group_id,
        batch.messages,
        batch.key,
      );
    } catch (error) {
      if (error instanceof LineQuotaExhausted) {
        const fresh = await fetchLineQuota(access).catch(() => null);
        const remaining = quotaRemaining(fresh);
        const groupShort = remaining !== null && remaining >= 1;
        const detail = groupShort
          ? quotaShortForGroup(
              Number.isFinite(remaining) ? remaining : 0,
              count !== null && count > remaining ? count : null,
            )
          : quotaExhaustedDetail;
        await db.query(
          "UPDATE notifications SET line_digest_id=NULL,last_error=$2 WHERE id=ANY($1::uuid[])",
          [batch.ids, detail],
        );
        if (groupShort) {
          if (Number.isFinite(remaining))
            await markGroupTooLarge(db, group_id, remaining);
          if (fresh) await saveQuotaUsage(db, fresh);
        } else await markQuotaExhausted(db, fresh ?? usage, access);
        break;
      }
      const detail = redact(String(error));
      // 整批被拒收時還不知道哪一則有問題，下一輪逐則送，只有單獨被拒收才算該通知失敗。
      const isolate = error instanceof LinePushRejected && error.status === 400 && batch.ids.length > 1;
      await db.query(
        `UPDATE notifications SET attempts=attempts+$4::int,last_error=$2,
           line_digest_id=CASE WHEN $3 OR attempts+$4::int>=3 THEN NULL ELSE line_digest_id END
         WHERE id=ANY($1::uuid[])`,
        [batch.ids, detail, error instanceof LinePushRejected, isolate ? 0 : 1],
      );
      await recordLinePush(db, detail);
    }
    if (result) {
      const updated =
        usage && result.newlyAccepted
          ? { ...usage, used: usage.used + pushCost(count) }
          : usage;
      await db.transaction(async (c) => {
        await c.query(
          `UPDATE notifications n SET sent_at=now(),attempts=attempts+1,last_error=NULL,sent_message_id=m.message_id
           FROM unnest($1::uuid[],$2::text[]) AS m(id,message_id) WHERE n.id=m.id`,
          [batch.ids, result.ids],
        );
        if (updated && updated !== usage) await saveQuotaUsage(db, updated, c);
      });
      usage = updated;
      await recordLinePush(db);
    }
    if (++requests >= 10) break;
  }
}
