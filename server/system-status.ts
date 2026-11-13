import type Docker from "dockerode";
import { WORKER_REV } from "./containers.js";

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
export interface SystemStatus {
  checkedAt: string;
  instance: string;
  requiredWorkerRev: string;
  services: ContainerStatus[];
  jobs: ContainerStatus[];
  images: WorkerImageStatus[];
  volumes: { jobs: number; sourceCaches: number };
}

const roles: Record<string, string> = {
  app: "看板與 API、排程與判讀",
  db: "PostgreSQL＋pgvector 資料庫",
  egress: "安裝階段套件出口（npm／PyPI／NuGet 白名單）",
  "egress-ai": "OpenAI／ChatGPT 專用出口",
  "subscription-relay": "訂閱推論轉送（容器不持有登入檔）",
  embedder: "本機向量模型 bge-m3",
  "db-test": "測試用資料庫",
};

export async function systemStatus(
  docker: Docker,
  instance: string,
): Promise<SystemStatus> {
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
    if (runId && (c.Labels?.["io.agentflow.instance"] ?? "production") === instance) {
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
      sourceCaches: volumes.filter((v) => v.Name.startsWith("agentflow-source-"))
        .length,
    },
  };
}
