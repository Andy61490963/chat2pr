import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Containers } from "../server/containers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(exitCode = 137, timeoutMs = 10000) {
  const c = new Containers(`verify-oom-${randomUUID().slice(0, 8)}`);
  const runId = randomUUID(),
    stream = new PassThrough();
  vi.spyOn(c, "ready").mockResolvedValue("fake-image");
  vi.spyOn(c, "assertNetwork").mockResolvedValue();
  const cleanup = vi.spyOn(c, "finishContainer").mockResolvedValue();
  let stdout: PassThrough, stderr: PassThrough;
  const inspect = vi.fn(async () => ({
    State: { OOMKilled: false },
    HostConfig: { Memory: 64 * 1024 * 1024 },
  }));
  const container = {
    id: "one-owned-container",
    inspect,
    attach: vi.fn(async () => stream),
    start: vi.fn(async () => {}),
    wait: vi.fn(async () => {
      stdout.write("原本的標準輸出\n");
      stderr.write("原本的錯誤\n");
      stream.end();
      stream.resume();
      return { StatusCode: exitCode };
    }),
  };
  const create = vi.fn(async () => container);
  c.docker = {
    createContainer: create,
    listContainers: vi.fn(async () => []),
    modem: {
      demuxStream: (
        _stream: PassThrough,
        out: PassThrough,
        err: PassThrough,
      ) => {
        stdout = out;
        stderr = err;
      },
    },
  } as unknown as Docker;
  const phase = () =>
    c.phase(
      runId,
      "fake",
      ["node"],
      "none",
      undefined,
      timeoutMs,
      false,
      false,
    );
  return { c, runId, container, inspect, create, cleanup, phase };
}

it("同一容器的 OOM 旗標晚到時確認真 OOM，保留輸出並顯示實際 64 MiB 限制", async () => {
  const f = fixture();
  f.inspect
    .mockResolvedValueOnce({
      State: { OOMKilled: false },
      HostConfig: { Memory: 64 * 1024 * 1024 },
    })
    .mockResolvedValueOnce({
      State: { OOMKilled: false },
      HostConfig: { Memory: 64 * 1024 * 1024 },
    })
    .mockResolvedValue({
      State: { OOMKilled: true },
      HostConfig: { Memory: 64 * 1024 * 1024 },
    });
  const result = f.phase();
  await vi.advanceTimersByTimeAsync(300);
  await expect(result).resolves.toMatchObject({
    exitCode: 137,
    stdout: "原本的標準輸出\n",
  });
  expect((await result).stderr).toContain("原本的錯誤\n");
  expect((await result).stderr).toContain("因記憶體不足（OOM）終止");
  expect((await result).stderr).toContain("64 MiB");
  expect(f.inspect).toHaveBeenCalledTimes(3);
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.cleanup).toHaveBeenCalledWith(f.container.id, f.runId, undefined);
});

it("137 但旗標持續為 false 時不冒稱 OOM，兩秒後仍保留原輸出及退出碼", async () => {
  const f = fixture();
  const result = f.phase();
  await vi.advanceTimersByTimeAsync(2010);
  const outcome = await result;
  expect(outcome.exitCode).toBe(137);
  expect(outcome.stdout).toBe("原本的標準輸出\n");
  expect(outcome.stderr).toContain("原本的錯誤\n");
  expect(outcome.stderr).toContain("退出碼 137");
  expect(outcome.stderr).toContain("未確認");
  expect(outcome.stderr).not.toContain("因記憶體不足（OOM）終止");
  expect(f.inspect.mock.calls.length).toBeGreaterThan(1);
  expect(f.inspect.mock.calls.length).toBeLessThanOrEqual(21);
});

it("診斷 inspect 永遠不回覆仍在兩秒內結束，不覆寫原故障輸出", async () => {
  const f = fixture();
  f.inspect.mockImplementation(() => new Promise(() => {}));
  const result = f.phase();
  await vi.advanceTimersByTimeAsync(2010);
  await expect(result).resolves.toMatchObject({
    exitCode: 137,
    stdout: "原本的標準輸出\n",
  });
  expect((await result).stderr).toContain("未確認");
  expect(f.inspect).toHaveBeenCalledTimes(1);
});

it("診斷期間仍受較短的工作總截止時間約束", async () => {
  const f = fixture(137, 1000);
  f.inspect.mockImplementation(() => new Promise(() => {}));
  const result = f.phase();
  const rejected = expect(result).rejects.toMatchObject({ statusCode: 408 });
  await vi.advanceTimersByTimeAsync(1010);
  await rejected;
  expect(f.cleanup).toHaveBeenCalledWith(
    f.container.id,
    f.runId,
    expect.objectContaining({ statusCode: 408 }),
  );
});

it("診斷期間取消仍保留 409，不能等晚到 inspect 後宣告成功", async () => {
  const f = fixture();
  f.inspect.mockImplementation(() => new Promise(() => {}));
  const result = f.phase();
  const rejected = expect(result).rejects.toMatchObject({ statusCode: 409 });
  await vi.advanceTimersByTimeAsync(10);
  await f.c.cancel(f.runId);
  await rejected;
  expect(f.cleanup).toHaveBeenCalledWith(
    f.container.id,
    f.runId,
    expect.objectContaining({ statusCode: 409 }),
  );
});

it("成功階段不額外等待 OOM 診斷", async () => {
  const f = fixture(0);
  const result = f.phase();
  await vi.advanceTimersByTimeAsync(10);
  await expect(result).resolves.toMatchObject({
    exitCode: 0,
    stderr: "原本的錯誤\n",
  });
  expect(f.inspect).not.toHaveBeenCalled();
});
