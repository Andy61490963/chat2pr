import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Containers } from "../server/containers.js";
import { SourceCache } from "../server/source-cache.js";

// @ts-expect-error 工作容器採用原生 ESM，無需 TypeScript 編譯。
import { observeTurn } from "../worker/observe.mjs";

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

async function readStderrChunks(chunks: string[]) {
  const { c, runId, container } = fixture();
  const { stream } = fakeRequest(true);
  vi.spyOn(c, "finishContainer").mockResolvedValue();
  const observed = vi.fn();
  const rejected = vi.fn();
  vi.mocked(c.docker.modem.demuxStream).mockImplementation((_stream, _stdout, stderr) => {
    for (const chunk of chunks) stderr.write(chunk);
  });
  Object.assign(container, {
    wait: async () => {
      stream.end();
      stream.resume();
      return { StatusCode: 0 };
    },
  });
  const result = await c.phase(runId, "fake", ["node"], "none", "{}", 1000, false, false, observed, {
    onRejectedWorkerEvent: rejected,
  });
  expect(result.exitCode).toBe(0);
  expect(observed.mock.calls.shift()).toEqual([{ kind: "container", containerId: container.id }]);
  return { events: observed.mock.calls.map(([event]) => event), rejected: rejected.mock.calls, stderr: result.stderr };
}

function readWorkerLines(lines: string[]) {
  return readStderrChunks(lines.map((line) => `AGENTFLOW_EVENT ${line}\n`));
}

it("工作端七種事件經容器入口保留，包含未取得結束碼的指令與空白回覆", async () => {
  const command = { id: "item_0", type: "command_execution", command: "pwd", aggregated_output: "" };
  const changes = [{ path: "example.txt", kind: "add" }];
  const usage = { input_tokens: 12, cached_input_tokens: 0, output_tokens: 4 };
  const events = [
    { type: "thread.started", thread_id: "thread_example-01" },
    { type: "turn.started" },
    { type: "item.started", item: { ...command, status: "in_progress", exit_code: null } },
    { type: "item.completed", item: { ...command, status: "failed", exit_code: null } },
    { type: "item.started", item: { ...command, id: "item_1", status: "in_progress" } },
    { type: "item.completed", item: { ...command, id: "item_1", status: "completed", exit_code: 0, aggregated_output: "/example" } },
    { type: "item.completed", item: { id: "item_2", type: "file_change", changes, status: "completed" } },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "" } },
    { type: "item.completed", item: { id: "item_4", type: "error", message: "範例錯誤" } },
    { type: "error", message: "" },
    { type: "turn.completed", usage },
  ];
  const lines: string[] = [];
  await observeTurn({ runStreamed: async () => ({ events }) }, "範例工作", {}, (event: unknown) => {
    lines.push(JSON.stringify(event));
  });
  const result = await readWorkerLines(lines);
  expect(result.events).toStrictEqual([
    { kind: "thread", threadId: "thread_example-01" },
    { kind: "command_start", detail: "pwd\n", exitCode: null },
    { kind: "command_end", detail: "pwd\n", exitCode: null },
    { kind: "command_start", detail: "pwd\n" },
    { kind: "command_end", detail: "pwd\n/example", exitCode: 0 },
    { kind: "files", detail: JSON.stringify(changes) },
    { kind: "message", detail: "" },
    { kind: "error", detail: "範例錯誤" },
    { kind: "error", detail: "" },
    { kind: "usage", detail: JSON.stringify(usage) },
  ]);
  expect(result.rejected).toEqual([]);
});

it("容器拒收保留種類、未知種類及格式錯誤，通知只含固定種類與原因", async () => {
  const reserved = ["phase", "phase_end", "container", "observer_error", "observer_restored", "truncated", "upstream_retry"];
  const invalid = [
    { kind: "範例未知種類" },
    { kind: "message", detail: "範例文字", exitCode: 1 },
    { kind: "command_end", detail: "範例文字", exitCode: "失敗" },
    { kind: "files" },
    { kind: "thread", threadId: "" },
    { kind: "thread", threadId: "範例\n識別碼" },
    { kind: "thread", threadId: "x".repeat(2048) },
  ];
  const result = await readWorkerLines([
    ...reserved.map((kind) => JSON.stringify({ kind })),
    ...invalid.map((event) => JSON.stringify(event)),
    "{",
    JSON.stringify({ kind: "message", detail: "後續回覆" }),
  ]);
  expect(result.events).toEqual([{ kind: "message", detail: "後續回覆" }]);
  expect(result.rejected).toEqual([
    ...reserved.map(() => ["未知", "種類不符"]),
    ["未知", "種類不符"], ["message", "欄位不符"], ["command_end", "欄位不符"], ["files", "欄位不符"],
    ["thread", "欄位不符"], ["thread", "欄位不符"], ["thread", "欄位不符"], ["未知", "無法解析"],
  ]);
});

it("分段接收含六千個跳脫字元的工作端訊息仍可還原原文", async () => {
  const detail = "\u0001".repeat(6000);
  const line = `AGENTFLOW_EVENT ${JSON.stringify({ kind: "message", detail })}\n`;
  const result = await readStderrChunks([line.slice(0, 25000), line.slice(25000)]);
  expect(result.events.map((event) => event.kind)).toEqual(["message"]);
  expect(result.events[0].detail === detail).toBe(true);
  expect(result.rejected).toEqual([]);
  expect(result.stderr).toBe("");
});

it("過長的容器事件分段抵達只拒收一次，保留下一筆事件與一般錯誤", async () => {
  const valid = { kind: "message", detail: "後續回覆" };
  const result = await readStderrChunks([
    'AGENTFLOW_EVENT {"detail":"',
    "x".repeat(32 * 1024),
    "x".repeat(32 * 1024),
    "不應出現在紀錄的尾段",
    `\nAGENTFLOW_EVENT ${JSON.stringify(valid)}\n範例診斷\n`,
  ]);
  expect(result.rejected).toEqual([["未知", "欄位不符"]]);
  expect(result.events).toEqual([valid]);
  expect(result.stderr).toBe("範例診斷\n");
});

it("容器事件在輸出結尾缺少完整 JSON 時只拒收一次", async () => {
  const result = await readStderrChunks(['AGENTFLOW_EVENT {"detail":', '"未完成']);
  expect(result.events).toEqual([]);
  expect(result.rejected).toEqual([["未知", "無法解析"]]);
  expect(result.stderr).toBe("");
});

it("連線整理的容器停用日誌驅動程式並保留即時附接輸出", async () => {
  const { c, runId, create } = fixture();
  create.mockRejectedValueOnce(new Error("虛構容器未建立"));
  await expect(
    c.phase(
      runId,
      "fake",
      ["node"],
      "none",
      "fictional-connection",
      1000,
      false,
      false,
      undefined,
      { sensitive: true },
    ),
  ).rejects.toThrow("虛構容器未建立");
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: expect.objectContaining({
        LogConfig: { Type: "none", Config: {} },
      }),
    }),
  );
});

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
