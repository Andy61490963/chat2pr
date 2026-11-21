import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { secrets } from "./config.js";
import { AppError } from "./policy.js";

export function registerRunnerAuth(
  app: FastifyInstance,
  readKey = () => secrets().runnerSecret,
) {
  app.addHook("onRequest", async (req) => {
    const key = Buffer.from(readKey() ?? "");
    const received = Buffer.from(String(req.headers["x-runner-key"] ?? ""));
    if (
      !key.length ||
      received.length !== key.length ||
      !timingSafeEqual(key, received)
    )
      throw new AppError(401, "執行器授權失敗");
  });
}
