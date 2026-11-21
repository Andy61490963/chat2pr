import type { TaskStatus, Project, Group } from "./types.js";
export const statusLabels: Record<TaskStatus, string> = {
  awaiting_approval: "待審核",
  queued: "待執行",
  running: "開發中",
  reviewing: "驗證中",
  ready: "待合併",
  failed: "需要處理",
  rejected: "已結束",
  cancelled: "已結束",
  budget_wait: "等待額度",
  merged: "已合併",
  answered: "已回覆",
  closed: "已關閉",
};

/** 專案優先顯示驗證進度與需要處理的狀態。 */
export const projectLabels = {
  missing: "找不到儲存庫",
  question: "等你回答",
  validating: "驗證中",
  failed: "驗證失敗",
  unverified: "需要驗證",
  disabled: "已驗證・未啟用",
  unbound: "未綁定群組",
  ready: "可派工",
} as const;
export const groupLabels = {
  left: "機器人已離開",
  disabled: "已停用",
  stopped: "辨識失敗，已停止",
  error: "辨識失敗",
  ready: "接收需求中",
  unbound: "沒有可用專案",
} as const;

export function projectStatus(
  p: Pick<
    Project,
    | "repo_missing_at"
    | "setup_input"
    | "validation_progress"
    | "validated_at"
    | "enabled"
  >,
  bound: boolean,
  validationFailed: boolean,
): keyof typeof projectLabels {
  if (p.validation_progress) return "validating";
  if (p.repo_missing_at) return "missing";
  if (p.setup_input) return "question";
  if (validationFailed) return "failed";
  if (!p.validated_at) return "unverified";
  if (!p.enabled) return "disabled";
  return bound ? "ready" : "unbound";
}
export function groupStatus(
  g: Pick<Group, "left_at" | "enabled" | "triage_failures" | "triage_error">,
  usable: boolean,
): keyof typeof groupLabels {
  if (g.left_at) return "left";
  if (!g.enabled) return "disabled";
  if (g.triage_failures >= 3) return "stopped";
  if (g.triage_error) return "error";
  return usable ? "ready" : "unbound";
}
