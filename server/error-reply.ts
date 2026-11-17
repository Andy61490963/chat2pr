import { z } from "zod";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { redact } from "./policy.js";

/**
 * 看板 API 的錯誤回應：`{ error }`，輸入格式錯誤另帶 `details`；5xx 不露出內部訊息。
 * 格式與 server/app.ts 的 setErrorHandler 相同。
 *
 * Fastify 的路由在建立當下就決定用哪個錯誤處理；在 app.ts 呼叫 setErrorHandler 之前註冊的路由
 * （例如 registerProjectDatabase）會落到 Fastify 預設格式 `{ statusCode, error: "Unprocessable Entity", message }`，
 * 看板只讀 error，就只看到英文狀態名稱。這類路由以 `{ errorHandler: replyError }` 指定這個函式。
 */
export function replyError(
  error: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof z.ZodError) {
    reply.code(400).send({
      error: "輸入格式錯誤",
      details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }
  const e = error as Error & { statusCode?: number };
  const status = e.statusCode ?? 500;
  reply.code(status).send({
    error:
      status >= 500
        ? "服務暫時無法完成操作，請檢查設定與服務狀態"
        : redact(e.message),
  });
  if (status >= 500) req.log.warn(redact(e.message));
}
