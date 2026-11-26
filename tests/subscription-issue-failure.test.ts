import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { HttpRunner, RunInferenceDiagnostics, type PhaseResult } from "../server/execution.js";
import { AppError } from "../server/policy.js";
import type { SubscriptionIdentity } from "../server/subscription-broker.js";

const fixture = vi.hoisted(() => ({
  runner: undefined as FastifyInstance | undefined,
  broker: undefined as FastifyInstance | undefined,
  upstream: vi.fn<() => Promise<Response>>(),
  key: "SyntheticRunner123456789012345678901234",
  credentials: vi.fn<() => Promise<SubscriptionIdentity>>(),
  container: vi.fn(),
}));
vi.mock("fastify", async (load) => {
  const original = await load<typeof import("fastify")>();
  return { ...original, default: (options: import("fastify").FastifyServerOptions) => {
    const app = original.default(options);
    vi.spyOn(app, "listen").mockImplementation(async () => {
      await app.ready();
      if (app.hasRoute({ method: "POST", url: "/phase" })) fixture.runner = app;
      if (app.hasRoute({ method: "POST", url: "/v1/:runId/:phaseId/responses" })) fixture.broker = app;
      return "http://runner.invalid";
    });
    return app;
  } };
});
vi.mock("../server/containers.js", async (load) => ({
  ...await load<typeof import("../server/containers.js")>(),
  Containers: class { cleanup = async () => {}; phase = fixture.container; },
}));
vi.mock("../server/check-environments.js", () => ({
  CheckEnvironments: class { cleanupAll = async () => {}; },
}));
vi.mock("../server/subscription-identity.js", () => ({ subscriptionIdentity: () => fixture.credentials }));
vi.mock("../server/subscription-http.js", async (load) => ({
  ...await load<typeof import("../server/subscription-http.js")>(), subscriptionFetch: fixture.upstream,
}));
vi.mock("node:fs", async (load) => ({
  ...await load<typeof import("node:fs")>(),
  readFileSync: (file: string) => {
    if (file !== resolve("verify-issue-267", "fixture.json")) throw new Error("測試不讀取主機檔案");
    return JSON.stringify({ runnerSecret: fixture.key });
  },
}));
vi.mock("../server/config.js", async (load) => ({
  ...await load<typeof import("../server/config.js")>(),
  secrets: () => ({ runnerSecret: fixture.key }), config: () => ({ runnerUrl: "http://runner.invalid" }),
}));
vi.mock("../server/runner-secrets.js", () => ({ registerRunnerSecrets: () => {} }));
beforeAll(async () => {
  vi.stubEnv("RUNNER_LISTEN_PORT", "34312");
  vi.stubEnv("SUBSCRIPTION_BROKER_PORT", "34313");
  vi.stubEnv("AGENTFLOW_INSTANCE", "verify-issue-267");
  vi.stubEnv("SECRETS_FILE", resolve("verify-issue-267", "fixture.json"));
  vi.stubEnv("CODEX_SERVICE_HOME", resolve("verify-issue-267", "fixture-home"));
  const startupLog = vi.spyOn(console, "log").mockImplementation(() => {});
  try { await import("../server/runner-main.js"); }
  finally { startupLog.mockRestore(); }
});
afterAll(async () => { await fixture.runner?.close(); await fixture.broker?.close(); vi.unstubAllEnvs(); });
beforeEach(() => { fixture.credentials.mockReset(); fixture.container.mockReset(); fixture.upstream.mockReset(); });

const identity = {
  accessToken: "SyntheticAccess1234", accountId: "SyntheticAccount1234", secrets: [],
  models: ["model-test"], defaultModel: "model-test",
};
const runner = new HttpRunner(() => fixture.key, async (address, options) => {
  const response = await fixture.runner!.inject({
    method: "POST", url: new URL(address).pathname, headers: options.headers, payload: String(options.body),
  });
  return { status: response.statusCode, body: response.body };
});
function work(phase: string, job = { mode: "subscription" }) {
  return { runId: randomUUID(), image: "test-worker", phase, job, timeoutMs: 10000 };
}

const current = async () => {};
const recovered = async () => {};

it.each(["code", "review"])("%s 只把主機代理的失敗類別交給健康檢查，容器結束碼零不能取代完成證據", async (phase) => {
  fixture.credentials.mockResolvedValue(identity);
  const evidence = vi.fn();
  const recover = vi.fn();
  const probe = vi.fn();
  const diagnostics = new RunInferenceDiagnostics();
  let exitCode = 0;
  let callBroker = false;
  fixture.container.mockImplementation(async (_id, _image, _command, _net, input: string) => {
    if (callBroker) {
      const job = JSON.parse(input);
      const response = await fixture.broker!.inject({
        method: "POST", url: new URL(job.proxyUrl).pathname + "/responses",
        headers: { authorization: `Bearer ${job.token}` },
        payload: { model: job.model, input: [], stream: true, store: false },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    return { exitCode, stdout: JSON.stringify({ inferenceCompleted: true, upstreamFailure: { kind: "auth" } }), stderr: "" };
  });
  fixture.upstream.mockImplementation(async () => new Response(null, { status: 502 }));
  const run = () => diagnostics.phase(true, phase, runner.call<PhaseResult>("phase", work(phase)), current, recover, evidence);
  await run();
  exitCode = 1;
  await run();
  expect(evidence).not.toHaveBeenCalled();
  callBroker = true;
  exitCode = 0;
  await run();
  expect(recover).not.toHaveBeenCalled();
  expect(evidence).not.toHaveBeenCalled();
  exitCode = 1;
  await run();
  expect(evidence.mock.calls).toEqual([[{ kind: "upstream_http", status: 502 }]]);
  diagnostics.finish(probe);
  expect(probe).toHaveBeenCalledOnce();
});

it.each(["code", "review"])("%s 只有本階段代理真的傳回完成的推論才回報恢復", async (phase) => {
  fixture.credentials.mockResolvedValue(identity);
  const recoveredWork = vi.fn(async () => {});
  const result = { exitCode: 0, stdout: "推論成功", stderr: "" };
  const diagnostics = new RunInferenceDiagnostics();
  const body = work(phase);
  const run = () => diagnostics.phase(true, phase, runner.call<PhaseResult>("phase", body), current, recoveredWork);
  fixture.container.mockResolvedValue(result);
  await run();
  expect(recoveredWork).not.toHaveBeenCalled();
  fixture.container.mockImplementation(async (_id, _image, _command, _net, input: string) => {
    const job = JSON.parse(input);
    await fixture.broker!.inject({
      method: "POST", url: new URL(job.proxyUrl).pathname + "/responses",
      headers: { authorization: `Bearer ${job.token}` },
      payload: { model: job.model, input: [], stream: true, store: false },
    });
    return result;
  });
  const reply = (output: number, text: string, tail = "") => new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 3, output_tokens: output } } })}\n\n${tail}`,
    { headers: { "content-type": "text/event-stream" } },
  );
  fixture.upstream.mockResolvedValueOnce(reply(0, "完成")).mockResolvedValueOnce(reply(2, ""))
    .mockResolvedValueOnce(reply(2, "完成", "截斷")).mockResolvedValueOnce(reply(2, "完成"));
  await run();
  await run();
  await run();
  expect(recoveredWork).not.toHaveBeenCalled();
  await run();
  expect(recoveredWork).toHaveBeenCalledTimes(1);
  fixture.container.mockResolvedValue(result);
  await run();
  expect(recoveredWork).toHaveBeenCalledTimes(1);
  expect(fixture.upstream).toHaveBeenCalledTimes(4);
});

it.each([
  ["期限已到", "階段失敗"], ["需求版本已改變", "授權失敗"], ["需求版本已改變", "階段成功"],
] as const)("%s 時以實際停止原因優先，%s 不得觸發補測或恢復", async (stop, source) => {
  const diagnostics = new RunInferenceDiagnostics();
  const recover = vi.fn(async () => {});
  const probe = vi.fn();
  const transport = new HttpRunner(() => fixture.key, async () => ({
    status: 502, body: JSON.stringify({ error: "上游未回應", upstreamFailure: { kind: "upstream_http", status: 502 } }),
  }));
  const phase = source === "授權失敗" ? transport.call<PhaseResult>("phase", work("code"))
    : Promise.resolve<PhaseResult>(source === "階段成功"
      ? { exitCode: 0, stdout: "", stderr: "", inferenceCompleted: true }
      : { exitCode: 1, stdout: "", stderr: "", upstreamFailure: { kind: "upstream_http", status: 502 } });
  const evidence = vi.fn();
  await expect(diagnostics.phase(true, "code", phase, async () => { throw new Error(stop); }, recover, evidence)).rejects.toThrow(stop);
  expect(evidence).not.toHaveBeenCalled();
  expect(diagnostics.failure).toBeUndefined();
  diagnostics.finish(probe);
  expect(probe).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
});

it("失敗證據寫入失敗時不蓋掉原本的訂閱錯誤，也不丟掉補測請求", async () => {
  fixture.credentials.mockRejectedValue(new Error("SyntheticPrivate1234"));
  const diagnostics = new RunInferenceDiagnostics();
  const evidence = vi.fn(async () => { throw new Error("SyntheticPrivate1234"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const request = vi.fn();
  try {
    await expect(diagnostics.phase(true, "review", runner.call<PhaseResult>("phase", work("review")), current, recovered, evidence))
      .rejects.toMatchObject({ statusCode: 503, upstreamFailure: { kind: "auth" } });
    diagnostics.finish(request);
    expect(evidence).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SyntheticPrivate1234");
  } finally { warn.mockRestore(); }
});

it("健康讀數無法寫入仍交回原本的工作結果，不觸發補測也不公開錯誤原文", async () => {
  const diagnostics = new RunInferenceDiagnostics();
  const request = vi.fn();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result: PhaseResult = { exitCode: 0, stdout: "修改完成", stderr: "", inferenceCompleted: true };
  try {
    await expect(diagnostics.phase(true, "code", Promise.resolve(result), current,
      async () => { throw new Error("SyntheticPrivate1234"); })).resolves.toBe(result);
    diagnostics.finish(request);
    expect(request).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SyntheticPrivate1234");
  } finally {
    warn.mockRestore();
  }
});

it.each([
  ["code", "auth", 503, new Error("SyntheticPrivate1234"), "訂閱登入讀取失敗，未使用其他計費方式"],
  ["review", "quota_unavailable", 429, new AppError(429, "無法確認訂閱額度，暫停新的推論"), "無法確認訂閱額度，暫停新的推論"],
  ["code", "quota", 429, new AppError(429, "Codex 訂閱額度已達上限"), "Codex 訂閱額度已達上限"],
  ["review", "model_denied", 403, null, "訂閱登入或指定模型不可用"],
] as const)("%s 授權失敗時保留 %s、原狀態碼與執行事件，不啟動工作", async (phase, kind, statusCode, error, message) => {
  if (error) fixture.credentials.mockRejectedValue(error);
  else fixture.credentials.mockResolvedValue({ ...identity, models: [] });
  const body = work(phase);
  const request = vi.fn();
  const diagnostics = new RunInferenceDiagnostics();
  const evidence = vi.fn();
  await expect(diagnostics.phase(true, phase, runner.call<PhaseResult>("phase", body), current, recovered, evidence)).rejects.toMatchObject({
    message, statusCode, upstreamFailure: { kind },
  });
  expect(await runner.observations(body.runId, 0)).toContainEqual(expect.objectContaining({
    kind: "phase_end", phase, detail: kind, exitCode: 1,
  }));
  expect(fixture.container).not.toHaveBeenCalled();
  expect(evidence.mock.calls).toEqual([[{ kind }]]);
  expect(request).not.toHaveBeenCalled();
  diagnostics.finish(request);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([
  ["付費模式", false, "code", { kind: "auth" }],
  ["非推論階段", true, "install", { kind: "auth" }],
  ["任意上游字串", true, "review", { kind: "SyntheticPrivate1234" }],
] as const)("%s 不以執行器錯誤觸發訂閱重測", async (_label, subscription, phase, upstreamFailure) => {
  const transport = new HttpRunner(() => fixture.key, async () => ({
    status: 503, body: JSON.stringify({ error: "執行器無法完成工作", upstreamFailure }),
  }));
  const diagnostics = new RunInferenceDiagnostics();
  await expect(diagnostics.phase(subscription, phase, transport.call<PhaseResult>("phase", work(phase)), current, recovered))
    .rejects.toMatchObject({ statusCode: 503 });
  const request = vi.fn();
  diagnostics.finish(request);
  expect(request).not.toHaveBeenCalled();
});

it("一般容器錯誤即使文字或狀態相同，也不當成訂閱代理的授權診斷", async () => {
  fixture.credentials.mockResolvedValue(identity);
  fixture.container.mockRejectedValue(new AppError(503, "訂閱登入讀取失敗，未使用其他計費方式"));
  const body = work("code");
  const request = vi.fn();
  const diagnostics = new RunInferenceDiagnostics();
  const error = await diagnostics.phase(true, "code", runner.call<PhaseResult>("phase", body), current, recovered).catch((reason: Error) => reason);
  expect(error).toMatchObject({ statusCode: 503 });
  expect(error).not.toMatchObject({ upstreamFailure: expect.anything() });
  expect(await runner.observations(body.runId, 0)).not.toContainEqual(expect.objectContaining({ detail: "auth" }));
  diagnostics.finish(request);
  expect(request).not.toHaveBeenCalled();
});
