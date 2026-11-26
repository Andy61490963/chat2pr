import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  SubscriptionBroker,
  subscriptionLimits,
  type SubscriptionIdentity,
} from "../server/subscription-broker.js";
import { AppError } from "../server/policy.js";
import { phaseEndEvents } from "../server/test-failures.js";
import {
  parseUpstreamFailure,
  upstreamFailureDetail,
  upstreamFailureText,
} from "../shared/upstream-failure.js";

const identity: SubscriptionIdentity = {
  accessToken: "SyntheticAccess123456789",
  accountId: "SyntheticAccount123456",
  secrets: ["SyntheticRefresh123456789"],
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
describe("訂閱上游診斷的白名單", () => {
  it("只採用固定類別和有效數字，不把附加資料帶到文字或事件", () => {
    const input = { kind: "invalid_usage", status: 200, message: identity.accessToken } as const;
    expect(parseUpstreamFailure(input)).toStrictEqual({ kind: "invalid_usage", status: 200 });
    expect(upstreamFailureText(input)).toBe("訂閱回應缺少有效用量（上游 HTTP 200）");
    expect(upstreamFailureDetail(input)).toBe("invalid_usage（HTTP 200）");
    for (const status of [100, 599]) {
      expect(parseUpstreamFailure({ ...input, status })).toStrictEqual({ kind: input.kind, status });
    }
    for (const status of [99, 600, 201.5, NaN, Infinity, "503", null]) {
      expect(parseUpstreamFailure({ ...input, status })).toStrictEqual({ kind: input.kind });
    }
    expect(upstreamFailureText({ ...input, status: 600 })).toBe("訂閱回應缺少有效用量");
    expect(upstreamFailureDetail({ ...input, status: 201.5 })).toBe("invalid_usage");
    for (const kind of [identity.accessToken, "__proto__", "toString", 502]) {
      expect(parseUpstreamFailure({ kind, status: 502 })).toBeUndefined();
    }
    for (const value of [undefined, null, [], "invalid_usage", {}])
      expect(parseUpstreamFailure(value)).toBeUndefined();
  });
});
describe("訂閱主憑證隔離與有限階段能力", () => {
  it.each([
    ["上游 500", () => new Response(null, { status: 500 }), { kind: "upstream_http", status: 500 }],
    ["串流中斷", () => sse([{ type: "response.created" }]), { kind: "stream_interrupted", status: 200 }],
    ["連線中斷", () => { throw new Error("虛構的連線錯誤"); }, { kind: "connection" }],
    ["非預期的串流格式", () => new Response("虛構的維護頁面"), { kind: "invalid_stream", status: 200 }],
  ] as const)("%s 後同一授權可再次推論，成功清除診斷並累計兩次用量", async (_name, fail, reason) => {
    let calls = 0;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => ++calls === 1 ? fail() : sse([event()]),
    });
    expect((await f.send()).statusCode).toBe(502);
    expect(f.lease.failure()).toStrictEqual(reason);
    const bytes = f.broker.usage(f.runId)!.inputBytes;
    expect(bytes).toBeGreaterThan(0);
    expect((await f.send()).statusCode).toBe(200);
    expect(calls).toBe(2);
    expect(f.lease.failure()).toBeUndefined();
    expect(f.broker.usage(f.runId)).toStrictEqual({
      requests: 2, inputBytes: 2 * bytes, outputTokens: 2, revoked: false,
    });
  });

  it("第五次連續失敗保留最後原因並撤銷，先前成功會重設連續次數", async () => {
    let calls = 0;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => {
        calls++;
        if (calls === 5) return sse([event()]);
        return new Response(null, { status: calls === 10 ? 504 : 503 });
      },
    });
    for (let i = 0; i < 4; i++) expect((await f.send()).statusCode).toBe(502);
    expect((await f.send()).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await f.send()).statusCode).toBe(502);
    expect((await f.send()).statusCode).toBe(403);
    expect(calls).toBe(10);
    expect(f.lease.failure()).toStrictEqual({ kind: "upstream_http", status: 504 });
    expect(f.broker.usage(f.runId)).toMatchObject({ revoked: true, requests: 10 });
  });

  it("上游拒絕請求時即使前次是暫時失敗也立即撤銷", async () => {
    let calls = 0;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => new Response(null, { status: ++calls === 1 ? 503 : 400 }),
    });
    expect((await f.send()).statusCode).toBe(502);
    expect((await f.send()).statusCode).toBe(502);
    expect((await f.send()).statusCode).toBe(403);
    expect(calls).toBe(2);
    expect(f.lease.failure()).toStrictEqual({ kind: "upstream_http", status: 400 });
  });

  it.each(["max_output_tokens", "content_filter"])("上游明確結束未完成的回應（%s）時，計入用量並停止重試", async (reason) => {
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => sse([{
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason }, usage: { input_tokens: 5, output_tokens: 3 } },
      }]),
    });
    expect((await f.send()).statusCode).toBe(502);
    expect(f.lease.failure()).toStrictEqual({ kind: "stream_error", status: 200 });
    expect((await f.send()).statusCode).toBe(403);
    expect(f.broker.usage(f.runId)).toMatchObject({ requests: 1, outputTokens: 3, revoked: true });
  });

  it("串流尾端中斷仍保留已回報的輸出用量，下一次推論超額會撤銷", async () => {
    let calls = 0;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => {
        if (++calls > 1) return sse([event()]);
        const completed = event("完成", { input_tokens: 1, output_tokens: subscriptionLimits.outputTokens - 1 });
        return new Response(`data: ${JSON.stringify(completed)}\n\ndata: `, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    expect((await f.send()).statusCode).toBe(502);
    expect((await f.send()).statusCode).toBe(429);
    expect(f.lease.failure()).toStrictEqual({ kind: "output_limit", status: 200 });
    expect((await f.send()).statusCode).toBe(403);
    expect(f.broker.usage(f.runId)).toMatchObject({ outputTokens: subscriptionLimits.outputTokens + 1 });
  });

  it.each(["完整事件", "未收完的事件"])("串流中斷時，%s 含有受保護資料就撤銷授權", async (part) => {
    const frame = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: identity.accessToken })}`;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => new Response(part === "完整事件" ? frame + "\n\n" : frame, {
        headers: { "content-type": "text/event-stream" },
      }),
    });
    const response = await f.send();
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(identity.accessToken);
    expect(f.lease.failure()).toStrictEqual({ kind: "protected_data", status: 200 });
    expect((await f.send()).statusCode).toBe(403);
  });

  it.each(["字串未結束", "物件未結束", "含跳脫字元"])("主憑證跨越完整事件與未收完的文字欄位（%s）時，記為受保護資料並撤銷授權", async (ending) => {
    const first = identity.accessToken.slice(0, 12);
    const second = identity.accessToken.slice(12);
    const frame = JSON.stringify({ type: "response.output_text.delta", delta: first });
    const partial = ending === "含跳脫字元"
      ? `\\u${second.charCodeAt(0).toString(16).padStart(4, "0")}${second.slice(1)}`
      : second;
    const tail = `data: {"type":"response.output_text.delta","delta":"${partial}${ending === "物件未結束" ? '"' : ""}`;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => new Response(`data: ${frame}\n\n${tail}`, {
        headers: { "content-type": "text/event-stream" },
      }),
    });
    const response = await f.send();
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(first);
    expect(response.body).not.toContain(second);
    expect(f.lease.failure()).toStrictEqual({ kind: "protected_data", status: 200 });
    expect((await f.send()).statusCode).toBe(403);
    expect(f.broker.usage(f.runId)).toMatchObject({ requests: 1, revoked: true });
  });

  it("未收完的另一個欄位恰好含有憑證後半段時，仍可重試", async () => {
    const frame = JSON.stringify({ type: "response.output_text.delta", delta: identity.accessToken.slice(0, 12) });
    const tail = `data: {"type":"response.output_text.delta","other":"${identity.accessToken.slice(12)}`;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => new Response(`data: ${frame}\n\n${tail}`, {
        headers: { "content-type": "text/event-stream" },
      }),
    });
    expect((await f.send()).statusCode).toBe(502);
    expect(f.lease.failure()).toStrictEqual({ kind: "stream_interrupted", status: 200 });
    expect(f.broker.usage(f.runId)?.revoked).toBe(false);
  });

  it("刷新時查不到額度仍拒絕新推論，並記下最後的上游狀態", async () => {
    const sample = await fixture({
      credentials: async (refresh) => {
        if (refresh) throw new AppError(429, "無法確認訂閱額度，暫停新的推論");
        return identity;
      },
      upstreamFetch: async () => new Response(null, { status: 401 }),
    });
    expect((await sample.send()).statusCode).toBe(429);
    expect(sample.lease.failure()).toEqual({ kind: "quota_unavailable", status: 401 });
  });

  it("撤銷正在推論的授權時記為階段取消，不猜測上游狀態", async () => {
    const sample = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => {
        sample.broker.revoke(sample.runId);
        throw new Error("已取消");
      },
    });
    expect((await sample.send()).statusCode).not.toBe(200);
    expect(sample.lease.failure()).toEqual({ kind: "phase_cancelled" });
  });
  it("上游 500 的本文不進入代理回應或階段結束事件，只有失敗階段保留診斷", async () => {
    const upstreamBody = "虛構的上游故障本文";
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => new Response(upstreamBody, { status: 500 }),
    });
    f.lease.revoke();
    const review = await f.broker.issue({
      runId: f.runId,
      phase: "review",
      deadline: Date.now() + 10000,
    });
    const r = await f.send({}, `${review.basePath}/responses`, review.token);
    expect(r.statusCode).toBe(502);
    expect(r.json().error.message).toBe("訂閱上游回應失敗，未使用其他計費方式");
    expect(f.broker.usage(f.runId)?.revoked).toBe(false);
    expect(r.body).not.toContain(upstreamBody);
    expect(review.failure()).toStrictEqual({ kind: "upstream_http", status: 500 });
    expect(f.lease.failure()).toBeUndefined();
    const events = phaseEndEvents("review", {
      exitCode: 1, stdout: "", stderr: upstreamBody, upstreamFailure: review.failure(),
    });
    expect(events).toStrictEqual([{ kind: "phase_end", exitCode: 1, detail: "upstream_http（HTTP 500）" }]);
    expect(JSON.stringify(events)).not.toContain(upstreamBody);
  });
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
    expect(f.lease.failure()).toBeUndefined();
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
    ["跨模型", { model: "other" }, 403, "model_denied"],
    ["遠端歷史", { previous_response_id: "old" }, 400, "invalid_request"],
    ["遠端工具", { tools: [{ type: "web_search" }] }, 403, "tool_denied"],
    ["工具格式", { tools: {} }, 403, "invalid_tools"],
    ["工具總數", {
      tools: [{ type: "function", name: "local" }],
      input: [{ type: "additional_tools", tools: Array(256).fill({ type: "custom", name: "local" }) }],
    }, 403, "tool_limit"],
    ["遠端工具選擇", { tool_choice: { type: "web_search" } }, 403, "tool_choice_denied"],
    ["未宣告工具", { tool_choice: { type: "function", name: "missing" } }, 403, "tool_choice_denied"],
    ["保存", { store: true }, 400, "invalid_request"],
    ["背景", { background: true }, 400, "invalid_request"],
    ["非串流", { stream: false }, 400, "invalid_request"],
  ])("拒絕%s且不呼上游", async (_name, body, status, kind) => {
    const f = await fixture();
    expect((await f.send(body as Record<string, unknown>)).statusCode).toBe(
      status,
    );
    expect(f.calls()).toBe(0);
    expect(f.lease.failure()).toStrictEqual({ kind });
  });
  it("跨run/path、無token、結束phase重播皆失敗，新phase用新token", async () => {
    const f = await fixture();
    expect(
      (await f.send({}, `/v1/${randomUUID()}/${randomUUID()}/responses`))
        .statusCode,
    ).toBe(403);
    expect((await f.send({}, undefined, "f".repeat(64))).statusCode).toBe(403);
    expect(f.lease.failure()).toBeUndefined();
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
    expect(next.failure()).toStrictEqual({ kind: "usage_limit" });
    expect(f.lease.failure()).toBeUndefined();
  });
  it("能核對授權且已到期時保留期限原因，仍回原本的 403", async () => {
    let now = Date.now();
    const f = await fixture({ now: () => now, credentials: async () => identity });
    now += 20000;
    expect((await f.send()).statusCode).toBe(403);
    expect(f.lease.failure()).toStrictEqual({ kind: "phase_deadline" });
    expect(f.calls()).toBe(0);
  });
  it("同時有效的兩份授權交叉使用時，兩個工作都沒有失敗紀錄", async () => {
    const f = await fixture();
    const other = await f.broker.issue({
      runId: randomUUID(), phase: "review", deadline: Date.now() + 10000,
    });
    expect((await f.send({}, `${other.basePath}/responses`, f.lease.token)).statusCode).toBe(403);
    expect((await f.send({}, undefined, other.token)).statusCode).toBe(403);
    expect(f.lease.failure()).toBeUndefined();
    expect(other.failure()).toBeUndefined();
    expect(f.calls()).toBe(0);
  });
  it.each([true, false])("已授權但本文過大，是否宣告長度 %s 都保留限制原因", async (declareLength) => {
    const f = await fixture();
    const chunk = Buffer.alloc(1024 * 1024, " ");
    const r = await f.app.inject({
      method: "POST",
      url: `${f.lease.basePath}/responses`,
      headers: {
        authorization: `Bearer ${f.lease.token}`,
        "content-type": "application/json",
        ...(declareLength ? { "content-length": String(subscriptionLimits.requestBytes + 2) } : {}),
      },
      payload: Readable.from([...Array(subscriptionLimits.requestBytes / chunk.length).fill(chunk), "{}"]),
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(f.lease.failure()).toStrictEqual({ kind: "request_limit" });
    expect(f.broker.usage(f.runId)?.revoked).toBe(true);
    expect(f.calls()).toBe(0);
  });
  it.each([true, false])("並行請求被拒後，以原請求的結果更新診斷（成功：%s）", async (success) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (r: Response) => void;
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: () => new Promise((resolve) => { finish = resolve; started(); }),
    });
    const pending = f.send().then((r) => r);
    await ready;
    try {
      expect((await f.send()).statusCode).toBe(429);
      expect(f.lease.failure()).toStrictEqual({ kind: "concurrent_request" });
    } finally {
      finish(success ? sse([event()]) : new Response(null, { status: 400 }));
      await pending;
    }
    if (!success) expect((await f.send()).statusCode).toBe(403);
    expect(f.lease.failure()).toStrictEqual(success ? undefined : { kind: "upstream_http", status: 400 });
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
    expect(f.lease.failure()).toStrictEqual({
      kind: _name === "錯誤事件" || _name === "巢狀錯誤" ? "stream_error" : "protected_data",
      status: 200,
    });
  });
  it.each([
    ["無usage", [event("完成", null)], "invalid_usage"],
    ["負input", [event("完成", { input_tokens: -1, output_tokens: 1 })], "invalid_usage"],
    [
      "錯誤cache",
      [
        event("完成", {
          input_tokens: 1,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: 2 },
        }),
      ],
      "invalid_usage",
    ],
    ["非整數output", [event("完成", { input_tokens: 1, output_tokens: 1.5 })], "invalid_usage"],
    ["完成後錯誤", [event(), { type: "error", message: "later failure" }], "stream_error"],
    ["重複完成", [event(), event()], "duplicate_completion"],
  ])("%s保守撤銷run而非盲重試", async (_name, events, kind) => {
    const f = await fixture({
      credentials: async () => identity,
      upstreamFetch: async () => sse(events as unknown[]),
    });
    expect((await f.send()).statusCode).toBe(502);
    expect(f.broker.usage(f.runId)?.revoked).toBe(true);
    expect(f.lease.failure()).toStrictEqual({ kind, status: 200 });
  });
  it("401只在可信主機刷新一次，舊token回顯也不得流出", async () => {
    let count = 0,
      refreshes = 0;
    const f = await fixture({
      credentials: async (refresh) => {
        if (refresh) refreshes++;
        return refresh
          ? { ...identity, accessToken: "SyntheticNewAccess123456789" }
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
    expect(f.lease.failure()).toStrictEqual({ kind: "protected_data", status: 200 });
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
    expect(f.lease.failure()).toStrictEqual({
      kind: status === 429 ? "quota" : "stream_error",
      status: 200,
    });
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
    expect(f.lease.failure()).toStrictEqual({ kind: "quota", status: 429 });
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
    expect(f.lease.failure()).toStrictEqual({ kind: "connection" });
  });
  it.each(["連線", "讀取串流", "刷新登入"])("%s拋出的 AppError 不得指定回應或診斷內容", async (stage) => {
    const error = new AppError(418, identity.accessToken);
    const f = await fixture({
      credentials: async (refresh) => {
        if (refresh) throw error;
        return identity;
      },
      upstreamFetch: async () => {
        if (stage === "連線") throw error;
        if (stage === "刷新登入") return new Response(null, { status: 401 });
        return new Response(new ReadableStream({ start: (controller) => controller.error(error) }));
      },
    });
    const response = await f.send();
    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toBe("訂閱推論連線失敗，未使用其他計費方式");
    expect(f.lease.failure()).toStrictEqual(stage === "連線" ? { kind: "connection" } :
      stage === "刷新登入" ? { kind: "auth", status: 401 } : { kind: "stream_interrupted", status: 200 });
    expect(f.broker.usage(f.runId)?.revoked).toBe(stage === "刷新登入");
  });
  it("發出授權前讀取登入失敗也只回固定訊息", async () => {
    const broker = new SubscriptionBroker({
      credentials: async () => { throw new AppError(418, identity.accessToken); },
    });
    await expect(broker.issue({ runId: randomUUID(), phase: "code", deadline: Date.now() + 10000 }))
      .rejects.toMatchObject({ statusCode: 503, message: "訂閱登入讀取失敗，未使用其他計費方式" });
  });
  it.each([
    ["沒有本文", () => new Response(null, { status: 204 }), "missing_body", 204, 502],
    ["非串流", () => new Response(identity.accessToken), "invalid_stream", 200, 502],
    ["非 JSON 事件", () => new Response(`data: ${identity.accessToken}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    }), "invalid_event", 200, 502],
    ["缺少事件類型", () => sse([{ error: identity.accessToken }]), "invalid_event", 200, 502],
    ["過大事件", () => new Response(new Uint8Array(subscriptionLimits.frameBytes + 1)), "frame_limit", 200, 502],
    ["過大回應", () => new Response(new Uint8Array(subscriptionLimits.responseBytes + 1)), "response_limit", 200, 429],
    ["輸出超額", () => sse([event("完成", { input_tokens: 0, output_tokens: subscriptionLimits.outputTokens + 1 })]), "output_limit", 200, 429],
    ["登入失效", () => new Response(null, { status: 401 }), "auth", 401, 401],
    ["重新導向", () => new Response(null, { status: 307, headers: { Location: "https://example.invalid" } }), "redirect", 307, 502],
  ] as const)("%s保留上游狀態碼與對應的固定原因", async (_name, respond, kind, status, publicStatus) => {
    const f = await fixture({ credentials: async () => identity, upstreamFetch: async () => respond() });
    const r = await f.send();
    expect(r.statusCode).toBe(publicStatus);
    expect(r.body).not.toContain(identity.accessToken);
    expect(f.lease.failure()).toStrictEqual({ kind, status });
    expect(f.broker.usage(f.runId)?.revoked).toBe(kind !== "invalid_stream");
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
