/**
 * Docker 磁碟盤點、歸屬與清理規則（看板、應用程式與主機執行器共用的純函式）。
 *
 * 安全原則：只有「能確認是本系統、本實例產生，而且已經用不到」的東西才會成為清理候選。
 * 正式資料庫、備份、專案原始碼快取、套件快取，以及無法確認歸屬的資源，任何規則都只列出不刪。
 */

/** 本系統建置的服務／工作映像儲存庫；舊標籤可依規則清理。 */
export const cleanupRepositories = [
  "line-agentflow-app",
  "line-agentflow-worker",
];
/** 一律保留的標籤：正式使用中的 `:local` 與 `:latest`。 */
export const protectedTags = new Set(["latest", "local"]);

export type DiskRule = "workspaces" | "containers" | "images" | "build_cache";
export const diskRules: DiskRule[] = [
  "workspaces",
  "containers",
  "images",
  "build_cache",
];

export interface DiskSettings {
  /** 可用空間低於此百分比時通知管理者。 */
  warn_percent: number;
  /** 可用空間低於此百分比時視為嚴重不足。 */
  pause_percent: number;
  /** 嚴重不足時暫停派新工作；預設關閉，只通知。 */
  pause_enabled: boolean;
  /** 既有的每日清理（舊 app／worker 標籤、懸空映像、7 天沒用的建置快取）。 */
  daily_cleanup: boolean;
  rules: {
    workspaces: { enabled: boolean; days: number };
    containers: { enabled: boolean };
    images: { enabled: boolean; days: number };
    build_cache: { enabled: boolean; limit_gb: number };
  };
}

/** 預設只盤點與提醒；每條清理規則都要管理者在系統頁明確開啟。 */
export const defaultDiskSettings: DiskSettings = {
  warn_percent: 15,
  pause_percent: 5,
  pause_enabled: false,
  daily_cleanup: true,
  rules: {
    workspaces: { enabled: false, days: 3 },
    containers: { enabled: false },
    images: { enabled: false, days: 14 },
    build_cache: { enabled: false, limit_gb: 20 },
  },
};

export function mergeDiskSettings(saved: unknown): DiskSettings {
  const s = (saved ?? {}) as Partial<DiskSettings> & {
    rules?: Partial<DiskSettings["rules"]>;
  };
  const d = defaultDiskSettings;
  return {
    warn_percent: s.warn_percent ?? d.warn_percent,
    pause_percent: s.pause_percent ?? d.pause_percent,
    pause_enabled: s.pause_enabled ?? d.pause_enabled,
    daily_cleanup: s.daily_cleanup ?? d.daily_cleanup,
    rules: {
      workspaces: { ...d.rules.workspaces, ...s.rules?.workspaces },
      containers: { ...d.rules.containers, ...s.rules?.containers },
      images: { ...d.rules.images, ...s.rules?.images },
      build_cache: { ...d.rules.build_cache, ...s.rules?.build_cache },
    },
  };
}

// ---- 執行器回報的原始盤點（對應 Docker 的 /system/df） ----

export type Labels = Record<string, string>;
export interface DiskImage {
  id: string;
  tags: string[];
  /** 建立時間（Unix 秒）。 */
  created: number;
  size: number;
  sharedSize: number;
  /** 使用此映像的容器數（含已停止）；-1 表示 Docker 未計算。 */
  containers: number;
  labels: Labels;
}
export interface DiskContainer {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  sizeRw: number;
  created: number;
  labels: Labels;
}
export interface DiskVolume {
  name: string;
  /** -1 表示 Docker 未計算。 */
  size: number;
  refCount: number;
  labels: Labels;
}
export interface DiskBuildCache {
  count: number;
  active: number;
  size: number;
  reclaimable: number;
}
export interface DiskSpace {
  label: string;
  freeBytes: number;
  totalBytes: number;
}
export interface DockerDiskInventory {
  instance: string;
  checkedAt: string;
  layersSize: number;
  images: DiskImage[];
  containers: DiskContainer[];
  volumes: DiskVolume[];
  buildCache: DiskBuildCache;
  /** 主機上 Docker 資料所在磁碟；讀不到時為 null。 */
  host: DiskSpace | null;
}

/** 回報給看板的標籤只保留歸屬判斷需要的，不帶其他專案的任意標籤內容。 */
export function pickLabels(labels: Labels | null | undefined): Labels {
  const picked: Labels = {};
  for (const [k, v] of Object.entries(labels ?? {}))
    if (
      k.startsWith("io.agentflow.") ||
      k === "com.docker.compose.project" ||
      k === "com.docker.compose.service" ||
      k === "com.docker.compose.volume"
    )
      picked[k] = String(v);
  return picked;
}

// ---- 與 docker system df 相同算法的用量摘要 ----

export interface DiskUsageRow {
  kind: "images" | "containers" | "volumes" | "build_cache";
  label: string;
  total: number;
  active: number;
  size: number;
  reclaimable: number;
}

/** 算法與 Docker CLI 的 `docker system df` 相同，看板數字才能和指令對得上。 */
export function diskUsage(inv: DockerDiskInventory): DiskUsageRow[] {
  let usedImages = 0;
  for (const i of inv.images)
    if (i.containers > 0 && i.size >= 0 && i.sharedSize >= 0)
      usedImages += i.size - i.sharedSize;
  const running = (c: DiskContainer) =>
    c.state === "running" || c.state === "paused";
  const containerSize = inv.containers.reduce(
    (n, c) => n + Math.max(0, c.sizeRw),
    0,
  );
  const volumeSize = (v: DiskVolume) => Math.max(0, v.size);
  return [
    {
      kind: "images",
      label: "映像",
      total: inv.images.length,
      active: inv.images.filter((i) => i.containers > 0).length,
      size: inv.layersSize,
      reclaimable: Math.max(0, inv.layersSize - usedImages),
    },
    {
      kind: "containers",
      label: "容器",
      total: inv.containers.length,
      active: inv.containers.filter(running).length,
      size: containerSize,
      reclaimable: inv.containers
        .filter((c) => !running(c))
        .reduce((n, c) => n + Math.max(0, c.sizeRw), 0),
    },
    {
      kind: "volumes",
      label: "資料卷",
      total: inv.volumes.length,
      active: inv.volumes.filter((v) => v.refCount > 0).length,
      size: inv.volumes.reduce((n, v) => n + volumeSize(v), 0),
      reclaimable: inv.volumes
        .filter((v) => v.refCount === 0)
        .reduce((n, v) => n + volumeSize(v), 0),
    },
    {
      kind: "build_cache",
      label: "建置快取",
      total: inv.buildCache.count,
      active: inv.buildCache.active,
      size: inv.buildCache.size,
      reclaimable: inv.buildCache.reclaimable,
    },
  ];
}

// ---- 歸屬 ----

export type DiskOwner =
  | "worker_image"
  | "derived_image"
  | "service_image"
  | "job_container"
  | "service_container"
  | "workspace_volume"
  | "database_volume"
  | "backup_volume"
  | "source_cache_volume"
  | "package_cache_volume"
  | "service_volume"
  | "unknown";

export const ownerLabels: Record<DiskOwner, string> = {
  worker_image: "工作映像",
  derived_image: "專案衍生映像",
  service_image: "服務映像",
  job_container: "工作容器",
  service_container: "服務容器",
  workspace_volume: "任務工作區",
  database_volume: "正式資料庫",
  backup_volume: "服務資料與備份",
  source_cache_volume: "原始碼快取",
  package_cache_volume: "套件快取",
  service_volume: "服務資料卷",
  unknown: "無法確認歸屬",
};

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 與 Containers.volume() 的命名規則一致：正式為 agentflow-job-<run>，驗收實例前面多實例名稱。 */
export function workspaceVolumeRun(name: string, instance: string) {
  const prefix =
    instance === "production"
      ? "agentflow-job-"
      : `agentflow-${escape(instance)}-job-`;
  const m = new RegExp(`^${prefix}(${uuid})(?:-baseline|-env)?$`).exec(name);
  return m?.[1];
}

/**
 * 永不刪除的資料卷及原因。名稱或標籤任一符合就保護：
 * 就算有人把正式資料卷貼上工作區標籤，也不會因此被清掉。
 */
export function protectedVolumeReason(v: DiskVolume): string | null {
  const l = v.labels;
  const compose = l["com.docker.compose.volume"];
  const name = v.name;
  if (compose === "database" || /(^|_)database$/.test(name))
    return "正式資料庫，永不自動刪除";
  if (compose === "data" || /(^|_)data$/.test(name) || /backup/i.test(name))
    return "服務資料與備份，永不自動刪除";
  if (
    l["io.agentflow.source-cache"] ||
    name.startsWith("agentflow-source-") ||
    /source-cache/.test(name)
  )
    return "專案原始碼快取，永不自動刪除";
  if (
    l["io.agentflow.nuget-feed"] ||
    /nuget|package-cache|-cache(-|$)/.test(name)
  )
    return "套件快取，永不自動刪除";
  if (l["com.docker.compose.project"]) return "服務資料卷，永不自動刪除";
  return null;
}

/** 只有名稱、標籤、執行識別碼全部吻合的本實例工作區資料卷才可能被刪。 */
export function deletableWorkspaceVolume(v: DiskVolume, instance: string) {
  if (protectedVolumeReason(v)) return undefined;
  const runId = workspaceVolumeRun(v.name, instance);
  if (
    !runId ||
    v.labels["io.agentflow.managed"] !== "true" ||
    v.labels["io.agentflow.instance"] !== instance ||
    v.labels["io.agentflow.run"] !== runId
  )
    return undefined;
  return runId;
}

export interface DiskItem {
  /** 唯一鍵：image:<標籤或 id>、container:<id>、volume:<名稱>、build_cache。 */
  key: string;
  kind: "image" | "container" | "volume" | "build_cache";
  /** 執行刪除時使用的識別：映像標籤、容器 id、資料卷名稱。 */
  target: string;
  name: string;
  owner: DiskOwner;
  size: number;
  detail: string;
  runId?: string;
  /** 映像項目所屬的映像 id；多個標籤共用同一映像時用來避免重複計算大小。 */
  imageId?: string;
  /** 依此規則可清理；沒有代表不在清理範圍。 */
  rule?: DiskRule;
  /** 永不刪除的原因。 */
  protected?: string;
}

export interface OwnershipContext {
  instance: string;
  now: number;
  /** 專案設定使用中的映像，一律保留。 */
  projectImages: string[];
  /** 盤點中出現的執行：完成時間（null 表示仍在執行）；不在表內代表資料庫找不到。 */
  runs: Record<string, { completedAt: string | null }>;
  settings: DiskSettings;
}

const day = 86400_000;
const gb = 1024 ** 3;
const sizeText = (bytes: number) => `${(bytes / gb).toFixed(1)} GB`;
const dateText = (ms: number) =>
  new Date(ms).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function classifyDisk(
  inv: DockerDiskInventory,
  ctx: OwnershipContext,
): DiskItem[] {
  const items: DiskItem[] = [];
  const rules = ctx.settings.rules;
  const keep = new Set(ctx.projectImages);
  const usedByContainer = new Set(inv.containers.map((c) => c.imageId));
  const serviceProject =
    ctx.instance === "production" ? "line-agentflow" : ctx.instance;

  for (const image of inv.images) {
    const worker = image.labels["io.agentflow.worker"] === "v1";
    const inUse = image.containers > 0 || usedByContainer.has(image.id);
    const ageDays = (ctx.now / 1000 - image.created) / 86400;
    const tags = image.tags.filter((t) => t && t !== "<none>:<none>");
    if (!tags.length) {
      items.push({
        key: `image:${image.id}`,
        kind: "image",
        imageId: image.id,
        target: image.id,
        name: `（無標籤）${image.id.replace(/^sha256:/, "").slice(0, 12)}`,
        owner: worker ? "worker_image" : "unknown",
        size: image.size,
        detail: inUse ? "有容器在用" : "懸空映像",
        ...(worker && !inUse ? { rule: "images" as const } : {}),
        ...(!worker ? { protected: "無法確認歸屬，只列出" } : {}),
      });
      continue;
    }
    for (const tag of tags) {
      const at = tag.lastIndexOf(":");
      const repository = tag.slice(0, at),
        name = tag.slice(at + 1);
      const ours = cleanupRepositories.includes(repository) || worker;
      const owner: DiskOwner =
        repository === "line-agentflow-worker"
          ? "worker_image"
          : worker
            ? "derived_image"
            : repository.startsWith("line-agentflow-")
              ? "service_image"
              : "unknown";
      const reasons: string[] = [];
      if (keep.has(tag)) reasons.push("專案使用中");
      if (inUse) reasons.push("有容器在用");
      if (protectedTags.has(name)) reasons.push(`:${name} 一律保留`);
      if (ageDays < rules.images.days)
        reasons.push(`${Math.floor(ageDays)} 天內建立`);
      const eligible = ours && !reasons.length;
      items.push({
        key: `image:${tag}`,
        kind: "image",
        imageId: image.id,
        target: tag,
        name: tag,
        owner,
        size: image.size,
        detail: [
          `建立於 ${dateText(image.created * 1000)}`,
          ...(tags.length > 1 ? ["與其他標籤共用"] : []),
          ...reasons,
        ].join("；"),
        ...(eligible ? { rule: "images" as const } : {}),
        ...(!ours && owner === "unknown"
          ? { protected: "不是本系統的映像，只列出" }
          : {}),
      });
    }
  }

  for (const c of inv.containers) {
    const runId = c.labels["io.agentflow.run"];
    const own =
      !!runId &&
      c.labels["io.agentflow.managed"] === "true" &&
      c.labels["io.agentflow.instance"] === ctx.instance;
    const running = c.state === "running" || c.state === "paused";
    const service =
      c.labels["com.docker.compose.project"] === serviceProject &&
      !!c.labels["com.docker.compose.service"];
    const run = runId ? ctx.runs[runId] : undefined;
    const active = !!run && run.completedAt === null;
    items.push({
      key: `container:${c.id}`,
      kind: "container",
      target: c.id,
      name: c.name,
      owner: own ? "job_container" : service ? "service_container" : "unknown",
      size: Math.max(0, c.sizeRw),
      detail: `${running ? "執行中" : "已停止"} · ${c.image}`,
      ...(own ? { runId } : {}),
      ...(own && !running && !active ? { rule: "containers" as const } : {}),
      ...(!own && !service
        ? { protected: "無法確認歸屬，只列出" }
        : service
          ? { protected: "服務容器，不在清理範圍" }
          : {}),
    });
  }

  for (const v of inv.volumes) {
    const reason = protectedVolumeReason(v);
    const runId = deletableWorkspaceVolume(v, ctx.instance);
    const base = {
      key: `volume:${v.name}`,
      kind: "volume" as const,
      target: v.name,
      name: v.name,
      size: Math.max(0, v.size),
    };
    if (reason) {
      const owner: DiskOwner = reason.startsWith("正式資料庫")
        ? "database_volume"
        : reason.startsWith("服務資料與備份")
          ? "backup_volume"
          : reason.startsWith("專案原始碼快取")
            ? "source_cache_volume"
            : reason.startsWith("套件快取")
              ? "package_cache_volume"
              : "service_volume";
      items.push({
        ...base,
        owner,
        detail: v.refCount > 0 ? "使用中" : "未掛載",
        protected: reason,
      });
      continue;
    }
    if (!runId) {
      items.push({
        ...base,
        owner: "unknown",
        detail: v.refCount > 0 ? "使用中" : "未掛載",
        protected: "無法確認歸屬，只列出給人決定",
      });
      continue;
    }
    const run = ctx.runs[runId];
    if (!run) {
      items.push({
        ...base,
        owner: "workspace_volume",
        runId,
        detail: "找不到對應的執行紀錄",
        protected: "無法確認歸屬，只列出給人決定",
      });
      continue;
    }
    if (run.completedAt === null) {
      items.push({
        ...base,
        owner: "workspace_volume",
        runId,
        detail: "任務執行中",
      });
      continue;
    }
    const until = Date.parse(run.completedAt) + rules.workspaces.days * day;
    items.push({
      ...base,
      owner: "workspace_volume",
      runId,
      detail:
        until > ctx.now
          ? `保留到 ${dateText(until)}`
          : `執行已於 ${dateText(Date.parse(run.completedAt))} 結束`,
      ...(until <= ctx.now && v.refCount === 0
        ? { rule: "workspaces" as const }
        : {}),
    });
  }

  const limit = rules.build_cache.limit_gb * gb;
  if (inv.buildCache.size > limit && inv.buildCache.reclaimable > 0)
    items.push({
      key: "build_cache",
      kind: "build_cache",
      target: String(Math.round(limit)),
      name: "建置快取",
      owner: "service_image",
      size: Math.min(inv.buildCache.reclaimable, inv.buildCache.size - limit),
      detail: `目前 ${sizeText(inv.buildCache.size)}，超過上限 ${sizeText(limit)}，從最舊的清起`,
      rule: "build_cache",
    });
  return items;
}

/** 會被刪除的項目；enabledOnly 時只取已開啟的規則（自動清理），否則取全部規則（看板手動預覽）。 */
export function cleanupPlan(
  items: DiskItem[],
  settings: DiskSettings,
  enabledOnly: boolean,
) {
  return items.filter(
    (i) =>
      i.rule &&
      !i.protected &&
      (!enabledOnly || settings.rules[i.rule].enabled),
  );
}

export const ruleLabels: Record<DiskRule, string> = {
  workspaces: "已結束任務的工作區資料卷",
  containers: "停止的工作容器",
  images: "沒有專案使用的舊工作映像",
  build_cache: "超過上限的建置快取",
};

export type DiskLevel = "ok" | "low" | "critical" | "unknown";

export function diskLevel(
  spaces: DiskSpace[],
  settings: DiskSettings,
): { level: DiskLevel; freePercent: number | null; space: DiskSpace | null } {
  let worst: DiskSpace | null = null;
  let percent: number | null = null;
  for (const s of spaces) {
    if (!(s.totalBytes > 0)) continue;
    const p = (s.freeBytes / s.totalBytes) * 100;
    if (percent === null || p < percent) {
      percent = p;
      worst = s;
    }
  }
  if (percent === null)
    return { level: "unknown", freePercent: null, space: null };
  return {
    level:
      percent < settings.pause_percent
        ? "critical"
        : percent < settings.warn_percent
          ? "low"
          : "ok",
    freePercent: Math.round(percent * 10) / 10,
    space: worst,
  };
}

/** 每小時維護在整點 10 分執行；每日清理距上次至少 23 小時。 */
export function nextCleanupAt(lastRun: Date | null, now: Date) {
  const earliest = lastRun
    ? Math.max(lastRun.getTime() + 23 * 3600_000, now.getTime())
    : now.getTime();
  const t = new Date(earliest);
  t.setUTCMinutes(10, 0, 0);
  if (t.getTime() < earliest) t.setUTCHours(t.getUTCHours() + 1);
  return t;
}

export interface DiskReport {
  checkedAt: string;
  instance: string;
  settings: DiskSettings;
  usage: DiskUsageRow[];
  spaces: DiskSpace[];
  level: DiskLevel;
  freePercent: number | null;
  /** 嚴重不足且已開啟暫停派工。 */
  paused: boolean;
  owners: { owner: DiskOwner; label: string; count: number; size: number }[];
  /** 依目前規則參數可清理的項目（不論規則是否開啟）。 */
  candidates: DiskItem[];
  /** 只列出、永不刪除的項目。 */
  protected: DiskItem[];
  nextCleanupAt: string | null;
  lastCleanup: { at: string; detail: string } | null;
}
