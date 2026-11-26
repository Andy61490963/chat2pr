import { readFile } from "node:fs/promises";
import type { Database } from "./db.js";
import type { Settings } from "../shared/types.js";
import { recordHealth } from "./health.js";
import { diskPaused } from "./docker-disk.js";
import type {
  CapacityRun,
  HoldKind,
  HostResources,
  QueueReason,
  TaskQueue,
} from "../shared/capacity.js";
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
/** 暫停後要回升到這個值以上才恢復派工（遲滯區間 512 MB）。 */
export const MEMORY_RESUME_MB = MEMORY_FLOOR_MB + 512;
/**
 * 回升到恢復門檻後還要穩定這麼久才恢復派工。執行中的工作會讓 Windows 可用記憶體
 * 在一兩分鐘內上下擺動超過 512 MB，只靠門檻遲滯會每隔幾分鐘暫停又恢復（#243）。
 */
export const MEMORY_STEADY_MS = 5 * 60_000;
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
const gbText = (mb: number) => `${Number((mb / 1024).toFixed(1))} GB`;
/** 暫停派工中的狀態；recoveringSince 是這一段連續回升到恢復門檻以上的起點。 */
export type MemoryPause = { recoveringSince: Date | null };
/** 暫停派工的原因與要保存的回升起點。 */
export type MemoryHold = { detail: string; recoveringSince: Date | null };
/**
 * 記憶體暫停派工的判斷（純函式）：量的是執行器所在 Windows 主機的可用實體記憶體。
 * 原本正常時低於 `MEMORY_FLOOR_MB` 立刻暫停；暫停中要回升到 `MEMORY_RESUME_MB` 以上
 * 並連續維持 `MEMORY_STEADY_MS` 才恢復，中途再掉下去就重新計算。
 */
export function memoryHold(
  r: HostResources,
  pause: MemoryPause | null = null,
  now = new Date(),
): MemoryHold | null {
  const floor = gbText(MEMORY_FLOOR_MB),
    resume = gbText(MEMORY_RESUME_MB),
    free = gbText(r.memFreeMb);
  if (r.memFreeMb < MEMORY_FLOOR_MB)
    return {
      detail: `Windows 主機可用記憶體只剩 ${free}（低於 ${floor}），暫停派新工作，回升到 ${resume} 以上並穩定 5 分鐘才恢復；執行中的工作不受影響`,
      recoveringSince: null,
    };
  if (!pause) return null;
  if (r.memFreeMb < MEMORY_RESUME_MB)
    return {
      detail: `Windows 主機可用記憶體 ${free}，尚未回升到 ${resume}，仍暫停派新工作；執行中的工作不受影響`,
      recoveringSince: null,
    };
  const since = pause.recoveringSince ?? now;
  const left = MEMORY_STEADY_MS - (now.getTime() - since.getTime());
  if (left <= 0) return null;
  return {
    detail: `Windows 主機可用記憶體 ${free}，已回升到 ${resume} 以上，穩定 5 分鐘後恢復派新工作（約剩 ${Math.max(1, Math.ceil(left / 60_000))} 分鐘）；執行中的工作不受影響`,
    recoveringSince: since,
  };
}

/**
 * 解析 Linux `/proc/meminfo`（純函式）：回傳 Docker（WSL2）VM 的總量與可用量（MB）。
 * 可用量優先用 `MemAvailable`（含可回收的快取），舊核心沒有時退回 `MemFree`。
 * 欄位缺少或格式不是「數字 kB」時就不填，不猜測。
 */
export function parseMeminfo(
  text: string,
): Pick<HostResources, "vmTotalMb" | "vmAvailMb"> {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:[ \\t]+(\\d+)[ \\t]+kB[ \\t]*$`, "m").exec(
      text,
    );
    return m ? Number(m[1]) : undefined;
  };
  const mb = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? undefined : Math.round(v / 1024);
  const total = mb(kb("MemTotal"));
  const avail = mb(kb("MemAvailable") ?? kb("MemFree"));
  const out: Pick<HostResources, "vmTotalMb" | "vmAvailMb"> = {};
  if (total !== undefined && total > 0) out.vmTotalMb = total;
  if (avail !== undefined && (out.vmTotalMb === undefined || avail <= total!))
    out.vmAvailMb = avail;
  return out;
}

/**
 * app 容器跑在 Docker（WSL2）VM 內，讀自己的 `/proc/meminfo` 就是 VM 的數字；
 * 不經執行器、不做 docker exec。讀不到（例如在 Windows 上跑測試）就不填。
 * 只供系統頁顯示與比對，暫停派工仍以 Windows 主機的 `memFreeMb` 判斷（`memoryHold`）。
 */
export async function withVmMemory(
  r: HostResources,
  read: () => Promise<string> = () => readFile("/proc/meminfo", "utf8"),
): Promise<HostResources> {
  try {
    return { ...r, ...parseMeminfo(await read()) };
  } catch {
    return r;
  }
}
const vmText = (r: HostResources) =>
  r.vmAvailMb !== undefined && r.vmTotalMb !== undefined
    ? `；Docker VM 可用 ${gbText(r.vmAvailMb)}／共 ${gbText(r.vmTotalMb)}（僅供參考）`
    : "";

/**
 * 排程器每輪讀一次主機資源並寫進系統狀態；記憶體不足時回傳暫停原因。
 * 讀不到資源（執行器暫時無回應）不擋派工，仍有每個容器的記憶體與程序數上限；
 * 這時只靜默更新狀態，不算一次「恢復」，也不通知。
 */
export async function checkHostResources(
  db: Database,
  read: () => Promise<unknown>,
  readMeminfo?: () => Promise<string>,
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
      { silent: true },
    );
    return null;
  }
  resources = await withVmMemory(resources, readMeminfo);
  // 是否在暫停中看上一次真實讀數：讀不到資源時 ok 會被靜默改成正常，reading_ok 不會；
  // 通知基準要等連續兩次讀數才改，不能拿來判斷。沒有 reading_ok 的舊列才沿用 ok 與通知基準。
  const previous = await db.one<{
    ok: boolean;
    reading_ok: boolean | null;
    notified_ok: boolean | null;
    recovering_since: Date | null;
  }>(
    "SELECT ok,reading_ok,notified_ok,recovering_since FROM service_health WHERE name=$1",
    [hostHealthName],
  );
  const paused =
    !!previous &&
    (previous.reading_ok === null
      ? previous.ok === false || previous.notified_ok === false
      : previous.reading_ok === false);
  const hold = memoryHold(
    resources,
    paused ? { recoveringSince: previous.recovering_since } : null,
  );
  await recordHealth(
    db,
    hostHealthName,
    !hold,
    hold?.detail ??
      `Windows 主機可用記憶體 ${gbText(resources.memFreeMb)}／共 ${gbText(resources.memTotalMb)}${vmText(resources)}`,
    { confirm: true },
  );
  await db.query(
    "UPDATE service_health SET recovering_since=$2 WHERE name=$1",
    [hostHealthName, hold?.recoveringSince ?? null],
  );
  return hold?.detail ?? null;
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

export const DISK_HOLD_TEXT =
  "Docker 磁碟空間嚴重不足，已暫停派新工作；空間回升後自動恢復，詳見下方磁碟用量";

interface QueuedRow {
  id: string;
  title: string;
  mode: "change" | "query";
  project_id: string | null;
  project: string | null;
  created_at: string;
  retry_at: string | null;
  retry_waiting: boolean;
  retry_clock: string | null;
  parent_active: boolean;
  has_project: boolean;
  project_enabled: boolean;
  project_validated: boolean;
  repo_missing: boolean;
  project_status: string | null;
  group_enabled: boolean;
  group_left: boolean;
  bound: boolean;
}
export type QueuedEntry = Omit<
  QueuedRow,
  | "retry_waiting"
  | "retry_clock"
  | "parent_active"
  | "has_project"
  | "project_enabled"
  | "project_validated"
  | "repo_missing"
  | "project_status"
  | "group_enabled"
  | "group_left"
  | "bound"
> &
  QueueReason & { position: number };

const short = (text: string, max = 80) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** 專案或群組讓這個任務無法開始的原因；沒有阻擋時為 null。 */
function bindingBlock(t: QueuedRow): QueueReason | null {
  if (!t.has_project)
    return {
      code: "project",
      text: "還沒指定專案",
      hint: "到任務詳情指定專案",
    };
  if (t.repo_missing)
    return {
      code: "project",
      text: "專案的儲存庫找不到，專案已停用",
      hint: "到專案頁確認儲存庫位置後重新驗證",
    };
  if (!t.project_validated)
    return {
      code: "project",
      text: t.project_status
        ? `專案驗證未通過：${short(t.project_status)}`
        : "專案尚未通過環境驗證",
      hint: "到專案頁重新驗證",
    };
  if (!t.project_enabled)
    return { code: "project", text: "專案已停用", hint: "到專案頁重新啟用" };
  if (t.group_left)
    return {
      code: "group",
      text: "機器人已離開這個群組",
      hint: "重新邀請機器人加入後，到群組頁重新啟用",
    };
  if (!t.group_enabled)
    return { code: "group", text: "群組已停用", hint: "到群組頁重新啟用" };
  if (!t.bound)
    return {
      code: "group",
      text: "群組沒有綁定這個專案",
      hint: "到群組頁綁定專案，或改派到已綁定的專案",
    };
  return null;
}

/**
 * 排隊中的任務為什麼還沒開始（系統頁與任務詳情共用）。判斷順序與派工一致：
 * 系統暫停 → Docker 磁碟暫停 → 主機記憶體不足 → 專案停用或驗證未通過或儲存庫遺失 →
 * 群組停用、已離開或未綁定 → 上一題未完成 → 暫時性錯誤退避中 → 同專案修改進行中 →
 * 等待空位／即將開始。只有沒有阻擋的任務才佔用空位、顯示「即將開始」。
 *
 * 帶 `taskId` 時只算到這個任務為止（前面的任務會影響空位），不受 50 筆上限限制。
 */
export async function queueSnapshot(db: Database, taskId?: string, rowLimit: number | null = taskId ? 10000 : 50) {
  const settings = await db.settings();
  const limit = maxRuns(settings);
  const running = await db.query<CapacityRun & { project_id: string | null }>(
    `SELECT t.id,t.title,t.mode,t.project_id,p.name AS project,r.status AS phase,r.started_at
     FROM runs r JOIN tasks t ON t.id=r.task_id LEFT JOIN projects p ON p.id=t.project_id
     WHERE r.completed_at IS NULL ORDER BY r.started_at`,
  );
  const queued = await db.query<QueuedRow>(
    `SELECT t.id,t.title,t.mode,t.project_id,p.name AS project,t.created_at,t.retry_at,
      COALESCE(t.retry_at>now(),false) AS retry_waiting,
      to_char(t.retry_at AT TIME ZONE 'Asia/Taipei','HH24:MI') AS retry_clock,
      (t.mode<>'query' AND EXISTS(SELECT 1 FROM tasks u WHERE u.id=t.parent_id AND u.status IN ('queued','running','reviewing','budget_wait'))) AS parent_active,
      p.id IS NOT NULL AS has_project,COALESCE(p.enabled,false) AS project_enabled,
      p.validated_at IS NOT NULL AS project_validated,p.repo_missing_at IS NOT NULL AS repo_missing,
      COALESCE(NULLIF(p.validation_error,''),NULLIF(p.setup_status,'')) AS project_status,
      COALESCE(g.enabled,false) AS group_enabled,g.left_at IS NOT NULL AS group_left,
      EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=t.group_id AND gp.project_id=t.project_id) AS bound
     FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN groups g ON g.id=t.group_id
     WHERE t.status='queued' AND ($1::uuid IS NULL OR t.created_at<=(SELECT created_at FROM tasks WHERE id=$1))
     ORDER BY t.created_at,t.id LIMIT $2`,
    [taskId ?? null, rowLimit],
  );
  const changing = new Set(
    running.filter((r) => r.mode !== "query").map((r) => r.project_id),
  );
  // Docker 磁碟嚴重不足且開啟暫停（#28），或主機記憶體不足（#21）時都不派新工作。
  const disk = await diskPaused(db);
  const memory = disk ? null : await hostHold(db.pool);
  const holdKind: HoldKind | null = disk ? "disk" : memory ? "memory" : null;
  const hold = disk ? DISK_HOLD_TEXT : memory;
  let free = limit - running.length;
  const entries = queued.map((t, i): QueuedEntry => {
    let reason: QueueReason | null = null;
    if (settings.paused)
      reason = {
        code: "paused",
        text: "系統已暫停派工",
        hint: "管理者在看板恢復派工後自動開始",
      };
    else if (holdKind === "disk")
      reason = {
        code: "disk",
        text: "Docker 磁碟不足，暫停派工中",
        hint: "到系統頁清理 Docker 磁碟；空間回升後自動繼續",
      };
    else if (holdKind === "memory")
      reason = {
        code: "memory",
        text: "主機記憶體不足，暫停派工中",
        hint: "記憶體回升後自動繼續，不用重新提出",
      };
    else reason = bindingBlock(t);
    if (!reason && t.parent_active)
      reason = { code: "parent", text: "等上一題完成", hint: null };
    if (!reason && t.retry_waiting)
      reason = {
        code: "retry",
        text: `暫時性錯誤，約 ${t.retry_clock} 自動重試`,
        hint: null,
      };
    if (!reason && t.mode !== "query" && changing.has(t.project_id))
      reason = { code: "changing", text: "同專案的修改進行中", hint: null };
    if (!reason) {
      if (free > 0) {
        free--;
        reason = { code: "next", text: "即將開始", hint: null };
      } else reason = { code: "waiting", text: "等待空位", hint: null };
    }
    return {
      id: t.id,
      title: t.title,
      mode: t.mode,
      project_id: t.project_id,
      project: t.project,
      created_at: t.created_at,
      retry_at: t.retry_at,
      position: i + 1,
      ...reason,
    };
  });
  return { limit, running, hold, holdKind, queued: entries };
}

/** 單一排隊中任務的排隊資訊（任務詳情用）；任務不在排隊中時為 null。 */
export async function taskQueue(
  db: Database,
  taskId: string,
): Promise<TaskQueue | null> {
  const { queued } = await queueSnapshot(db, taskId);
  const t = queued.find((q) => q.id === taskId);
  if (!t) return null;
  return {
    code: t.code,
    text: t.text,
    hint: t.hint,
    position: t.position,
    retry_at: t.retry_at,
  };
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
