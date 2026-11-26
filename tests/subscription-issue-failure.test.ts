import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { HttpRunner, RunInferenceDiagnostics, type PhaseResult } from "../server/execution.js";
import { AppError } from "../server/policy.js";
import type { SubscriptionIdentity } from "../server/subscription-broker.js";

const fixture = vi.hoisted(() => ({
  runner: undefined as FastifyInstance | undefined,
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
afterAll(async () => { await fixture.runner?.close(); vi.unstubAllEnvs(); });
beforeEach(() => { fixture.credentials.mockReset(); fixture.container.mockReset(); });

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
  await expect(diagnostics.phase(true, phase, runner.call<PhaseResult>("phase", body))).rejects.toMatchObject({
    message, statusCode, upstreamFailure: { kind },
  });
  expect(await runner.observations(body.runId, 0)).toContainEqual(expect.objectContaining({
    kind: "phase_end", phase, detail: kind, exitCode: 1,
  }));
  expect(fixture.container).not.toHaveBeenCalled();
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
  await expect(diagnostics.phase(subscription, phase, transport.call<PhaseResult>("phase", work(phase))))
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
  const error = await diagnostics.phase(true, "code", runner.call<PhaseResult>("phase", body)).catch((reason: Error) => reason);
  expect(error).toMatchObject({ statusCode: 503 });
  expect(error).not.toMatchObject({ upstreamFailure: expect.anything() });
  expect(await runner.observations(body.runId, 0)).not.toContainEqual(expect.objectContaining({ detail: "auth" }));
  diagnostics.finish(request);
  expect(request).not.toHaveBeenCalled();
});
