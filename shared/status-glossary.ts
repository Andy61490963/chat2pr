import type { TaskStatus, Project, Group } from "./types.js";

export const memberRoleLabels = {
  admin: "管理者",
  member: "成員",
} as const;

export const memberRoleText = {
  adminPermissions: "管理群組、專案、設定、系統與成員名單",
  owner: "擁有者，固定為管理者",
  saving: "正在變更角色",
} as const;

export const groupPlatformLabels = {
  line: "LINE",
  discord: "Discord",
} as const;
export const groupPageText = {
  subtitle: "設定 LINE 群組與 Discord 頻道可修改的專案與 AI 記憶",
  unnamed: "未命名的 LINE 群組",
  departed: (count: number) => `已離開的群組（${count}）`,
  created: "建立日期",
  lastMessage: "最近一則訊息",
  noSavedMessages: "沒有保留的訊息",
} as const;

const chatReplyLocations = {
  line: "回覆請用 LINE",
  discord: "回覆請到 Discord 頻道",
} as const;

export function chatReplyHint(platform?: Group["platform"]) {
  return platform
    ? chatReplyLocations[platform]
    : "回覆請回到原本的群組或頻道";
}

export function isUnnamedLineGroup(group: Pick<Group, "platform" | "id" | "name">) {
  return (
    group.platform === "line" &&
    (!group.name.trim() || group.name === `群組 ${group.id.slice(-6)}`)
  );
}

export const dataRetentionSecretText =
  "金鑰只會寫入，不會顯示。擁有者可在「連線金鑰」更新。GitHub 與入口設定請在主機的本機設定頁修改。";

export const followupText = {
  label: "後續問題",
  action: "接著問",
  example: "例如剛才提到的報表有哪些欄位？",
  description: "沿用原本的專案與分支提出新問題，原問答會保留。",
  line: "也可以在 LINE 引用機器人的回答追問。",
  discord: "也可以在 Discord 回覆機器人的回答追問。",
} as const;

export const groupDeliveryText = {
  generic: "群組訊息",
  receivedNotice: "需求接收通知",
  mergedNotice: "合併通知",
  closedNotice: "結束通知",
  quota: "LINE 本月推播額度已用完",
  groupSize: "LINE 剩餘推播額度不夠這個群組的人數",
  lineRate: "LINE 暫時限制推播速度",
  lineRejected: "LINE 沒有收下這則訊息",
  lineError: "LINE 回應錯誤",
  lineUnavailable: "LINE 無法處理這則訊息",
  sent: "已送到群組",
  claiming: "正在透過成員的 /進度 指令補送到群組",
  queued: "正在排隊等待送到群組",
  pending: "還沒送到群組",
  undelivered: "沒有送到群組",
  failed: (attempts: number) => `重試 ${attempts} 次後仍沒有送到群組`,
  repliesOff: "群組回覆已關閉",
  expired: "已超過補送期限",
  superseded: "已有較新的回覆",
  retry: "系統會再試",
  replyFailed: "透過 /進度 補送失敗",
  forward: "需要時請在看板查看並轉達",
  tryProgress: "可請群組成員用 /進度 取回，或在看板查看並轉達",
  enableReplies: "如需恢復通知，請確認群組回覆設定",
  lineConnection: "連不上 LINE",
} as const;
export const discordServiceLabels = {
  unconfigured: "尚未設定",
  configError: "設定無法讀取",
  connecting: "連線中",
  connected: "已連線",
  disconnected: "連線中斷",
} as const;
export const discordServiceText = {
  configError:
    "無法讀取 Discord 設定。請擁有者檢查設定檔，或到看板的「連線金鑰」重新填寫機器人權杖。",
  unconfigured:
    "尚未填寫機器人權杖，無法接收 Discord 訊息。請擁有者到「連線金鑰」填寫設定。",
  connecting: "正在建立 Discord 連線，請稍候。",
  connected: "已連線，可以接收 Discord 頻道訊息。",
  disconnected:
    "暫時收不到 Discord 訊息，可能是網路中斷、權杖失效或讀取訊息內容權限未開啟。系統會重試，請確認網路及機器人設定。",
} as const;

export const connectionSecretStatusLabels = {
  configured: "已設定",
  unconfigured: "未設定",
  unknownUpdatedAt: "沒有更新紀錄",
} as const;

export const messageEditLabel = "來源訊息已編輯";

export const unavailableMessageLabels = {
  revoked: "此訊息已撤回",
  expired: (retentionDays: number) => `原文已超過保存期限（${retentionDays} 天）`,
} as const;

export const adminNotificationLabels = {
  destination: "管理者通知送到",
  paired: "已配對",
  unpaired: "尚未配對",
} as const;

export const discordDeliveryNotes = {
  rate: "Discord 暫時限制送訊速度，系統會在解除限制後重試。",
  token: "Discord 未授權送訊。請管理者確認機器人權杖後再試。",
  permission: "Discord 拒絕送訊，機器人可能缺少頻道權限。請管理者檢查權限後再試。",
  missing: "Discord 找不到頻道或原訊息。請管理者確認頻道仍可用，並視需要在看板查看後轉達。",
  content: "Discord 拒收這則訊息。請管理者在看板查看內容並轉達。",
  unavailable: "暫時無法送到 Discord，服務可能異常。請確認連線或在看板查看後轉達。",
  origin: "找不到原訊息，無法加入收到反應。請在看板查看需求。",
} as const;
export const discordGroupReplyLabels = {
  all: "收到需求時會在原訊息加上反應，補問與結果會回到原頻道或討論串",
  results: "補問與結果會回到原頻道或討論串",
} as const;
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
  mergedWeek: "近 7 天已合併",
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
  answer: "等你回答：補充需求",
  chooseProject: "等你決定：選專案",
  review: "等你決定：確認需求",
  approveChange: "等你核准修改",
  chooseOption: "等你決定：選方案",
  chooseTasks: "等你決定：挑選任務",
  amend: "等你補充：修改需求",
  retry: "重試任務",
  viewFailure: "查看詳情",
  fix: (action: string) => `等你處理：${action}`,
} as const;

export const taskClarificationLabels = {
  action: "回答問題",
  amend: "修改這一題",
} as const;

export const taskAcceptanceLabels = {
  heading: "預期驗收條件",
  build: "驗證範圍僅包含建置檢查，未執行自動測試。",
  partial: "只執行了部分自動測試。",
  uncovered: (scope: string) => `未涵蓋的範圍：${scope}`,
  unknownScope: "請查看執行紀錄確認細項。",
} as const;

export const activityStatusLabels = {
  scheduled: "已自動排程",
  investigationStarted: "開始調查",
  investigationRunning: "調查中",
  queryAnswered: "查詢已回覆",
  answered: statusLabels.answered,
  ready: statusLabels.ready,
  failed: statusLabels.failed,
} as const;

export const taskEndLabels = {
  reject: { badge: "已拒絕", event: "拒絕" },
  cancel: { badge: "已取消", event: "取消" },
  closed: { badge: "PR 已關閉", event: "在 GitHub 關閉" },
  unsend: { badge: "來源已撤回", event: "來源訊息被撤回" },
  duplicate: {
    badge: "重複需求",
    event: "辨識為重複需求",
    rejected: "以重複需求拒絕",
    cancelled: "以重複需求取消",
  },
  other: { badge: taskListLabels.ended, event: "結束" },
} as const;

/** 管理者拒絕或結束任務時選的原因；判讀會參考同群組近期的拒絕原因。 */
export const endReasonLabels = {
  not_for_ai: "不是給 AI 的工作（同事會自己處理）",
  not_settled: "需求還沒定案",
  unclear: "需求不清楚",
  no_project: "選不出專案",
  duplicate: "重複",
  other: "其他",
} as const;
export type EndReason = keyof typeof endReasonLabels;
export const endReasons = Object.keys(endReasonLabels) as [
  EndReason,
  ...EndReason[],
];
/** 這兩種原因代表「同類訊息不該建立任務」，判讀時當成負面範例。 */
export const triageLearnedEndReasons = [
  "not_for_ai",
  "not_settled",
] as const satisfies readonly EndReason[];
export const endReasonText = {
  legend: "拒絕原因",
  note: "補充（選填）",
  required: "請選一個拒絕原因",
} as const;

export const taskCompletionEvents = {
  merged: "合併",
  answered: "回覆",
} as const;

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
  // 執行紀錄的結果與鈴鐺共用：逾時但修改已保留、系統自動接續的那次執行（#256）。
  autoResumed: "逾時，已自動接續",
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
  all: "全部",
  attention: "需處理",
  attentionEmpty: "目前沒有需要處理的定期檢查",
} as const;

export const checkAttentionLabels = {
  equipment: "設備異常",
  connection: "連線缺失",
  system: "系統無法執行",
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
  disabled: "已驗證（未啟用）",
  unbound: "未綁定群組",
  ready: "可派工",
} as const;
export const taskProjectLabels = {
  primary: "主要",
} as const;
export const projectSectionLabels = {
  attention: "需要處理",
  ready: projectLabels.ready,
  unbound: "沒有群組使用",
} as const;
export const projectBindingText = {
  next: "環境已就緒，下一步綁定群組",
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

export const connectionStatusLabels = {
  disabled: "未啟用",
  stale: "待確認",
  healthy: "正常",
  needsAttention: "需處理",
  noRecord: "尚無紀錄",
  unchecked: "未檢查",
} as const;

export const inferenceStatusLabels = {
  healthy: "正常",
  failed: "異常",
  unknown: "未確認",
} as const;

export const systemStatusLabels = {
  attention: taskStatusFilterLabels.todo,
  runner: {
    ok: "連線正常",
    docker: "Docker 沒有回應",
    down: "執行器沒有回應",
    unavailable: "無法讀取狀態",
  },
  container: {
    running: "運轉中",
    stopped: "未運轉",
    idle: "平常停止，跑測試時才啟動",
    unhealthy: "健康檢查未通過",
  },
  disk: {
    ok: "空間足夠",
    low: "空間不足",
    critical: "嚴重不足",
    unknown: "讀不到可用空間",
  },
} as const;

export const groupChangeStatsText = {
  heading: "近 30 天的修改需求",
  counts: { created: "建立", approved: "核准", rejected: "拒絕" },
  unit: "筆",
  hint: (commandLabel: string) =>
    `近 30 天建立的修改需求多半被拒絕。如果這些工作多由同事自己處理，可以把上方的需求觸發方式改成「${commandLabel}」，只在有人明確交給機器人時建立任務。`,
} as const;

export const triageNoTaskLabels = {
  coworker_assignment: "訊息屬於同事之間的分工，系統未建立任務。",
  undecided_discussion: "討論尚未定案，系統未建立任務。",
  reusable_memory: "訊息提供了可重複使用的群組規則，系統未建立任務。",
  no_actionable_request: "訊息沒有明確需求，系統未建立任務。",
  similar_rejected: "訊息與管理者近期拒絕的需求相似，系統未建立任務。",
} as const;

export const undecidedDiscussionWaiting =
  "討論尚未定案，系統會等新訊息，或在滿 15 分鐘時再判讀一次。";

export const projectDescriptionPreselection =
  "程式索引超過上限。需求與本群組唯一可用專案的說明相符，已預選該專案。請核對後確認。";

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
