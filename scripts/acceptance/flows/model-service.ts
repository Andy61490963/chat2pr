import { createServer } from "node:http";
import { once } from "node:events";
import { createModelUpstreamHandler, type ModelStep } from "./model-upstream.js";
import { modelAccount, modelToken } from "./subscription.js";

export async function startModelService(alwaysUnavailable: boolean) {
  let handler = createModelUpstreamHandler([]), requests = 0;
  const server = createServer((request, reply) => {
    if (request.method === "GET" && request.url === "/account") {
      const models = ["gpt-6.1-sol", "gpt-5.4-mini"].map((id, index) => ({ id, name: id, description: "驗收用模型", isDefault: index === 0, efforts: ["low", "medium", "high"], defaultEffort: "medium" }));
      reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ plan: "驗收", allowed: true, limits: [{ id: "驗收", name: "時段", reached: null, windows: [{ usedPercent: 0, minutes: 300, resetsAt: null }] }], models, checkedAt: new Date().toISOString() }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${modelToken}` || request.headers["chatgpt-account-id"] !== modelAccount) {
      request.resume(); reply.writeHead(401).end(); return;
    }
    if (request.method === "POST" && request.url === "/backend-api/codex/responses") requests++;
    if (alwaysUnavailable) { request.resume(); reply.writeHead(502).end(); return; }
    handler(request, reply);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("無法取得模型替身的專屬埠");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    script(steps: readonly ModelStep[]) { handler = createModelUpstreamHandler(steps); },
    requests: () => requests,
    close: () => new Promise<void>((done, fail) => { server.close(error => error ? fail(error) : done()); server.closeAllConnections(); }),
  };
}
