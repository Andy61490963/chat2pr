import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
import { readCodexAccount } from "../server/codex-account.js";
afterEach(() => vi.restoreAllMocks());
describe("訂閱身份刷新只由可信CLI處理", () => {
  it("收到401時以官方account/read refreshToken契約刷新，額度未知不偽造充足", async () => {
    const methods: Array<{ method: string; params: unknown }> = [];
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new Writable(),
      kill: vi.fn(),
    });
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const q = JSON.parse(String(chunk));
        methods.push({ method: q.method, params: q.params });
        const result =
          q.method === "account/rateLimits/read"
            ? {
                ordinaryUsageAllowed: null,
                rateLimits: {
                  planType: "test",
                  primary: null,
                  secondary: null,
                },
                rateLimitsByLimitId: null,
              }
            : q.method === "model/list"
              ? { data: [] }
              : {};
        if (q.id)
          queueMicrotask(() =>
            child.stdout.write(JSON.stringify({ id: q.id, result }) + "\n"),
          );
        done();
      },
    });
    mocked.spawn.mockReturnValue(child);
    const result = await readCodexAccount("synthetic-codex-home", true);
    expect(methods.find((m) => m.method === "account/read")).toEqual({
      method: "account/read",
      params: { refreshToken: true },
    });
    expect(methods.findIndex((m) => m.method === "account/read")).toBeLessThan(
      methods.findIndex((m) => m.method === "account/rateLimits/read"),
    );
    expect(result.allowed).toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });
  it("可信CLI在回應前退出立即失敗，不掛住到外層工作超時", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new Writable({
        write(_chunk, _encoding, done) {
          queueMicrotask(() => child.emit("exit", 1));
          done();
        },
      }),
      kill: vi.fn(),
    });
    mocked.spawn.mockReturnValue(child);
    await expect(
      readCodexAccount("synthetic-codex-home", true),
    ).rejects.toThrow("已中止");
  });
});
