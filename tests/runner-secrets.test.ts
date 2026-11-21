import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRunnerAuth } from "../server/runner-auth.js";
import { registerRunnerSecrets } from "../server/runner-secrets.js";

const files = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (files.failRename) throw new Error("模擬重新命名失敗");
      return fs.renameSync(...args);
    },
  };
});

const runnerKey = "fictional-runner-key";
const openaiKey = "sk-fictional-openai-key-for-tests";
const previous = {
  runnerSecret: runnerKey,
  githubClientId: "虛構應用程式",
  discordApplicationId: "100000000000000019",
};
let dir: string;
let path: string;
let app: ReturnType<typeof Fastify>;
beforeEach(() => {
  files.failRename = false;
  dir = mkdtempSync(join(tmpdir(), "connection-secrets-"));
  path = join(dir, "secrets.json");
  writeFileSync(path, JSON.stringify(previous));
  app = Fastify({ logger: false });
  registerRunnerAuth(app, () => runnerKey);
  registerRunnerSecrets(app, path);
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const put = (payload: object, key = runnerKey) =>
  app.inject({
    method: "POST",
    url: "/secrets",
    headers: { "x-runner-key": key },
    payload,
  });

it("驗證執行器授權後原子替換完整檔案，保留其他設定並以權限 600 保存", async () => {
  expect((await put({ openaiKey }, "虛構錯誤權杖")).statusCode).toBe(401);
  const response = await put({ openaiKey, discordApplicationId: null });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    changed: ["discordApplicationId", "openaiKey"],
  });
  expect(response.body).not.toContain(openaiKey);
  const updated = JSON.parse(readFileSync(path, "utf8"));
  expect(updated).not.toHaveProperty("discordApplicationId");
  expect(updated).toMatchObject({
    runnerSecret: runnerKey,
    githubClientId: previous.githubClientId,
    openaiKey,
    connectionSecretUpdatedAt: {
      discordApplicationId: expect.any(String),
      openaiKey: expect.any(String),
    },
  });
  expect(readdirSync(dir)).toEqual(["secrets.json"]);
  // Windows 由本機設定目錄的 ACL 限制存取，POSIX 才有檔案模式。
  if (process.platform !== "win32")
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

it("拒絕白名單外欄位、格式錯誤和移除必填欄位，原檔保持完整", async () => {
  const clientSecret = "fictional-discord-client-secret";
  for (const [payload, hint] of [
    [{ githubClientSecret: "虛構內容", openaiKey }, "不支援的欄位"],
    [{ discordToken: clientSecret, openaiKey }, "Reset Token"],
    [{ lineSecret: null }, "格式不符"],
  ] as const) {
    const response = await put(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain(hint);
    expect(response.body).not.toContain(clientSecret);
    expect(response.body).not.toContain(openaiKey);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify(previous));
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
  }
});

it("暫存檔無法改名時保留原檔並清理，下一次可重試", async () => {
  files.failRename = true;
  const response = await put({ openaiKey });
  expect(response.statusCode).toBe(503);
  expect(response.body).not.toContain(openaiKey);
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(previous));
  expect(readdirSync(dir)).toEqual(["secrets.json"]);
  files.failRename = false;
  expect((await put({ openaiKey })).statusCode).toBe(200);
});

it("設定檔無法讀取時拒絕寫入，且請求本文解析失敗時不回顯", async () => {
  rmSync(path);
  mkdirSync(path);
  expect((await put({ openaiKey })).statusCode).toBe(503);
  expect(readdirSync(dir)).toEqual(["secrets.json"]);
  const failed = await app.inject({
    method: "POST",
    url: "/secrets",
    headers: { "x-runner-key": runnerKey, "content-type": "application/json" },
    payload: `{"openaiKey":${openaiKey}}`,
  });
  expect(failed.statusCode).toBe(400);
  expect(failed.body).not.toContain(openaiKey);
});

it("上一次寫入中途結束留下的舊鎖檔會被清掉，新的鎖檔仍會擋下同時寫入", async () => {
  const lock = `${path}.lock`;
  writeFileSync(lock, "");
  // 剛建立的鎖檔代表另一個程序正在寫，這次不寫。
  expect((await put({ openaiKey })).statusCode).toBe(503);
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lock, old, old);
  expect((await put({ openaiKey })).statusCode).toBe(200);
  expect(JSON.parse(readFileSync(path, "utf8")).openaiKey).toBe(openaiKey);
  expect(readdirSync(dir)).toEqual(["secrets.json"]);
});
