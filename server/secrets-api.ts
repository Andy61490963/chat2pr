import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  connectionSecretFields,
  parseConnectionSecrets,
  secretReauthMessage,
} from "../shared/connection-secrets.js";
import { describeConnectionSecretChanges } from "../shared/settings-diff.js";
import { requireUser } from "./auth.js";
import { config, secrets } from "./config.js";
import { connectionSecretStatus } from "./connection-secrets-file.js";
import type { Database, DbClient } from "./db.js";
import type { Runner } from "./execution.js";
import { replyError } from "./error-reply.js";
import { AppError } from "./policy.js";

export function registerConnectionSecrets(
  app: FastifyInstance,
  db: Database,
  runner: Pick<Runner, "call">,
  refreshDiscord?: () => void,
) {
  app.put(
    "/api/secrets",
    {
      bodyLimit: 32 * 1024,
      errorHandler(error, req, reply) {
        if (error.statusCode === 413 || error.statusCode === 415)
          return reply.code(error.statusCode).send({
            error:
              "連線金鑰尚未更新，因為送出的資料過大或格式不符。請重新整理後，只貼上欄位需要的內容。",
          });
        replyError(error, req, reply);
      },
    },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const user = await requireUser(db, req);
      if (user.user_id !== config().adminId)
        throw new AppError(403, "連線金鑰只有擁有者能更新");
      if (!user.recentlyAuthenticated)
        throw new AppError(409, secretReauthMessage);
      const parsed = parseConnectionSecrets(req.body);
      if ("error" in parsed) throw new AppError(400, parsed.error);
      if (Object.keys(parsed.patch).length === 0)
        return { connectionSecrets: connectionSecretStatus(secrets()) };

      const noticeKey = `connection-secrets:${randomUUID()}`;
      let names: string | undefined;
      async function recordChange(client: DbClient) {
        // 若提交後連線中斷，重試時以同一通知鍵避免重複留下稽核。
        const notice = await client.query(
          `INSERT INTO notifications(kind,dedupe_key,text)
           VALUES('connection_secrets_updated',$1,$2)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [noticeKey, `連線金鑰已更新：${names}`],
        );
        if (notice.rowCount)
          await db.audit(
            null,
            "settings",
            `擁有者 ${user.login} 更新連線金鑰：${names}`,
            client,
          );
      }
      try {
        await db.transaction(async (client) => {
          // 連線時間有限，資料庫無法開始交易時不向主機寫入。
          const result = await runner.call<{ changed: unknown }>(
            "secrets",
            parsed.patch,
            5000,
          );
          const reported = result.changed;
          if (!Array.isArray(reported)) throw new Error("執行器未回傳更新欄位");
          const changed = connectionSecretFields.filter(
            (field) =>
              Object.hasOwn(parsed.patch, field) && reported.includes(field),
          );
          if (!changed.length) return;
          names = describeConnectionSecretChanges(changed);
          if (
            changed.some(
              (field) =>
                field === "discordToken" || field === "discordApplicationId",
            )
          )
            refreshDiscord?.();
          await recordChange(client);
        });
      } catch {
        // 主機或資料庫錯誤可攜帶請求細節，僅回傳固定說明。
        if (!names)
          return reply.code(503).send({
            error:
              "無法確認連線金鑰是否已更新，因為主機或資料庫未正常回應。請重新整理確認更新時間，再檢查主機執行器與資料庫。",
          });
        try {
          await db.transaction(recordChange);
        } catch {
          return reply.code(503).send({
            error:
              "連線金鑰已寫入主機，但未能保存變更紀錄。請檢查資料庫連線與最近動態。",
          });
        }
      }
      return { connectionSecrets: connectionSecretStatus(secrets()) };
    },
  );
}
