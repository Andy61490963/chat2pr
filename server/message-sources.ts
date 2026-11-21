import type { Database, DbClient } from "./db.js";
import { revokePickSource } from "./pick-lists.js";

export async function invalidateMessageSources(
  db: Database,
  c: DbClient,
  group: string,
  ids: string[],
  eventId: string,
  change: "撤回" | "編輯",
) {
  for (const id of ids) await revokePickSource(c, group, id);
  const { rows: affected } = await c.query<{ id: string; status: string }>(
    "SELECT id,status FROM tasks WHERE group_id=$1 AND source_ids && $2::text[] ORDER BY id FOR UPDATE",
    [group, ids],
  );
  for (const task of affected) {
    const running = ["running", "reviewing"].includes(task.status);
    if (
      running ||
      ["queued", "budget_wait", "awaiting_approval", "failed"].includes(
        task.status,
      )
    )
      await c.query(
        `UPDATE tasks SET status='awaiting_approval',approved_version=NULL,version=version+1,
         base_sha=NULL,branch=NULL,pr_number=NULL,pr_url=NULL,approved_paths='{}',
         missing=missing || jsonb_build_array($2::text),
         last_error=CASE WHEN $3::text IS NOT NULL THEN $3 ELSE last_error END,updated_at=now() WHERE id=$1`,
        [
          task.id,
          `來源訊息已${change}，請重新確認需求`,
          running ? `來源已${change}，執行中止並待重新審核` : null,
        ],
      );
    const kind = change === "編輯" ? "message_edit" : "unsend";
    await db.audit(
      task.id,
      kind,
      `來源訊息已${change}；請確認已整理需求及既有 PR`,
      c,
    );
    await c.query(
      "INSERT INTO notifications(task_id,kind,dedupe_key,text) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [
        task.id,
        kind,
        `${kind}:${eventId}:${task.id}`,
        `需求來源已${change}，請查看看板確認處理方式。`,
      ],
    );
  }
}
