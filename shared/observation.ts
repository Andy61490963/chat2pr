import type { InstallReport } from "./install-plan.js";
export interface RunEvent {
  seq: number;
  at: string;
  phase: string;
  kind: string;
  detail?: string | null;
  threadId?: string;
  containerId?: string;
  exitCode?: number;
}
export interface RunView {
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
  phase_end: "階段結束",
  truncated: "部分紀錄已截斷",
  observer_error: "進度連線中斷",
  observer_restored: "進度連線恢復",
};
