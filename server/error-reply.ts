import { z } from "zod";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { maskCredentials } from "../shared/credentials.js";
import { redact } from "./policy.js";

/**
 * 看板 API 的錯誤回應：`{ error }`，輸入格式錯誤另帶 `details`；5xx 不露出內部訊息。
 * server/app.ts 以 `app.setErrorHandler(replyError)` 套用到所有路由。
 *
 * Fastify 的路由在建立當下就決定用哪個錯誤處理；比 setErrorHandler 早註冊的路由會落到 Fastify 預設格式
 * `{ statusCode, error: "Bad Request", message }`，看板只讀 error，就只看到英文狀態名稱。
 * 所以 app.ts 在註冊任何路由之前就設定它（docs/conventions.md 第 1 節）。
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

/**
 * 隔離執行器（server/runner-main.ts）的錯誤回應：`{ error }`，訊息最多 2000 字。
 * 應用程式會把它顯示在看板與執行紀錄。先遮蔽再截斷：截斷點落在帳密中間時，剩下的半段遮蔽規則認不出來。
 */
export function replyRunnerError(
  error: FastifyError | Error,
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  const e = error as Error & { statusCode?: number };
  reply
    .code(e.statusCode ?? 500)
    .send({ error: maskCredentials(e.message).slice(0, 2000) });
}
