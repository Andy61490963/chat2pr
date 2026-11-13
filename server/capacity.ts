import type { Database } from "./db.js";
import type { Settings } from "../shared/types.js";
import { recordHealth } from "./health.js";
import type { HostResources } from "../shared/capacity.js";
export type { HostResources };

/**
 * 同時執行多個任務（#21）：全系統計數＋每專案修改鎖。
 *
 * - 全系統同時執行數由系統頁設定（`settings.max_runs`，預設 2）；
 * - 同一專案的修改一次一個，查詢唯讀可並行；
 * - 搶位置在 `CLAIM_LOCK` 交易鎖內完成，搶不到一律視為稍後再派，不記錯誤。
 */
export const DEFAULT_MAX_RUNS = 2;
/** 設定的上限；`execute` 佇列的本機工作數也用這個值，實際同時數由資料庫計數控制。 */
export const MAX_RUNS_CAP = 8;
/** 每個執行持有的工作階段鎖：`pg_try_advisory_lock(RUN_LOCK, hashtext(task_id))`。 */
export const RUN_LOCK = 73462;
/** 搶執行位置時的交易鎖，讓計數、專案修改鎖與每日執行次數一起判斷。 */
export const CLAIM_LOCK = 73468;
/** 回收中斷執行時的工作階段鎖，避免多個排程器同時回收。 */
export const RECOVER_LOCK = 73469;
/** 主機可用記憶體低於這個值（一個工作容器的記憶體上限）就暫停派新工作。 */
export const MEMORY_FLOOR_MB = 2048;
export const hostHealthName = "host_resources";

export const maxRuns = (s: Pick<Settings, "max_runs">) => {
  const n = Number(s.max_runs ?? DEFAULT_MAX_RUNS);
  return Number.isInteger(n) && n >= 1
    ? Math.min(n, MAX_RUNS_CAP)
    : DEFAULT_MAX_RUNS;
};

type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[] } | unknown[]>;
};
const rowsOf = <T>(r: { rows: unknown[] } | unknown[]) =>
  (Array.isArray(r) ? r : r.rows) as T[];

export type Busy = "full" | "project";
/**
 * 這個任務現在能不能拿到執行位置。
 * 同專案修改以任務的專案與類型判斷（不只看 `runs.change_project_id`），
 * 舊版留下的未完成紀錄也算在內。
 */
export async function busyFor(
  c: Queryable,
  task: { id: string; project_id: string | null; mode: string },
  limit: number,
): Promise<Busy | null> {
  const [r] = rowsOf<{ active: number; same: number }>(
    await c.query(
      `SELECT count(*)::int AS active,
        count(*) FILTER (WHERE r.change_project_id=$1 OR (t.project_id=$1 AND t.mode<>'query'))::int AS same
       FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.completed_at IS NULL AND r.task_id<>$2`,
      [task.project_id, task.id],
    ),
  );
  if (r.active >= limit) return "full";
  if (task.mode !== "query" && r.same > 0) return "project";
  return null;
}

export function parseResources(raw: unknown): HostResources | null {
  const r = raw as Partial<HostResources> | null;
  if (
    !r ||
    typeof r.cpus !== "number" ||
    typeof r.memTotalMb !== "number" ||
    typeof r.memFreeMb !== "number"
  )
    return null;
  return r as HostResources;
}
/**
 * 依主機建議的同時執行數：每個執行最多佔 2 顆 CPU、2 GB 記憶體，
 * 另保留約 4 GB 給資料庫、向量模型與看板。
 */
export function suggestedMaxRuns(r: HostResources) {
  const cpus = r.dockerCpus || r.cpus;
  const mem = r.dockerMemMb || r.memTotalMb;
  const byCpu = Math.floor(cpus / 2);
  const byMem = Math.floor((mem - 4096) / 2560);
  return Math.max(1, Math.min(MAX_RUNS_CAP, byCpu, byMem));
}
export function memoryHold(r: HostResources): string | null {
  return r.memFreeMb < MEMORY_FLOOR_MB
    ? `主機可用記憶體只剩 ${(r.memFreeMb / 1024).toFixed(1)} GB（低於 ${MEMORY_FLOOR_MB / 1024} GB），暫停派新工作；執行中的工作不受影響`
    : null;
}

/**
 * 排程器每輪讀一次主機資源並寫進系統狀態；記憶體不足時回傳暫停原因。
 * 讀不到資源（執行器暫時無回應）不擋派工，仍有每個容器的記憶體與程序數上限。
 */
export async function checkHostResources(
  db: Database,
  read: () => Promise<unknown>,
): Promise<string | null> {
  let resources: HostResources | null = null;
  try {
    resources = parseResources(await read());
  } catch {
    resources = null;
  }
  if (!resources) {
    await recordHealth(
      db,
      hostHealthName,
      true,
      "暫時讀不到主機資源；沿用每個工作容器的資源上限",
    );
    return null;
  }
  const hold = memoryHold(resources);
  await recordHealth(
    db,
    hostHealthName,
    !hold,
    hold ??
      `可用記憶體 ${(resources.memFreeMb / 1024).toFixed(1)} GB／共 ${(resources.memTotalMb / 1024).toFixed(1)} GB`,
    { confirm: true },
  );
  return hold;
}

/** 派工前確認最近一次主機資源檢查沒有要求暫停；兩分鐘前的結果視為過期。 */
export async function hostHold(c: Queryable): Promise<string | null> {
  const [r] = rowsOf<{ detail: string }>(
    await c.query(
      `SELECT detail FROM service_health WHERE name=$1 AND NOT ok AND checked_at>now()-interval '2 minutes'`,
      [hostHealthName],
    ),
  );
  return r?.detail ?? null;
}

/**
 * 排隊中的任務排在第幾位、預估多久開始：
 * 以最近 20 次執行耗時的中位數，乘上前面還有幾輪（排在前面的件數＋1，除以同時執行數）。
 */
export async function queueEstimate(
  c: Queryable,
  taskId: string,
  limit: number,
) {
  const [r] = rowsOf<{
    position: number;
    running: number;
    seconds: number | null;
  }>(
    await c.query(
      `SELECT (SELECT count(*)::int FROM tasks q WHERE q.status='queued' AND q.created_at<=(SELECT created_at FROM tasks WHERE id=$1)) AS position,
        (SELECT count(*)::int FROM runs WHERE completed_at IS NULL) AS running,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-started_at))
          FROM (SELECT completed_at,started_at FROM runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 20) d) AS seconds`,
      [taskId],
    ),
  );
  const position = Math.max(1, r.position);
  const minutes = r.seconds
    ? Math.max(
        1,
        Math.ceil((Number(r.seconds) * Math.ceil(position / limit)) / 60),
      )
    : null;
  return { position, running: r.running, minutes };
}
