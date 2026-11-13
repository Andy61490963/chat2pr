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
