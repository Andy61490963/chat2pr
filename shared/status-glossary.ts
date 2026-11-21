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
export const taskStationLabels = {
  request: "整理需求",
  approval: "審核",
  queue: "排程",
  change: "開發",
  query: "調查",
  verify: "驗證",
  report: "整理報告",
  pr: "PR",
  reply: "回覆",
} as const;

export const taskListLabels = {
  active: "進行中與待處理",
  ended: "已結束",
} as const;

export const taskListEmptyLabels = {
  active: "目前沒有進行中或待處理的任務",
  closed: "目前沒有已結束的任務",
  all: "還沒有任務",
  filtered: "沒有符合條件的任務",
} as const;

export const inboxStatusLabels = {
  clear: "都處理完了",
  clearDescription: "目前沒有需要你處理、執行中或待合併的工作。",
} as const;

export const taskEndLabels = {
  reject: { badge: "已拒絕", event: "拒絕" },
  cancel: { badge: "已取消", event: "取消" },
  closed: { badge: "PR 已關閉", event: "在 GitHub 關閉" },
  unsend: { badge: "來源已撤回", event: "來源訊息被撤回" },
  duplicate: { badge: "重複需求", event: "辨識為重複需求" },
  other: { badge: taskListLabels.ended, event: "結束" },
} as const;

export const taskEndSystemActor = "系統";
export const taskCompletionEvents = { merged: "合併", answered: "回覆" } as const;

export const taskStatusFilterLabels = {
  todo: "待處理",
  waiting: statusLabels.budget_wait,
  moving: "進行中",
  ready: statusLabels.ready,
} as const;

export const pickListLabels = {
  pending: "待挑選清單",
  closed: "已結束",
} as const;

export const taskStationStatusLabels = {
  decision: "等你決定",
  blockedAtVerification: "卡在驗證",
  unknownStation: "無法判定站別",
  runningQuery: "調查中",
  ready: "已開 PR",
} as const;

export const projectQuotaWaitPrefix = `${statusLabels.budget_wait}｜`;

export const notificationLabels = {
  action: "需要你處理",
  privatePushPaused: "私訊暫停",
  serviceDown: "服務異常",
  serviceUp: "服務已恢復",
} as const;

export const networkStatusLabels = {
  open: "所有專案已開放網路",
} as const;

export const workerImageLabels = {
  current: (rev: string | null) => `版本 ${rev ?? "未回報"}`,
  outdated: "過舊，請重新驗證使用它的專案",
  unused: "沒有專案使用，可清理",
} as const;

export function workerImageStatus(
  current: boolean,
  usedByProject: boolean,
): keyof typeof workerImageLabels {
  if (current) return "current";
  return usedByProject ? "outdated" : "unused";
}

export const linePushServiceLabels = {
  quota: "本月額度用完，見下一列",
} as const;

export const checkListLabels = {
  empty: "還沒有定期檢查",
} as const;

export const chatRoutingLabels = {
  linked: "已連結任務",
  pending: "等待辨識",
  noRequest: "沒有需求",
} as const;

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
export const projectVerificationLabels = {
  passed: "通過",
  partial: "部分通過",
  failed: "失敗",
  validating: projectLabels.validating,
  unverified: projectLabels.unverified,
} as const;
export const groupLabels = {
  left: "機器人已離開",
  disabled: "已停用",
  stopped: "辨識失敗，已停止",
  error: "辨識失敗",
  ready: "接收需求中",
  unbound: "沒有可用專案",
} as const;

export const triageNoTaskLabels = {
  coworker_assignment: "訊息屬於同事之間的分工，系統未建立任務。",
  undecided_discussion: "討論尚未定案，系統未建立任務。",
  reusable_memory: "訊息提供了可重複使用的群組規則，系統未建立任務。",
  no_actionable_request: "訊息沒有明確需求，系統未建立任務。",
} as const;

export const sshProbeLabels = {
  reachable: "你可以從伺服器連到這個連接埠。",
  unreachable: "你無法從伺服器連到這個連接埠。",
  unmeasured: "你目前沒有這台主機的 TCP 實測結果。",
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
