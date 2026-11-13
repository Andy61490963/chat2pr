import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type Docker from "dockerode";
import { Containers } from "../server/containers.js";
import { AppError } from "../server/policy.js";

afterEach(() => vi.useRealTimers());
const conflict = () =>
  Object.assign(new Error("removal already in progress"), { statusCode: 409 });
const missing = () =>
  Object.assign(new Error("not found"), { statusCode: 404 });

it("移除回應 409 時等待容器真正消失，資料卷不會提前清除", async () => {
  const c = new Containers("verify-cleanup-race"),
    runId = randomUUID();
  let exists = true,
    inspections = 0,
    removals = 0;
  const labels = c.labels(runId),
    volumeRemovals: string[] = [];
  const container = {
    inspect: async () => {
      if (++inspections >= 4) exists = false;
      if (!exists) throw missing();
      return { Config: { Labels: labels } };
    },
    remove: async () => {
      removals++;
      throw conflict();
    },
  };
  c.docker = {
    listContainers: async () => (exists ? [{ Id: "own-id" }] : []),
    getContainer: () => container,
    getVolume: (name: string) => ({
      inspect: async () => ({ Labels: labels }),
      remove: async () => {
        expect(exists).toBe(false);
        volumeRemovals.push(name);
      },
    }),
  } as unknown as Docker;
  await Promise.all([
    c.removeOwnedContainer("own-id", runId),
    c.dispose(runId),
  ]);
  expect(removals).toBe(3);
  expect(volumeRemovals).toEqual([
    c.volume(runId),
    `${c.volume(runId)}-baseline`,
  ]);
});

it("每次重試重讀所有權，不認領名稱相同但其他 instance 的資源", async () => {
  const c = new Containers("verify-cleanup-owner"),
    runId = randomUUID();
  let inspections = 0,
    removals = 0;
  c.docker = {
    getContainer: () => ({
      inspect: async () => ({
        Config: {
          Labels: {
            ...c.labels(runId),
            "io.agentflow.instance":
              ++inspections === 1 ? c.instance : "production",
          },
        },
      }),
      remove: async () => {
        removals++;
        throw conflict();
      },
    }),
  } as unknown as Docker;
  await expect(c.removeOwnedContainer("same-id", runId)).rejects.toThrow(
    "拒絕清除",
  );
  expect(removals).toBe(1);
});

it("持續 409 的重試有界，非 409 的 Docker 故障立即回報", async () => {
  vi.useFakeTimers();
  const c = new Containers("verify-cleanup-bounded"),
    runId = randomUUID();
  const remove = vi.fn(async () => {
    throw conflict();
  });
  c.docker = {
    getContainer: () => ({
      inspect: async () => ({ Config: { Labels: c.labels(runId) } }),
      remove,
    }),
  } as unknown as Docker;
  const rejected = expect(
    c.removeOwnedContainer("own-id", runId, 250),
  ).rejects.toMatchObject({ statusCode: 503 });
  await vi.advanceTimersByTimeAsync(300);
  await rejected;
  expect(remove).toHaveBeenCalledTimes(3);
  remove.mockImplementation(async () => {
    throw Object.assign(new Error("Docker unavailable"), { statusCode: 500 });
  });
  await expect(c.removeOwnedContainer("own-id", runId)).rejects.toMatchObject({
    statusCode: 500,
  });
  expect(remove).toHaveBeenCalledTimes(4);
});

it("資料卷使用中只有限重試，重試前仍核對所有權", async () => {
  const c = new Containers("verify-cleanup-volume"),
    runId = randomUUID();
  let removals = 0,
    baselineRemoved = false;
  c.docker = {
    listContainers: async () => [],
    getVolume: (name: string) => ({
      inspect: async () => ({ Labels: c.labels(runId) }),
      remove: async () => {
        if (name.endsWith("-baseline")) {
          baselineRemoved = true;
          return;
        }
        if (++removals < 3) throw conflict();
      },
    }),
  } as unknown as Docker;
  await c.dispose(runId);
  expect(removals).toBe(3);
  expect(baselineRemoved).toBe(true);
});

it("清理故障保留原始 408 與原因，不被 Docker 409 或回應內容蓋掉", async () => {
  const c = new Containers("verify-cleanup-cause"),
    runId = randomUUID();
  vi.spyOn(c, "removeOwnedContainer").mockRejectedValue(
    new Error("不應公開的 Docker 回應"),
  );
  await expect(
    c.finishContainer(
      "own-id",
      runId,
      new AppError(408, "專案快取準備超過時間限制"),
    ),
  ).rejects.toMatchObject({
    statusCode: 408,
    message: "專案快取準備超過時間限制；容器清理尚未完成，請重試清理",
  });
});

it("資料卷 409 後所有權改變立即拒絕，其他環境與基底都不再刪除", async () => {
  const c = new Containers("verify-cleanup-volume-owner"),
    runId = randomUUID();
  let inspected = 0,
    removed = 0;
  c.docker = {
    listContainers: async () => [],
    getVolume: () => ({
      inspect: async () => ({
        Labels: {
          ...c.labels(runId),
          "io.agentflow.instance":
            ++inspected === 1 ? c.instance : "production",
        },
      }),
      remove: async () => {
        removed++;
        throw conflict();
      },
    }),
  } as unknown as Docker;
  await expect(c.dispose(runId)).rejects.toThrow("拒絕清除");
  expect(removed).toBe(1);
});

it("封存檔準備失敗後清理也失敗，仍保留第一個錯誤與狀態碼", async () => {
  const c = new Containers("verify-prepare-first-cause"),
    runId = randomUUID();
  vi.spyOn(c, "ready").mockResolvedValue("fake-image");
  vi.spyOn(c, "ensureVolume").mockResolvedValue();
  vi.spyOn(c, "removeOwnedContainer").mockRejectedValue(
    new AppError(503, "後續清理失敗"),
  );
  c.docker = {
    createContainer: async () => ({
      id: "fake-helper",
      start: async () => {
        throw new AppError(408, "原始封存檔初始化失敗");
      },
    }),
  } as unknown as Docker;
  await expect(c.prepare(runId, "fake", Buffer.alloc(0))).rejects.toMatchObject(
    {
      statusCode: 408,
      message: "原始封存檔初始化失敗；容器清理尚未完成，請重試清理",
    },
  );
});

it("可信基底快照失敗後清理也失敗，不會被後續清理原因取代", async () => {
  const c = new Containers("verify-snapshot-first-cause"),
    runId = randomUUID();
  vi.spyOn(c, "ready").mockResolvedValue("fake-image");
  vi.spyOn(c, "ensureVolume").mockResolvedValue();
  vi.spyOn(c, "phase").mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  vi.spyOn(c, "removeOwnedContainer").mockImplementation(async (id) => {
    if (id === "fake-snapshot") throw new AppError(503, "後續清理失敗");
  });
  let created = 0;
  c.docker = {
    createContainer: async () =>
      ++created === 1
        ? {
            id: "fake-helper",
            start: async () => {},
            wait: async () => ({ StatusCode: 0 }),
            putArchive: async () => {},
          }
        : {
            id: "fake-snapshot",
            start: async () => {},
            wait: async () => ({ StatusCode: 1 }),
          },
  } as unknown as Docker;
  await expect(c.prepare(runId, "fake", Buffer.alloc(0))).rejects.toMatchObject(
    {
      statusCode: 500,
      message: "無法記錄唯讀工作基底；容器清理尚未完成，請重試清理",
    },
  );
});
