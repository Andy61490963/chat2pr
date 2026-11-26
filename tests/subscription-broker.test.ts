import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  SubscriptionBroker,
  subscriptionLimits,
  type SubscriptionIdentity,
} from "../server/subscription-broker.js";
import { AppError } from "../server/policy.js";

const identity: SubscriptionIdentity = {
  accessToken: "synthetic-main-access-token-123456789",
  accountId: "synthetic-account-id-123456",
  secrets: ["synthetic-refresh-token-123456789"],
  models: ["model-test"],
  defaultModel: "model-test",
};
const event = (
  text = "完成",
  usage: unknown = { input_tokens: 10, output_tokens: 2 },
) => ({
  type: "response.completed",
  response: {
    usage,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  },
});
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of close.splice(0)) await f();
});
async function fixture(
  options: ConstructorParameters<typeof SubscriptionBroker>[0] = {
    credentials: async () => identity,
  },
) {
  let calls = 0;
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e instanceof AppError ? e.statusCode : 500).send({
      error: { message: e instanceof AppError ? e.message : "安全錯誤" },
    }),
  );
  const broker = new SubscriptionBroker({
    ...options,
    upstreamFetch:
      options.upstreamFetch ??
      (async () => {
        calls++;
        return sse([event()]);
      }),
  });
  broker.register(app);
  await app.ready();
  close.push(async () => {
    broker.close();
    await app.close();
  });
  const runId = randomUUID();
  const lease = await broker.issue({
    runId,
    phase: "code",
    deadline: Date.now() + 10000,
  });
  const send = (
    body: Record<string, unknown> = {},
    url = `${lease.basePath}/responses`,
    token = lease.token,
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        model: "model-test",
        input: [],
        stream: true,
        store: false,
        ...body,
      },
    });
  return { app, broker, runId, lease, send, calls: () => calls };
}
describe("訂閱主憑證隔離與有限階段能力", () => {
  it("正常請求固定訂閱上游、不轉送任意URL/標頭且保留用量", async () => {
    let seen: RequestInit | undefined;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async (url, init) => {
        expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
        seen = init;
        return sse([event()]);
      },
    });
    const response = await f.send({
      upstream: "https://api.openai.com",
      account: "other",
      headers: { Authorization: "evil" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("完成");
    expect(seen?.redirect).toBe("error");
    expect(JSON.parse(String(seen?.body))).not.toHaveProperty("upstream");
    expect((seen?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${identity.accessToken}`,
    );
    expect(f.broker.usage(f.runId)).toMatchObject({
      requests: 1,
      outputTokens: 2,
    });
    expect(response.body).not.toContain(identity.accountId);
  });
  it.each(["additional_tools", "tool_search_output"])(
    "%s 的巢狀namespace本機工具與具名選擇可正常使用",
    async (type) => {
      const f = await fixture();
      const r = await f.send({
        input: [
          {
            type,
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [
                  { type: "custom", name: "exec" },
                  { type: "function", name: "wait" },
                ],
              },
            ],
          },
        ],
        tool_choice: { type: "custom", name: "exec", namespace: "functions" },
      });
      expect(r.statusCode).toBe(200);
      expect(f.calls()).toBe(1);
    },
  );
  it.each([
    ["additional_tools", [{ type: "web_search" }]],
    [
      "additional_tools",
      [{ type: "mcp", name: "remote", server_url: "https://example.invalid" }],
    ],
    [
      "additional_tools",
      [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "computer_use_preview", name: "remote" }],
        },
      ],
    ],
    [
      "tool_search_output",
      [
        {
          type: "namespace",
          name: "tools",
          tools: [{ type: "web_search", name: "remote" }],
        },
      ],
    ],
    ["additional_tools", null],
    [
      "additional_tools",
      [
        {
          type: "namespace",
          name: "functions",
          tools: { type: "function", name: "exec" },
        },
      ],
    ],
  ])("%s 不能從input或namespace繞過遠端工具限制", async (type, tools) => {
    const f = await fixture();
    const r = await f.send({ input: [{ type, role: "developer", tools }] });
    expect(r.statusCode).toBe(403);
    expect(f.calls()).toBe(0);
  });
  it.each([
    ["跨模型", { model: "other" }, 403],
    ["遠端歷史", { previous_response_id: "old" }, 400],
    ["遠端工具", { tools: [{ type: "web_search" }] }, 403],
    ["遠端工具選擇", { tool_choice: { type: "web_search" } }, 403],
    ["未宣告工具", { tool_choice: { type: "function", name: "missing" } }, 403],
    ["保存", { store: true }, 400],
    ["背景", { background: true }, 400],
    ["非串流", { stream: false }, 400],
  ])("拒絕%s且不呼上游", async (_name, body, status) => {
    const f = await fixture();
    expect((await f.send(body as Record<string, unknown>)).statusCode).toBe(
      status,
    );
    expect(f.calls()).toBe(0);
  });
  it("跨run/path、無token、結束phase重播皆失敗，新phase用新token", async () => {
    const f = await fixture();
    expect(
      (await f.send({}, `/v1/${randomUUID()}/${randomUUID()}/responses`))
        .statusCode,
    ).toBe(403);
    expect((await f.send({}, undefined, "f".repeat(64))).statusCode).toBe(403);
    f.lease.revoke();
    expect((await f.send()).statusCode).toBe(403);
    const second = await f.broker.issue({
      runId: f.runId,
      phase: "review",
      model: "model-test",
      deadline: Date.now() + 10000,
    });
    expect(second.token).not.toBe(f.lease.token);
    expect(
      (await f.send({}, `${second.basePath}/responses`, second.token))
        .statusCode,
    ).toBe(200);
    f.broker.revoke(f.runId);
    await expect(
      f.broker.issue({
        runId: f.runId,
        phase: "code",
        deadline: Date.now() + 10000,
      }),
    ).rejects.toThrow("已取消");
  });
  it("用量上限跨phase累計，失敗及下一階段不能重新取得128次", async () => {
    const f = await fixture();
    for (let i = 0; i < subscriptionLimits.requests; i++)
      expect((await f.send()).statusCode).toBe(200);
    f.lease.revoke();
    const next = await f.broker.issue({
      runId: f.runId,
      phase: "review",
      deadline: Date.now() + 10000,
    });
    expect(
      (await f.send({}, `${next.basePath}/responses`, next.token)).statusCode,
    ).toBe(429);
    expect(f.calls()).toBe(subscriptionLimits.requests);
  });
  it.each([
    ["完整文字", [event(identity.accessToken)]],
    [
      "跨delta",
      [
        {
          type: "response.output_text.delta",
          delta: identity.accessToken.slice(0, 15),
        },
        {
          type: "response.output_text.delta",
          delta: identity.accessToken.slice(15),
        },
        event(),
      ],
    ],
    ["refresh", [event(identity.secrets[0])]],
    ["帳號", [event(identity.accountId)]],
    ["錯誤事件", [{ type: "error", message: identity.accessToken }]],
    [
      "巢狀錯誤",
      [{ ...event(), response: { error: { message: identity.accessToken } } }],
    ],
  ])("%s不得把主憑證送到worker", async (_name, events) => {
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => sse(events as unknown[]),
    });
    const r = await f.send();
    expect(r.statusCode).toBe(502);
    for (const secret of [
      identity.accessToken,
      identity.accountId,
      ...identity.secrets,
    ])
      expect(r.body).not.toContain(secret);
    expect(f.broker.usage(f.runId)?.revoked).toBe(true);
    expect((await f.send()).statusCode).toBe(403);
  });
  it.each([
    ["無usage", [event("完成", null)]],
    ["負input", [event("完成", { input_tokens: -1, output_tokens: 1 })]],
    [
      "錯誤cache",
      [
        event("完成", {
          input_tokens: 1,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: 2 },
        }),
      ],
    ],
    ["非整數output", [event("完成", { input_tokens: 1, output_tokens: 1.5 })]],
    ["完成後錯誤", [event(), { type: "error", message: "later failure" }]],
    ["重複完成", [event(), event()]],
    ["未完成", [{ type: "response.created" }]],
  ])("%s保守撤銷run而非盲重試", async (_name, events) => {
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => sse(events as unknown[]),
    });
    expect((await f.send()).statusCode).toBe(502);
    expect(f.broker.usage(f.runId)?.revoked).toBe(true);
  });
  it("401只在可信主機刷新一次，舊token回顯也不得流出", async () => {
    let count = 0,
      refreshes = 0;
    const f = await fixture({
      credentials: async (refresh) => {
        if (refresh) refreshes++;
        return refresh
          ? { ...identity, accessToken: "synthetic-new-access-token-123456789" }
          : identity;
      },
      upstreamFetch: async () =>
        ++count === 1
          ? new Response("do not expose", { status: 401 })
          : sse([event(identity.accessToken)]),
    });
    const r = await f.send();
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain(identity.accessToken);
    expect(refreshes).toBe(1);
    expect(count).toBe(2);
  });
  it.each([
    ["error.code", { type: "error", code: "usage_limit_reached" }, 429],
    ["error.rate", { type: "error", code: "rate_limit_exceeded" }, 429],
    [
      "failed.error.code",
      {
        type: "response.failed",
        response: { error: { code: "rate_limit_exceeded" } },
      },
      429,
    ],
    [
      "error.error.type",
      { type: "error", error: { type: "usage_limit_reached" } },
      429,
    ],
    ["未知代碼", { type: "error", code: "unknown_upstream_failure" }, 502],
    ["非額度錯誤", { type: "error", code: "permission_denied" }, 502],
    [
      "完成事件冒充額度",
      { ...event(), response: { error: { code: "usage_limit_reached" } } },
      502,
    ],
    [
      "錯誤代碼只接受完整字串",
      { type: "error", code: "usage_limit_reached_suffix" },
      502,
    ],
  ])("SSE %s只以可信代碼辨識額度且不洩漏原文", async (_name, value, status) => {
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () =>
        sse([{ ...value, message: `usage limit 429 ${identity.accessToken}` }]),
    });
    const response = await f.send();
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain(identity.accessToken);
    expect(response.body).not.toContain("usage limit");
    expect(f.broker.usage(f.runId)?.revoked).toBe(true);
    expect((await f.send()).statusCode).toBe(403);
  });
  it("正常assistant文字含額度詞或代碼不會觸發額度停用", async () => {
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () =>
        sse([
          {
            type: "response.output_text.delta",
            delta: "usage limit 429",
            code: "usage_limit_reached",
          },
          event("rate_limit_exceeded usage_limit_reached"),
        ]),
    });
    const response = await f.send();
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("rate_limit_exceeded");
    expect(f.broker.usage(f.runId)?.revoked).toBe(false);
  });
  it("HTTP429仍使用安全額度錯誤並撤銷工作", async () => {
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () =>
        new Response(identity.accessToken, { status: 429 }),
    });
    const response = await f.send();
    expect(response.statusCode).toBe(429);
    expect(response.body).toContain("Codex 訂閱額度已達上限");
    expect(response.body).not.toContain(identity.accessToken);
    expect(f.broker.usage(f.runId)?.revoked).toBe(true);
  });
  it("上游重導/例外不得洩密或重試API", async () => {
    let count = 0;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => {
        count++;
        throw new Error(identity.accessToken);
      },
    });
    const r = await f.send();
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain(identity.accessToken);
    expect(count).toBe(1);
  });
  it("登入等待超期會立即結束；稍後登入結果不產生可用能力", async () => {
    let resolve!: (v: SubscriptionIdentity) => void;
    const broker = new SubscriptionBroker({
      credentials: () => new Promise((r) => (resolve = r)),
    });
    close.push(async () => broker.close());
    const runId = randomUUID();
    const pending = broker.issue({
      runId,
      phase: "code",
      deadline: Date.now() + 30,
    });
    await expect(pending).rejects.toThrow("超過期限");
    resolve(identity);
    expect(broker.usage(runId)?.requests).toBe(0);
  });
  it("取消會中斷登入等待，不能遲到復活", async () => {
    let resolve!: (v: SubscriptionIdentity) => void;
    const broker = new SubscriptionBroker({
      credentials: () => new Promise((r) => (resolve = r)),
    });
    close.push(async () => broker.close());
    const runId = randomUUID(),
      pending = broker.issue({
        runId,
        phase: "code",
        deadline: Date.now() + 10000,
      });
    broker.revoke(runId);
    await expect(pending).rejects.toThrow("已取消");
    resolve(identity);
  });
});

describe("上游失敗只留下固定類別與狀態碼（#264）", () => {
  it("可信執行器只回報本階段的上游結果，未使用上游不能清除故障", async () => {
    let now = Date.now();
    const success = await fixture({ credentials: async () => identity, now: () => now });
    expect(success.lease.outcome()).toEqual({});
    expect((await success.send()).statusCode).toBe(200);
    const observed = now;
    now += 1000;
    expect(success.lease.outcome()).toEqual({ upstreamSucceeded: true, upstreamObservedAt: observed });
    const blocked = await fixture();
    expect((await blocked.send({ model: "invalid" })).statusCode).toBe(403);
    expect(blocked.lease.outcome()).toEqual({});
    const failed = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => new Response(null, { status: 503 }),
      now: () => now,
    });
    expect((await failed.send()).statusCode).toBe(502);
    expect(failed.lease.outcome()).toEqual({ upstreamFailure: { kind: "server_error", status: 503 }, upstreamObservedAt: now });
  });
  const upstreamText = "虛構上游錯誤：內部節點 node-7 回應 overloaded";
  const failing = (
    upstreamFetch: typeof fetch,
    credentials: ConstructorParameters<typeof SubscriptionBroker>[0]["credentials"] = async () => identity,
  ) => fixture({ credentials, upstreamFetch });
  const body = (text: string, status: number, type = "application/json") =>
    new Response(JSON.stringify({ error: { message: text, code: "server_error" } }), {
      status,
      headers: { "Content-Type": type, "X-Upstream-Node": "node-7" },
    });
  const frames = (...events: unknown[]) => sse(events);
  it("串流正在讀取時取消不當成上游斷線", async () => {
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const work = await failing(async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options!.signal!.addEventListener("abort", () => controller.error(new Error(upstreamText)), { once: true });
      },
      pull() { reading(); },
    }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } }));
    const pending = work.send().then(response => response);
    await started;
    work.broker.revoke(work.runId);
    expect((await pending).statusCode).toBe(408);
    expect(work.lease.outcome()).toEqual({});
  });
  it("刷新登入時取消不當成登入失效", async () => {
    let refreshing!: () => void;
    const started = new Promise<void>((resolve) => { refreshing = resolve; });
    const work = await failing(async () => body(upstreamText, 401), async (refresh) => {
      if (refresh) {
        refreshing();
        return new Promise<typeof identity>(() => {});
      }
      return identity;
    });
    const pending = work.send().then(response => response);
    await started;
    work.broker.revoke(work.runId);
    expect((await pending).statusCode).toBe(408);
    expect(work.lease.outcome()).toEqual({});
  });
  it.each([
    [503, 401, "auth"],
    [429, 429, "quota"],
  ] as const)("上游回 401 後刷新失敗（%i）仍保留原狀態，不再推論或傳出原文", async (refreshStatus, relayStatus, kind) => {
    let requests = 0;
    const work = await failing(async () => {
      requests++;
      return body(upstreamText, 401);
    }, async (refresh) => {
      if (refresh) throw new AppError(refreshStatus, upstreamText);
      return identity;
    });
    const reply = await work.send();
    expect(reply.statusCode).toBe(relayStatus);
    expect(reply.body).not.toContain(upstreamText);
    expect(work.lease.outcome()).toEqual({ upstreamFailure: { kind, status: 401 }, upstreamObservedAt: expect.any(Number) });
    expect(requests).toBe(1);
  });
  it.each([
    ["上游 503", async () => body(upstreamText, 503), { kind: "server_error", status: 503 }],
    ["上游 500", async () => body(upstreamText, 500), { kind: "server_error", status: 500 }],
    ["上游 400 拒絕", async () => body(upstreamText, 400), { kind: "rejected", status: 400 }],
    ["上游 404", async () => body(upstreamText, 404), { kind: "rejected", status: 404 }],
    ["上游 429", async () => body(upstreamText, 429), { kind: "quota", status: 429 }],
    [
      "連線失敗",
      async () => {
        throw new Error(`connect ECONNRESET ${upstreamText}`);
      },
      { kind: "connection" },
    ],
    [
      "傳輸層的固定連線錯誤",
      async () => {
        throw new AppError(502, "訂閱上游連線失敗");
      },
      { kind: "connection" },
    ],
    [
      "不是串流",
      async () => new Response(upstreamText, { headers: { "Content-Type": "text/html" } }),
      { kind: "invalid_response" },
    ],
    [
      "串流事件不是 JSON",
      async () =>
        new Response(`data: {${upstreamText}\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      { kind: "invalid_response" },
    ],
    ["串流事件是空值", async () => frames(null), { kind: "invalid_response" }],
    ["串流事件缺少類型", async () => frames({}), { kind: "invalid_response" }],
    [
      "串流缺少用量",
      async () => frames(event("完成", null)),
      { kind: "invalid_response" },
    ],
    [
      "串流在完成前結束",
      async () => frames({ type: "response.created" }),
      { kind: "stream_interrupted" },
    ],
    [
      "串流讀到一半斷線",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: "response.created" })}\n\n`,
                ),
              );
              controller.error(new Error(`socket hang up ${upstreamText}`));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      { kind: "stream_interrupted" },
    ],
    [
      "失敗事件：上游過載",
      async () => frames({ type: "error", code: "server_is_overloaded", message: upstreamText }),
      { kind: "server_error" },
    ],
    [
      "失敗事件：對話超過上限",
      async () =>
        frames({
          type: "response.failed",
          response: { error: { code: "context_length_exceeded", message: upstreamText } },
        }),
      { kind: "context_too_long" },
    ],
    [
      "失敗事件：模型不存在",
      async () => frames({ type: "error", error: { type: "model_not_found", message: upstreamText } }),
      { kind: "model_unavailable" },
    ],
    [
      "失敗事件：額度代碼",
      async () => frames({ type: "error", code: "usage_limit_reached" }),
      { kind: "quota" },
    ],
    [
      "失敗事件：未知代碼",
      async () => frames({ type: "error", code: "unknown_upstream_failure", message: upstreamText }),
      { kind: "stream_error" },
    ],
    [
      "失敗事件：只有訊息文字像白名單代碼也不採信",
      async () => frames({ type: "error", message: "context_length_exceeded model_not_found" }),
      { kind: "stream_error" },
    ],
  ])("%s", async (_name, upstreamFetch, expected) => {
    const f = await failing(upstreamFetch as typeof fetch);
    const response = await f.send();
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const receivedHeaders = !["connection"].includes((expected as { kind: string }).kind);
    expect(f.broker.upstreamFailure(f.runId)).toEqual(receivedHeaders ? { status: 200, ...(expected as object) } : expected);
    // 記錄與回給工作容器的內容都不含上游的字串或標頭。
    const recorded = JSON.stringify(f.broker.upstreamFailure(f.runId));
    for (const text of [upstreamText, "node-7", "overloaded", "ECONNRESET", "socket hang up"]) {
      expect(recorded).not.toContain(text);
      expect(response.body).not.toContain(text);
    }
  });
  it("刷新登入後上游仍回 401 記成登入失效", async () => {
    const f = await failing(
      async () => body(upstreamText, 401),
      async (refresh) =>
        refresh ? { ...identity, accessToken: "SyntheticRenewedAccessToken12345" } : identity,
    );
    expect((await f.send()).statusCode).toBe(401);
    expect(f.broker.upstreamFailure(f.runId)).toEqual({ kind: "auth", status: 401 });
  });
  it("刷新後憑證未更換也保留上游的 401", async () => {
    const rejected = await failing(async () => body(upstreamText, 401));
    expect((await rejected.send()).statusCode).toBe(401);
    expect(rejected.broker.upstreamFailure(rejected.runId)).toEqual({ kind: "auth", status: 401 });
  });
  it.each([
    ["model_not_found", "model_unavailable"],
    ["context_length_exceeded", "context_too_long"],
    ["constructor", "rejected"],
  ])("拒絕請求只採用已知的結構化代碼 %s", async (code, kind) => {
    const rejected = await failing(async () => Response.json({ error: { code, message: upstreamText } }, { status: 400 }));
    const response = await rejected.send();
    expect(response.body).not.toContain(upstreamText);
    expect(rejected.broker.upstreamFailure(rejected.runId)).toEqual({ kind, status: 400 });
  });
  it("成功的呼叫與代理自己擋下的請求沒有上游失敗", async () => {
    const ok = await fixture();
    expect((await ok.send()).statusCode).toBe(200);
    expect(ok.broker.upstreamFailure(ok.runId)).toBeUndefined();
    const local = await fixture();
    expect((await local.send({ model: "other-model" })).statusCode).toBe(403);
    expect(local.broker.upstreamFailure(local.runId)).toBeUndefined();
    expect(local.calls()).toBe(0);
  });
});
