import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { SubscriptionBroker, type SubscriptionIdentity } from "../server/subscription-broker.js";
import { registerRunnerAuth } from "../server/runner-auth.js";
import { AppError } from "../server/policy.js";
import { HttpRunner } from "../server/execution.js";

const host = vi.hoisted(() => ({ runnerUrl: "" }));
vi.mock("../server/config.js", async (load) => ({
  ...await load<typeof import("../server/config.js")>(), config: () => host,
}));

const identity: SubscriptionIdentity = {
  accessToken: "SyntheticAccess1234",
  accountId: "SyntheticAccount1234",
  secrets: ["SyntheticRefresh1234"],
  defaultModel: "model-default",
  models: ["model-default", "model-code"],
  quota: { allowed: true, limits: [{ windows: [{ usedPercent: 30, resetsAt: null }] }] },
};
const runnerKey = "SyntheticRunner1234";
const completed = (outputTokens = 1, text = "1") => ({
  type: "response.completed",
  response: {
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 8, output_tokens: outputTokens },
  },
});
const stream = (...events: unknown[]) => new Response(
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  upstream: typeof fetch = async () => stream(completed()),
  credentials: (refresh: boolean) => Promise<SubscriptionIdentity> = async () => identity,
) {
  let now = Date.now();
  const fetchUpstream = vi.fn<typeof fetch>((address, options) => {
    now += 27;
    return upstream(address, options);
  });
  const broker = new SubscriptionBroker({ credentials, upstreamFetch: fetchUpstream, now: () => now });
  const relayTarget = Fastify();
  const runner = Fastify();
  registerRunnerAuth(runner, () => runnerKey);
  const requests: { url: string; authorization?: string }[] = [];
  relayTarget.addHook("onRequest", async (req) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
  });
  broker.register(relayTarget);
  await relayTarget.listen({ host: "127.0.0.1", port: 0 });
  const port = (relayTarget.server.address() as AddressInfo).port;
  broker.registerRunnerProbe(runner, port);
  cleanups.push(async () => {
    broker.close();
    await runner.close();
    await relayTarget.close();
  });
  const probe = (overrides = {}, key = runnerKey) =>
    runner.inject({
      method: "POST", url: "/codex/inference-probe", headers: { "x-runner-key": key },
      payload: { model: null, reservePercent: 60, ...overrides },
    });
  return { probe, runner, relayTarget, requests, fetchUpstream, advance: (ms: number) => { now += ms; } };
}

it("應用程式執行器客戶端以四十五秒期限呼叫，直接得到推論成功或固定失敗類別", async () => {
  let healthy = true;
  const sample = await fixture(async () => healthy ? stream(completed()) : new Response(null, { status: 503 }));
  host.runnerUrl = await sample.runner.listen({ host: "127.0.0.1", port: 0 });
  const client = new HttpRunner(() => runnerKey);
  const probe = () => client.call("codex/inference-probe", { model: null, reservePercent: 60 }, 45000);
  await expect(probe()).resolves.toStrictEqual({ ok: true });
  healthy = false;
  await expect(probe()).resolves.toStrictEqual({ ok: false, failure: { kind: "upstream_http", status: 503 } });
});

it.each(["model-default", "model-code"])("以訂閱階段授權經相同代理測試 %s，只送一次固定的短推論", async (model) => {
  const supported = new Set(["model", "stream", "store", "instructions", "input", "prompt_cache_key"]);
  const sample = await fixture(async (_url, init) =>
    Object.keys(JSON.parse(String(init?.body))).every((key) => supported.has(key))
      ? stream(completed())
      : new Response("不支援此參數", { status: 400 }));
  const result = await sample.probe(model === "model-default" ? {} : { model });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toStrictEqual({ ok: true });
  expect(sample.requests).toHaveLength(1);
  const [request] = sample.requests;
  expect(request.url).toMatch(/^\/v1\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/responses$/);
  expect(request.authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
  expect(sample.fetchUpstream).toHaveBeenCalledTimes(1);
  const [url, init] = sample.fetchUpstream.mock.calls[0];
  expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
  const payload = JSON.parse(String(init?.body));
  expect(payload).toMatchObject({
    model, stream: true, store: false,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "1" }] }],
  });
  expect(payload.tools ?? []).toEqual([]);
  expect(payload.instructions.length).toBeLessThan(30);
  expect((await sample.relayTarget.inject({
    method: "POST", url: request.url, headers: { authorization: request.authorization }, payload,
  })).statusCode).toBe(403);
});

it.each(["response.output_text.delta", "response.reasoning_text.delta", "response.reasoning_summary_text.delta"])(
  "%s 與先前文字的總量達到 256 位元組便主動中止，不等待完成用量", async (type) => {
    let aborted = false;
    let upstreamEnded = false;
    const sample = await fixture(async (_url, init) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => { upstreamEnded = true; controller.close(); }, 100).unref();
          init?.signal?.addEventListener("abort", () => { aborted = true; clearTimeout(timer); }, { once: true });
          for (const event of [
            { type: "response.output_text.delta", delta: "一".repeat(50) },
            { type, delta: "二".repeat(35) + "1" },
          ]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    expect((await sample.probe()).json()).toStrictEqual({ ok: false, failure: { kind: "output_limit", status: 200 } });
    expect(aborted).toBe(true);
    expect(upstreamEnded).toBe(false);
    expect(sample.fetchUpstream).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["上游故障", () => new Response(identity.accessToken, { status: 502 }), { kind: "upstream_http", status: 502 }],
  ["缺少完成事件", () => stream({ type: "response.created" }), { kind: "stream_interrupted", status: 200 }],
  ["受保護資料", () => stream(completed(1, identity.secrets[0])), { kind: "protected_data", status: 200 }],
  ["超出輸出上限", () => stream(completed(65)), { kind: "output_limit", status: 200 }],
  ["毫無輸出", () => stream(completed(0, "")), { kind: "invalid_usage", status: 200 }],
  ["僅有推理用量而沒有文字", () => stream(completed(5, "")), { kind: "missing_body", status: 200 }],
  ["上游依限制截斷", () => stream({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }), { kind: "output_limit", status: 200 }],
] as const)("%s 時固定回報代理的診斷，不附加原文或重送", async (_name, respond, failure) => {
  const sample = await fixture(async () => respond());
  const result = await sample.probe();
  expect(result.statusCode).toBe(200);
  expect(result.json()).toStrictEqual({ ok: false, failure });
  expect(sample.fetchUpstream).toHaveBeenCalledTimes(1);
});

it("完成事件未重送文字時，串流中真正產生的文字仍算推論成功", async () => {
  const sample = await fixture(async () => stream({ type: "response.output_text.delta", delta: "1" }, completed(1, "")));
  expect((await sample.probe()).json()).toStrictEqual({ ok: true });
});

it.each([
  ["無法確認額度", () => { throw new AppError(429, "無法確認訂閱額度，暫停新的推論"); }, "quota_unavailable"],
  ["登入讀取失敗", () => { throw new Error(identity.accessToken); }, "auth"],
  ["模型未授權", () => ({ ...identity, models: [] }), "model_denied"],
] as const)("取得階段授權前發現%s，不呼叫上游也不虛構狀態碼", async (_name, readIdentity, kind) => {
  const sample = await fixture(undefined, async () => readIdentity());
  const result = await sample.probe();
  expect(result.statusCode).toBe(200);
  expect(result.json()).toStrictEqual({ ok: false, failure: { kind } });
  expect(sample.fetchUpstream).not.toHaveBeenCalled();
});

it("未授權或外加提示、目標網址、工具或成本參數時不消耗額度", async () => {
  const sample = await fixture();
  expect((await sample.probe({}, "WrongKey1234")).statusCode).toBe(401);
  for (const payload of [{ input: "其他指令" }, { url: "https://example.invalid" }, { tools: [] }, { max_output_tokens: 2048 }, { reservePercent: -1 }, { reservePercent: 91 }, { reservePercent: undefined }])
    expect((await sample.probe(payload)).statusCode).toBe(400);
  expect(sample.requests).toHaveLength(0);
  expect(sample.fetchUpstream).not.toHaveBeenCalled();
});

it.each([
  ["任一視窗觸及保留額度", 40, "quota"],
  ["視窗用量未知", null, "quota_unavailable"],
] as const)("%s 時不發出推論", async (_name, usedPercent, kind) => {
  const windows = usedPercent === null ? [] : [{ usedPercent, resetsAt: null }];
  const sample = await fixture(undefined, async () => ({ ...identity, quota: { allowed: true, limits: [{ windows }] } }));
  expect((await sample.probe()).json()).toStrictEqual({ ok: false, failure: { kind } });
  expect(sample.fetchUpstream).not.toHaveBeenCalled();
});

it("取得授權與推論共用四十五秒，不在期限後送出請求", async () => {
  const sample = await fixture(undefined, async () => { sample.advance(45000); return identity; });
  expect((await sample.probe()).json()).toStrictEqual({ ok: false, failure: { kind: "phase_deadline" } });
  expect(sample.fetchUpstream).not.toHaveBeenCalled();
});

it("登入刷新時發現保留額度已用完，不重送推論", async () => {
  const sample = await fixture(async () => new Response(null, { status: 401 }), async (refresh) =>
    refresh ? { ...identity, accessToken: "SyntheticNewAccess1234", quota: { allowed: true, limits: [{ windows: [{ usedPercent: 40, resetsAt: null }] }] } } : identity);
  expect((await sample.probe()).json()).toStrictEqual({ ok: false, failure: { kind: "quota", status: 401 } });
  expect(sample.fetchUpstream).toHaveBeenCalledTimes(1);
});

it("同時觸發的第二次探測不再消耗訂閱額度", async () => {
  let started!: () => void;
  let finish!: (value: Response) => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const response = new Promise<Response>((resolve) => { finish = resolve; });
  const sample = await fixture(async () => { started(); return response; });
  const first = sample.probe().then((reply) => reply);
  try {
    await Promise.race([ready, first.then(() => { throw new Error("第一個探測未呼叫上游"); })]);
    expect((await sample.probe()).json()).toMatchObject({ ok: false, failure: { kind: "concurrent_request" } });
  } finally {
    finish(stream(completed()));
    await first;
  }
  expect(sample.fetchUpstream).toHaveBeenCalledTimes(1);
});
