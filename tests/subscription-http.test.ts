import { afterEach, expect, it } from "vitest";
import http from "node:http";
import type { request as httpsRequest } from "node:https";
import {
  createSubscriptionTransport,
  SUBSCRIPTION_RESPONSES_URL,
} from "../server/subscription-http.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of clean.splice(0)) await close();
});
async function fixture(handler: http.RequestListener) {
  const server = http.createServer(handler),
    sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  clean.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const calls: Array<{ address: string; method: unknown }> = [];
  const transport = createSubscriptionTransport(((
    address: URL,
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void,
  ) => {
    calls.push({ address: String(address), method: options.method });
    return http.request(url, options, callback);
  }) as typeof httpsRequest);
  const send = (signal = AbortSignal.timeout(2000)) =>
    transport(SUBSCRIPTION_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-main" },
      body: '{"model":"test"}',
      signal,
    });
  return { transport, send, calls };
}
it("延遲標頭只受指定phase期限控制，固定POST與上游，無任意標頭回流", async () => {
  let received = "";
  const f = await fixture((req, res) => {
    req.on("data", (b) => (received += b));
    setTimeout(() => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-secret": "synthetic-main",
      });
      res.end("data: complete\n\n");
    }, 70);
  });
  const result = await f.send(AbortSignal.timeout(500));
  expect(await result.text()).toBe("data: complete\n\n");
  expect(result.headers.get("x-secret")).toBeNull();
  expect(f.calls).toEqual([
    { address: SUBSCRIPTION_RESPONSES_URL, method: "POST" },
  ]);
  expect(received).toBe('{"model":"test"}');
});
it("等待標頭時取消立即結束，不等供應商回覆", async () => {
  const f = await fixture((req) => req.resume());
  const controller = new AbortController();
  const pending = f.send(controller.signal);
  setTimeout(() => controller.abort(), 30);
  await expect(pending).rejects.toThrow("已取消");
  expect(f.calls).toHaveLength(1);
});
it("已取得標頭後取消仍中止回應串流", async () => {
  const f = await fixture((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: begin\n\n");
  });
  const controller = new AbortController(),
    response = await f.send(controller.signal);
  const reading = response.text();
  controller.abort();
  await expect(reading).rejects.toThrow();
});
it("不跟隨重導也不回顯Location或上游原因", async () => {
  const f = await fixture((req, res) => {
    req.resume();
    res.writeHead(302, { location: "https://example.invalid/synthetic-main" });
    res.end("synthetic-main");
  });
  await expect(f.send()).rejects.toThrow("不接受重新導向");
  expect(f.calls).toHaveLength(1);
});
it("錯誤目的地、方法或無phase signal不送出網路請求", async () => {
  const f = await fixture((_req, res) => res.end());
  await expect(
    f.transport("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(100),
    }),
  ).rejects.toThrow("格式無效");
  await expect(
    f.transport(SUBSCRIPTION_RESPONSES_URL, {
      method: "GET",
      body: "{}",
      signal: AbortSignal.timeout(100),
    }),
  ).rejects.toThrow("格式無效");
  await expect(
    f.transport(SUBSCRIPTION_RESPONSES_URL, { method: "POST", body: "{}" }),
  ).rejects.toThrow("格式無效");
  expect(f.calls).toHaveLength(0);
});
it("空內容類型仍交完整SSE守門處理，HTTP錯誤也不洩漏其他標頭", async () => {
  const f = await fixture((req, res) => {
    req.resume();
    res.statusCode = 401;
    res.setHeader("www-authenticate", "synthetic-main");
    res.end("error");
  });
  const response = await f.send();
  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).toBeNull();
  expect(response.headers.get("www-authenticate")).toBeNull();
  await response.body?.cancel();
});
