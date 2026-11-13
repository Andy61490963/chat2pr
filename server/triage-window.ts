import type { Database } from "./db.js";

// 檢查整個待判讀佇列，而非前 100 則；混有一般需求時必須保留原本的彙整時間。
const pendingBatch = `SELECT count(*) AS count, bool_and(m.type='text' AND m.bot_reply) AS fast
 FROM messages m WHERE m.group_id=g.id AND NOT m.processed AND NOT m.revoked
 AND m.received_at>message_retention_cutoff() AND m.trigger_mode<>'chat'
 AND (g.trigger_mode='auto' OR m.trigger_mode='command')`;

export async function dueTriageGroups(
  db: Database,
  groupId: string | null = null,
) {
  return db.query<{ id: string; fast: boolean }>(
    `SELECT g.id,b.fast FROM groups g CROSS JOIN LATERAL (${pendingBatch}) b
     WHERE ($1::text IS NULL OR g.id=$1) AND b.count>0
     AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND NOT COALESCE((value->>'triage_paused')::boolean,false) AND NOT (value->>'paused')::boolean)
     AND g.enabled AND g.triage_failures<3
     AND EXISTS(SELECT 1 FROM group_projects gp JOIN projects p ON p.id=gp.project_id WHERE gp.group_id=g.id AND p.enabled AND p.validated_at IS NOT NULL)
     AND g.first_pending_at IS NOT NULL
     AND (g.last_pending_at<=now()-CASE WHEN b.fast THEN interval '5 seconds' ELSE interval '60 seconds' END OR g.first_pending_at<=now()-interval '300 seconds')`,
    [groupId],
  );
}

export async function isFollowupBatch(db: Database, groupId: string) {
  const batch = await db.one<{ fast: boolean }>(
    `SELECT COALESCE(b.fast,false) AS fast FROM groups g CROSS JOIN LATERAL (${pendingBatch}) b WHERE g.id=$1`,
    [groupId],
  );
  return batch?.fast === true;
}
