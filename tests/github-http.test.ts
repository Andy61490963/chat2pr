import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Octokit } from "@octokit/rest";
import { createGitHubFetch, githubHttpFetch } from "../server/github-http.js";

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
async function serve(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("缺少測試位址");
  return `http://127.0.0.1:${address.port}`;
}

describe("GitHub API 完整 HTTP 截止時間", () => {
  it("沒有 headers 時在截止時間拒絕並關閉連線", async () => {
    let closed = false;
    const url = await serve((req) =>
      req.on("close", () => {
        closed = true;
      }),
    );
    const request = createGitHubFetch({ timeoutMs: 80 });
    await expect(request(url)).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.waitFor(() => expect(closed).toBe(true));
  });
  it("200 慢速本文仍拒絕，Octokit 不能吞成成功空資料", async () => {
    let closed = false;
    const url = await serve((req, res) => {
      req.on("close", () => {
        closed = true;
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
    });
    const api = new Octokit({
      baseUrl: url,
      request: { fetch: createGitHubFetch({ timeoutMs: 80 }) },
    });
    await expect(api.request("GET /slow-body")).rejects.toMatchObject({
      status: 500,
    });
    await vi.waitFor(() => expect(closed).toBe(true));
  });
  it("保留既有取消，取消後不再呼叫上游", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200);
      res.write("x");
    });
    const controller = new AbortController();
    const request = createGitHubFetch({ timeoutMs: 1000 });
    const pending = request(url, { signal: controller.signal });
    controller.abort(new Error("呼叫端取消"));
    await expect(pending).rejects.toThrow("呼叫端取消");
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(request(url, { signal: controller.signal })).rejects.toThrow(
      "呼叫端取消",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("每次重新建立期限，第一次過期不影響下一次成功與回應屬性", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/hang") return;
      res.writeHead(200, {
        "content-type": "application/json",
        "x-test": "retained",
      });
      res.end('{"ok":true}');
    });
    const request = createGitHubFetch({ timeoutMs: 80 });
    await expect(request(`${url}/hang`)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await delay(90);
    const response = await request(`${url}/healthy`);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.url).toBe(`${url}/healthy`);
    expect(response.headers.get("x-test")).toBe("retained");
  });
  it("不依賴 Content-Length，逐塊限制本文總位元組", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("x".repeat(40));
      res.end("y".repeat(40));
    });
    await expect(
      createGitHubFetch({ maxResponseBytes: 64 })(url),
    ).rejects.toMatchObject({
      statusCode: 413,
    });
  });
  it("預設可讀取超過 10MiB 的合法 base64 API 回應", async () => {
    const body = JSON.stringify({
      content: Buffer.alloc(10 * 1024 * 1024).toString("base64"),
    });
    const url = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(body);
    });
    const response = await githubHttpFetch(url);
    expect((await response.json()).content.length).toBe(13981016);
  });
  it("204 空本文不誤判失敗", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const response = await githubHttpFetch(url);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
