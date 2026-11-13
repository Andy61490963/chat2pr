import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, reset, fixture } from "./helpers.js";
import {
  cleanupCandidates,
  cleanupDocker,
  cleanupSummary,
  dailyDockerCleanup,
  pruneBuildCache,
} from "../server/docker-cleanup.js";
import type Docker from "dockerode";

const day = 86400;
const now = Date.parse("2026-11-13T00:00:00Z");
const old = now / 1000 - 30 * day,
  fresh = now / 1000 - 2 * day;

describe("要清理的映像標籤", () => {
  const images = [
    {
      Id: "sha:app-old",
      Created: old,
      RepoTags: [
        "line-agentflow-app:before-readability",
        "line-agentflow-app:readability-test",
      ],
    },
    {
      Id: "sha:app-latest",
      Created: old,
      RepoTags: ["line-agentflow-app:latest"],
    },
    {
      Id: "sha:app-new",
      Created: fresh,
      RepoTags: ["line-agentflow-app:ux-audit-release"],
    },
    {
      Id: "sha:worker-old",
      Created: old,
      RepoTags: [
        "line-agentflow-worker:local",
        "line-agentflow-worker:before-query-reports",
        "line-agentflow-worker:rag-production",
      ],
    },
    {
      Id: "sha:running",
      Created: old,
      RepoTags: ["line-agentflow-worker:query-report-test"],
    },
    {
      Id: "sha:mssql",
      Created: old,
      RepoTags: ["line-agentflow-worker-mssql:local"],
    },
    {
      Id: "sha:other",
      Created: old,
      RepoTags: [
        "comfyui:latest",
        "postgres:17-alpine",
        "line-agentflow-egress:old",
      ],
    },
    { Id: "sha:dangling", Created: old, RepoTags: null as unknown as string[] },
  ];

  it("只挑本系統的 app／worker 舊標籤；保留 latest、local、專案在用、容器在用與 14 天內的", () => {
    const result = cleanupCandidates(images, {
      keep: ["line-agentflow-worker:rag-production"],
      inUse: new Set(["sha:running"]),
      now,
    });
    expect(result).toEqual({
      candidates: [
        "line-agentflow-app:before-readability",
        "line-agentflow-app:readability-test",
        "line-agentflow-worker:before-query-reports",
      ],
      keptInUse: ["line-agentflow-worker:query-report-test"],
    });
  });

  it("透過 Docker API 刪除候選標籤（不強制）、清懸空映像，建置快取只清超過期限的", async () => {
    const calls: string[] = [];
    let dial: { path: string; options: unknown } | undefined;
    const docker = {
      listContainers: async () => [{ ImageID: "sha:running" }],
      listImages: async () =>
        images.map((i) => ({ ...i, Created: i.Created - 0 })),
      getImage: (name: string) => ({
        remove: async (opts?: unknown) => {
          calls.push(`remove ${name} ${JSON.stringify(opts ?? {})}`);
          if (name.endsWith("readability-test")) throw new Error("conflict");
        },
      }),
      pruneImages: async (opts: unknown) => {
        calls.push(`pruneImages ${JSON.stringify(opts)}`);
        return {
          ImagesDeleted: [{ Deleted: "sha:dangling" }],
          SpaceReclaimed: 2 * 1024 ** 3,
        };
      },
      pruneBuilder: async () => {
        throw new Error("不可使用：會忽略條件整個清空");
      },
      modem: {
        dial: (
          opts: { path: string; options: unknown },
          done: (e: unknown, d: unknown) => void,
        ) => {
          dial = { path: opts.path, options: opts.options };
          done(null, { SpaceReclaimed: 5 * 1024 ** 3 });
        },
      },
    } as unknown as Docker;
    const report = await cleanupDocker(docker, {
      keep: ["line-agentflow-worker:rag-production"],
    });
    expect(report.removedTags).toEqual([
      "line-agentflow-app:before-readability",
      "line-agentflow-worker:before-query-reports",
    ]);
    expect(report.errors).toEqual([
      "無法刪除 line-agentflow-app:readability-test",
    ]);
    expect(calls).toContain(
      'pruneImages {"filters":{"dangling":{"true":true}}}',
    );
    expect(calls.every((c) => !c.includes("force"))).toBe(true);
    expect(dial).toEqual({
      path: "/build/prune?",
      options: { filters: { until: ["168h"] } },
    });
    expect(cleanupSummary(report)).toBe(
      "Docker 定期清理：刪除 2 個舊映像標籤；1 個懸空映像；建置快取 5.0 GB；映像共釋放 2.0 GB；1 個舊標籤仍有容器在用，保留；未完成：無法刪除 line-agentflow-app:readability-test",
    );
  });

  it("建置快取清理把期限放進查詢條件", async () => {
    let seen: unknown;
    await pruneBuildCache(
      {
        modem: {
          dial: (
            opts: { options: unknown },
            done: (e: unknown, d: unknown) => void,
          ) => {
            seen = opts.options;
            done(null, {});
          },
        },
      } as unknown as Docker,
      24,
    );
    expect(seen).toEqual({ filters: { until: ["24h"] } });
  });
});

describe("每日排程", () => {
  beforeEach(reset);
  afterAll(() => db.close());

  it("把專案在用的映像交給執行器，結果寫進活動紀錄；23 小時內不重複執行", async () => {
    const project = await fixture();
    await db.query(
      "UPDATE projects SET image='line-agentflow-worker:rag-production' WHERE id=$1",
      [project],
    );
    const bodies: unknown[] = [];
    const call = async <T>(path: string, body: unknown): Promise<T> => {
      expect(path).toBe("maintenance/docker");
      bodies.push(body);
      return {
        removedTags: ["line-agentflow-app:before-x"],
        keptInUse: [],
        dangling: 0,
        reclaimedBytes: 0,
        cacheBytes: 0,
        errors: [],
      } as T;
    };
    await dailyDockerCleanup(db, call);
    await dailyDockerCleanup(db, call);
    expect(bodies).toEqual([
      { keep: ["line-agentflow-worker:rag-production"] },
    ]);
    const trail = await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='docker_cleanup'",
    );
    expect(trail).toHaveLength(1);
    expect(trail[0].detail).toContain("刪除 1 個舊映像標籤");
  });

  it("驗收實例回報略過時不留紀錄", async () => {
    await dailyDockerCleanup(db, async <T>() => ({ skipped: true }) as T);
    expect(
      await db.query("SELECT 1 FROM audit WHERE kind='docker_cleanup'"),
    ).toHaveLength(0);
  });
});
