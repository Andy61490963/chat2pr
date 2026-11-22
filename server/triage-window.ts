import type { Database, DbClient } from "./db.js";
import type { Message } from "../shared/types.js";

const pendingMessages = `FROM messages m WHERE m.group_id=g.id AND NOT m.processed AND NOT m.revoked
 AND m.received_at>message_retention_cutoff() AND m.trigger_mode<>'chat'
 AND (g.trigger_mode='auto' OR m.trigger_mode='command')`;
const discussion = `m.triage_defer IS NOT DISTINCT FROM 'undecided_discussion'`;
const expired = `m.received_at<=now()-interval '15 minutes'`;

// 檢查整個待判讀佇列，而非前 100 則；混有一般需求時必須保留原本的彙整時間。
const pendingBatch = `SELECT
  bool_or(NOT (${discussion})) AS regular,
  bool_or((${discussion}) AND ${expired}) AS deadline,
  bool_or(m.triage_defer IS NULL) AS fresh,
  CASE WHEN bool_or(m.triage_defer IS NULL) THEN bool_and(m.type='text' AND m.bot_reply)
       ELSE bool_and(m.type='text' AND m.bot_reply) FILTER (WHERE NOT (${discussion}) OR ${expired}) END AS fast
  ${pendingMessages}`;
const regularDue = `b.regular AND g.first_pending_at IS NOT NULL
 AND (g.last_pending_at<=now()-CASE WHEN b.fast THEN interval '5 seconds' ELSE interval '60 seconds' END
   OR g.first_pending_at<=now()-interval '300 seconds')`;

export async function clearEmptyTriageWindow(c: DbClient, group: string) {
  // 等候中的討論有自己的到期時間，不沿用已清空的普通彙整時段。
  await c.query(
    `UPDATE groups g SET first_pending_at=NULL,last_pending_at=NULL
     WHERE g.id=$1 AND NOT EXISTS (SELECT 1 ${pendingMessages} AND NOT (${discussion}))`,
    [group],
  );
}

export async function dueTriageGroups(
  db: Database,
  groupId: string | null = null,
) {
  return db.query<{ id: string; fast: boolean }>(
    `SELECT g.id,b.fast FROM groups g CROSS JOIN LATERAL (${pendingBatch}) b
     WHERE ($1::text IS NULL OR g.id=$1)
     AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND NOT COALESCE((value->>'triage_paused')::boolean,false) AND NOT (value->>'paused')::boolean)
     AND g.enabled AND g.triage_failures<3
     AND (g.triage_retry_at IS NULL OR g.triage_retry_at<=now())
     AND EXISTS(SELECT 1 FROM group_projects gp JOIN projects p ON p.id=gp.project_id WHERE gp.group_id=g.id AND p.enabled AND p.validated_at IS NOT NULL)
     AND (b.deadline OR (${regularDue}))`,
    [groupId],
  );
}

export async function pendingTriageMessages(
  db: Database,
  groupId: string,
  scheduled: boolean,
) {
  const ready = `${pendingMessages} AND (
        ((${discussion}) AND ${expired})
        OR ((NOT $2::boolean OR (${regularDue})) AND (NOT (${discussion}) OR b.fresh))
      )`;
  const order = `((${discussion}) AND NOT (${expired})), m.received_at,m.id`;
  // 一批只判讀同一個 Discord 討論串（或頻道本身）的訊息，私人討論串內容不與其他對話混在一起。
  return db.query<Message>(
    `SELECT batch.* FROM groups g CROSS JOIN LATERAL (${pendingBatch}) b CROSS JOIN LATERAL (
      SELECT m.* ${ready}
        AND m.discord_thread_id IS NOT DISTINCT FROM (
          SELECT m.discord_thread_id ${ready} ORDER BY ${order} LIMIT 1
        )
      ORDER BY ${order} LIMIT 100
    ) batch WHERE g.id=$1 ORDER BY batch.received_at,batch.id`,
    [groupId, scheduled],
  );
}

export async function refreshTriageWindow(
  c: DbClient,
  groupId: string,
  retryIncomplete: boolean,
) {
  // 新訊息可能在模型判讀期間抵達；有新內容時以收訊時間彙整。
  await c.query(
    `UPDATE groups g SET (first_pending_at,last_pending_at)=(
     SELECT CASE WHEN w.incomplete AND NOT w.fresh
                 THEN CASE WHEN $2 THEN now() ELSE g.first_pending_at END ELSE w.first_at END,
            CASE WHEN w.incomplete AND NOT w.fresh
                 THEN CASE WHEN $2 THEN now()+interval '4 minutes' ELSE g.last_pending_at END ELSE w.last_at END
     FROM (
       SELECT min(m.received_at) AS first_at,max(m.received_at) AS last_at,
         COALESCE(bool_or(m.triage_defer IS NULL),false) AS fresh,
         COALESCE(bool_or(m.triage_defer='incomplete'),false) AS incomplete
       ${pendingMessages} AND NOT (${discussion})
     ) w) WHERE g.id=$1`,
    [groupId, retryIncomplete],
  );
}

export async function isFollowupBatch(db: Database, groupId: string) {
  const batch = await db.one<{ fast: boolean }>(
    `SELECT COALESCE(b.fast,false) AS fast FROM groups g CROSS JOIN LATERAL (${pendingBatch}) b WHERE g.id=$1`,
    [groupId],
  );
  return batch?.fast === true;
}
