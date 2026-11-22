import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { hash } from "../server/auth.js";
import type { Secrets } from "../server/config.js";
import { discordConnection } from "../server/discord-connection.js";
import type { DiscordGateway } from "../server/discord.js";
import { HttpRunner } from "../server/execution.js";
import { registerRunnerAuth } from "../server/runner-auth.js";
import { registerRunnerSecrets } from "../server/runner-secrets.js";
import { scrubConnectionSecrets } from "../server/secret-scrub.js";
import { db, reset, session } from "./helpers.js";

const fixture = vi.hoisted(() => ({ file: "" }));
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => JSON.parse(readFileSync(fixture.file, "utf8")) as Secrets,
}));

const runnerKey = "fictional-runner-key";
const updates = {
  lineSecret: "abcdef0123456789abcdef0123456789",
  lineToken: "fictional-line-channel-access-token=",
  discordToken: "fictionalDiscordTokenPart1.part2.fictionalDiscordTokenPart3",
  discordApplicationId: "100000000000000019",
  openaiKey: "sk-fictional-openai-key-for-tests",
};
const initial = { runnerSecret: runnerKey, githubClientId: "虛構應用程式" };
let dir: string;
let runner: ReturnType<typeof Fastify>;
let app: Awaited<ReturnType<typeof buildApp>>;
let discord: ReturnType<typeof discordConnection>;
const gatewayEvents: string[] = [];
const gateways: Parameters<DiscordGateway["start"]>[1][] = [];

beforeEach(async () => {
  await reset();
  dir = mkdtempSync(join(tmpdir(), "dashboard-secrets-"));
  fixture.file = join(dir, "secrets.json");
  writeFileSync(fixture.file, JSON.stringify(initial));
  gatewayEvents.length = 0;
  gateways.length = 0;
  discord = discordConnection(db, () => {
    let activeToken: string;
    return {
      start(token, callbacks) {
        activeToken = token;
        gatewayEvents.push(`啟動：${token}`);
        gateways.push(callbacks);
      },
      async stop() {
        gatewayEvents.push(`停止：${activeToken}`);
      },
    };
  });
  runner = Fastify({ logger: false });
  registerRunnerAuth(runner, () => runnerKey);
  registerRunnerSecrets(runner, fixture.file);
  const client = new HttpRunner(
    () => runnerKey,
    async (url, { body, headers }) => {
      const response = await runner.inject({
        method: "POST",
        url: new URL(url).pathname,
        headers,
        payload: body as string,
      });
      return { status: response.statusCode, body: response.body };
    },
  );
  app = await buildApp(
    db,
    undefined,
    undefined,
    undefined,
    client,
    undefined,
    () => void discord.refresh(),
  );
});

afterEach(async () => {
  await discord?.stop();
  await app?.close();
  await runner?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => db.close());

const put = (headers: Record<string, string>, payload: object) =>
  app.inject({ method: "PUT", url: "/api/secrets", headers, payload });

async function ownerSession(age = "1 minute") {
  const headers = await session();
  await db.query(
    "UPDATE sessions SET login='小林',created_at=now()-$1::interval",
    [age],
  );
  return headers;
}

it("擁有者可更新所有白名單欄位，回應與狀態只顯示是否設定及更新時間", async () => {
  const headers = await ownerSession();
  const saved = await put(headers, updates);
  expect(saved.statusCode).toBe(200);
  const status = await app.inject({ url: "/api/state", headers });
  expect(status.statusCode).toBe(200);
  const response = saved.json();
  expect(Object.keys(response)).toEqual(["connectionSecrets"]);
  expect(status.json().connectionSecrets).toEqual(response.connectionSecrets);
  expect(Object.keys(response.connectionSecrets)).toEqual(Object.keys(updates));
  for (const [field, value] of Object.entries(updates)) {
    expect(response.connectionSecrets[field]).toEqual({
      configured: true,
      updatedAt: expect.any(String),
    });
    expect(
      Date.parse(response.connectionSecrets[field].updatedAt),
    ).toBeGreaterThan(0);
    expect(saved.body).not.toContain(value);
    expect(status.body).not.toContain(value);
    // 應用程式 ID 是公開識別碼（也是機器人的使用者 ID），不遮蔽，否則「@機器人」會被遮掉。
    expect(scrubConnectionSecrets(`虛構紀錄 ${value}`)).toBe(
      field === "discordApplicationId"
        ? `虛構紀錄 ${value}`
        : "虛構紀錄 [已遮蔽連線金鑰]",
    );
  }
  const names =
    "LINE Channel Secret、LINE Channel Access Token、Discord 機器人權杖、Discord 應用程式 ID、OpenAI API 金鑰";
  expect(await db.query("SELECT kind,detail FROM audit")).toEqual([
    { kind: "settings", detail: `擁有者 小林 更新連線金鑰：${names}` },
  ]);
  expect(
    await db.query("SELECT kind,text,group_id FROM notifications"),
  ).toContainEqual({
    kind: "connection_secrets_updated",
    text: `連線金鑰已更新：${names}`,
    group_id: null,
  });
  const unchanged = await put(headers, {
    openaiKey: "  ",
    lineSecret: updates.lineSecret,
  });
  expect(unchanged.json()).toEqual(response);
  expect(await db.query("SELECT detail FROM audit")).toHaveLength(1);
});

it("未登入、一般管理者、缺少操作驗證或舊工作階段都不能寫入", async () => {
  const headers = await ownerSession("10 minutes 1 second");
  const body = { openaiKey: updates.openaiKey };
  await db.query(
    "INSERT INTO members(github_id,login,role) VALUES('1000002','小陳','admin')",
  );
  await db.query(
    "INSERT INTO sessions(id_hash,user_id,csrf,expires_at,created_at) VALUES($1,'1000002','fictional-csrf',now()+interval '1 hour',now())",
    [hash("fictional-admin-session")],
  );
  const admin = {
    ...headers,
    cookie: "af_session=fictional-admin-session",
    "x-csrf-token": "fictional-csrf",
  };
  expect((await put({}, body)).statusCode).toBe(401);
  expect((await put(admin, body)).statusCode).toBe(403);
  expect(
    (await app.inject({ url: "/api/state", headers: admin })).json(),
  ).not.toHaveProperty("connectionSecrets");
  expect(
    (await put({ cookie: headers.cookie, origin: headers.origin }, body))
      .statusCode,
  ).toBe(403);
  expect(
    (await put({ ...headers, origin: "https://fictional.invalid" }, body))
      .statusCode,
  ).toBe(403);
  const expired = await put(headers, body);
  expect(expired.statusCode).toBe(409);
  expect(expired.json().error).toContain("GitHub 登入已超過十分鐘");
  await db.query("UPDATE sessions SET created_at=NULL WHERE user_id='1000001'");
  expect((await put(headers, body)).json()).toEqual(expired.json());
  expect(readFileSync(fixture.file, "utf8")).toBe(JSON.stringify(initial));
  expect(await db.query("SELECT detail FROM audit")).toEqual([]);
});

it("不支援的欄位和格式錯誤回繁體中文，保留原檔且不建立稽核", async () => {
  const headers = await ownerSession();
  const forbidden = await put(headers, {
    githubClientSecret: "虛構內容",
    lineSecret: updates.lineSecret,
  });
  expect(forbidden.statusCode).toBe(400);
  expect(forbidden.json().error).toContain("不支援的欄位");
  const clientSecret = "fictional-discord-client-secret";
  const invalid = await put(headers, { discordToken: clientSecret });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().error).toContain("Reset Token");
  expect(invalid.body).not.toContain(clientSecret);
  expect(readFileSync(fixture.file, "utf8")).toBe(JSON.stringify(initial));
  expect(await db.query("SELECT detail FROM audit")).toEqual([]);
});

it("金鑰寫入後遇到暫時的稽核錯誤，會補寫一筆稽核和一則私訊", async () => {
  const headers = await ownerSession();
  const audit = vi
    .spyOn(db, "audit")
    .mockRejectedValueOnce(new Error("模擬資料庫暫時斷線"));
  try {
    const response = await put(headers, { openaiKey: updates.openaiKey });
    expect(response.statusCode).toBe(200);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(await db.query("SELECT detail FROM audit")).toEqual([
      { detail: "擁有者 小林 更新連線金鑰：OpenAI API 金鑰" },
    ]);
    expect(await db.query("SELECT text FROM notifications")).toEqual([
      { text: "連線金鑰已更新：OpenAI API 金鑰" },
    ]);
  } finally {
    audit.mockRestore();
  }
});

it("替換權杖或應用程式 ID 會先關閉舊 Gateway，移除權杖後記為未設定", async () => {
  const headers = await ownerSession();
  const first = updates.discordToken;
  const second = first.replace("Part3", "Part4");
  expect((await put(headers, { discordToken: first })).statusCode).toBe(200);
  await discord.refresh();
  await gateways[0].health("connected");
  expect(
    await db.one("SELECT ok FROM service_health WHERE name='discord'"),
  ).toEqual({ ok: true });
  const oldPlatform = discord.platform();
  expect((await put(headers, { discordToken: second })).statusCode).toBe(200);
  await discord.refresh();
  expect(discord.platform()).not.toBe(oldPlatform);
  expect(
    (await put(headers, { discordApplicationId: updates.discordApplicationId }))
      .statusCode,
  ).toBe(200);
  await discord.refresh();
  const removed = await put(headers, { discordToken: null });
  expect(removed.json().connectionSecrets.discordToken).toEqual({
    configured: false,
    updatedAt: expect.any(String),
  });
  await discord.refresh();
  expect(discord.platform()).toBeUndefined();
  expect(gatewayEvents).toEqual([
    `啟動：${first}`,
    `停止：${first}`,
    `啟動：${second}`,
    `停止：${second}`,
    `啟動：${second}`,
    `停止：${second}`,
  ]);
  await discord.stop();
  expect(
    await db.one("SELECT detail FROM service_health WHERE name='discord'"),
  ).toMatchObject({
    detail: expect.stringContaining("尚未填寫機器人權杖"),
  });
});
