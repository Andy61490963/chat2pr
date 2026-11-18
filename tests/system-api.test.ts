import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { db, reset, session } from "./helpers.js";
import { runnerProbe } from "../server/system-status.js";

// 系統頁 `GET /api/system`：模擬執行器，分辨執行器沒回應、Docker 沒回應與逾時（項目 11）。
beforeEach(reset);
afterAll(() => db.close());

const snapshot = {
  checkedAt: "2026-11-18T00:00:00.000Z",
  instance: "production",
  requiredWorkerRev: "1",
  services: [
    {
      name: "line-agentflow-db-1",
      role: "PostgreSQL＋pgvector 資料庫",
      image: "pgvector/pgvector:pg17",
      state: "running",
      status: "Up 3 hours",
      created: "2026-11-18T00:00:00.000Z",
    },
  ],
  jobs: [],
  images: [],
  volumes: { jobs: 2, sourceCaches: 1 },
};
let server: Server | undefined;
const keys: string[] = [];
const originalUrl = process.env.RUNNER_URL;
const originalProbe = { ...runnerProbe };
async function fakeRunner(system: (res: ServerResponse) => void) {
  server = createServer((req, res) => {
    keys.push(String(req.headers["x-runner-key"] ?? ""));
    if (req.url === "/alive") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    system(res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  process.env.RUNNER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stop() {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((r) => server!.close(r));
  server = undefined;
}
afterEach(async () => {
  await stop();
  Object.assign(runnerProbe, originalProbe);
  if (originalUrl === undefined) delete process.env.RUNNER_URL;
  else process.env.RUNNER_URL = originalUrl;
});

async function system() {
  const { buildApp } = await import("../server/app.js");
  const app = await buildApp(db);
  try {
    const r = await app.inject({
      url: "/api/system",
      headers: await session(),
    });
    return { status: r.statusCode, body: r.json(), raw: r.body };
  } finally {
    await app.close();
  }
}

it("執行器與 Docker 都正常：回傳清單與 runner.state=ok", async () => {
  await fakeRunner((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(snapshot));
  });
  const r = await system();
  expect(r.status).toBe(200);
  expect(r.body.runner).toEqual({ state: "ok" });
  expect(r.body.services).toHaveLength(1);
  expect(r.body.volumes).toEqual({ jobs: 2, sourceCaches: 1 });
});

it("執行器拒絕連線：200 且 runner.state=down，清單為 null", async () => {
  await fakeRunner(() => {});
  await stop(); // 連接埠已關閉，連線會被拒絕
  const r = await system();
  expect(r.status).toBe(200);
  expect(r.body.runner.state).toBe("down");
  expect(r.body.runner.detail).toContain("執行器（主機程序 4312）沒有回應");
  expect(r.body.services).toBeNull();
  expect(r.body.jobs).toBeNull();
});

it("執行器 /system 回 500：runner.state=docker，不夾帶 Docker 原始訊息", async () => {
  await fakeRunner((res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: "虛構的 Docker 錯誤：pipe/docker_engine" }),
    );
  });
  const r = await system();
  expect(r.status).toBe(200);
  expect(r.body.runner.state).toBe("docker");
  expect(r.body.runner.detail).toContain("執行器正常，但 Docker 沒有回應");
  expect(r.raw).not.toContain("docker_engine");
  expect(r.body.services).toBeNull();
});

it("/system 逾時但 /alive 正常：runner.state=docker 且說明逾時", async () => {
  runnerProbe.systemMs = 300;
  await fakeRunner(() => {}); // 不回應，模擬 Docker 卡住
  const r = await system();
  expect(r.status).toBe(200);
  expect(r.body.runner.state).toBe("docker");
  expect(r.body.runner.detail).toContain("Docker 超過 20 秒沒有回應");
});

it("回應說明不含執行器金鑰", async () => {
  await fakeRunner((res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `虛構錯誤 ${keys[0] ?? ""}` }));
  });
  const r = await system();
  expect(r.body.runner.state).toBe("docker");
  for (const k of keys.filter(Boolean)) expect(r.raw).not.toContain(k);
  expect(r.raw).not.toMatch(/x-runner-key|runnerSecret/);
});
