import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  probeSystem,
  runnerProbe,
  runnerText,
} from "../server/system-status.js";

// 不需要資料庫：系統頁分辨「執行器沒回應」與「Docker 沒回應」（項目 11）。
// 虛構的執行器金鑰，只用於確認不會出現在回傳的說明裡。
const key = "fictional-runner-key-0123456789abcdef";
const snapshot = {
  checkedAt: "2026-11-18T00:00:00.000Z",
  instance: "production",
  requiredWorkerRev: "1",
  services: [],
  jobs: [],
  images: [],
  volumes: { jobs: 0, sourceCaches: 0 },
};

type Handler = (
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
) => void;
let server: Server | undefined;
const seen: { url: string; key: string }[] = [];
async function runner(system: Handler) {
  seen.length = 0;
  server = createServer((req, res) => {
    seen.push({
      url: req.url ?? "",
      key: String(req.headers["x-runner-key"] ?? ""),
    });
    if (req.headers["x-runner-key"] !== key) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "執行器授權失敗" }));
      return;
    }
    if (req.url === "/alive") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    system(req, res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const original = { ...runnerProbe };
afterEach(async () => {
  Object.assign(runnerProbe, original);
  if (!server) return;
  server.closeAllConnections();
  await new Promise((r) => server!.close(r));
  server = undefined;
});

describe("系統頁的執行器狀態", () => {
  it("執行器與 Docker 都正常：照舊回傳清單並標示 ok", async () => {
    const url = await runner((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot));
    });
    const s = await probeSystem(url, key, "production");
    expect(s.runner).toEqual({ state: "ok" });
    expect(s.services).toEqual([]);
    expect(s.volumes).toEqual({ jobs: 0, sourceCaches: 0 });
    expect(seen.every((r) => r.key === key)).toBe(true);
  });

  it("連不上執行器（拒絕連線）：down，清單為 null", async () => {
    const url = await runner(() => {});
    server!.closeAllConnections();
    await new Promise((r) => server!.close(r));
    server = undefined;
    const s = await probeSystem(url, key, "production");
    expect(s.runner.state).toBe("down");
    expect(s.runner.detail).toBe(runnerText.down);
    expect(s.runner.detail).toContain("npm run services");
    expect(s.services).toBeNull();
    expect(s.jobs).toBeNull();
  });

  it("連線途中被切斷（沒有任何 HTTP 回應）：down", async () => {
    const url = await runner((req) => req.socket.destroy());
    const s = await probeSystem(url, key, "production");
    expect(s.runner.state).toBe("down");
  });

  it("執行器回 500（Docker listContainers 失敗）：docker，不夾帶 Docker 原始訊息", async () => {
    const url = await runner((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `connect ENOENT //./pipe/docker_engine ${key}`,
        }),
      );
    });
    const s = await probeSystem(url, key, "production");
    expect(s.runner.state).toBe("docker");
    expect(s.runner.detail).toBe(runnerText.docker);
    expect(s.runner.detail).not.toContain("ENOENT");
    expect(JSON.stringify(s)).not.toContain(key);
    expect(s.services).toBeNull();
  });

  it("/system 逾時但 /alive 有回應：docker，說明 Docker 超過 20 秒沒有回應", async () => {
    runnerProbe.systemMs = 200;
    const url = await runner(() => {}); // 不回應，模擬 Docker 盤點卡住
    const s = await probeSystem(url, key, "production");
    expect(s.runner.state).toBe("docker");
    expect(s.runner.detail).toContain("Docker 超過 20 秒沒有回應");
    expect(seen.map((r) => r.url)).toEqual(["/system", "/alive"]);
  });

  it("/system 與 /alive 都逾時：down", async () => {
    runnerProbe.systemMs = 200;
    runnerProbe.aliveMs = 200;
    seen.length = 0;
    server = createServer(() => {}); // 收到請求但什麼都不回
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const s = await probeSystem(url, key, "production");
    expect(s.runner.state).toBe("down");
  });

  it("授權失敗等 4xx 照舊拋出，不當成 Docker 問題", async () => {
    const url = await runner(() => {});
    await expect(
      probeSystem(url, "fictional-wrong-key", "production"),
    ).rejects.toMatchObject({ statusCode: 401, message: "執行器授權失敗" });
  });

  it("任何狀態的說明都不含執行器金鑰", () => {
    for (const text of Object.values(runnerText))
      expect(text).not.toContain(key);
  });
});
