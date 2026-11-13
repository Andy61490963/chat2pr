/** 主機資源：執行器回報的 CPU、記憶體（Docker 可用的部分讀得到就一併回報）。 */
export interface HostResources {
  cpus: number;
  memTotalMb: number;
  memFreeMb: number;
  dockerCpus?: number;
  dockerMemMb?: number;
}
export interface CapacityRun {
  id: string;
  title: string;
  mode: "change" | "query";
  project: string | null;
  phase: string;
  started_at: string;
}
export interface CapacityQueued {
  id: string;
  title: string;
  mode: "change" | "query";
  project: string | null;
  created_at: string;
  /** 為什麼還沒開始：等待空位、同專案的修改進行中、等上一題完成或即將開始。 */
  reason: string;
}
/** 看板「系統」頁的同時執行狀態（`GET /api/capacity`）。 */
export interface Capacity {
  maxRuns: number;
  cap: number;
  defaultRuns: number;
  memoryFloorMb: number;
  suggested: number | null;
  host: HostResources | null;
  /** 主機資源不足而暫停派新工作的原因；沒有暫停時為 null。 */
  hold: string | null;
  running: CapacityRun[];
  queued: CapacityQueued[];
}
