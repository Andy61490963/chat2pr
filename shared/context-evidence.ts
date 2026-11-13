export type ContextMechanism =
  "recent" | "direct" | "database" | "vector" | "outcome";
export type ContextSource =
  | "message"
  | "image"
  | "task"
  | "memory"
  | "knowledge"
  | "project_context"
  | "repo"
  | "outcome";
export type ContextEvidenceInput = {
  mechanism: ContextMechanism;
  source_kind: ContextSource;
  source_id: string;
  project_id?: string | null;
  source_time?: string | Date | null;
  score?: number | null;
  path?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  index_sha?: string | null;
  source_hash?: string | null;
};
export type ContextEvidence = ContextEvidenceInput & {
  id: string;
  version: number;
  phase: string;
  observed_at: string;
  valid: boolean;
};
export const contextMechanismLabels: Record<ContextMechanism, string> = {
  recent: "近期對話",
  direct: "直接引用",
  database: "資料庫記憶",
  vector: "向量檢索",
  outcome: "過往任務結果",
};
export const contextSourceLabels: Record<ContextSource, string> = {
  message: "訊息",
  image: "圖片摘要",
  task: "任務",
  memory: "群組記憶",
  knowledge: "專案規範",
  project_context: "專案資訊與環境",
  repo: "專案檔案",
  outcome: "任務結果",
};
