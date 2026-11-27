import { createServer } from "node:http";
import { once } from "node:events";
import { createModelUpstreamHandler, type ModelStep } from "./model-upstream.js";
import { modelAccount, modelToken } from "./subscription.js";

export type ModelFault = Extract<ModelStep, { kind: "error" | "disconnect" }> | { kind: "stall" };

export async function startModelService(alwaysUnavailable: boolean) {
  let handler = createModelUpstreamHandler([]), requests = 0;
  let prefix = 0, hits = 0, exhausted = false, repeat: ModelFault | undefined;
  const server = createServer(async (request, reply) => {
    if (request.method === "GET" && request.url === "/account") {
      const models = ["gpt-6.1-sol", "gpt-5.4-mini"].map((id, index) => ({ id, name: id, description: "驗收用模型", isDefault: index === 0, efforts: ["low", "medium", "high"], defaultEffort: "medium" }));
      reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ plan: "驗收", allowed: !exhausted, limits: [{ id: "驗收", name: "時段", reached: exhausted ? "時段" : null, windows: [{ usedPercent: exhausted ? 100 : 0, minutes: 300, resetsAt: null }] }], models, checkedAt: new Date().toISOString() }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${modelToken}` || request.headers["chatgpt-account-id"] !== modelAccount) {
      request.resume(); reply.writeHead(401).end(); return;
    }
    let body: Buffer | undefined;
    if (request.method === "POST" && request.url === "/backend-api/codex/responses") {
      const parts: Buffer[] = [];
      let length = 0;
      try {
        for await (const part of request) {
          length += part.length;
          if (length > 1024 * 1024) { reply.writeHead(413).end(); return; }
          parts.push(part);
        }
        body = Buffer.concat(parts);
        const payload = body.length ? JSON.parse(body.toString("utf8")) : {};
        if (!alwaysUnavailable && payload?.instructions === "只輸出數字 1。" && payload.input?.[0]?.content?.[0]?.text === "1") {
          await createModelUpstreamHandler([{ kind: "text", text: "1" }])(request, reply);
          return;
        }
      } catch { reply.writeHead(400).end(); return; }
      requests++;
      if (prefix > 0) prefix--;
      else if (repeat) {
        hits++;
        if (repeat.kind === "stall") { request.resume(); return; }
        if (repeat.kind === "error" && repeat.status === 429) exhausted = true;
        createModelUpstreamHandler([repeat])(request, reply);
        return;
      }
    }
    if (alwaysUnavailable) { request.resume(); reply.writeHead(502).end(); return; }
    await handler(request, reply, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("無法取得模型替身的專屬埠");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    script(steps: readonly ModelStep[], fault?: ModelFault) {
      handler = createModelUpstreamHandler(steps); prefix = steps.length; repeat = fault; hits = 0; exhausted = false;
    },
    faultHits: () => hits,
    requests: () => requests,
    close: () => new Promise<void>((done, fail) => { server.close(error => error ? fail(error) : done()); server.closeAllConnections(); }),
  };
}
