import { randomUUID } from "node:crypto";
import { repliesOffNote } from "../shared/group-delivery.js";
import {
  expiredNote,
  lineQuotaLow,
  quotaExhaustedDetail,
  quotaRemaining,
  quotaShortForGroup,
  quotaShortPrefix,
  unknownGroupPushCost,
} from "../shared/line-quota.js";
import { splitQueryAnswer } from "../shared/query-answer.js";
import { groupDeliveryText } from "../shared/status-glossary.js";
import type { ChatButton } from "./chat-platform.js";
import type { Database, DbClient } from "./db.js";
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

const pending = "n.sent_at IS NULL AND n.attempts<3 AND n.line_reply_policy IS NULL";
const rejectedContent = String(new LinePushRejected(400));

/** 在送出前提交名單與重試鍵。原批次可能已被 LINE 收下，即使縮批也沿用同一把鍵。 */
async function claimBatch(db: Database, group: string, importantOnly: boolean, singleId: string | null) {
  return db.transaction(async (c) => {
    await c.query(
      `UPDATE notifications u SET sent_at=now(),last_error=$2
       FROM (SELECT n.id FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id
         WHERE n.group_id=$1 AND ${pending} AND ${staleNotification} FOR UPDATE OF n SKIP LOCKED) s
       WHERE u.id=s.id`,
      [group, expiredNote],
    );
    if (importantOnly) await holdOptional(c, group);
    const { rows } = await c.query<Notice>(
      `WITH anchor AS (
         SELECT n.id,n.line_digest_id,n.attempts,n.last_error FROM notifications n JOIN groups g ON g.id=n.group_id
         WHERE n.group_id=$1 AND ${pending} AND g.left_at IS NULL AND g.reply_mode<>'off'
           AND COALESCE((SELECT (value->>'group_replies')::boolean FROM settings WHERE id=1),true)
           AND (n.line_digest_id IS NOT NULL OR NOT $2 OR ${importantLineGroupNotice})
           AND ($5::uuid IS NULL OR (n.id=$5 AND n.last_error=$4))
         ORDER BY n.line_digest_id IS NULL,n.created_at,n.id LIMIT 1
       )
       SELECT n.id,n.kind,n.text,n.quick_replies,n.line_digest_id FROM notifications n CROSS JOIN anchor a
       WHERE n.group_id=$1 AND ${pending} AND n.attempts=a.attempts AND n.line_digest_id IS NOT DISTINCT FROM a.line_digest_id
         AND (n.id=a.id OR (n.last_error IS DISTINCT FROM $4 AND a.last_error IS DISTINCT FROM $4))
         AND (n.line_digest_id IS NOT NULL OR NOT $2 OR ${importantLineGroupNotice})
       ORDER BY n.created_at,n.id LIMIT $3 FOR UPDATE OF n SKIP LOCKED`,
      [group, importantOnly, lineReplyLimit, rejectedContent, singleId],
    );
    if (!rows.length) return;
    // LINE 只顯示最後一則的快速回覆按鈕。把下一題留到下一批，兩題都能在自己的訊息下作答。
    const question = rows.findIndex((n) => n.quick_replies?.length);
    const notices = question < 0 ? rows : rows.slice(0, question + 1);
    const ids = notices.map((n) => n.id);
    const key = notices[0].line_digest_id ?? randomUUID();
    await c.query(
      `UPDATE notifications SET line_digest_id=$2,
         last_error=CASE WHEN last_error LIKE $3||'%' THEN NULL ELSE last_error END WHERE id=ANY($1::uuid[])`,
      [ids, key, quotaShortPrefix],
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

async function holdOptional(c: DbClient, group: string | null = null) {
  await c.query(
    `UPDATE notifications u SET line_reply_policy='free',last_error=$1
     FROM (SELECT n.id FROM notifications n JOIN groups g ON g.id=n.group_id
       WHERE g.platform='line' AND ${pending} AND ($2::text IS NULL OR n.group_id=$2) AND NOT ${importantLineGroupNotice}
       FOR UPDATE OF n SKIP LOCKED) held WHERE u.id=held.id`,
    [groupDeliveryText.quotaPriority, group],
  );
}

/** 409 的識別碼屬於先前收下的名單。名單曾縮小時只確認送達，避免把引用識別碼配給另一則。 */
async function confirmRetriedBatch(c: DbClient, key: string, currentSize: number, messageIds: (string | null)[]) {
  const { rows } = await c.query<{ size: number }>(
    "SELECT count(*)::int AS size FROM notifications WHERE line_digest_id=$1",
    [key],
  );
  const originalSize = rows[0].size;
  if (originalSize === currentSize && messageIds.length === currentSize) return messageIds;
  if (originalSize > currentSize && messageIds.length === originalSize) {
    await c.query(
      `UPDATE notifications SET sent_at=now(),attempts=attempts+1,last_error=NULL,sent_message_id=NULL,line_reply_policy=NULL
       WHERE line_digest_id=$1 AND sent_at IS NULL AND line_reply_policy='free'`,
      [key],
    );
  } else if (originalSize > currentSize && messageIds.length !== currentSize) {
    // 無法確認哪些較早的通知已送達，只留給群組自行用 /進度 取回。
    await c.query(
      `UPDATE notifications SET line_reply_policy='manual',last_error=$2
       WHERE line_digest_id=$1 AND sent_at IS NULL AND line_reply_policy='free'`,
      [key, groupDeliveryText.replyUncertain],
    );
  }
  return [];
}

/** 呼叫端持有 LINE 推播鎖。每群首批立即送，後續兩分鐘的通知累積成同一個推播請求。 */
export async function flushLineGroups(db: Database, access: string) {
  const off = (await db.settings()).group_replies === false;
  await db.query(
    `UPDATE notifications n SET sent_at=now(),
       last_error=CASE WHEN g.left_at IS NOT NULL THEN $2 ELSE $3 END
     FROM groups g WHERE n.group_id=g.id AND g.platform='line' AND n.sent_at IS NULL
       AND ($1 OR g.left_at IS NOT NULL OR g.reply_mode='off')`,
    [off, groupDeliveryText.botLeft, repliesOffNote],
  );
  if (off) return;
  const blocked = await lineQuotaBlocked(db);
  let usage = await lineQuotaUsage(db);
  if (!blocked && lineQuotaLow(usage)) await holdOptional(db.pool);
  await db.query(
    `UPDATE notifications u SET sent_at=now(),last_error=$1
     FROM (SELECT n.id FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id
       WHERE n.sent_at IS NULL AND n.line_reply_policy='free' AND ${staleNotification}
       FOR UPDATE OF n SKIP LOCKED) s WHERE u.id=s.id`,
    [expiredNote],
  );
  if (blocked) return;
  const groups = await db.query<{ group_id: string; rejected_ids: string[] | null }>(
    `SELECT n.group_id,(array_agg(n.id ORDER BY n.created_at,n.id) FILTER (WHERE n.last_error=$2))[1:10] AS rejected_ids
     FROM notifications n JOIN groups g ON g.id=n.group_id
     WHERE g.platform='line' AND ${pending} AND (n.last_error=$2 OR NOT EXISTS (
       SELECT 1 FROM notifications p WHERE p.group_id=n.group_id AND p.line_digest_id IS NOT NULL
         AND p.last_error IS NULL AND p.sent_at>now()-interval '2 minutes'))
     GROUP BY n.group_id,g.id
     ORDER BY COALESCE(g.member_count_at>now()-interval '24 hours'
       AND GREATEST(COALESCE(g.member_count,$3::int),g.member_count_estimate,1)>$1,false),
       min(n.created_at),n.group_id LIMIT 50`,
    [
      Number.isFinite(quotaRemaining(usage) ?? Infinity)
        ? quotaRemaining(usage)
        : null,
      rejectedContent,
      unknownGroupPushCost,
    ],
  );
  const platform = new LineChatPlatform(access);
  let requests = 0;
  const queue = groups.flatMap(({ group_id, rejected_ids }) =>
    (rejected_ids ?? [null]).map((singleId) => ({ group_id, singleId })),
  );
  while (queue.length && requests < 10) {
    const { group_id, singleId } = queue.shift()!;
    const left = quotaRemaining(usage);
    const { members, cost } = await groupMemberCount(db, group_id, access);
    if (left !== null && left < cost) {
      await holdOptional(db.pool, group_id);
      await db.query(
        `UPDATE notifications n SET last_error=$2 WHERE n.group_id=$1 AND ${pending}`,
        [group_id, quotaShortForGroup(left, members !== null && members > left ? members : null)],
      );
      continue;
    }
    await expireQuotaHeld(db.pool, group_id);
    const batch = await claimBatch(db, group_id, lineQuotaLow(usage, cost), singleId);
    if (!batch) continue;
    requests++;
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
              members !== null && members > remaining ? members : null,
            )
          : quotaExhaustedDetail;
        await db.query(
          "UPDATE notifications SET last_error=$2 WHERE id=ANY($1::uuid[])",
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
      // LINE 明確拒絕整批後可安全拆開，只有單獨被拒收才算該通知失敗。
      const isolate = error instanceof LinePushRejected && error.status === 400 && batch.ids.length > 1;
      await db.query(
        `UPDATE notifications SET attempts=attempts+$4::int,last_error=$2,
           line_digest_id=CASE WHEN $3 OR attempts+$4::int>=3 THEN NULL ELSE line_digest_id END
         WHERE id=ANY($1::uuid[])`,
        [batch.ids, detail, error instanceof LinePushRejected, isolate ? 0 : 1],
      );
      if (isolate) queue.unshift(...batch.ids.map((singleId) => ({ group_id, singleId })));
      await recordLinePush(db, detail);
    }
    if (result) {
      const { ids: messageIds, newlyAccepted } = result;
      const updated =
        usage && newlyAccepted
          ? { ...usage, used: usage.used + cost }
          : usage;
      await db.transaction(async (c) => {
        const ids = newlyAccepted ? messageIds : await confirmRetriedBatch(c, batch.key, batch.ids.length, messageIds);
        await c.query(
          `UPDATE notifications n SET sent_at=now(),attempts=attempts+1,last_error=NULL,sent_message_id=m.message_id
           FROM unnest($1::uuid[],$2::text[]) AS m(id,message_id) WHERE n.id=m.id`,
          [batch.ids, batch.ids.map((_, i) => ids[i] ?? null)],
        );
        if (updated && updated !== usage) await saveQuotaUsage(db, updated, c);
      });
      usage = updated;
      await recordLinePush(db);
    }
  }
}
