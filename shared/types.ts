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
export interface Task {
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
  /** 開發階段可經套件白名單出口下載 npm／PyPI／NuGet；預設開啟。 */
  code_downloads: boolean;
  /** 總開關：關閉時所有群組都不回覆，只私訊管理者；各群組另有自己的回覆範圍。預設開啟。 */
  group_replies?: boolean;
  /** isolated：只開放套件白名單；open：開發、測試、審查容器可直接連網際網路與公司內網。 */
  container_network: "isolated" | "open";
  ai_mode: AiMode;
  daily_runs: number;
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
