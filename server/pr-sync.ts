import type { Database } from "./db.js";
import type { GitHub } from "./github.js";
import type { Project } from "../shared/types.js";

// GitHub 的 PR 合併／關閉 Webhook 可能延遲或遺失；定期直接查詢待合併任務的 PR 狀態補上。
export async function syncOpenPullRequests(
  db: Database,
  github: Pick<GitHub, "pullState">,
) {
  const rows = await db.query<Project & { task_id: string; pr_number: number }>(
    "SELECT p.*,t.id AS task_id,t.pr_number FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.status='ready' AND t.pr_number IS NOT NULL AND p.repo_missing_at IS NULL ORDER BY t.updated_at LIMIT 30",
  );
  for (const row of rows) {
    try {
      const pr = await github.pullState(row, row.pr_number);
      if (pr.state !== "closed") continue;
      const status = pr.merged ? "merged" : "closed";
      const updated = await db.query(
        "UPDATE tasks SET status=$2,updated_at=now() WHERE id=$1 AND status='ready' RETURNING id",
        [row.task_id, status],
      );
      if (!updated.length) continue;
      await db.query(
        "UPDATE project_knowledge SET status=$3 WHERE project_id=$1 AND pr_number=$2 AND status='in_pr'",
        [row.id, row.pr_number, status],
      );
      await db.audit(
        row.task_id,
        status,
        `PR #${row.pr_number} 已在 GitHub ${pr.merged ? "合併" : "關閉"}（定期同步）`,
      );
    } catch {
      // 單一 PR 查詢失敗不影響其他任務，下次再同步。
    }
  }
}
