export interface RoutingEvidence {
  kind: "message" | "repo" | "description";
  sourceId: string;
  quote: string;
}

export interface RoutingDecision {
  status: "clear" | "uncertain" | "conflict";
  basis: "explicit" | "repository" | "project_description" | "none";
  reason: string;
  evidence: RoutingEvidence[];
}
export const maxRelatedProjects = 5;

export interface ProjectRouting extends Omit<RoutingDecision, "basis"> {
  /** followup：接續上一題（追問或追加），沿用它已確認的專案。只由系統設定，AI 不能宣稱。 */
  basis: RoutingDecision["basis"] | "followup";
  bindingVersion: number;
  /** 接續的上一題。 */
  followupOf?: { id: string; title: string };
  /** 查詢指名或手動選擇的已綁定專案，執行時唯讀提供原始碼。 */
  relatedProjects?: { id: string; name: string; repo: string }[];
  unboundSuggestions?: UnboundProjectSuggestion[];
}
export interface UnboundProjectSuggestion {
  projectId: string;
  configVersion: number;
  reason: string;
  sourceIds: string[];
}
export interface ProjectConfirmation {
  target_branch: string;
  task_id: string;
  version: number;
  project_id: string;
  config_version: number;
  binding_version: number;
  mode: "query" | "change";
  kind: "manual" | "evidence";
  actor: string;
  confirmed_at: string;
}
export interface RoutingSource {
  id: string;
  projectId: string;
  path: string;
  sha: string;
  text: string;
}
