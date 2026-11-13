import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Containers } from "../server/containers.js";
import { SourceCache } from "../server/source-cache.js";

vi.mock("node:http", async (original) => ({
  ...(await original<typeof import("node:http")>()),
  request: vi.fn(),
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(request).mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function observe(promise: Promise<unknown>) {
  const state: {
    status: "pending" | "resolved" | "rejected";
    error?: unknown;
  } = { status: "pending" };
  void promise.then(
    () => {
      state.status = "resolved";
    },
    (error) => {
      state.status = "rejected";
      state.error = error;
    },
  );
  return state;
}
const never = () => new Promise<never>(() => {});
function fixture() {
  const c = new Containers(`verify-deadline-${randomUUID().slice(0, 8)}`),
    runId = randomUUID();
  vi.spyOn(c, "ready").mockResolvedValue("fake-worker");
  vi.spyOn(c, "ensureVolume").mockResolvedValue();
  vi.spyOn(c, "assertNetwork").mockResolvedValue();
  vi.spyOn(c, "sourceNetwork").mockResolvedValue("none");
  let exists = true;
  const stream = new PassThrough();
  const container = {
    id: "fake-owned-container",
    attach: vi.fn(async () => stream),
    start: vi.fn(async () => {}),
    wait: vi.fn(never),
    kill: vi.fn(async () => {}),
    inspect: vi.fn(async () => {
      if (!exists)
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      return { Config: { Labels: c.labels(runId) } };
    }),
    remove: vi.fn(async () => {
      exists = false;
    }),
  };
  const create = vi.fn(async () => container);
  c.docker = {
    createContainer: create,
    getContainer: () => container,
    getImage: () => ({
      inspect: async () => ({
        Id: "fake-source",
        Config: { Labels: { "io.agentflow.source": "v1" } },
      }),
    }),
    modem: { demuxStream: vi.fn() },
  } as unknown as Docker;
  const phase = () =>
    c.phase(runId, "fake", ["node"], "none", undefined, 1000, false, false);
  const inputPhase = () =>
    c.phase(
      runId,
      "fake",
      ["node"],
      "none",
      '{"auth":"synthetic-only"}',
      1000,
      false,
      false,
    );
  const source = () =>
    new SourceCache(c).prepare(
      runId,
      "fake",
      {
        repo: "fixture/test",
        sha: "a".repeat(40),
        repositoryId: 1,
        installationId: 1,
        token: "synthetic-only",
      },
      1000,
    );
  return { c, runId, stream, container, create, phase, inputPhase, source };
}
function fakeRequest(immediate: boolean) {
  const stream = Object.assign(new PassThrough(), { setTimeout: vi.fn() });
  const req = Object.assign(new EventEmitter(), {
    setTimeout: vi.fn(),
    destroy: vi.fn(),
    end: vi.fn(),
  });
  const upgrade = () => req.emit("upgrade", {}, stream, Buffer.alloc(0));
  req.end.mockImplementation(() => {
    if (immediate) upgrade();
  });
  vi.mocked(request).mockReturnValue(
    req as unknown as ReturnType<typeof request>,
  );
  return { req, stream, upgrade };
}

it.each(["cancel", "cleanup", "dispose"] as const)(
  "%s 列出容器永不回覆也必須有界失敗，不猜測刪除資源",
  async (mode) => {
    const f = fixture();
    Object.assign(f.c.docker, { listContainers: vi.fn(never) });
    const state = observe(
      mode === "cleanup" ? f.c.cleanup() : f.c[mode](f.runId),
    );
    await vi.advanceTimersByTimeAsync(15010);
    expect(state.status).toBe("rejected");
    expect(state.error).toMatchObject({ statusCode: 503 });
    expect(f.container.remove).not.toHaveBeenCalled();
  },
);

it.each(["inspect", "remove"] as const)(
  "dispose 的資料卷 %s 永不回覆也必須截止，不轉刪其他卷",
  async (operation) => {
    const f = fixture();
    const inspected: string[] = [],
      removed: string[] = [];
    Object.assign(f.c.docker, {
      listContainers: vi.fn(async () => []),
      getVolume: (name: string) => ({
        inspect: async () => {
          inspected.push(name);
          return operation === "inspect"
            ? never()
            : { Labels: f.c.labels(f.runId) };
        },
        remove: async () => {
          removed.push(name);
          return never();
        },
      }),
    });
    const state = observe(f.c.dispose(f.runId));
    await vi.advanceTimersByTimeAsync(15010);
    expect(state.status).toBe("rejected");
    expect(state.error).toMatchObject({ statusCode: 503 });
    expect(inspected).toEqual([f.c.volume(f.runId)]);
    expect(removed).toEqual(
      operation === "inspect" ? [] : [f.c.volume(f.runId)],
    );
  },
);

it.each(["inspect", "remove"] as const)(
  "清理 %s RPC 永不回覆也必須在截止時間拒絕",
  async (operation) => {
    const f = fixture();
    f.container[operation].mockImplementation(never);
    const state = observe(
      f.c.removeOwnedContainer(f.container.id, f.runId, 25),
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(state.status).toBe("rejected");
    expect(state.error).toMatchObject({ statusCode: 503 });
    if (operation === "inspect")
      expect(f.container.remove).not.toHaveBeenCalled();
  },
);

it("冪等 createVolume 晚到只保留既有工作卷，不刪除尚未發布的候選證據", async () => {
  const f = fixture(),
    createdVolume = deferred<unknown>();
  vi.mocked(f.c.ensureVolume).mockRestore();
  let evidence: string | null = "既有 Codex 候選與驗收截圖";
  const removed = vi.fn(async () => {
    evidence = null;
  });
  Object.assign(f.c.docker, {
    createVolume: vi.fn(() => createdVolume.promise),
    getVolume: () => ({
      inspect: async () => ({ Labels: f.c.labels(f.runId) }),
      remove: removed,
    }),
  });
  const state = observe(
    f.c.phase(f.runId, "fake", ["node"], "none", undefined, 1000),
  );
  await vi.advanceTimersByTimeAsync(1200);
  expect(state.status).toBe("rejected");
  expect(state.error).toMatchObject({ statusCode: 408 });
  createdVolume.resolve({
    Name: f.c.volume(f.runId),
    Labels: f.c.labels(f.runId),
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(removed).not.toHaveBeenCalled();
  expect(evidence).toBe("既有 Codex 候選與驗收截圖");
  expect(f.container.start).not.toHaveBeenCalled();
});

it("createContainer 未回覆時 dispose 有界失敗並保留工作卷，晚到只清理容器", async () => {
  const f = fixture(),
    created = deferred<typeof f.container>();
  f.create.mockImplementation(() => created.promise);
  const volume = vi.fn(() => {
    throw new Error("未確認 create 結果前不應操作卷");
  });
  Object.assign(f.c.docker, {
    listContainers: vi.fn(async () => []),
    getVolume: volume,
  });
  const phase = observe(f.phase());
  await vi.advanceTimersByTimeAsync(1200);
  expect(phase.status).toBe("rejected");
  const disposed = observe(f.c.dispose(f.runId));
  await vi.advanceTimersByTimeAsync(15010);
  expect(disposed.status).toBe("rejected");
  expect(disposed.error).toMatchObject({ statusCode: 503 });
  expect(volume).not.toHaveBeenCalled();
  created.resolve(f.container);
  await vi.advanceTimersByTimeAsync(200);
  expect(f.container.remove).toHaveBeenCalled();
  expect(f.container.start).not.toHaveBeenCalled();
  expect(volume).not.toHaveBeenCalled();
});

it.each(["phase", "source"] as const)(
  "%s create 尚未逾時即被取消，晚到容器不得開始工作",
  async (mode) => {
    const f = fixture(),
      created = deferred<typeof f.container>();
    f.create.mockImplementation(() => created.promise);
    Object.assign(f.c.docker, { listContainers: vi.fn(async () => []) });
    const state = observe(f[mode]());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.create).toHaveBeenCalledTimes(1);
    await f.c.cancel(f.runId);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.status).toBe("rejected");
    expect(state.error).toMatchObject({
      statusCode: 409,
      message: "工作已取消",
    });
    created.resolve(f.container);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.container.remove).toHaveBeenCalled();
    expect(f.container.attach).not.toHaveBeenCalled();
    expect(f.container.start).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  },
);

it("phase attach 逾時仍清理；晚到 stream 被銷毀且不啟動容器", async () => {
  const f = fixture(),
    attached = deferred<PassThrough>();
  f.container.attach.mockImplementation(() => attached.promise);
  const state = observe(f.phase());
  await vi.advanceTimersByTimeAsync(1200);
  expect(state.status).toBe("rejected");
  expect(state.error).toMatchObject({ statusCode: 408 });
  expect(f.container.remove).toHaveBeenCalled();
  attached.resolve(f.stream);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stream.destroyed).toBe(true);
  expect(f.container.start).not.toHaveBeenCalled();
});

it("phase start RPC 逾時仍回報408；晚到成功不繼續等待或操作工作", async () => {
  const f = fixture(),
    started = deferred<void>();
  f.container.start.mockImplementation(() => started.promise);
  const state = observe(f.phase());
  await vi.advanceTimersByTimeAsync(1200);
  expect(state.status).toBe("rejected");
  expect(state.error).toMatchObject({ statusCode: 408 });
  expect(f.container.remove).toHaveBeenCalled();
  started.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.container.wait).not.toHaveBeenCalled();
});

it.each(["phase", "source"] as const)(
  "%s create 晚於截止時間返回，只清理晚到容器，不再attach或start",
  async (mode) => {
    const f = fixture(),
      created = deferred<typeof f.container>();
    f.create.mockImplementation(() => created.promise);
    const state = observe(f[mode]());
    await vi.advanceTimersByTimeAsync(1200);
    expect(state.status).toBe("rejected");
    expect(state.error).toMatchObject({ statusCode: 408 });
    created.resolve(f.container);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.container.remove).toHaveBeenCalled();
    expect(f.container.attach).not.toHaveBeenCalled();
    expect(f.container.start).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  },
);

it.each(["source", "inputPhase"] as const)(
  "%s attach 逾時銷毀 request；晚到 upgrade 不啟動或輸入憑證",
  async (mode) => {
    const f = fixture(),
      input = fakeRequest(false);
    const written = vi.spyOn(input.stream, "write");
    const state = observe(f[mode]());
    await vi.advanceTimersByTimeAsync(1200);
    expect(state.status).toBe("rejected");
    expect(state.error).toMatchObject({ statusCode: 408 });
    expect(input.req.destroy).toHaveBeenCalled();
    input.upgrade();
    await vi.advanceTimersByTimeAsync(0);
    expect(input.stream.destroyed).toBe(true);
    expect(f.container.start).not.toHaveBeenCalled();
    expect(written).not.toHaveBeenCalled();
  },
);

it.each(["source", "inputPhase"] as const)(
  "%s start 逾時後即使晚到成功，也不寫入來源憑證",
  async (mode) => {
    const f = fixture(),
      input = fakeRequest(true),
      started = deferred<void>();
    const written = vi.spyOn(input.stream, "write");
    f.container.start.mockImplementation(() => started.promise);
    const state = observe(f[mode]());
    await vi.advanceTimersByTimeAsync(1200);
    expect(state.status).toBe("rejected");
    expect(state.error).toMatchObject({ statusCode: 408 });
    expect(f.container.remove).toHaveBeenCalled();
    started.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).not.toHaveBeenCalled();
    expect(f.container.wait).not.toHaveBeenCalled();
    expect(input.stream.destroyed).toBe(true);
  },
);
