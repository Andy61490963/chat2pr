import type Docker from "dockerode";
import { statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupRepositories,
  deletableWorkspaceVolume,
  mergeDiskSettings,
  pickLabels,
  protectedTags,
  protectedVolumeReason,
  type DiskSpace,
  type DockerDiskInventory,
} from "../shared/docker-disk.js";

/**
 * 每天清理一次 Docker：只動這個系統自己產生、已經用不到的東西。
 * - line-agentflow-app／line-agentflow-worker 的舊標籤（部署前留的還原點、測試版），超過 imageDays 天才刪；
 *   :latest、:local、專案正在用的映像、任何容器（含已停止）正在用的映像都保留。
 * - 沒有名稱的懸空映像：無法再被引用，等同 docker image prune 的預設行為。
 * - 超過 cacheHours 小時沒用到的建置快取；最近的快取保留，部署不會因此變慢。
 * 不刪資料卷，也不動其他專案有名稱的映像。
 */
export { cleanupRepositories };

export interface CleanupReport {
  removedTags: string[];
  keptInUse: string[];
  dangling: number;
  reclaimedBytes: number;
  cacheBytes: number;
  errors: string[];
}

export function cleanupCandidates(
  images: Pick<Docker.ImageInfo, "Id" | "RepoTags" | "Created">[],
  options: {
    keep: string[];
    inUse: Set<string>;
    now?: number;
    imageDays?: number;
  },
) {
  const now = options.now ?? Date.now();
  const cutoff = now / 1000 - (options.imageDays ?? 14) * 86400;
  const keep = new Set(options.keep);
  const candidates: string[] = [],
    keptInUse: string[] = [];
  for (const image of images)
    for (const tag of image.RepoTags ?? []) {
      const at = tag.lastIndexOf(":");
      const repository = tag.slice(0, at),
        name = tag.slice(at + 1);
      if (
        !cleanupRepositories.includes(repository) ||
        protectedTags.has(name) ||
        keep.has(tag) ||
        image.Created > cutoff
      )
        continue;
      if (options.inUse.has(image.Id)) keptInUse.push(tag);
      else candidates.push(tag);
    }
  return { candidates: candidates.sort(), keptInUse: keptInUse.sort() };
}

/**
 * dockerode 的 pruneBuilder 不會送出任何條件，會把建置快取整個清空；
 * 這裡直接呼叫 Docker API，只清超過指定時數沒用到的快取。
 */
export function pruneBuildCache(docker: Docker, hours: number) {
  return new Promise<{ SpaceReclaimed?: number }>((resolve, reject) =>
    docker.modem.dial(
      {
        path: "/build/prune?",
        method: "POST",
        options: { filters: { until: [`${hours}h`] } },
        statusCodes: { 200: true, 500: "server error" },
      },
      (error, data) =>
        error
          ? reject(error)
          : resolve((data ?? {}) as { SpaceReclaimed?: number }),
    ),
  );
}

export async function cleanupDocker(
  docker: Docker,
  options: { keep: string[]; imageDays?: number; cacheHours?: number },
): Promise<CleanupReport> {
  const errors: string[] = [];
  const containers = await docker.listContainers({ all: true });
  const inUse = new Set(containers.map((c) => c.ImageID));
  const { candidates, keptInUse } = cleanupCandidates(
    await docker.listImages(),
    { keep: options.keep, inUse, imageDays: options.imageDays },
  );
  const removedTags: string[] = [];
  for (const tag of candidates)
    try {
      // 不加 force：仍有容器在用的映像 Docker 會拒絕刪除。
      await docker.getImage(tag).remove();
      removedTags.push(tag);
    } catch {
      errors.push(`無法刪除 ${tag}`);
    }
  let dangling = 0,
    reclaimedBytes = 0,
    cacheBytes = 0;
  try {
    const pruned = await docker.pruneImages({
      filters: { dangling: { true: true } },
    });
    dangling = pruned.ImagesDeleted?.length ?? 0;
    reclaimedBytes = pruned.SpaceReclaimed ?? 0;
  } catch {
    errors.push("無法清除懸空映像");
  }
  try {
    cacheBytes =
      (await pruneBuildCache(docker, options.cacheHours ?? 168))
        .SpaceReclaimed ?? 0;
  } catch {
    errors.push("無法清除建置快取");
  }
  return {
    removedTags,
    keptInUse,
    dangling,
    reclaimedBytes,
    cacheBytes,
    errors,
  };
}

export const gigabytes = (bytes: number) =>
  `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function cleanupSummary(r: CleanupReport) {
  const parts = [
    `刪除 ${r.removedTags.length} 個舊映像標籤`,
    `${r.dangling} 個懸空映像`,
    `建置快取 ${gigabytes(r.cacheBytes)}`,
    `映像共釋放 ${gigabytes(r.reclaimedBytes)}`,
  ];
  if (r.keptInUse.length)
    parts.push(`${r.keptInUse.length} 個舊標籤仍有容器在用，保留`);
  if (r.errors.length) parts.push(`未完成：${r.errors.slice(0, 3).join("、")}`);
  return `Docker 定期清理：${parts.join("；")}`;
}

/** 由每小時的維護工作呼叫；距離上次清理不到 23 小時就略過。 */
export async function dailyDockerCleanup(
  db: {
    query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
    audit: (
      taskId: string | null,
      kind: string,
      detail: string,
    ) => Promise<unknown>;
  },
  call: <T>(path: string, body: unknown, timeoutMs?: number) => Promise<T>,
) {
  const recent = await db.query(
    "SELECT 1 FROM audit WHERE kind='docker_cleanup' AND created_at>now()-interval '23 hours' LIMIT 1",
  );
  if (recent.length) return;
  // 管理者可在系統頁關閉這項既有清理；沒設定過時維持原本的開啟。
  const [disk] = await db.query<{ settings: unknown }>(
    "SELECT settings FROM docker_disk WHERE id=1",
  );
  if (!mergeDiskSettings(disk?.settings).daily_cleanup) return;
  const keep = (
    await db.query<{ image: string }>("SELECT DISTINCT image FROM projects")
  ).map((p) => p.image);
  const report = await call<CleanupReport & { skipped?: boolean }>(
    "maintenance/docker",
    { keep },
    10 * 60 * 1000,
  );
  if (report.skipped) return;
  await db.audit(null, "docker_cleanup", cleanupSummary(report));
}

// ---- Docker 磁碟盤點與看板確認後的清理（Issue #25） ----

interface DockerDf {
  LayersSize?: number;
  Images?: {
    Id: string;
    RepoTags?: string[] | null;
    Created: number;
    Size: number;
    SharedSize: number;
    Containers: number;
    Labels?: Record<string, string> | null;
  }[];
  Containers?: {
    Id: string;
    Names?: string[];
    Image: string;
    ImageID: string;
    State: string;
    SizeRw?: number;
    Created: number;
    Labels?: Record<string, string> | null;
  }[];
  Volumes?: {
    Name: string;
    Labels?: Record<string, string> | null;
    UsageData?: { Size: number; RefCount: number } | null;
  }[];
  BuildCache?: { Size: number; InUse: boolean; Shared: boolean }[];
}

/** Docker Desktop 在 Windows 把資料放在 LOCALAPPDATA 下的 Docker 資料夾；Linux 為 /var/lib/docker。 */
export function dockerDataPath() {
  const local = process.env.LOCALAPPDATA;
  if (
    process.platform === "win32" &&
    local &&
    existsSync(join(local, "Docker"))
  )
    return join(local, "Docker");
  return existsSync("/var/lib/docker") ? "/var/lib/docker" : process.cwd();
}

export async function diskSpace(
  path: string,
  label: string,
): Promise<DiskSpace | null> {
  try {
    const s = await statfs(path);
    return {
      label,
      freeBytes: Number(s.bavail) * Number(s.bsize),
      totalBytes: Number(s.blocks) * Number(s.bsize),
    };
  } catch {
    return null;
  }
}

/** 對應 `docker system df -v` 的盤點；只回報歸屬判斷需要的欄位與標籤。 */
export async function dockerDiskInventory(
  docker: Pick<Docker, "df">,
  instance: string,
  hostPath = dockerDataPath(),
): Promise<DockerDiskInventory> {
  const df = (await docker.df()) as DockerDf;
  const cache = (df.BuildCache ?? []).filter((b) => !b.Shared);
  return {
    instance,
    checkedAt: new Date().toISOString(),
    layersSize: df.LayersSize ?? 0,
    images: (df.Images ?? []).map((i) => ({
      id: i.Id,
      tags: (i.RepoTags ?? []).filter((t) => t !== "<none>:<none>"),
      created: i.Created,
      size: i.Size,
      sharedSize: i.SharedSize,
      containers: i.Containers,
      labels: pickLabels(i.Labels),
    })),
    containers: (df.Containers ?? []).map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
      image: c.Image.startsWith("sha256:") ? c.Image.slice(7, 19) : c.Image,
      imageId: c.ImageID,
      state: c.State,
      sizeRw: c.SizeRw ?? 0,
      created: c.Created,
      labels: pickLabels(c.Labels),
    })),
    volumes: (df.Volumes ?? []).map((v) => ({
      name: v.Name,
      size: v.UsageData?.Size ?? -1,
      refCount: v.UsageData?.RefCount ?? 0,
      labels: pickLabels(v.Labels),
    })),
    buildCache: {
      count: df.BuildCache?.length ?? 0,
      active: (df.BuildCache ?? []).filter((b) => b.InUse).length,
      size: cache.reduce((n, b) => n + b.Size, 0),
      reclaimable: cache
        .filter((b) => !b.InUse)
        .reduce((n, b) => n + b.Size, 0),
    },
    host: await diskSpace(hostPath, "主機磁碟（Docker 資料所在）"),
  };
}

export interface DiskRemoval {
  kind: "image" | "container" | "volume" | "build_cache";
  target: string;
  runId?: string;
}
export interface DiskRemovalReport {
  removed: string[];
  failed: { key: string; reason: string }[];
  cacheBytes: number;
}
export interface DiskRemovalEnv {
  docker: Docker;
  instance: string;
  isActive(runId: string): boolean;
  removeOwnedVolume(name: string, runId: string): Promise<void>;
}

const removalKey = (r: DiskRemoval) =>
  r.kind === "build_cache" ? "build_cache" : `${r.kind}:${r.target}`;
const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode;

/**
 * 執行器端再核對一次才刪：應用程式送來的清單不被當成授權。
 * 正式資料庫、備份、快取與無法確認歸屬的資源在這裡也一律拒絕；刪除都不加 force。
 */
export async function removeDiskItems(
  env: DiskRemovalEnv,
  items: DiskRemoval[],
  keep: string[],
): Promise<DiskRemovalReport> {
  const report: DiskRemovalReport = { removed: [], failed: [], cacheBytes: 0 };
  const keepSet = new Set(keep);
  const refuse = (key: string, reason: string) =>
    report.failed.push({ key, reason });
  for (const item of items) {
    const key = removalKey(item);
    try {
      if (item.kind === "image") {
        const image = env.docker.getImage(item.target);
        const info = await image.inspect();
        const worker = info.Config?.Labels?.["io.agentflow.worker"] === "v1";
        // 專案衍生映像只刪本實例建立的。
        if (
          info.Config?.Labels?.["io.agentflow.derived"] === "v1" &&
          info.Config.Labels["io.agentflow.derived-instance"] !== env.instance
        ) {
          refuse(key, "其他執行環境的衍生映像");
          continue;
        }
        if (item.target.startsWith("sha256:")) {
          if (!worker || (info.RepoTags ?? []).length) {
            refuse(key, "不是本系統的懸空映像");
            continue;
          }
        } else {
          const at = item.target.lastIndexOf(":");
          const repository = item.target.slice(0, at),
            name = item.target.slice(at + 1);
          if (
            at <= 0 ||
            protectedTags.has(name) ||
            keepSet.has(item.target) ||
            !(cleanupRepositories.includes(repository) || worker)
          ) {
            refuse(key, "受保護或不是本系統的映像");
            continue;
          }
        }
        // 不加 force：仍有容器（含已停止）在用時 Docker 會拒絕。
        await image.remove();
      } else if (item.kind === "container") {
        const container = env.docker.getContainer(item.target);
        const info = await container.inspect();
        const labels = info.Config?.Labels ?? {};
        const runId = labels["io.agentflow.run"];
        if (
          !runId ||
          labels["io.agentflow.managed"] !== "true" ||
          labels["io.agentflow.instance"] !== env.instance
        ) {
          refuse(key, "不是本實例的工作容器");
          continue;
        }
        if (info.State?.Running || info.State?.Paused || env.isActive(runId)) {
          refuse(key, "工作容器仍在執行");
          continue;
        }
        // 不加 v：不連帶刪除容器的匿名資料卷。
        await container.remove();
      } else if (item.kind === "volume") {
        const info = await env.docker.getVolume(item.target).inspect();
        const volume = {
          name: info.Name,
          size: -1,
          refCount: 0,
          labels: pickLabels(info.Labels),
        };
        const reason = protectedVolumeReason(volume);
        const runId = deletableWorkspaceVolume(volume, env.instance);
        if (reason || !runId || runId !== item.runId) {
          refuse(key, reason ?? "無法確認是本實例的任務工作區");
          continue;
        }
        if (env.isActive(runId)) {
          refuse(key, "任務仍在執行");
          continue;
        }
        await env.removeOwnedVolume(item.target, runId);
      } else {
        const limit = Number(item.target);
        if (!Number.isSafeInteger(limit) || limit < 1024 ** 3) {
          refuse(key, "建置快取上限錯誤");
          continue;
        }
        report.cacheBytes =
          (await pruneBuildCacheTo(env.docker, limit)).SpaceReclaimed ?? 0;
      }
      report.removed.push(key);
    } catch (error) {
      refuse(
        key,
        statusOf(error) === 404
          ? "已不存在"
          : statusOf(error) === 409
            ? "仍在使用中，Docker 拒絕刪除"
            : "刪除失敗",
      );
    }
  }
  return report;
}

/** 建置快取超過上限時從最舊的清起，直到不超過上限。 */
export function pruneBuildCacheTo(docker: Docker, limitBytes: number) {
  return new Promise<{ SpaceReclaimed?: number }>((resolve, reject) =>
    docker.modem.dial(
      {
        path: "/build/prune?",
        method: "POST",
        // keep-storage 給舊版 Docker；新版改用 max-used-space，兩者同值。
        options: {
          all: true,
          "keep-storage": limitBytes,
          "max-used-space": limitBytes,
        },
        statusCodes: { 200: true, 500: "server error" },
      },
      (error, data) =>
        error
          ? reject(error)
          : resolve((data ?? {}) as { SpaceReclaimed?: number }),
    ),
  );
}
