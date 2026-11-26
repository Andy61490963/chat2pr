import { containsCredential } from "../shared/credentials.js";
import { taskEndLabels } from "../shared/status-glossary.js";
import {
  endedStatuses,
  type Task,
  type TaskEndSummary,
} from "../shared/types.js";

type EndAudit = { kind: string; detail: string; created_at: string };
type EndTask = Pick<
  Task,
  "status" | "updated_at" | "pr_number" | "approved_version" | "end_reason"
>;

export function taskEndSummary(
  task: EndTask,
  audit: EndAudit | null,
  phase: string | null = null,
): TaskEndSummary | null {
  if (!endedStatuses.includes(task.status)) return null;

  const station =
    task.pr_number || phase === "publish"
      ? "pr"
      : phase && ["test", "review", "verify"].includes(phase)
        ? "verify"
        : phase && ["code", "collect"].includes(phase)
          ? "work"
          : phase || task.approved_version !== null
            ? "queue"
            : null;
  const summary: TaskEndSummary = {
    kind: "other",
    actor: null,
    at: new Date(audit?.created_at ?? task.updated_at).toISOString(),
    reason: null,
    station,
  };
  const kind = audit?.kind ??
    (task.status === "rejected" ? "reject" : task.status === "cancelled" ? "cancel" : null);
  if (kind === "reject" || kind === "cancel") {
    summary.kind = task.end_reason === "duplicate" ? "duplicate" : kind;
    if (!audit) return summary;
    const action = taskEndLabels[kind].event;
    const pattern = new RegExp(
      `^(.+?)\\s+${action}（需求版本 \\d+(?:；目標分支 [^）]+)?）(?:(?:，原因：|：)([\\s\\S]*))?$`,
    );
    const match = pattern.exec(audit.detail);
    const actor = match?.[1].trim();
    const reason = match?.[2]?.trim();
    if (actor && !containsCredential(actor)) summary.actor = actor;
    if (reason && !containsCredential(reason)) {
      summary.reason = reason.replace(/\s+/g, " ").slice(0, 500);
    }
    return summary;
  }

  switch (audit?.kind) {
    case "closed":
      // 同一種稽核也用於專案刪除與停止追蹤，只有 GitHub 確認關閉才標成 PR 已關閉。
      if (/^PR #\d+ 已在 GitHub 關閉(?:（定期同步）)?$/.test(audit.detail)) {
        summary.kind = "closed";
        // 關閉的是 GitHub 上的人，系統只是同步到；不寫操作者。
        summary.station = "pr";
      }
      break;
    case "unsend":
      summary.kind = "unsend";
      // 撤回的是群組成員，不寫操作者。
      break;
  }
  return summary;
}

export type TaskWithEndAudit = Task & {
  ending_audit: EndAudit | null;
  ending_phase: string | null;
};

// 依目前狀態找出結案操作。舊任務只有同時撤回的稽核時才採用撤回，後續判讀仍留在時間軸。
export const taskEndColumns =
  "row_to_json(ending) AS ending_audit, previous_run.status AS ending_phase";
export const taskEndJoins = `
  LEFT JOIN LATERAL (
    SELECT kind,detail,created_at FROM audit
    WHERE task_id=t.id AND t.status IN ('${endedStatuses.join("','")}')
      AND kind IN ('reject','cancel','closed','answered','merged','unsend')
      AND (kind=CASE t.status WHEN 'rejected' THEN 'reject' WHEN 'cancelled' THEN 'cancel' ELSE t.status END
        OR (kind='unsend' AND t.status IN ('closed','rejected','cancelled') AND created_at=t.updated_at))
      AND (kind<>'merged' OR detail IN (
        'PR #'||t.pr_number||' 已在 GitHub 合併','PR #'||t.pr_number||' 已在 GitHub 合併（定期同步）'))
    ORDER BY (kind='unsend'),created_at DESC,id DESC LIMIT 1
  ) ending ON true
  LEFT JOIN LATERAL (
    SELECT status FROM runs
    WHERE task_id=t.id AND t.status IN ('rejected','cancelled','closed') AND t.pr_number IS NULL
    ORDER BY started_at DESC,id DESC LIMIT 1
  ) previous_run ON true`;

export function withTaskEnd<T extends TaskWithEndAudit>({
  ending_audit,
  ending_phase,
  ...task
}: T) {
  return {
    ...task,
    end_summary: taskEndSummary(task, ending_audit, ending_phase),
  };
}
