import Fastify from "fastify";
import { Routes } from "discord.js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { downloadArchive } from "../server/archive-download.js";
import { githubHttpFetch } from "../server/github-http.js";
import { LineChatPlatform } from "../server/line-platform.js";
import { fetchLineQuota } from "../server/line-quota.js";
import {
  createAcceptanceFetch,
  startChatProvider,
} from "../scripts/acceptance/flows/chat-provider.js";

const nativeFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubEnv("AGENTFLOW_INSTANCE", "verify-chat-test");
  // 即使路由回歸，測試也只能連到自己啟動的本機服務。
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.hostname !== "127.0.0.1") throw new Error("測試傳輸拒絕外部連線");
    return nativeFetch(input, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function chatFixture() {
  const chat = await startChatProvider();
  onTestFinished(() => chat.close());
  vi.stubGlobal("fetch", createAcceptanceFetch({ chatOrigin: chat.origin }));
  return chat;
}

it("用完每月額度時 HTTP push 回 monthly limit，免費 reply 仍送達本群組", async () => {
  vi.stubEnv("AGENTFLOW_INSTANCE", "verify-266-line-20");
  vi.stubEnv("ACCEPTANCE_FLOW_REAL", "0");
  const chat = await chatFixture();
  const line = new LineChatPlatform("Fixtureline");
  await chat.setLineQuotaExhausted(true);
  const quota = await fetchLineQuota("Fixtureline");
  expect(quota.used).toBe(quota.limit);
  const push = await fetch("https://api.line.me/v2/bot/message/push", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "C-lantern", messages: [{ type: "text", text: "推送" }] }) });
  expect(push.status).toBe(429);
  expect(await push.json()).toMatchObject({ message: expect.stringMatching(/monthly limit/i) });
  chat.registerLineReply("Fixturefree", "C-lantern");
  expect((await line.replyToMessage({ replyToken: "Fixturefree" }, ["收到"])).status).toBe(200);
  expect(await chat.groupMessages("C-lantern")).toEqual(["收到"]);
  await chat.setLineQuotaExhausted(false);
  expect((await fetchLineQuota("Fixtureline")).used).toBe(0);
  vi.stubEnv("ACCEPTANCE_FLOW_REAL", "1");
  await expect(chat.setLineQuotaExhausted(true)).rejects.toThrow("固定劇本");
});

it("LINE 批次回覆與 Discord 頻道發送按群組保留送達順序，重送不重複入帳", async () => {
  const chat = await chatFixture();
  const line = new LineChatPlatform("Fixtureline");
  const discord = chat.discord;
  const channel = "100000000000000111";
  chat.registerLineReply("Fixturereply", "C-lantern");
  const pushed = await line.sendToGroup("C-lantern", "第一則", "Fixtureretry");
  const sent = await discord.sendToGroup(
    "discord:" + channel,
    "另一群",
    "Fixturenonce",
  );
  const batch = await line.replyToMessage({ replyToken: "Fixturereply" }, [
    "第二則",
    "第三則",
  ]);
  expect(batch.status).toBe(200);
  expect(
    await discord.sendToGroup("discord:" + channel, "另一群", "Fixturenonce"),
  ).toEqual(sent);
  expect(
    (await line.sendToGroup("C-lantern", "第一則", "Fixtureretry"))
      .newlyAccepted,
  ).toBe(false);
  expect(
    (await line.replyToMessage({ replyToken: "Fixturereply" }, ["重播"]))
      .status,
  ).toBe(400);
  expect(
    chat.records.map(({ sequence, groupId, kind, text }) => [
      sequence,
      groupId,
      kind,
      text,
    ]),
  ).toEqual([
    [1, "C-lantern", "push", "第一則"],
    [2, "discord:" + channel, "message", "另一群"],
    [3, "C-lantern", "reply", "第二則"],
    [4, "C-lantern", "reply", "第三則"],
  ]);
  const ids = chat.records.map((record) => record.messageId);
  expect(ids).toEqual([pushed.messageId, sent.messageId, ...batch.ids!]);
  expect(new Set(ids).size).toBe(4);
  expect(await chat.groupMessages("C-lantern")).toEqual([
    "第一則",
    "第二則",
    "第三則",
  ]);
  expect(await chat.groupMessages("discord:" + channel)).toEqual(["另一群"]);
  expect(JSON.stringify(chat.records)).not.toMatch(/Fixture/);
  await discord.react("discord:" + channel, sent.messageId);
  await discord.sendToAdmin(
    "discord:100000000000000011",
    "私訊",
    "Fixtureadmin",
  );
  expect(chat.records.at(-1)?.text).toBe("私訊");
  expect(await chat.groupMessages("discord:" + channel)).toEqual(["另一群"]);
});

it("LINE 帳號、成員及群組資料可讀，只有推播消耗額度", async () => {
  await chatFixture();
  const bot = "https://api.line.me/v2/bot";
  const before = await fetchLineQuota("Fixtureline");
  expect(before.used).toBe(0);
  expect(before.limit).toBeGreaterThan(0);
  const read = async (path: string) => (await fetch(bot + path)).json();
  expect(await read("/info")).toMatchObject({
    displayName: expect.any(String),
  });
  expect(await read("/group/C-lantern/summary")).toMatchObject({
    groupId: "C-lantern",
  });
  for (const path of [
    "/group/C-lantern/member/U-lin",
    "/room/R-demo/member/U-lin",
    "/profile/U-lin",
  ]) {
    expect(await read(path)).toMatchObject({
      userId: "U-lin",
      displayName: expect.any(String),
    });
  }
  const { count } = await read("/group/C-lantern/members/count");
  await new LineChatPlatform("Fixtureline").sendToGroup(
    "C-lantern",
    "點燈",
    "Fixturekey",
  );
  expect(await fetchLineQuota("Fixtureline")).toEqual({
    limit: before.limit,
    used: count,
  });
  expect((await fetch(bot + "/unknown")).status).toBe(404);
});

it("Discord 延後回覆、讀取、編輯原訊息與後續訊息沿用來源頻道", async () => {
  const chat = await chatFixture();
  const event = {
    id: "100000000000000121",
    applicationId: "100000000000000122",
    channelId: "100000000000000123",
    token: "Fixtureinteraction",
  };
  chat.registerDiscordInteraction(event);
  const api = "https://discord.com/api/v10";
  const callback = api + Routes.interactionCallback(event.id, event.token);
  const original =
    api + Routes.webhookMessage(event.applicationId, event.token, "@original");
  const write = (url: string, method: string, body: unknown) =>
    fetch(url, {
      method,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  expect((await fetch(original)).ok).toBe(false);
  expect((await write(callback, "POST", { type: 5 })).status).toBe(204);
  const anchor = await (await fetch(original)).json();
  expect(anchor).toMatchObject({
    id: expect.stringMatching(/^\d+$/),
    channel_id: event.channelId,
  });
  expect(
    await (await write(original, "PATCH", { content: "已收到" })).json(),
  ).toMatchObject({
    id: anchor.id,
    content: "已收到",
  });
  expect(await (await fetch(original)).json()).toMatchObject({
    id: anchor.id,
    content: "已收到",
  });
  const extra = await write(
    api + Routes.webhook(event.applicationId, event.token) + "?wait=true",
    "POST",
    { content: "處理中" },
  );
  expect((await extra.json()).id).not.toBe(anchor.id);
  expect(
    chat.records.map((record) => [record.groupId, record.kind, record.text]),
  ).toEqual([
    ["discord:" + event.channelId, "callback", ""],
    ["discord:" + event.channelId, "edit", "已收到"],
    ["discord:" + event.channelId, "followup", "處理中"],
  ]);
  expect((await write(callback, "POST", { type: 5 })).ok).toBe(false);
  expect(await chat.groupMessages("discord:" + event.channelId)).toEqual([
    "已收到",
    "處理中",
  ]);
  const privateEvent = {
    ...event,
    id: "100000000000000124",
    token: "Fixtureprivate",
  };
  chat.registerDiscordInteraction(privateEvent);
  await write(
    api + Routes.interactionCallback(privateEvent.id, privateEvent.token),
    "POST",
    { type: 5, data: { flags: 64 } },
  );
  await write(
    api +
      Routes.webhookMessage(
        privateEvent.applicationId,
        privateEvent.token,
        "@original",
      ),
    "PATCH",
    { content: "僅自己可見" },
  );
  expect(chat.records.at(-1)?.text).toBe("僅自己可見");
  expect(await chat.groupMessages("discord:" + event.channelId)).toEqual([
    "已收到",
    "處理中",
  ]);
  expect(JSON.stringify(chat.records)).not.toContain(event.token);
});

it("GitHub API、封存與本機請求各自抵達指定服務，保留方法、查詢、本文與中止訊號", async () => {
  const api = Fastify(),
    archive = Fastify();
  onTestFinished(async () => {
    await Promise.all([api.close(), archive.close()]);
  });
  api.post("/repos/demo/lantern/issues", (req) => ({
    path: req.url,
    body: req.body,
    header: req.headers["x-fixture"],
  }));
  const binary = Buffer.from([0, 255, 128, 10]);
  archive.get("/repos/demo/lantern/tarball/abc", () => binary);
  archive.get("/demo/lantern/tar.gz/abc", () => binary);
  const listen = { port: 0, host: "127.0.0.1" };
  const githubOrigin = await api.listen(listen);
  const archiveOrigin = await archive.listen(listen);
  const routed = createAcceptanceFetch({ githubOrigin, archiveOrigin });
  vi.stubGlobal("fetch", routed);
  const url = "https://api.github.com/repos/demo/lantern/issues?page=2";
  const request = new Request(url, { method: "POST", body: "燈籠" });
  const response = await githubHttpFetch(request, {
    headers: { "content-type": "text/plain", "x-fixture": "demo" },
  });
  expect(await response.json()).toEqual({
    path: "/repos/demo/lantern/issues?page=2",
    body: "燈籠",
    header: "demo",
  });
  for (const location of [
    "https://api.github.com/repos/demo/lantern/tarball/abc",
    "https://codeload.github.com/demo/lantern/tar.gz/abc",
    archiveOrigin + "/demo/lantern/tar.gz/abc",
  ]) {
    const stream = await downloadArchive(location, "Fixtureinstallation");
    expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(
      binary,
    );
  }
  await expect(
    routed(new URL(url), { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("已登記的 GitHub 替身可直接供應 tarball，雙斜線路徑也留在本機", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response("驗收"));
  vi.stubGlobal("fetch", transport);
  const origin = "http://127.0.0.1:15461";
  const routed = createAcceptanceFetch({ githubOrigin: origin });
  for (const path of [
    "/repos/demo/lantern/tarball/abc",
    "//example.invalid/archive?step=2",
  ]) {
    await routed("https://api.github.com" + path);
    const [input] = transport.mock.lastCall!;
    expect(input instanceof Request ? input.url : input.toString()).toBe(
      origin + path,
    );
  }
});

it("GitHub 網站只允許把 OAuth 權杖交換 POST 送到 GitHub 替身", async () => {
  const api = Fastify();
  onTestFinished(() => api.close());
  let exchanges = 0;
  api.post("/login/oauth/access_token", (req) => {
    exchanges++;
    expect(req.body).toEqual({ code: "Fixturecode" });
    return { access_token: "Fixtureoauth" };
  });
  const githubOrigin = await api.listen({ port: 0, host: "127.0.0.1" });
  const routed = createAcceptanceFetch({ githubOrigin });
  const url = "https://github.com/login/oauth/access_token";
  const exchange = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "Fixturecode" }),
  });
  expect(await (await routed(exchange)).json()).toEqual({ access_token: "Fixtureoauth" });
  await expect(routed(url)).rejects.toThrow();
  await expect(routed(url + "/extra", { method: "POST" })).rejects.toThrow();
  await expect(routed("https://github.com/login/oauth/authorize")).rejects.toThrow();
  await expect(createAcceptanceFetch({})(url, { method: "POST" })).rejects.toThrow();
  expect(exchanges).toBe(1);
});

it("任何 redirect 模式都拒絕轉址，第二個本機端點也收不到請求", async () => {
  const server = Fastify();
  onTestFinished(() => server.close());
  let visits = 0;
  server.get("/jump", (_req, res) => res.redirect("/arrived", 307));
  server.get("/missing", (_req, res) => res.code(302).send());
  server.get("/arrived", () => ++visits);
  const origin = await server.listen({ port: 0, host: "127.0.0.1" });
  const routed = createAcceptanceFetch({ githubOrigin: origin });
  for (const redirect of ["follow", "manual", "error"] as const) {
    await expect(
      routed("https://api.github.com/jump", { redirect }),
    ).rejects.toThrow();
    await expect(routed(origin + "/jump", { redirect })).rejects.toThrow();
  }
  await expect(routed(origin + "/missing")).rejects.toThrow();
  expect(visits).toBe(0);
});

it("未知主機、缺少對應、非 HTTPS 外部網址與正式埠都在傳輸前拒絕", async () => {
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  const routed = createAcceptanceFetch({
    chatOrigin: "http://127.0.0.1:15460",
  });
  for (const url of [
    "https://api.line.me.invalid/test",
    "https://unknown.invalid/",
    "https://api.github.com/",
    "https://codeload.github.com/",
    "http://api.line.me/",
    "https://api.line.me:8443/",
    "http://localhost:4310/",
    "http://127.0.0.1:4312/",
    "http://[::1]:5439/",
    "file:///fixture",
    "http://192.0.2.10/",
    "http://fixture@localhost:15460/",
  ])
    await expect(routed(url)).rejects.toThrow();
  for (const chatOrigin of [
    "https://unknown.invalid",
    "http://localhost:4310",
    "http://127.0.0.1:15460/path",
  ]) {
    expect(() => createAcceptanceFetch({ chatOrigin })).toThrow();
  }
  expect(transport).not.toHaveBeenCalled();
});

it("缺少驗收實例及正式環境拒絕啟用，換回正式實例後既有 wrapper 也停止", async () => {
  const routed = createAcceptanceFetch({});
  for (const instance of ["production", undefined, "verify-"]) {
    vi.stubEnv("AGENTFLOW_INSTANCE", instance);
    expect(() => createAcceptanceFetch({})).toThrow();
    await expect(routed("http://127.0.0.1:15460/")).rejects.toThrow(
      /驗收|AGENTFLOW_INSTANCE/,
    );
    await expect(startChatProvider()).rejects.toThrow();
  }
  vi.stubEnv("AGENTFLOW_INSTANCE", "verify-chat-test");
  vi.stubEnv("NODE_ENV", "production");
  expect(() => createAcceptanceFetch({})).toThrow();
  await expect(startChatProvider()).rejects.toThrow();
});
