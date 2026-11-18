/**
 * 主機資源：執行器回報的 CPU、記憶體（Docker 可用的部分讀得到就一併回報）。
 * `cpus`、`memTotalMb`、`memFreeMb` 是執行器所在的 Windows 主機；
 * `dockerCpus`、`dockerMemMb` 是 Docker（WSL）VM 的總量，只用於建議同時執行數。
 * `vmTotalMb`、`vmAvailMb` 是 app 容器讀自己的 `/proc/meminfo` 得到的 Docker VM 總量與可用量，
 * 只顯示供比對；暫停派工仍看 Windows 的 `memFreeMb`（改判斷前要先在正式主機比對兩組數字）。
 */
export interface HostResources {
  cpus: number;
  memTotalMb: number;
  memFreeMb: number;
  dockerCpus?: number;
  dockerMemMb?: number;
  vmTotalMb?: number;
  vmAvailMb?: number;
}
export interface CapacityRun {
  id: string;
  title: string;
  mode: "change" | "query";
  project: string | null;
  phase: string;
  started_at: string;
}
/**
 * 排隊中的任務為什麼還沒開始，依判斷順序：
 * 系統暫停、Docker 磁碟不足、主機記憶體不足、專案停用或驗證未通過、群組停用或未綁定、
 * 上一題未完成、暫時性錯誤退避中、同專案修改進行中、等待空位、即將開始。
 */
export type QueueCode =
  | "paused"
  | "disk"
  | "memory"
  | "project"
  | "group"
  | "parent"
  | "retry"
  | "changing"
  | "waiting"
  | "next";
export interface QueueReason {
  code: QueueCode;
  /** 給人看的原因，例如「專案已停用」。 */
  text: string;
  /** 建議怎麼處理；會自動繼續、不用處理時為 null。 */
  hint: string | null;
}
/** 任務詳情（`GET /api/tasks/:id`）在排隊中時附帶的排隊資訊。 */
export interface TaskQueue extends QueueReason {
  /** 排在第幾位（所有排隊中的任務依提出時間）。 */
  position: number;
  /** 暫時性錯誤的自動重試時間；沒有退避時為 null。 */
  retry_at: string | null;
}
export interface CapacityQueued {
  id: string;
  title: string;
  mode: "change" | "query";
  project: string | null;
  created_at: string;
  /** 為什麼還沒開始（與 `text` 相同，保留給既有畫面）。 */
  reason: string;
  code: QueueCode;
  hint: string | null;
}
/** 暫停派工的來源：主機記憶體不足或 Docker 磁碟嚴重不足。 */
export type HoldKind = "memory" | "disk";
/** 看板「系統」頁的同時執行狀態（`GET /api/capacity`）。 */
export interface Capacity {
  maxRuns: number;
  cap: number;
  defaultRuns: number;
  /** 低於這個值暫停派新工作（量的是執行器所在的 Windows 主機）。 */
  memoryFloorMb: number;
  /** 暫停後要回升到這個值以上才恢復派工。 */
  memoryResumeMb: number;
  suggested: number | null;
  host: HostResources | null;
  /** 主機資源不足而暫停派新工作的原因；沒有暫停時為 null。 */
  hold: string | null;
  holdKind: HoldKind | null;
  running: CapacityRun[];
  queued: CapacityQueued[];
}
