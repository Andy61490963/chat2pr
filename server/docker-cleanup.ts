import type Docker from "dockerode";

/**
 * 每天清理一次 Docker：只動這個系統自己產生、已經用不到的東西。
 * - line-agentflow-app／line-agentflow-worker 的舊標籤（部署前留的還原點、測試版），超過 imageDays 天才刪；
 *   :latest、:local、專案正在用的映像、任何容器（含已停止）正在用的映像都保留。
 * - 沒有名稱的懸空映像：無法再被引用，等同 docker image prune 的預設行為。
 * - 超過 cacheHours 小時沒用到的建置快取；最近的快取保留，部署不會因此變慢。
 * 不刪資料卷，也不動其他專案有名稱的映像。
 */
export const cleanupRepositories = [
  "line-agentflow-app",
  "line-agentflow-worker",
];
const protectedTags = new Set(["latest", "local"]);

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
