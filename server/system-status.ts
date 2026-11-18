import type Docker from "dockerode";
import { WORKER_REV } from "./containers.js";
import { AppError, redact } from "./policy.js";

// 看板「系統」頁的容器狀態：只回報名稱、映像、狀態與標籤，不含環境變數或掛載內容。
export interface ContainerStatus {
  name: string;
  role: string;
  image: string;
  state: string;
  status: string;
  created: string;
  runId?: string;
  phase?: string;
}
export interface WorkerImageStatus {
  tag: string;
  rev: string | null;
  current: boolean;
  sizeMb: number;
  created: string;
}
/** 執行器 `/system` 回傳的 Docker 盤點結果。 */
export interface DockerSnapshot {
  checkedAt: string;
  instance: string;
  requiredWorkerRev: string;
  services: ContainerStatus[];
  jobs: ContainerStatus[];
  images: WorkerImageStatus[];
  volumes: { jobs: number; sourceCaches: number };
}
/**
 * 執行器那一列的狀態：
 * - ok：執行器與 Docker 都有回應。
 * - docker：執行器有回應，但 Docker 沒回應、回報錯誤或超過時間。
 * - down：執行器（主機程序）本身沒有任何 HTTP 回應。
 */
export type RunnerState = "ok" | "docker" | "down";
export interface RunnerHealth {
  state: RunnerState;
  detail?: string;
}
/** 看板 `/api/system`：讀不到 Docker 時清單為 null，看板沿用上一次成功的資料。 */
export interface SystemStatus {
  checkedAt: string;
  instance: string;
  requiredWorkerRev: string;
  runner: RunnerHealth;
  services: ContainerStatus[] | null;
  jobs: ContainerStatus[] | null;
  images: WorkerImageStatus[] | null;
  volumes: { jobs: number; sourceCaches: number } | null;
}

export const runnerText = {
  down: "執行器（主機程序 4312）沒有回應；監督程序每 30 秒會自動拉起，可執行 npm run services 觀察",
  docker:
    "執行器正常，但 Docker 沒有回應或回報錯誤；請確認 Docker Desktop 與主機可用記憶體",
  timeout:
    "執行器正常，但 Docker 超過 20 秒沒有回應；請確認 Docker Desktop 與主機可用記憶體",
};
/** 測試可以縮短；正式環境 `/system` 等 20 秒（盤點容器、映像與資料卷），`/alive` 等 2 秒。 */
export const runnerProbe = { systemMs: 20000, aliveMs: 2000 };

const timedOut = (e: unknown) =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/**
 * 系統頁向執行器要容器狀態，並分辨「執行器沒回應」與「Docker 沒回應」。
 * 只有 fetch 本身拋錯、完全沒有 HTTP 回應才算執行器沒回應；拿到 5xx 表示執行器在、Docker 出錯。
 * 逾時再以 2 秒打一次不碰 Docker 的 `/alive` 區分兩者。授權失敗等 4xx 照舊拋出。
 * 訊息固定、不夾帶 Docker 原始錯誤，並經 redact。
 */
export async function probeSystem(
  runnerUrl: string,
  key: string,
  instance: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SystemStatus> {
  const headers = { "x-runner-key": key };
  const unavailable = (
    state: Exclude<RunnerState, "ok">,
    detail: string,
  ): SystemStatus => ({
    checkedAt: new Date().toISOString(),
    instance,
    requiredWorkerRev: WORKER_REV,
    runner: { state, detail: redact(detail) },
    services: null,
    jobs: null,
    images: null,
    volumes: null,
  });
  let r: Response;
  try {
    r = await fetchImpl(`${runnerUrl}/system`, {
      headers,
      signal: AbortSignal.timeout(runnerProbe.systemMs),
    });
  } catch (e) {
    if (!timedOut(e)) return unavailable("down", runnerText.down);
    try {
      await fetchImpl(`${runnerUrl}/alive`, {
        headers,
        signal: AbortSignal.timeout(runnerProbe.aliveMs),
      });
      return unavailable("docker", runnerText.timeout);
    } catch {
      return unavailable("down", runnerText.down);
    }
  }
  if (r.status >= 500) return unavailable("docker", runnerText.docker);
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    // 有回應但內容讀不完（多半是 Docker 盤點卡住）：執行器在，歸到 Docker。
    if (r.ok) return unavailable("docker", runnerText.docker);
    data = {};
  }
  if (!r.ok)
    throw new AppError(
      r.status,
      (data as { error?: string }).error ?? "無法讀取容器狀態",
    );
  return { ...(data as DockerSnapshot), runner: { state: "ok" } };
}

const roles: Record<string, string> = {
  app: "看板與 API、排程與判讀",
  db: "PostgreSQL＋pgvector 資料庫",
  egress: "安裝階段套件出口（下載來源白名單，系統頁可改）",
  "egress-ai": "OpenAI／ChatGPT 專用出口",
  "subscription-relay": "訂閱推論轉送（容器不持有登入檔）",
  embedder: "本機向量模型 bge-m3",
  "db-test": "測試用資料庫",
};

export async function systemStatus(
  docker: Docker,
  instance: string,
): Promise<DockerSnapshot> {
  const prefix = instance === "production" ? "line-agentflow" : instance;
  const all = await docker.listContainers({ all: true });
  const services: ContainerStatus[] = [];
  const jobs: ContainerStatus[] = [];
  for (const c of all) {
    const name = (c.Names[0] ?? "").replace(/^\//, "");
    const base = {
      name,
      image: c.Image.startsWith("sha256:") ? c.Image.slice(7, 19) : c.Image,
      state: c.State,
      status: c.Status,
      created: new Date(c.Created * 1000).toISOString(),
    };
    const runId = c.Labels?.["io.agentflow.run"];
    if (
      runId &&
      (c.Labels?.["io.agentflow.instance"] ?? "production") === instance
    ) {
      jobs.push({
        ...base,
        role: "工作容器",
        runId,
        phase: c.Labels?.["io.agentflow.phase"],
      });
      continue;
    }
    const service = c.Labels?.["com.docker.compose.service"];
    const project = c.Labels?.["com.docker.compose.project"];
    if (service && project === prefix)
      services.push({ ...base, role: roles[service] ?? service });
  }
  const images = (await docker.listImages())
    .flatMap((i) =>
      (i.RepoTags ?? [])
        .filter((t) => t.startsWith("line-agentflow-worker:"))
        .map((tag) => {
          const rev = i.Labels?.["io.agentflow.worker-rev"] ?? null;
          return {
            tag,
            rev,
            current: !!rev && rev >= WORKER_REV,
            sizeMb: Math.round(i.Size / 1024 / 1024),
            created: new Date(i.Created * 1000).toISOString(),
          };
        }),
    )
    .sort((a, b) => a.tag.localeCompare(b.tag));
  const volumes = (await docker.listVolumes()).Volumes ?? [];
  return {
    checkedAt: new Date().toISOString(),
    instance,
    requiredWorkerRev: WORKER_REV,
    services: services.sort((a, b) => a.name.localeCompare(b.name)),
    jobs,
    images,
    volumes: {
      jobs: volumes.filter((v) => /^agentflow-job-[0-9a-f-]+$/.test(v.Name))
        .length,
      sourceCaches: volumes.filter((v) =>
        v.Name.startsWith("agentflow-source-"),
      ).length,
    },
  };
}
