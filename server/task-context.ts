import type { Database, DbClient } from "./db.js";
import type {
  ContextEvidence,
  ContextEvidenceInput,
} from "../shared/context-evidence.js";

/** 只保存來源及量測，不複製原文、片段或提示詞。 */
export async function recordContextEvidence(
  c: DbClient,
  taskId: string,
  phase: string,
  items: ContextEvidenceInput[],
  version?: number,
) {
  if (!items.length) return;
  await c.query(
    `INSERT INTO task_context_evidence(task_id,version,phase,mechanism,source_kind,source_id,project_id,source_time,score,path,line_start,line_end,index_sha,source_hash)
    SELECT t.id,t.version,$2,e.mechanism,e.source_kind,e.source_id,e.project_id,e.source_time,e.score,e.path,e.line_start,e.line_end,e.index_sha,e.source_hash
    FROM tasks t CROSS JOIN jsonb_to_recordset($3::jsonb) e(mechanism text,source_kind text,source_id text,project_id uuid,source_time timestamptz,score double precision,path text,line_start int,line_end int,index_sha text,source_hash text)
    WHERE t.id=$1 AND ($4::int IS NULL OR t.version=$4)`,
    [taskId, phase, JSON.stringify(items), version ?? null],
  );
}

export async function readTaskContextEvidence(db: Database, taskId: string) {
  return db.query<ContextEvidence>(
    `SELECT e.id::text,e.version,e.phase,e.mechanism,e.source_kind,e.source_id,e.project_id,e.source_time,e.score,e.path,e.line_start,e.line_end,e.index_sha,e.source_hash,e.observed_at,
    (EXISTS(SELECT 1 FROM groups g WHERE g.id=t.group_id AND g.enabled)
      AND (e.project_id IS NULL OR EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=t.group_id AND gp.project_id=e.project_id))
      AND CASE e.source_kind
        WHEN 'message' THEN EXISTS(SELECT 1 FROM messages m WHERE m.id=e.source_id AND m.group_id=t.group_id AND NOT m.revoked AND m.received_at>message_retention_cutoff() AND m.text IS NOT NULL AND (e.source_hash IS NULL OR e.source_hash=encode(sha256(convert_to(m.text,'UTF8')),'hex')))
        WHEN 'image' THEN EXISTS(SELECT 1 FROM messages m JOIN image_observations o ON o.message_id=m.id WHERE m.id=e.source_id AND m.group_id=t.group_id AND NOT m.revoked AND m.received_at>message_retention_cutoff() AND m.image IS NOT NULL AND (e.source_hash IS NULL OR o.source_hash=e.source_hash) AND encode(sha256(m.image),'hex')=o.source_hash)
        WHEN 'memory' THEN EXISTS(SELECT 1 FROM group_memories m WHERE m.id::text=e.source_id AND m.group_id=t.group_id)
        WHEN 'knowledge' THEN EXISTS(SELECT 1 FROM project_knowledge k JOIN group_projects gp ON gp.project_id=k.project_id AND gp.group_id=t.group_id WHERE k.id::text=e.source_id AND k.status<>'closed')
        WHEN 'project_context' THEN EXISTS(SELECT 1 FROM projects p WHERE p.id=e.project_id AND p.config_version::text=e.source_id)
        WHEN 'task' THEN EXISTS(SELECT 1 FROM tasks s WHERE s.id::text=e.source_id AND s.group_id=t.group_id)
        WHEN 'outcome' THEN EXISTS(SELECT 1 FROM tasks s JOIN group_projects gp ON gp.project_id=s.project_id AND gp.group_id=s.group_id WHERE s.id::text=e.source_id AND s.project_id=t.project_id AND s.status IN ('failed','ready','merged'))
        WHEN 'repo' THEN (e.phase='routing' AND e.mechanism='direct' AND e.version=t.version AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.project_routing->'evidence') ref WHERE ref->>'sourceId'=e.source_id)) OR EXISTS(SELECT 1 FROM repo_indexes r WHERE r.project_id=e.project_id AND r.active_sha=e.index_sha AND (t.base_sha IS NULL OR t.project_id<>e.project_id OR t.base_sha=e.index_sha))
        ELSE false END) AS valid
    FROM task_context_evidence e JOIN tasks t ON t.id=e.task_id WHERE e.task_id=$1
    ORDER BY e.version DESC,e.observed_at DESC,e.id LIMIT 800`,
    [taskId],
  );
}
