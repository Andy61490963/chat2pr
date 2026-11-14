import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type Docker from "dockerode";
import { db, reset, fixture, session } from "./helpers.js";
import {
  classifyDisk,
  cleanupPlan,
  defaultDiskSettings,
  diskLevel,
  diskUsage,
  nextCleanupAt,
  type DiskSettings,
  type DiskVolume,
  type DockerDiskInventory,
  type OwnershipContext,
} from "../shared/docker-disk.js";
import {
  dailyDockerCleanup,
  dockerDiskInventory,
  removeDiskItems,
  type DiskRemoval,
} from "../server/docker-cleanup.js";
import {
  diskMaintenance,
  diskPaused,
  readDiskSettings,
} from "../server/docker-disk.js";
import { notificationView } from "../shared/notifications.js";

const GB = 1024 ** 3;
const now = Date.parse("2026-11-13T00:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86400_000).toISOString();
const sec = (d: number) => Math.floor((now - d * 86400_000) / 1000);
// 虛構的執行識別碼。
const run = {
  expired: "11111111-1111-4111-8111-111111111111",
  fresh: "22222222-2222-4222-8222-222222222222",
  active: "33333333-3333-4333-8333-333333333333",
  missing: "44444444-4444-4444-8444-444444444444",
};
const jobLabels = (runId: string, instance = "production") => ({
  "io.agentflow.managed": "true",
  "io.agentflow.instance": instance,
  "io.agentflow.run": runId,
});

const allOn: DiskSettings = {
  ...defaultDiskSettings,
  rules: {
    workspaces: { enabled: true, days: 1 },
    containers: { enabled: true },
    images: { enabled: true, days: 3 },
    build_cache: { enabled: true, limit_gb: 5 },
  },
};

/** 受保護的資料卷：名稱或標籤任一符合，就算被貼上工作區標籤也不刪。 */
const protectedVolumes: DiskVolume[] = [
  {
    name: "line-agentflow_database",
    size: 20 * GB,
    refCount: 0,
    labels: {
      "com.docker.compose.project": "line-agentflow",
      "com.docker.compose.volume": "database",
    },
  },
  {
    name: "line-agentflow_data",
    size: 3 * GB,
    refCount: 0,
    labels: {
      "com.docker.compose.project": "line-agentflow",
      "com.docker.compose.volume": "data",
    },
  },
  {
    name: "line-agentflow_embed-models",
    size: 2 * GB,
    refCount: 0,
    labels: {
      "com.docker.compose.project": "line-agentflow",
      "com.docker.compose.volume": "embed-models",
    },
  },
  {
    name: "agentflow-source-demo-repo",
    size: GB,
    refCount: 0,
    labels: { "io.agentflow.source-cache": "v1" },
  },
  {
    name: "agentflow-production-nuget-feed-v1",
    size: GB,
    refCount: 0,
    labels: {
      "io.agentflow.nuget-feed": "v1",
      "io.agentflow.instance": "production",
    },
  },
  {
    name: "agentflow-backup-archive",
    size: GB,
    refCount: 0,
    labels: {},
  },
  // 名稱像工作區，但其實是 Compose 的正式資料庫資料卷。
  {
    name: `agentflow-job-${run.expired}-env`,
    size: GB,
    refCount: 0,
    labels: {
      ...jobLabels(run.expired),
      "com.docker.compose.volume": "database",
    },
  },
  // 名稱是資料庫，卻被貼上工作區標籤。
  {
    name: "line-agentflow-copy_database",
    size: GB,
    refCount: 0,
    labels: jobLabels(run.expired),
  },
];
const unknownVolumes: DiskVolume[] = [
  { name: "a".repeat(64), size: 5 * GB, refCount: 0, labels: {} },
  {
    name: `agentflow-job-${run.missing}`,
    size: GB,
    refCount: 0,
    labels: jobLabels(run.missing),
  },
  // 其他實例或標籤不完整的工作區：無法確認是本實例的。
  {
    name: `agentflow-job-${run.fresh}-env`,
    size: GB,
    refCount: 0,
    labels: jobLabels(run.fresh, "acceptance-x"),
  },
  {
    name: `agentflow-job-${run.fresh}-baseline`,
    size: GB,
    refCount: 0,
    labels: { "io.agentflow.run": run.fresh },
  },
];

function inventory(): DockerDiskInventory {
  return {
    instance: "production",
    checkedAt: new Date(now).toISOString(),
    layersSize: 40 * GB,
    images: [
      {
        id: "sha256:worker-local",
        tags: ["line-agentflow-worker:local"],
        created: sec(40),
        size: 5 * GB,
        sharedSize: GB,
        containers: 1,
        labels: { "io.agentflow.worker": "v1" },
      },
      {
        id: "sha256:worker-old",
        tags: [
          "line-agentflow-worker:before-readability",
          "line-agentflow-worker:query-report-test",
        ],
        created: sec(30),
        size: 5 * GB,
        sharedSize: GB,
        containers: 0,
        labels: { "io.agentflow.worker": "v1" },
      },
      {
        id: "sha256:worker-project",
        tags: ["line-agentflow-worker:rag-production"],
        created: sec(30),
        size: 5 * GB,
        sharedSize: GB,
        containers: 0,
        labels: { "io.agentflow.worker": "v1" },
      },
      {
        id: "sha256:worker-new",
        tags: ["line-agentflow-worker:ux-audit"],
        created: sec(1),
        size: 5 * GB,
        sharedSize: GB,
        containers: 0,
        labels: { "io.agentflow.worker": "v1" },
      },
      {
        id: "sha256:derived-old",
        tags: ["demo-dotnet-worker:2026-10"],
        created: sec(20),
        size: 6 * GB,
        sharedSize: GB,
        containers: 0,
        labels: { "io.agentflow.worker": "v1" },
      },
      {
        id: "sha256:in-container",
        tags: ["line-agentflow-app:before-x"],
        created: sec(30),
        size: GB,
        sharedSize: 0,
        containers: 1,
        labels: {},
      },
      {
        id: "sha256:other",
        tags: ["comfyui:latest", "postgres:17-alpine"],
        created: sec(90),
        size: 3 * GB,
        sharedSize: 0,
        containers: 0,
        labels: {},
      },
      {
        id: "sha256:dangling-worker",
        tags: [],
        created: sec(90),
        size: GB,
        sharedSize: 0,
        containers: 0,
        labels: { "io.agentflow.worker": "v1" },
      },
      {
        id: "sha256:dangling-other",
        tags: [],
        created: sec(90),
        size: GB,
        sharedSize: 0,
        containers: 0,
        labels: {},
      },
    ],
    containers: [
      {
        id: "c-stopped-job",
        name: "agentflow-job-stopped",
        image: "line-agentflow-worker:local",
        imageId: "sha256:worker-local",
        state: "exited",
        sizeRw: 10 * 1024 ** 2,
        created: sec(5),
        labels: jobLabels(run.expired),
      },
      {
        id: "c-running-job",
        name: "agentflow-job-running",
        image: "line-agentflow-worker:local",
        imageId: "sha256:worker-local",
        state: "running",
        sizeRw: 1024 ** 2,
        created: sec(0),
        labels: jobLabels(run.active),
      },
      {
        id: "c-stopped-active",
        name: "agentflow-job-phase",
        image: "line-agentflow-worker:local",
        imageId: "sha256:worker-local",
        state: "exited",
        sizeRw: 1024 ** 2,
        created: sec(0),
        labels: jobLabels(run.active),
      },
      {
        id: "c-db",
        name: "line-agentflow-db-1",
        image: "pgvector/pgvector:pg17",
        imageId: "sha256:pg",
        state: "exited",
        sizeRw: 1024 ** 2,
        created: sec(50),
        labels: {
          "com.docker.compose.project": "line-agentflow",
          "com.docker.compose.service": "db",
        },
      },
      {
        id: "c-other",
        name: "someone-else",
        image: "comfyui:latest",
        imageId: "sha256:other",
        state: "exited",
        sizeRw: 1024 ** 2,
        created: sec(50),
        labels: {},
      },
    ],
    volumes: [
      ...protectedVolumes,
      ...unknownVolumes,
      {
        name: `agentflow-job-${run.expired}`,
        size: 2 * GB,
        refCount: 0,
        labels: jobLabels(run.expired),
      },
      {
        name: `agentflow-job-${run.expired}-baseline`,
        size: GB,
        refCount: 0,
        labels: jobLabels(run.expired),
      },
      {
        name: `agentflow-job-${run.fresh}`,
        size: 2 * GB,
        refCount: 0,
        labels: jobLabels(run.fresh),
      },
      {
        name: `agentflow-job-${run.active}`,
        size: 2 * GB,
        refCount: 1,
        labels: jobLabels(run.active),
      },
    ],
    buildCache: { count: 100, active: 2, size: 30 * GB, reclaimable: 25 * GB },
    host: { label: "主機磁碟", freeBytes: 200 * GB, totalBytes: 1000 * GB },
  };
}

const context = (settings: DiskSettings = allOn): OwnershipContext => ({
  instance: "production",
  now,
  projectImages: ["line-agentflow-worker:rag-production"],
  runs: {
    [run.expired]: { completedAt: daysAgo(4) },
    [run.fresh]: { completedAt: new Date(now - 3600_000).toISOString() },
    [run.active]: { completedAt: null },
  },
  settings,
});

describe("盤點與用量", () => {
  it("用量與 docker system df 的算法一致", () => {
    const usage = diskUsage(inventory());
    const images = usage.find((u) => u.kind === "images")!;
    // 在用的映像：worker-local（5-1）與 in-container（1-0）；可回收 = 40 - 5 = 35 GB。
    expect(images).toMatchObject({ total: 9, active: 2, size: 40 * GB });
    expect(images.reclaimable).toBe(35 * GB);
    const containers = usage.find((u) => u.kind === "containers")!;
    expect(containers).toMatchObject({ total: 5, active: 1 });
    expect(containers.reclaimable).toBe(10 * 1024 ** 2 + 3 * 1024 ** 2);
    const volumes = usage.find((u) => u.kind === "volumes")!;
    expect(volumes.active).toBe(1);
    expect(volumes.reclaimable).toBe(volumes.size - 2 * GB);
    expect(usage.find((u) => u.kind === "build_cache")).toMatchObject({
      size: 30 * GB,
      reclaimable: 25 * GB,
    });
  });

  it("執行器把 Docker 的 /system/df 整理成盤點，只保留歸屬需要的標籤", async () => {
    const docker = {
      df: async () => ({
        LayersSize: 7,
        Images: [
          {
            Id: "sha256:a",
            RepoTags: ["<none>:<none>"],
            Created: 1,
            Size: 3,
            SharedSize: 1,
            Containers: 0,
            Labels: { "io.agentflow.worker": "v1", "org.secret": "x" },
          },
        ],
        Containers: [
          {
            Id: "c1",
            Names: ["/job"],
            Image: "sha256:abcdefabcdefabcdef",
            ImageID: "sha256:a",
            State: "exited",
            SizeRw: 5,
            Created: 2,
            Labels: { "com.docker.compose.service": "db", PASSWORD: "x" },
          },
        ],
        Volumes: [
          { Name: "v1", Labels: null, UsageData: { Size: 9, RefCount: 0 } },
        ],
        BuildCache: [
          { Size: 4, InUse: false, Shared: false },
          { Size: 6, InUse: true, Shared: false },
          { Size: 8, InUse: false, Shared: true },
        ],
      }),
    } as unknown as Docker;
    const inv = await dockerDiskInventory(docker, "production", "Z:/不存在");
    expect(inv.images[0]).toMatchObject({
      tags: [],
      labels: { "io.agentflow.worker": "v1" },
    });
    expect(inv.containers[0]).toMatchObject({
      name: "job",
      image: "abcdefabcdef",
      labels: { "com.docker.compose.service": "db" },
    });
    expect(inv.volumes[0]).toEqual({
      name: "v1",
      size: 9,
      refCount: 0,
      labels: {},
    });
    expect(inv.buildCache).toEqual({
      count: 3,
      active: 1,
      size: 10,
      reclaimable: 4,
    });
    expect(inv.host).toBeNull();
  });
});

describe("專案衍生映像（#18）", () => {
  const derived = (
    tag: string,
    instance: string,
    createdDays: number,
  ): DockerDiskInventory["images"][number] => ({
    id: `sha256:${tag.replace(/\W/g, "")}`,
    tags: [tag],
    created: sec(createdDays),
    size: 5 * GB,
    sharedSize: 4 * GB,
    containers: 0,
    labels: {
      "io.agentflow.worker": "v1",
      "io.agentflow.derived": "v1",
      "io.agentflow.derived-instance": instance,
      "io.agentflow.project": "fictional-project",
    },
  });
  const inv = (): DockerDiskInventory => ({
    ...inventory(),
    images: [
      derived("line-agentflow-derived:idle", "production", 40),
      derived("line-agentflow-derived:recent", "production", 40),
      derived("line-agentflow-derived:unknown-use", "production", 1),
      derived("agentflow-verify-x-derived:other", "verify-x", 40),
    ],
  });
  const ctx = (settings: DiskSettings): OwnershipContext => ({
    ...context(settings),
    derived: {
      "line-agentflow-derived:idle": {
        project: "虛構訂單系統",
        lastUsed: daysAgo(20),
      },
      "line-agentflow-derived:recent": {
        project: "虛構訂單系統",
        lastUsed: daysAgo(1),
      },
    },
  });
  it("歸屬為專案衍生映像，以最後使用時間判斷；預設規則關閉時不自動刪", () => {
    const items = classifyDisk(inv(), ctx(defaultDiskSettings));
    expect(
      new Set(items.filter((i) => i.kind === "image").map((i) => i.owner)),
    ).toEqual(new Set(["derived_image"]));
    expect(cleanupPlan(items, defaultDiskSettings, true)).toEqual([]);
    const idle = items.find((i) => i.target === "line-agentflow-derived:idle");
    expect(idle?.detail).toContain("專案衍生映像（虛構訂單系統）");
    expect(idle?.detail).toContain("最後使用");
    // 預設 14 天；20 天沒用的可清，1 天前用過的保留（即使 40 天前建立）。
    expect(idle?.rule).toBe("images");
    const recent = items.find(
      (i) => i.target === "line-agentflow-derived:recent",
    );
    expect(recent?.rule).toBeUndefined();
    expect(recent?.detail).toContain("1 天內用過");
  });
  it("開啟規則後只清本實例、超過天數沒用的；其他實例的只列出", () => {
    const settings = {
      ...defaultDiskSettings,
      rules: {
        ...defaultDiskSettings.rules,
        images: { enabled: true, days: 14 },
      },
    };
    const items = classifyDisk(inv(), ctx(settings));
    expect(cleanupPlan(items, settings, true).map((i) => i.target)).toEqual([
      "line-agentflow-derived:idle",
    ]);
    expect(
      items.find((i) => i.target === "agentflow-verify-x-derived:other")
        ?.protected,
    ).toContain("其他執行環境");
  });
});

describe("清理規則", () => {
  it("預設全部規則關閉：自動清理沒有任何項目", () => {
    expect(
      Object.values(defaultDiskSettings.rules).every((r) => !r.enabled),
    ).toBe(true);
    expect(defaultDiskSettings.pause_enabled).toBe(false);
    const items = classifyDisk(inventory(), context(defaultDiskSettings));
    expect(cleanupPlan(items, defaultDiskSettings, true)).toEqual([]);
  });

  it("正式資料庫、備份、快取與無法確認歸屬的資料卷在任何規則下都不會被列入清理", () => {
    const protectedNames = new Set(
      [...protectedVolumes, ...unknownVolumes].map((v) => `volume:${v.name}`),
    );
    for (const days of [1, 3, 30])
      for (const enabledOnly of [true, false]) {
        const settings = {
          ...allOn,
          rules: { ...allOn.rules, workspaces: { enabled: true, days } },
        };
        const items = classifyDisk(inventory(), context(settings));
        const plan = cleanupPlan(items, settings, enabledOnly);
        // 同名的受保護資料卷（例如被貼上工作區標籤的 line-agentflow_database）也不能混進來。
        const volumeKeys = plan
          .filter((i) => i.kind === "volume")
          .map((i) => i.key);
        expect(
          volumeKeys.every(
            (k) =>
              k === `volume:agentflow-job-${run.expired}` ||
              k === `volume:agentflow-job-${run.expired}-baseline`,
          ),
        ).toBe(true);
        for (const v of protectedVolumes) {
          const listed = items.filter(
            (i) => i.key === `volume:${v.name}` && i.protected,
          );
          expect(listed.length).toBeGreaterThan(0);
        }
        expect(plan.some((i) => protectedNames.has(i.key))).toBe(false);
      }
  });

  it("工作區資料卷：超過保留期才清；執行中、保留期內、找不到執行紀錄的不清", () => {
    const items = classifyDisk(inventory(), context());
    const plan = cleanupPlan(items, allOn, true).map((i) => i.key);
    expect(plan).toContain(`volume:agentflow-job-${run.expired}`);
    expect(plan).not.toContain(`volume:agentflow-job-${run.fresh}`);
    expect(plan).not.toContain(`volume:agentflow-job-${run.active}`);
    expect(plan).not.toContain(`volume:agentflow-job-${run.missing}`);
    expect(
      items.find((i) => i.key === `volume:agentflow-job-${run.missing}`)
        ?.protected,
    ).toContain("無法確認歸屬");
    // 保留天數拉長到 7 天，4 天前結束的也保留。
    const longer = {
      ...allOn,
      rules: { ...allOn.rules, workspaces: { enabled: true, days: 7 } },
    };
    expect(
      cleanupPlan(
        classifyDisk(inventory(), context(longer)),
        longer,
        true,
      ).some((i) => i.rule === "workspaces"),
    ).toBe(false);
  });

  it("容器：只清本實例已停止、執行已結束的工作容器", () => {
    const plan = cleanupPlan(
      classifyDisk(inventory(), context()),
      allOn,
      true,
    ).filter((i) => i.kind === "container");
    expect(plan.map((i) => i.target)).toEqual(["c-stopped-job"]);
  });

  it("同一份盤點裡，定期檢查環境（#19）與專案衍生映像（#18）各自歸屬，互不混淆", () => {
    const inv = inventory();
    inv.images.push(
      {
        id: "sha256:derived-x",
        tags: ["line-agentflow-derived:abc"],
        created: sec(30),
        size: 5 * GB,
        sharedSize: 4 * GB,
        containers: 0,
        labels: {
          "io.agentflow.worker": "v1",
          "io.agentflow.derived": "v1",
          "io.agentflow.derived-instance": "production",
          // 建置容器的歸屬標籤在映像上是空的。
          "io.agentflow.instance": "",
          "io.agentflow.managed": "",
          "io.agentflow.run": "",
        },
      },
      {
        id: "sha256:check-image",
        tags: ["line-agentflow-check:local"],
        created: sec(30),
        size: GB,
        sharedSize: 0,
        containers: 1,
        labels: { "io.agentflow.check-image": "v1" },
      },
    );
    inv.containers.push({
      id: "c-check-probe",
      name: "agentflow-check-0b3a2d6e-1f00-4c1a-9a00-00000000000a-probe",
      image: "line-agentflow-check:local",
      imageId: "sha256:check-image",
      state: "running",
      sizeRw: 1024,
      created: sec(1),
      labels: {
        "io.agentflow.managed": "true",
        "io.agentflow.instance": "production",
        "io.agentflow.check": "0b3a2d6e-1f00-4c1a-9a00-00000000000a",
        "io.agentflow.check-role": "probe",
      },
    });
    const items = classifyDisk(inv, {
      ...context(),
      derived: {
        "line-agentflow-derived:abc": {
          project: "虛構訂單系統",
          lastUsed: daysAgo(20),
        },
      },
    });
    const owner = (target: string) =>
      items.find((i) => i.target === target)?.owner;
    expect(owner("line-agentflow-derived:abc")).toBe("derived_image");
    expect(owner("line-agentflow-check:local")).toBe("service_image");
    expect(owner("c-check-probe")).toBe("check_container");
    expect(cleanupPlan(items, allOn, true).map((i) => i.target)).toContain(
      "line-agentflow-derived:abc",
    );
    expect(cleanupPlan(items, allOn, false).map((i) => i.target)).not.toContain(
      "line-agentflow-check:local",
    );
  });

  it("定期檢查環境（#19）的容器認得歸屬，但只列出不清：由執行器依閒置逾時清除", () => {
    const inv = inventory();
    inv.containers.push({
      id: "c-check-probe",
      name: "agentflow-check-0b3a2d6e-1f00-4c1a-9a00-00000000000a-probe",
      image: "line-agentflow-check:local",
      imageId: "sha256:check",
      state: "exited",
      sizeRw: 1024,
      created: sec(1),
      labels: {
        "io.agentflow.managed": "true",
        "io.agentflow.instance": "production",
        "io.agentflow.check": "0b3a2d6e-1f00-4c1a-9a00-00000000000a",
        "io.agentflow.check-role": "probe",
      },
    });
    const items = classifyDisk(inv, context());
    const probe = items.find((i) => i.target === "c-check-probe")!;
    expect(probe.owner).toBe("check_container");
    expect(probe.protected).toContain("定期檢查環境");
    expect(probe.rule).toBeUndefined();
    expect(cleanupPlan(items, allOn, false).map((i) => i.target)).not.toContain(
      "c-check-probe",
    );
  });

  it("映像：只清沒有專案、沒有容器在用、超過天數的本系統映像；:local 與其他專案的映像不動", () => {
    const items = classifyDisk(inventory(), context());
    const plan = cleanupPlan(items, allOn, true)
      .filter((i) => i.kind === "image")
      .map((i) => i.target)
      .sort();
    expect(plan).toEqual([
      "demo-dotnet-worker:2026-10",
      "line-agentflow-worker:before-readability",
      "line-agentflow-worker:query-report-test",
      "sha256:dangling-worker",
    ]);
    expect(
      items.find((i) => i.key === "image:comfyui:latest")?.protected,
    ).toBeTruthy();
    expect(
      items.find((i) => i.key === "image:sha256:dangling-other")?.protected,
    ).toBeTruthy();
  });

  it("建置快取超過上限時清到上限", () => {
    const cache = classifyDisk(inventory(), context()).find(
      (i) => i.kind === "build_cache",
    );
    expect(cache).toMatchObject({ target: String(5 * GB), size: 25 * GB });
    const roomy = {
      ...allOn,
      rules: { ...allOn.rules, build_cache: { enabled: true, limit_gb: 50 } },
    };
    expect(
      classifyDisk(inventory(), context(roomy)).some(
        (i) => i.kind === "build_cache",
      ),
    ).toBe(false);
  });

  it("空間等級取最緊的一顆磁碟；下次清理排在整點 10 分", () => {
    const s = defaultDiskSettings;
    expect(
      diskLevel(
        [
          { label: "a", freeBytes: 50, totalBytes: 100 },
          { label: "b", freeBytes: 10, totalBytes: 100 },
        ],
        s,
      ),
    ).toMatchObject({ level: "low", freePercent: 10 });
    expect(
      diskLevel([{ label: "a", freeBytes: 4, totalBytes: 100 }], s).level,
    ).toBe("critical");
    expect(diskLevel([], s).level).toBe("unknown");
    expect(
      nextCleanupAt(null, new Date("2026-11-13T03:20:00Z")).toISOString(),
    ).toBe("2026-11-13T04:10:00.000Z");
    expect(
      nextCleanupAt(
        new Date("2026-11-12T05:10:30Z"),
        new Date("2026-11-13T03:20:00Z"),
      ).toISOString(),
    ).toBe("2026-11-13T05:10:00.000Z");
  });
});

describe("執行器端再核對", () => {
  function fakeDocker(volumes: DiskVolume[]) {
    const removed: string[] = [];
    const docker = {
      getVolume: (name: string) => ({
        inspect: async () => {
          const v = volumes.find((x) => x.name === name);
          if (!v) throw Object.assign(new Error("no"), { statusCode: 404 });
          return { Name: v.name, Labels: v.labels };
        },
        remove: async () => {
          removed.push(`volume:${name}`);
        },
      }),
      getImage: (name: string) => ({
        inspect: async () => ({
          RepoTags: name.startsWith("sha256:") ? [] : [name],
          Config: {
            Labels: name.startsWith("comfyui")
              ? {}
              : { "io.agentflow.worker": "v1" },
          },
        }),
        remove: async (opts?: unknown) => {
          removed.push(`image:${name}${opts ? JSON.stringify(opts) : ""}`);
        },
      }),
      getContainer: (id: string) => ({
        inspect: async () => ({
          Config: {
            Labels:
              id === "c-other"
                ? {}
                : jobLabels(id === "c-active" ? run.active : run.expired),
          },
          State: { Running: id === "c-running", Paused: false },
        }),
        remove: async (opts?: unknown) => {
          removed.push(`container:${id}${opts ? JSON.stringify(opts) : ""}`);
        },
      }),
    } as unknown as Docker;
    const owned: string[] = [];
    return {
      removed,
      owned,
      env: {
        docker,
        instance: "production",
        isActive: (id: string) => id === run.active,
        removeOwnedVolume: async (name: string) => {
          owned.push(name);
        },
      },
    };
  }

  it("就算應用程式直接要求，受保護與無法確認歸屬的資料卷也一律拒絕", async () => {
    const legit = {
      name: `agentflow-job-${run.expired}`,
      size: GB,
      refCount: 0,
      labels: jobLabels(run.expired),
    };
    const all = [...protectedVolumes, ...unknownVolumes, legit];
    const { env, removed, owned } = fakeDocker(all);
    const requests: DiskRemoval[] = all.map((v) => ({
      kind: "volume",
      target: v.name,
      runId: run.expired,
    }));
    const report = await removeDiskItems(env, requests, []);
    expect(owned).toEqual([legit.name]);
    expect(removed).toEqual([]);
    expect(report.removed).toEqual([`volume:${legit.name}`]);
    expect(report.failed.length).toBe(all.length - 1);
  });

  it("映像與容器不加 force；:local、專案在用、其他專案與執行中的一律拒絕", async () => {
    const { env, removed } = fakeDocker([]);
    const report = await removeDiskItems(
      env,
      [
        { kind: "image", target: "line-agentflow-worker:old" },
        { kind: "image", target: "line-agentflow-worker:local" },
        { kind: "image", target: "line-agentflow-worker:rag-production" },
        { kind: "image", target: "comfyui:latest" },
        { kind: "image", target: "sha256:dangling-worker" },
        { kind: "container", target: "c-stopped" },
        { kind: "container", target: "c-running" },
        { kind: "container", target: "c-active" },
        { kind: "container", target: "c-other" },
      ],
      ["line-agentflow-worker:rag-production"],
    );
    expect(removed).toEqual([
      "image:line-agentflow-worker:old",
      "image:sha256:dangling-worker",
      "container:c-stopped",
    ]);
    expect(report.failed.map((f) => f.key)).toEqual([
      "image:line-agentflow-worker:local",
      "image:line-agentflow-worker:rag-production",
      "image:comfyui:latest",
      "container:c-running",
      "container:c-active",
      "container:c-other",
    ]);
  });

  it("建置快取依上限清理，從最舊的清起", async () => {
    let seen: { path: string; options: unknown } | undefined;
    const env = {
      docker: {
        modem: {
          dial: (
            opts: { path: string; options: unknown },
            done: (e: unknown, d: unknown) => void,
          ) => {
            seen = opts;
            done(null, { SpaceReclaimed: 3 * GB });
          },
        },
      } as unknown as Docker,
      instance: "production",
      isActive: () => false,
      removeOwnedVolume: async () => {},
    };
    const report = await removeDiskItems(
      env,
      [
        { kind: "build_cache", target: String(20 * GB) },
        { kind: "build_cache", target: "12" },
      ],
      [],
    );
    expect(seen?.path).toBe("/build/prune?");
    expect(seen?.options).toEqual({
      all: true,
      "keep-storage": 20 * GB,
      "max-used-space": 20 * GB,
    });
    expect(report.cacheBytes).toBe(3 * GB);
    expect(report.failed).toEqual([
      { key: "build_cache", reason: "建置快取上限錯誤" },
    ]);
  });
});

describe("排程、提醒與看板", () => {
  // 其他測試檔不重設這張表；每個測試前後都回到預設，避免影響既有每日清理的測試。
  const clear = () =>
    db.query(
      "UPDATE docker_disk SET settings='{}',level='unknown',free_percent=NULL,detail=NULL,checked_at=NULL WHERE id=1",
    );
  beforeEach(async () => {
    await reset();
    await clear();
  });
  afterEach(clear);
  afterAll(() => db.close());

  const runner = (
    free: number,
    removals: unknown[] = [],
    paths: string[] = [],
  ) => {
    const call = async <T>(path: string, body: unknown): Promise<T> => {
      paths.push(path);
      if (path === "maintenance/disk/space")
        return {
          space: {
            label: "主機磁碟",
            freeBytes: free * GB,
            totalBytes: 100 * GB,
          },
        } as T;
      if (path === "maintenance/disk/inventory")
        return {
          ...inventory(),
          host: {
            label: "主機磁碟",
            freeBytes: free * GB,
            totalBytes: 100 * GB,
          },
        } as T;
      if (path === "maintenance/disk/remove") {
        removals.push(body);
        const items = (body as { items: { kind: string; target: string }[] })
          .items;
        return {
          removed: items.map((i) =>
            i.kind === "build_cache" ? "build_cache" : `${i.kind}:${i.target}`,
          ),
          failed: [],
          cacheBytes: 0,
        } as T;
      }
      throw new Error(`未預期的呼叫 ${path}`);
    };
    return call;
  };
  const options = { now: new Date(now), appSpace: async () => null };
  const insertRuns = async () => {
    const project = await fixture();
    const task = await db.one<{ id: string }>(
      "INSERT INTO tasks(group_id,project_id,title,summary,status,dedupe_key) VALUES('group-a',$1,'測試','測試','ready','disk-test') RETURNING id",
      [project],
    );
    for (const [id, done] of [
      [run.expired, daysAgo(4)],
      [run.fresh, new Date(now - 3600_000).toISOString()],
      [run.active, null],
    ] as const)
      await db.query(
        "INSERT INTO runs(id,task_id,version,model,deadline,completed_at) VALUES($1,$2,1,'m',now(),$3)",
        [id, task.id, done],
      );
  };

  it("預設只盤點與提醒：空間不足時私訊管理者一次，不刪任何東西，也不暫停派工", async () => {
    const removals: unknown[] = [];
    const paths: string[] = [];
    await diskMaintenance(db, runner(10, removals, paths), options);
    await diskMaintenance(db, runner(10, removals, paths), options);
    expect(removals).toEqual([]);
    // 沒有開啟規則時每小時只讀可用空間，不跑完整盤點。
    expect(new Set(paths)).toEqual(new Set(["maintenance/disk/space"]));
    const sent = await db.query<{ kind: string; text: string }>(
      "SELECT kind,text FROM notifications ORDER BY created_at",
    );
    expect(sent.map((n) => n.kind)).toEqual(["disk_low"]);
    expect(sent[0].text).toContain("低於提醒門檻 15%");
    expect(notificationView("disk_low")).toBe("system");
    // 嚴重不足但沒開啟暫停：只提醒。
    await diskMaintenance(db, runner(3, removals), options);
    expect(await diskPaused(db)).toBe(false);
    const latest = await db.one<{ text: string }>(
      "SELECT text FROM notifications ORDER BY created_at DESC LIMIT 1",
    );
    expect(latest.text).toContain("暫停派工未開啟，只提醒");
    // 剛好回到門檻不算恢復，多 1 個百分點才通知恢復。
    await diskMaintenance(db, runner(15.5, removals), options);
    expect(
      await db.query("SELECT 1 FROM notifications WHERE kind='disk_ok'"),
    ).toHaveLength(0);
    await diskMaintenance(db, runner(30, removals), options);
    expect(
      await db.query("SELECT 1 FROM notifications WHERE kind='disk_ok'"),
    ).toHaveLength(1);
    expect(
      await db.query("SELECT 1 FROM audit WHERE kind LIKE 'docker_disk%'"),
    ).toHaveLength(0);
  });

  it("開啟暫停派工後，嚴重不足時暫停，回升後恢復", async () => {
    await db.query(
      "UPDATE docker_disk SET settings='{\"pause_enabled\":true}' WHERE id=1",
    );
    await diskMaintenance(db, runner(3), options);
    expect(await diskPaused(db)).toBe(true);
    const text = (
      await db.one<{ text: string }>(
        "SELECT text FROM notifications WHERE kind='disk_low'",
      )
    ).text;
    expect(text).toContain("已暫停派新工作");
    await diskMaintenance(db, runner(40), options);
    expect(await diskPaused(db)).toBe(false);
  });

  it("開啟的規則每天自動清一次，只清開啟的規則，結果寫進活動紀錄", async () => {
    await insertRuns();
    await db.query("UPDATE docker_disk SET settings=$1 WHERE id=1", [
      JSON.stringify({ rules: { workspaces: { enabled: true, days: 3 } } }),
    ]);
    const removals: { items: { kind: string; target: string }[] }[] = [];
    await diskMaintenance(db, runner(50, removals), options);
    await diskMaintenance(db, runner(50, removals), options);
    expect(removals).toHaveLength(1);
    expect(removals[0].items.map((i) => i.target).sort()).toEqual([
      `agentflow-job-${run.expired}`,
      `agentflow-job-${run.expired}-baseline`,
    ]);
    const trail = await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='docker_disk_auto'",
    );
    expect(trail).toHaveLength(1);
    expect(trail[0].detail).toContain("已結束任務的工作區資料卷");
  });

  it("看板：預覽列出可清理項目，確認後只刪確認且仍符合條件的項目，並寫稽核", async () => {
    await insertRuns();
    const removals: { items: { kind: string; target: string }[] }[] = [];
    const { buildApp } = await import("../server/app.js");
    const app = await buildApp(db, undefined, undefined, undefined, {
      call: runner(50, removals),
    });
    try {
      const headers = await session();
      const report = (
        await app.inject({ url: "/api/system/disk", headers })
      ).json();
      expect(report.settings.rules.workspaces.enabled).toBe(false);
      expect(report.nextCleanupAt).not.toBeNull(); // 既有每日清理仍開啟
      expect(report.usage.map((u: { label: string }) => u.label)).toEqual([
        "映像",
        "容器",
        "資料卷",
        "建置快取",
      ]);
      const keys = report.candidates.map((c: { key: string }) => c.key);
      expect(keys).toContain(`volume:agentflow-job-${run.expired}`);
      expect(keys).not.toContain("volume:line-agentflow_database");
      expect(
        report.protected.some(
          (p: { name: string }) => p.name === "line-agentflow_database",
        ),
      ).toBe(true);

      // 只送受保護的項目：不會被刪。
      const refused = await app.inject({
        method: "POST",
        url: "/api/system/disk/cleanup",
        headers,
        payload: {
          keys: [
            "volume:line-agentflow_database",
            "volume:line-agentflow_data",
          ],
        },
      });
      expect(refused.statusCode).toBe(409);
      expect(removals).toEqual([]);

      const done = await app.inject({
        method: "POST",
        url: "/api/system/disk/cleanup",
        headers,
        payload: {
          keys: [
            `volume:agentflow-job-${run.expired}`,
            "volume:line-agentflow_database",
          ],
        },
      });
      expect(done.statusCode).toBe(200);
      expect(removals).toHaveLength(1);
      expect(removals[0].items).toEqual([
        {
          kind: "volume",
          target: `agentflow-job-${run.expired}`,
          runId: run.expired,
        },
      ]);
      const audit = await db.one<{ detail: string }>(
        "SELECT detail FROM audit WHERE kind='docker_disk_cleanup'",
      );
      expect(audit.detail).toContain("在看板確認清理 Docker");
      expect(audit.detail).toContain(`agentflow-job-${run.expired}`);
      expect(audit.detail).toContain("1 項已變動未處理");

      const saved = await app.inject({
        method: "PUT",
        url: "/api/system/disk/settings",
        headers,
        payload: {
          ...defaultDiskSettings,
          rules: {
            ...defaultDiskSettings.rules,
            containers: { enabled: true },
          },
        },
      });
      expect(saved.statusCode).toBe(200);
      expect((await readDiskSettings(db)).rules.containers.enabled).toBe(true);
      expect(
        (
          await db.one<{ detail: string }>(
            "SELECT detail FROM audit WHERE kind='docker_disk_settings'",
          )
        ).detail,
      ).toContain("停止的工作容器：開啟");
      const bad = await app.inject({
        method: "PUT",
        url: "/api/system/disk/settings",
        headers,
        payload: { ...defaultDiskSettings, pause_percent: 20 },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("管理者關閉既有每日清理後，不再呼叫執行器清理", async () => {
    await db.query(
      "UPDATE docker_disk SET settings='{\"daily_cleanup\":false}' WHERE id=1",
    );
    let called = false;
    await dailyDockerCleanup(db, async <T>() => {
      called = true;
      return {} as T;
    });
    expect(called).toBe(false);
  });
});
