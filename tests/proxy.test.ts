import { beforeEach, afterAll, afterEach, it, expect, vi } from "vitest";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ openaiKey: "fictional-master-key" }),
}));
import { db, reset, fixture } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Budget } from "../server/budget.js";
import { hash } from "../server/auth.js";
beforeEach(reset);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => db.close());
async function setup() {
  const p = await fixture();
  const t = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,status,dedupe_key) VALUES($1,'group-a','測試','測試','running','proxy') RETURNING id",
    [p],
  );
  const reservation = await new Budget(db).reserve(3, t.id);
  await db.query(
    "INSERT INTO runs(task_id,version,reservation_id,token_hash,model,deadline,proxy_active) VALUES($1,1,$2,$3,'gpt-6.1-sol',now()+interval '30 minutes',true)",
    [t.id, reservation, hash("temporary-token")],
  );
  return { app: await buildApp(db), reservation };
}
it("模型、遠端工具、額度與取消狀態都不能由工作容器繞過", async () => {
  const s = await setup();
  const upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
  const send = (body: Record<string, unknown>) =>
    s.app.inject({
      method: "POST",
      url: "/internal/proxy/v1/responses",
      headers: { authorization: "Bearer temporary-token" },
      payload: body,
    });
  expect((await send({ model: "other-model" })).statusCode).toBe(403);
  expect(
    (await send({ model: "gpt-6.1-sol", tools: [{ type: "web_search" }] }))
      .statusCode,
  ).toBe(403);
  await db.query("UPDATE reservations SET spent=amount");
  expect((await send({ model: "gpt-6.1-sol" })).statusCode).toBe(429);
  await db.query("UPDATE tasks SET status='cancelled'");
  expect((await send({ model: "gpt-6.1-sol" })).statusCode).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
  await s.app.close();
});
it("執行逾期後即使持有短效授權也不能再呼叫模型", async () => {
  const s = await setup(),
    upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
  await db.query("UPDATE runs SET deadline=now()-interval '1 second'");
  const r = await s.app.inject({
    method: "POST",
    url: "/internal/proxy/v1/responses",
    headers: { authorization: "Bearer temporary-token" },
    payload: { model: "gpt-6.1-sol" },
  });
  expect(r.statusCode).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
  await s.app.close();
});
it("供應商限流保留重試時間與安全代碼，不回傳原始錯誤內容", async () => {
  const s = await setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "rate_limit_exceeded",
              message: "fictional-master-key 機密提示",
            },
          }),
          { status: 429, headers: { "Retry-After": "12" } },
        ),
    ),
  );
  const r = await s.app.inject({
    method: "POST",
    url: "/internal/proxy/v1/responses",
    headers: { authorization: "Bearer temporary-token" },
    payload: { model: "gpt-6.1-sol", input: "測試" },
  });
  expect(r.statusCode).toBe(429);
  expect(r.headers["retry-after"]).toBe("12");
  expect(r.json().error.code).toBe("rate_limit_exceeded");
  const audit = await db.query(
    "SELECT detail FROM audit WHERE kind='api_error'",
  );
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit) + r.body).not.toContain("fictional-master-key");
  expect(await db.query("SELECT * FROM usage")).toHaveLength(0);
  await s.app.close();
});
it("代理只向供應商使用主金鑰、限制輸出且記錄實際用量", async () => {
  const s = await setup();
  let sent: Record<string, unknown> = {};
  const upstream = vi.fn(async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer fictional-master-key",
    );
    return new Response(
      JSON.stringify({
        id: "response",
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 100,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", upstream);
  const r = await s.app.inject({
    method: "POST",
    url: "/internal/proxy/v1/responses",
    headers: { authorization: "Bearer temporary-token" },
    payload: {
      model: "gpt-6.1-sol",
      input: "測試",
      max_output_tokens: 999999,
      store: true,
    },
  });
  expect(r.statusCode).toBe(200);
  expect(sent.max_output_tokens).toBe(16000);
  expect(sent.store).toBe(false);
  expect(r.body).not.toContain("fictional-master-key");
  expect((await db.query("SELECT * FROM usage")).length).toBe(1);
  await s.app.close();
});
it("SDK 收到串流完成後的下一輪會等前一輪記帳，不誤判成併發限流", async () => {
  const realFetch = globalThis.fetch;
  const s = await setup();
  const url = await s.app.listen({ port: 0, host: "127.0.0.1" });
  let release!: () => void;
  const accounting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = Budget.prototype.charge;
  let charges = 0;
  vi.spyOn(Budget.prototype, "charge").mockImplementation(async function (
    this: Budget,
    ...args
  ) {
    if (++charges === 1) await accounting;
    return original.apply(this, args);
  });
  const upstream = vi.fn(
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", upstream);
  const send = () =>
    realFetch(`${url}/internal/proxy/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer temporary-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-6.1-sol", stream: true }),
    });
  try {
    const first = await send();
    const reader = first.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const next = send();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upstream).toHaveBeenCalledTimes(1);
    release();
    const second = await next;
    expect(second.status).toBe(200);
    await second.text();
    while (!(await reader.read()).done) {}
    expect(await db.query("SELECT * FROM usage")).toHaveLength(2);
  } finally {
    release();
    await s.app.close();
  }
});
