import type { DiskLevel } from "./docker-disk.js";
import type {
  systemStatusLabels,
  workerImageStatus,
} from "./status-glossary.js";

export const systemTabs = {
  execution: "執行",
  disk: "容器與磁碟",
  network: "網路",
  architecture: "架構",
} as const;

export type SystemTab = keyof typeof systemTabs;
export const defaultSystemTab: SystemTab = "execution";

export function readSystemTab(value: string | null): SystemTab {
  return value && Object.hasOwn(systemTabs, value)
    ? (value as SystemTab)
    : defaultSystemTab;
}

export function containerCondition(container: {
  state: string;
  status: string;
}): keyof typeof systemStatusLabels.container {
  if (container.state !== "running") return "stopped";
  return /\(unhealthy\)/i.test(container.status) ? "unhealthy" : "running";
}

export function diskAttentionCount({
  probeFailed,
  services,
  images,
  diskLevel,
  diskPaused,
}: {
  probeFailed: boolean;
  services: readonly ReturnType<typeof containerCondition>[];
  images: readonly ReturnType<typeof workerImageStatus>[];
  diskLevel: DiskLevel | null;
  diskPaused: boolean;
}) {
  // 探測失敗時只計一次，等恢復後再以最新的容器與映像清單計算。
  const containerIssues = probeFailed
    ? 1
    : services.filter((status) => status !== "running").length +
      images.filter((status) => status === "outdated").length;
  return (
    containerIssues +
    Number(diskPaused || diskLevel === "low" || diskLevel === "critical")
  );
}
