import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import {
  createModelUpstreamHandler,
  type ModelStep,
} from "../scripts/acceptance/flows/model-upstream.js";
import { SubscriptionBroker } from "../server/subscription-broker.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(steps: readonly ModelStep[]) {
  const server = createServer(createModelUpstreamHandler(steps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("未取得驗收埠號");
  const origin = "http://127.0.0.1:" + address.port;
  const app = Fastify();
  const broker = new SubscriptionBroker({
    credentials: async () => ({
      accessToken: "FictionalAccessToken266",
      accountId: "FictionalAccount266",
      secrets: [],
      models: ["model-test"],
      defaultModel: "model-test",
    }),
    upstreamFetch: (url, init) =>
      fetch(origin + new URL(String(url)).pathname, init),
  });
  broker.register(app);
  cleanup.push(async () => {
    broker.close();
    await app.close();
  });
  const runId = randomUUID();
  const lease = await broker.issue({
    runId,
    phase: "code",
    deadline: Date.now() + 10000,
  });
  const send = () =>
    app.inject({
      method: "POST",
      url: lease.basePath + "/responses",
      headers: { authorization: "Bearer " + lease.token },
      payload: { model: "model-test", stream: true, input: [] },
    });
  return { origin, send, usage: () => broker.usage(runId) };
}

it("只讓指定路徑的 POST 推進腳本；broker 依序收到工具指令、文字與用量", async () => {
  const args = { label: "驗收" };
  const peer = await fixture([
    { kind: "tool", name: "show_label", arguments: args },
    { kind: "text", text: "已完成驗收" },
  ]);
  expect((await fetch(peer.origin + "/backend-api/codex/responses")).ok).toBe(
    false,
  );
  expect((await fetch(peer.origin + "/other", { method: "POST" })).ok).toBe(
    false,
  );
  for (const item of [
    {
      type: "function_call",
      name: "show_label",
      arguments: JSON.stringify(args),
      call_id: expect.any(String),
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "已完成驗收", annotations: [] }],
    },
  ]) {
    const reply = await peer.send();
    expect(reply.statusCode).toBe(200);
    const events = reply.body
      .trim()
      .split("\n\n")
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "response.output_item.done",
        item: expect.objectContaining(item),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { output: [item], usage: { output_tokens: 1 } },
    });
  }
  expect(peer.usage()).toMatchObject({ requests: 2, outputTokens: 2 });
  expect((await peer.send()).statusCode).toBe(502);
});

it("永久錯誤回傳劇本指定的原因，不會變成服務暫時失敗", async () => {
  const peer = await fixture([{ kind: "error", status: 400, message: "指定的模型不存在" }]);
  const response = await fetch(peer.origin + "/backend-api/codex/responses", { method: "POST" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { message: "指定的模型不存在" } });
});

it.each<[ModelStep, number, string]>([
  [{ kind: "error", status: 429 }, 429, "訂閱額度"],
  [{ kind: "error", status: 502 }, 502, "上游回應失敗"],
  [{ kind: "disconnect" }, 502, "完成前中斷"],
])("broker 辨識假上游故障 %j", async (step, status, diagnostic) => {
  const reply = await (await fixture([step])).send();
  expect(reply.statusCode).toBe(status);
  expect(reply.body).toContain(diagnostic);
  expect(reply.body).not.toContain("data:");
});
