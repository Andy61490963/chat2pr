import { afterAll, afterEach, beforeEach, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "驗收簽章",
    lineToken: "驗收LINE憑證",
    openaiKey: "sk-acceptance-secret-never-log-123456",
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { hash } from "../server/auth.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { downloadArchive } from "../server/archive-download.js";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  await reset();
  app = await buildApp(db);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await app.close();
});
afterAll(() => db.close());
const event = (n: number, group = "group-a") => ({
  webhookEventId: `驗收事件-${n}`,
  type: "message",
  timestamp: 1000000 - n,
  source: { type: "group", groupId: group },
  message: { id: `驗收訊息-${n}`, type: "text", text: `第${n}則聊天` },
});
async function send(events: unknown[], valid = true) {
  const body = JSON.stringify({ events });
  return app.inject({
    method: "POST",
    url: "/webhooks/line",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-line-signature": valid
        ? createHmac("sha256", "驗收簽章").update(body).digest("base64")
        : "錯誤簽章",
    },
  });
}
it("E01.ingest：1／100／1000 訊息分批亂序與重送只落地一次，先撤回不復活", async () => {
  const all = Array.from({ length: 1000 }, (_, n) => event(n));
  expect((await send([all[0]])).statusCode).toBe(200);
  expect((await send(all.slice(0, 100))).statusCode).toBe(200);
  expect(
    (
      await send([
        {
          webhookEventId: "先撤回",
          type: "unsend",
          source: { type: "group", groupId: "group-a" },
          unsend: { messageId: "驗收訊息-999" },
        },
      ])
    ).statusCode,
  ).toBe(200);
  for (let offset = 900; offset >= 0; offset -= 100) {
    const batch = all.slice(offset, offset + 100).reverse();
    expect((await send(batch)).statusCode).toBe(200);
    expect((await send(batch)).statusCode).toBe(200);
  }
  expect(
    (await db.one<{ n: number }>("SELECT count(*)::int n FROM messages")).n,
  ).toBe(1000);
  expect(
    (
      await db.one<{ n: number }>(
        "SELECT count(*)::int n FROM events WHERE provider='line'",
      )
    ).n,
  ).toBe(1001);
  expect(
    await db.one("SELECT text,revoked FROM messages WHERE id='驗收訊息-999'"),
  ).toEqual({ text: null, revoked: true });
  expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
}, 60000);
it("E01.invalid：單批超過100、錯誤簽章、無效型別與超大本文不保存", async () => {
  expect(
    (await send(Array.from({ length: 101 }, (_, n) => event(n)))).statusCode,
  ).toBe(400);
  expect((await send([event(1)], false)).statusCode).toBe(401);
  expect(
    (
      await send([
        { ...event(2), message: { id: "錯誤", type: "text", text: 123 } },
      ])
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await send([
        {
          ...event(3),
          message: {
            id: "超長",
            type: "text",
            text: "x".repeat(4 * 1024 * 1024),
          },
        },
      ])
    ).statusCode,
  ).toBe(413);
  expect(await db.query("SELECT id FROM messages")).toHaveLength(0);
});
it("E03.notification：供應商已接受但本機寫入中斷，重試沿用同一去重碼且只接受一次", async () => {
  await db.query(
    'UPDATE settings SET value=value||\'{"admin_line_id":"驗收管理者"}\'',
  );
  const line = new Line(db),
    accepted = new Set<string>(),
    keys: string[] = [];
  const upstream = vi.fn(async (_url: string, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)["X-Line-Retry-Key"];
    keys.push(key);
    if (accepted.has(key))
      return new Response(null, {
        status: 409,
        headers: { "x-line-accepted-request-id": "accepted-remote-request-id" },
      });
    accepted.add(key);
    return new Response("{}");
  });
  vi.stubGlobal("fetch", upstream);
  await line.notify(null, "ready", "唯一驗收通知", "完成");
  await line.notify(null, "ready", "唯一驗收通知", "完成");
  const original = db.query.bind(db);
  let interrupted = false;
  const spy = vi.spyOn(db, "query").mockImplementation(async (sql, values) => {
    if (!interrupted && sql.startsWith("UPDATE notifications SET sent_at")) {
      interrupted = true;
      throw new Error("模擬供應商接受後的資料庫中斷");
    }
    return original(sql, values);
  });
  await line.flushNotifications();
  spy.mockRestore();
  await line.flushNotifications();
  await line.flushNotifications();
  expect(accepted.size).toBe(1);
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(new Set(keys).size).toBe(1);
  const rows = await db.query<{ sent_at: Date; attempts: number }>(
    "SELECT sent_at,attempts FROM notifications",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].sent_at).not.toBeNull();
  expect(rows[0].attempts).toBe(2);
});
async function proxy() {
  const p = await fixture();
  const task = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,status,dedupe_key) VALUES($1,'group-a','故障驗收','摘要','running','provider') RETURNING id",
    [p],
  );
  const reservation = await new Budget(db).reserve(3, task.id);
  await db.query(
    "INSERT INTO runs(task_id,version,reservation_id,token_hash,model,deadline,proxy_active) VALUES($1,1,$2,$3,'gpt-6.1-sol',now()+interval '30 minutes',true)",
    [task.id, reservation, hash("acceptance-token")],
  );
  return () =>
    app.inject({
      method: "POST",
      url: "/internal/proxy/v1/responses",
      headers: { authorization: "Bearer acceptance-token" },
      payload: { model: "gpt-6.1-sol", input: "無敏感測試" },
    });
}
it("E06.statuses：AI／LINE圖片／GitHub下載4014034295xx不洩漏回應或憑證，不無限重試", async () => {
  const call = await proxy();
  for (const status of [401, 403, 429, 500, 503]) {
    const response = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "internal_detail",
            message: "sk-acceptance-secret-never-log-123456",
          },
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    const upstream = vi.fn(async () => response());
    vi.stubGlobal("fetch", upstream);
    const result = await call();
    expect(result.statusCode).toBe(status);
    expect(result.body).not.toContain("never-log");
    await expect(new Line(db).image("圖片")).rejects.toThrow(String(status));
    const archive = vi.fn(async () => response());
    await expect(
      downloadArchive(
        "https://fixture.invalid/archive",
        "sk-acceptance-secret-never-log-123456",
        archive,
      ),
    ).rejects.toThrow(String(status));
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenCalledOnce();
  }
  expect(
    JSON.stringify(await db.query("SELECT detail FROM audit")),
  ).not.toContain("never-log");
  expect(await db.query("SELECT * FROM usage")).toHaveLength(0);
});
it.each([401, 403, 429, 500, 503])(
  "E06.notifications：LINE %i 最多嘗試3次且保留原因",
  async (status) => {
    await db.query(
      'UPDATE settings SET value=value||\'{"admin_line_id":"驗收管理者"}\'',
    );
    const upstream = vi.fn(
      async () => new Response("憑證不能出現在本機", { status }),
    );
    vi.stubGlobal("fetch", upstream);
    const line = new Line(db);
    await line.notify(null, "failed", "錯誤通知", "需要處理");
    for (let n = 0; n < 6; n++) await line.flushNotifications();
    expect(upstream).toHaveBeenCalledTimes(3);
    const row = await db.one<{
      attempts: number;
      last_error: string;
      sent_at: Date;
    }>("SELECT * FROM notifications");
    expect(row.attempts).toBe(3);
    expect(row.sent_at).toBeNull();
    expect(row.last_error).toContain(String(status));
    expect(row.last_error).not.toContain("憑證不能");
  },
);
it("E06.timeout：模型請求受工作deadline中止，不再送出第二次請求", async () => {
  const call = await proxy();
  await db.query("UPDATE runs SET deadline=now()+interval '500 milliseconds'");
  const upstream = vi.fn(
    (_url, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(new Error("測試上游被中止")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", upstream);
  const start = Date.now(),
    result = await call();
  expect(result.statusCode).toBe(500);
  expect(Date.now() - start).toBeLessThan(3000);
  expect(upstream).toHaveBeenCalledOnce();
  expect((await call()).statusCode).toBe(403);
  expect(upstream).toHaveBeenCalledOnce();
});
it("E06.stream：模型串流中斷時結束客戶端、保守記帳一次並釋放鎖", async () => {
  await proxy();
  const realFetch = globalThis.fetch;
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const upstream = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"type":"response.created"}\n\n'),
            );
            setTimeout(
              () =>
                controller.error(
                  new Error(
                    "測試串流中斷 sk-acceptance-secret-never-log-123456",
                  ),
                ),
              10,
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", upstream);
  const result = await realFetch(url + "/internal/proxy/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer acceptance-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-6.1-sol", stream: true }),
    signal: AbortSignal.timeout(3000),
  });
  expect(await result.text()).toContain("response.created");
  expect(upstream).toHaveBeenCalledOnce();
  expect(await db.query("SELECT * FROM usage")).toHaveLength(1);
  let audits: { detail: string }[] = [];
  for (let n = 0; n < 50; n++) {
    audits = await db.query(
      "SELECT detail FROM audit WHERE kind='api_stream_error'",
    );
    if (audits.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits)).not.toContain("never-log");
});
it("E08.budget：50個並行預留最多用完15美元，停止AI後仍能收取新訊息", async () => {
  await fixture();
  const budget = new Budget(db);
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, () => budget.reserve(3)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(45);
  const classify = vi.fn(),
    github = new GitHub();
  const triage = new Triage(db, { classify }, github, new Line(db), budget);
  expect((await send([event(1)])).statusCode).toBe(200);
  await expect(triage.process("group-a")).rejects.toThrow("額度不足");
  expect(classify).not.toHaveBeenCalled();
  expect((await send([event(2)])).statusCode).toBe(200);
  expect(
    await db.query("SELECT id FROM messages WHERE NOT processed"),
  ).toHaveLength(2);
  expect((await budget.summary()).reserved).toBe(15);
});
it("E12.authorization：非管理者不能讀訊息圖片或改設定，跨群游標不能取得別群資料", async () => {
  await fixture();
  const headers = await session();
  await send([event(1), event(2, "group-b")]);
  const own = await app.inject({
    url: "/api/groups/group-a/messages",
    headers,
  });
  expect(own.statusCode).toBe(200);
  expect(own.body).not.toContain("驗收訊息-2");
  expect(
    (
      await app.inject({
        url:
          "/api/groups/group-a/messages?before=" +
          encodeURIComponent("驗收訊息-2"),
        headers,
      })
    ).statusCode,
  ).toBe(400);
  await db.query("UPDATE sessions SET user_id='非管理者'");
  for (const url of [
    "/api/state",
    "/api/groups/group-a/messages",
    "/api/messages/驗收訊息-1/image",
  ])
    expect(
      (await app.inject({ url: encodeURI(url), headers })).statusCode,
    ).toBe(401);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        headers,
        payload: { paused: false },
      })
    ).statusCode,
  ).toBe(401);
});
