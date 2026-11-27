import type { InstallReport } from "./install-plan.js";
import type { UpstreamFailure } from "./upstream-failure.js";
export type RunVerificationScope = {
  kind: "build" | "partial";
  limitations?: string;
};

export interface RunEvent {
  seq: number;
  at: string;
  phase: string;
  kind: string;
  detail?: string | null;
  threadId?: string;
  containerId?: string;
  exitCode?: number | null;
  rejectedCount?: number | null;
}
export interface RunView {
  /** 這次執行的訂閱代理診斷；舊紀錄可能沒有這個欄位。 */
  upstream_failure?: UpstreamFailure | null;
  pr_summary?: string | null;
  /** 本次執行實際使用的有限驗證範圍。 */
  verification_scope?: RunVerificationScope | null;
  query_sources?:
    | { name: string; repo: string; branch: string; commit: string | null }[]
    | null;
  id: string;
  version: number;
  status: string;
  outcome: string | null;
  model: string;
  started_at: string;
  completed_at: string | null;
  heartbeat_at: string;
  deadline: string;
  observed: boolean;
  threads: { phase: string; threadId: string }[];
  /** 進入各階段的時間，用來算各階段花費時間（#256）；舊紀錄沒有時為空陣列。 */
  phases?: PhaseMark[];
  /** 這次執行使用的系統套件與專案衍生映像（#18）；沒有安裝計畫時為 null。 */
  install_report?: InstallReport | null;
}
export const phaseLabels: Record<string, string> = {
  starting: "準備環境",
  issue: "同步 Issue",
  archive: "下載與準備專案",
  install: "安裝依賴",
  context: "檢索專案經驗",
  code: "Codex 修改程式",
  collect: "收集差異",
  test: "執行測試",
  review: "獨立審查",
  publish: "建立 PR",
  interrupted: "服務中斷",
  verify: "評估驗證結果",
};
export const eventLabels: Record<string, string> = {
  phase: "開始階段",
  container: "容器啟動",
  thread: "Codex 對話已建立",
  command_start: "開始執行命令",
  command_end: "命令執行結果",
  files: "檔案修改",
  message: "Codex 回覆",
  usage: "Token 用量",
  error: "錯誤",
  notice: "提示",
  reconnect_rejected: "重連被拒（HTTP 403）",
  phase_end: "階段結束",
  truncated: "部分紀錄已截斷",
  observer_error: "進度連線中斷",
  observer_restored: "進度連線恢復",
  worker_event_rejected: "容器事件已丟棄",
  upstream_retry: "訂閱上游重試",
};

const modelMetadataFallback =
  /^Model metadata for `[A-Za-z0-9._:/-]+` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.$/;

export function runEventKind({
  kind,
  phase,
  detail,
}: Pick<RunEvent, "kind" | "phase" | "detail">) {
  if (kind !== "error" || !detail) return kind;
  if (modelMetadataFallback.test(detail)) return "notice";
  if (
    (phase === "code" || phase === "review") &&
    /^Reconnecting\.\.\. \d+\/\d+ \(unexpected status 403\b/i.test(detail)
  )
    return "reconnect_rejected";
  return kind;
}

/** 自動修復那次「Codex 修改程式」的階段說明；舊紀錄沒有時，以之前出現過「評估驗證結果」判斷。 */
export const repairPhaseDetail = "自動修復";
/** 執行紀錄的「各階段花費時間」分組；收集差異與評估驗證結果算進前一個階段（#256）。 */
export const phaseGroups = [
  "prepare",
  "test",
  "code",
  "review",
  "repair",
  "publish",
] as const;
export type PhaseGroup = (typeof phaseGroups)[number];
export const phaseGroupLabels: Record<PhaseGroup, string> = {
  prepare: "準備",
  test: "測試",
  code: "修改",
  review: "審查",
  repair: "修復",
  publish: "建立 PR",
};
/** 執行器每次進入新階段時寫下的事件（run_events 的 source='app'、kind='phase'）。 */
export interface PhaseMark {
  phase: string;
  at: string;
  detail?: string | null;
}
export interface PhaseSpan {
  group: PhaseGroup;
  label: string;
  ms: number;
}
const ownGroup: Record<string, PhaseGroup> = {
  test: "test",
  review: "review",
  publish: "publish",
};
/** 每個階段從進入到下一個階段（最後一個到 end）為止的時間，依分組加總。 */
export function phaseDurations(marks: PhaseMark[], end: string): PhaseSpan[] {
  const sorted = [...marks].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const totals = new Map<PhaseGroup, number>();
  let group: PhaseGroup = "prepare",
    verified = false;
  sorted.forEach((mark, i) => {
    if (mark.phase === "verify") verified = true;
    if (mark.phase === "code")
      group = mark.detail === repairPhaseDetail || verified ? "repair" : "code";
    else if (ownGroup[mark.phase]) group = ownGroup[mark.phase];
    else if (mark.phase !== "collect" && mark.phase !== "verify")
      group = "prepare";
    const until = Date.parse(sorted[i + 1]?.at ?? end);
    totals.set(
      group,
      (totals.get(group) ?? 0) + Math.max(0, until - Date.parse(mark.at)),
    );
  });
  return phaseGroups
    .filter((g) => totals.has(g))
    .map((g) => ({ group: g, label: phaseGroupLabels[g], ms: totals.get(g)! }));
}
export const longestPhase = (spans: PhaseSpan[]) =>
  spans.reduce<PhaseSpan | undefined>(
    (top, span) => (!top || span.ms > top.ms ? span : top),
    undefined,
  );
/** 「10.6 分鐘」；不到一分鐘時不寫 0.x。 */
export const phaseMinutes = (ms: number) =>
  ms < 60000 ? "不到 1 分鐘" : `${Number((ms / 60000).toFixed(1))} 分鐘`;
