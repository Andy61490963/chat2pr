import { expect, it } from "vitest";
import Fastify from "fastify";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { SubscriptionBroker } from "../server/subscription-broker.js";
import { AppError } from "../server/policy.js";

it.each(["deadline", "cancel"])(
  "半送本文仍受%s及單請求限制，未解析JSON也不占住主機",
  async (mode) => {
    let calls = 0;
    const broker = new SubscriptionBroker({
      credentials: async () => ({
        accessToken: "synthetic-master-token",
        accountId: "synthetic-account",
        secrets: [],
        models: ["model-test"],
        defaultModel: "model-test",
      }),
      upstreamFetch: async () => {
        calls++;
        throw new Error("不應呼叫");
      },
    });
    const app = Fastify();
    app.setErrorHandler((e, _q, r) =>
      r
        .code(e instanceof AppError ? e.statusCode : 400)
        .send({ error: "安全拒絕" }),
    );
    broker.register(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const runId = randomUUID();
    const lease = await broker.issue({
      runId,
      phase: "code",
      deadline: Date.now() + (mode === "deadline" ? 300 : 3000),
    });
    const requests: http.ClientRequest[] = [];
    const slow = () =>
      new Promise<{ status?: number; closed?: boolean }>((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: `${lease.basePath}/responses`,
            method: "POST",
            headers: {
              Authorization: `Bearer ${lease.token}`,
              "Content-Type": "application/json",
              "Content-Length": "1000000",
            },
          },
          (res) => {
            res.resume();
            resolve({ status: res.statusCode });
          },
        );
        requests.push(req);
        req.on("error", () => resolve({ closed: true }));
        req.write('{"model":"model-test","padding":"' + "x".repeat(1024));
      });
    try {
      const first = slow();
      await new Promise((r) => setTimeout(r, 20));
      const second = slow();
      if (mode === "cancel") setTimeout(() => broker.revoke(runId), 40);
      const values = await Promise.race([
        Promise.all([first, second]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("半送本文未中止")), 1500).unref(),
        ),
      ]);
      expect(values[0]).toEqual({ closed: true });
      expect(values[1]).toEqual({ status: 429 });
      expect(calls).toBe(0);
      expect(broker.usage(runId)?.requests).toBe(1);
      expect(broker.usage(runId)?.inputBytes).toBeLessThan(2000);
    } finally {
      for (const req of requests) req.destroy();
      broker.close();
      await app.close();
    }
  },
);
