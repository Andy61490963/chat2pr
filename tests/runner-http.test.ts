import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { runnerRequest } from "../server/runner-http.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("測試伺服器未監聽");
  return `http://127.0.0.1:${address.port}`;
}

it("專用 transport 等待慢標頭與完整回應，不使用 fetch 的隱含標頭期限", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("不可使用全域 fetch"));
  const url = await serve((_req, res) =>
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":');
      setTimeout(() => res.end("true}"), 60);
    }, 60),
  );
  const result = await runnerRequest(url, {
    body: "{}",
    headers: {},
    timeoutMs: 1000,
  });
  expect(result).toEqual({ status: 200, body: '{"ok":true}' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["headers", "body"])("%s 卡住時總期限中止連線", async (mode) => {
  let closed = false;
  const url = await serve((_req, res) => {
    res.on("close", () => {
      closed = true;
    });
    if (mode === "body") {
      res.writeHead(200);
      res.write('{"ok":');
    }
  });
  await expect(
    runnerRequest(url, { body: "{}", headers: {}, timeoutMs: 60 }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("archive 串流上傳及回應共用期限，逾時取消來源串流", async () => {
  let cancelled = false;
  const url = await serve((req) => req.resume());
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    runnerRequest(url, { body, headers: {}, timeoutMs: 60 }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.waitFor(() => expect(cancelled).toBe(true));
});

it("archive 完整抵達且沒有跟隨重新導向或轉送金鑰", async () => {
  let bytes = 0,
    leaked = false;
  const target = await serve((_req, res) => {
    leaked = true;
    res.end("{}");
  });
  const url = await serve((req, res) => {
    req.on("data", (b) => {
      bytes += b.length;
    });
    req.on("end", () => {
      res.writeHead(307, { location: target });
      res.end("{}");
    });
  });
  const result = await runnerRequest(url, {
    body: new Blob([new Uint8Array(10000)]).stream(),
    headers: { "x-runner-key": "synthetic-runner-key" },
    timeoutMs: 1000,
  });
  expect(result.status).toBe(307);
  expect(bytes).toBe(10000);
  expect(leaked).toBe(false);
});

it("回應界限以 UTF-8 bytes 計算，過量立即中止而不回傳截斷 JSON", async () => {
  const url = await serve((_req, res) => res.end("中".repeat(100)));
  await expect(
    runnerRequest(url, {
      body: "{}",
      headers: {},
      timeoutMs: 1000,
      maxResponseBytes: 200,
    }),
  ).rejects.toMatchObject({ statusCode: 413 });
});

it("半截回應與連線重設均失敗，不能誤判成功", async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("{}");
    setTimeout(() => res.destroy(), 10);
  });
  await expect(
    runnerRequest(url, { body: "{}", headers: {}, timeoutMs: 1000 }),
  ).rejects.toThrow();
});

it("已鎖定的上傳來源同步失敗時不留下連線或取消呼叫者的 reader", async () => {
  const sockets = new Set<import("node:net").Socket>();
  let cancelled = false;
  const url = await serve(() => {});
  servers.at(-1)!.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
    reader = source.getReader();
  await expect(
    runnerRequest(url, { body: source, headers: {}, timeoutMs: 5000 }),
  ).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sockets.size).toBe(0);
  expect(cancelled).toBe(false);
  reader.releaseLock();
  await source.cancel();
});
