import type { FastifyInstance } from "fastify";
import { parseConnectionSecrets } from "../shared/connection-secrets.js";
import { updateConnectionSecrets } from "./connection-secrets-file.js";
import { AppError } from "./policy.js";

export function registerRunnerSecrets(app: FastifyInstance, path?: string) {
  // 此路由沿用執行器的 x-runner-key 驗證。固定回應避免剖析錯誤帶出本文。
  app.post(
    "/secrets",
    {
      bodyLimit: 32 * 1024,
      errorHandler(error, _req, reply) {
        const status = error.statusCode ?? 500;
        reply.code(status).send({
          error:
            error instanceof AppError
              ? error.message
              : "連線金鑰尚未更新，請確認送出的資料與主機設定後再試。",
        });
      },
    },
    async (req) => {
      const parsed = parseConnectionSecrets(req.body);
      if ("error" in parsed) throw new AppError(400, parsed.error);
      try {
        return updateConnectionSecrets(parsed.patch, path);
      } catch {
        throw new AppError(
          503,
          "連線金鑰未能寫入主機設定檔，請確認執行器可存取設定檔後再試。",
        );
      }
    },
  );
}
