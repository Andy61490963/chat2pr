export type TaskStatus =
  | "awaiting_approval"
  | "queued"
  | "running"
  | "reviewing"
  | "ready"
  | "failed"
  | "rejected"
  | "cancelled"
  | "budget_wait"
  | "merged"
  | "answered"
  | "closed";
/**
 * 看板依狀態分的幾組任務：需要你處理、等待額度（會自動繼續）、進行中、待合併。
 * `/api/state` 依 `unfinishedStatuses` 完整載入這些任務（不受「最近 N 筆」限制），
 * 改這裡等於同時改伺服器的載入範圍（docs/conventions.md 第 3 節）。
 */
export const taskGroups = {
  attention: ["awaiting_approval", "failed"],
  waiting: ["budget_wait"],
  moving: ["queued", "running", "reviewing"],
  ready: ["ready"],
} satisfies Record<string, TaskStatus[]>;
export const unfinishedStatuses: TaskStatus[] = Object.values(
  taskGroups,
).flat() as TaskStatus[];
/** `/api/state` 一次最多完整載入的未結束任務數；超過的筆數記在 `StateTotals.unfinishedOmitted`。 */
export const UNFINISHED_LIMIT = 1000;
/** `/api/state` 的 totals：資料庫裡的實際數量，不受看板載入範圍影響。 */
export interface StateTotals {
  tasks: number;
  activity: number;
  /** 各狀態的任務數。 */
  byStatus: Partial<Record<TaskStatus, number>>;
  /** 近 7 天（臺北時間，含今天）合併的任務數。 */
  mergedWeek: number;
  /** 未結束的任務超過 UNFINISHED_LIMIT 時沒有載入的筆數；平常是 0。 */
  unfinishedOmitted: number;
}
/** 依 byStatus 加總一組狀態的任務數。 */
export const countStatuses = (
  byStatus: Partial<Record<TaskStatus, number>> | undefined,
  statuses: readonly TaskStatus[],
) => statuses.reduce((n, s) => n + (byStatus?.[s] ?? 0), 0);
export type Action =
  | "approve"
  | "reject"
  | "cancel"
  | "retry"
  | "amend"
  | "assumption"
  | "assign"
  | "adopt"
  | "mode"
  | "target"
  | "reopen";
/** change：修改程式並開 PR；query：只調查並回覆，不修改程式。 */
export type TaskMode = "change" | "query";
// 儲存庫找不到時記下的原狀；接回後照這份復原。
export interface RepoMissingState {
  enabled: boolean;
  validated_at: string | null;
  config_version: number;
  // 當時綁定這個專案的群組。
  groups: string[];
  // 因此交回人工、暫時沒有專案的任務。
  tasks: string[];
  // 確定刪除時一併結束的待合併任務。
  closed?: string[];
}
export interface Project {
  project_context?: import("./project-context.js").ProjectContext;
  context_updated_at?: string | null;
  context_updated_by?: string | null;
  setup_input?: import("./project-context.js").ProjectInputRequest | null;
  setup_mode?: "auto" | "manual";
  /** AI 自動設定時是否提供測試用 SQL Server：auto 依專案判斷，always／never 是管理者覆寫。 */
  sql_server?: "auto" | "always" | "never";
  /** 完全存取：工作容器每個階段都可連所有網路，並取得專案登記的資料庫連線（管理者逐專案開啟）。 */
  full_access?: boolean;
  setup_plan?: import("./project-setup.js").SetupPlan | null;
  setup_status?: string | null;
  index_phase?: "queued" | "indexing" | "ready" | "failed" | "limited" | null;
  index_chunks?: number;
  index_error?: string | null;
  config_version: number;
  id: string;
  name: string;
  repo: string;
  description: string;
  base_branch: string;
  image: string;
  install_command: string;
  test_command: string;
  sensitive_paths: string[];
  index_paths?: string[];
  /** 收集差異時對預設建置產物排除清單的增減，見 shared/build-output.ts。 */
  collect_excludes?: string[];
  enabled: boolean;
  validated_at: string | null;
  validation_error: string | null;
  // GitHub 給儲存庫的固定編號；改名或轉移後路徑會變，編號不變。
  repo_id?: string | number | null;
  // GitHub App 在任何安裝都看不到這個儲存庫的時間（刪除、搬到沒安裝 App 的地方，或被移出存取範圍）。
  repo_missing_at?: string | null;
  repo_missing_state?: RepoMissingState | null;
  created_at: string;
}
export interface Group {
  binding_version?: number;
  trigger_mode: "auto" | "command";
  /** 是否在群組回覆：off 不回覆、results 只回覆結果、all 另外通知已收到。 */
  reply_mode?: "off" | "results" | "all";
  trigger_version: number;
  triage_failures: number;
  triage_error: string | null;
  /** 機器人離開群組的時間；重新加入後清除。離開期間不能啟用。 */
  left_at?: string | null;
  /** 更換綁定時需重新確認的任務總數，不受看板清單載入範圍影響。 */
  affected_tasks?: number;
  id: string;
  name: string;
  project_ids: string[];
  enabled: boolean;
  first_pending_at: string | null;
  last_pending_at: string | null;
}
/** 從 LINE 提出定期檢查時要求的排程（二擇一）。 */
export interface CheckSchedule {
  intervalMinutes: number | null;
  dailyAt: string | null;
}
export interface Task {
  /** 草擬定期檢查的查詢任務：記下要求的排程。 */
  check_draft?: CheckSchedule | null;
  question?: import("./clarification.js").ClarificationQuestion | null;
  assumptions?: string[];
  target_branch: string | null;
  branch_selection?: import("./task-branch.js").TaskBranchSelection;
  project_routing?: import("./project-routing.js").ProjectRouting;
  pending_paths: string[];
  approved_paths: string[];
  id: string;
  project_id: string | null;
  group_id: string;
  title: string;
  summary: string;
  acceptance: string[];
  risk_reasons: string[];
  missing: string[];
  suggestions: Suggestion[];
  source_ids: string[];
  status: TaskStatus;
  version: number;
  approved_version: number | null;
  base_sha: string | null;
  branch: string | null;
  issue_number: number | null;
  issue_url: string | null;
  pr_number: number | null;
  pr_url: string | null;
  parent_id: string | null;
  last_error: string | null;
  mode: TaskMode;
  /** 查詢任務的調查結果。 */
  answer: string | null;
  created_at: string;
  updated_at: string;
  /** 只有 /api/state 帶：進行中執行的階段（runs.status）；沒有未完成的執行時為 null。 */
  run_phase?: string | null;
  run_started_at?: string | null;
  run_deadline?: string | null;
  run_heartbeat_at?: string | null;
}
export type AiMode = "subscription" | "api";
export const efforts = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type Effort = (typeof efforts)[number];
export interface Settings {
  rag_enabled: boolean;
  paused: boolean;
  triage_paused: boolean;
  /** AI 可從對話自行歸納群組記憶；預設開啟。 */
  auto_memory: boolean;
  /** 開發階段可經下載來源白名單出口下載套件；預設開啟。 */
  code_downloads: boolean;
  /** 總開關：關閉時所有群組都不回覆，只私訊管理者；各群組另有自己的回覆範圍。預設開啟。 */
  group_replies?: boolean;
  /** isolated：只開放套件白名單；open：開發、測試、審查容器可直接連網際網路與公司內網。 */
  container_network: "isolated" | "open";
  /** 安裝階段與開發下載套件可連的網域（系統頁維護）；沒有設定時用預設白名單。 */
  egress_domains?: string[];
  ai_mode: AiMode;
  daily_runs: number;
  /** 全系統同時執行的任務數（系統頁設定，預設 2）；同一專案的修改仍一次一個。 */
  max_runs?: number;
  /** 定期檢查環境閒置多久清除（分鐘，系統頁設定，預設 120）。 */
  check_env_idle_minutes?: number;
  /** 同時保留的定期檢查環境數上限（系統頁設定，預設 20）。 */
  check_env_max?: number;
  codex_model: string | null;
  triage_effort: Effort;
  coding_effort: Effort;
  daily_budget: number;
  task_budget: number;
  task_minutes: number;
  triage_model: string;
  coding_model: string;
  retention_days: number;
  admin_line_id: string | null;
}
export interface Message {
  contextOrigin?: "direct" | "rag";
  trigger_mode?: "auto" | "command" | "chat";
  contextOnly?: boolean;
  id: string;
  group_id: string;
  user_id: string | null;
  type: string;
  text: string | null;
  image: Buffer | null;
  image_mime: string | null;
  quoted_id: string | null;
  received_at: string;
  revoked: boolean;
  processed: boolean;
}
export interface Memory {
  id: string;
  group_id: string;
  project_id: string | null;
  content: string;
  source: "chat" | "admin" | "ai";
  source_message_id: string | null;
  created_at: string;
}
export interface TriageDecision {
  /** 使用者要求定期、重複檢查時的排程；其他情況為 null。 */
  schedule?: CheckSchedule | null;
  question?: import("./clarification.js").ClarificationQuestion | null;
  assumptions?: string[];
  targetBranch?: import("./task-branch.js").BranchDecision;
  routing?: import("./project-routing.js").RoutingDecision;
  /** request／clarification 的任務類型；未提供時視為修改程式。 */
  taskType?: TaskMode;
  contextSourceIds?: string[];
  imageSourceIds?: string[];
  imageReferenceResolution?: "none" | "unique" | "ambiguous";
  kind:
    | "ignore"
    | "request"
    | "clarification"
    | "duplicate"
    | "memory"
    | "knowledge"
    | "defer";
  projectId: string | null;
  title: string;
  summary: string;
  acceptance: string[];
  sourceIds: string[];
  risks: string[];
  missing: string[];
  relatedTaskId: string | null;
  suggestions: Suggestion[];
}
// 需求不明確時 AI 提出的具體方案，管理者可一鍵採用。
export interface Suggestion {
  recommended?: boolean;
  reason?: string;
  label: string;
  summary: string;
  acceptance: string[];
}
export const statusLabels: Record<TaskStatus, string> = {
  awaiting_approval: "待審核",
  queued: "待執行",
  running: "開發中",
  reviewing: "驗證中",
  ready: "待合併",
  failed: "需要處理",
  rejected: "已拒絕",
  cancelled: "已取消",
  budget_wait: "等待額度",
  merged: "已合併",
  answered: "已回覆",
  closed: "已關閉",
};
/**
 * /api/state 的 notificationFailures：重試 3 次仍送不出去、還沒過期的私訊與群組通知，
 * 以及重送時會標成「已過期，未補送」略過的通知數。
 */
export interface NotificationFailures {
  direct: number;
  group: number;
  stale: number;
}
/** POST /api/notifications/retry 的結果：重新排入的私訊、群組通知與略過的過期通知數。 */
export interface NotificationRetryResult {
  direct: number;
  group: number;
  expired: number;
}
export interface Knowledge {
  id: string;
  project_id: string;
  group_id: string | null;
  content: string;
  source: "chat" | "admin";
  status: "pending" | "in_pr" | "merged" | "closed";
  pr_url: string | null;
  created_at: string;
}
