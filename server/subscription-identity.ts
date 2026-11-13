import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readCodexAccount } from "./codex-account.js";
import { AppError } from "./policy.js";
import type { SubscriptionIdentity } from "./subscription-broker.js";

/** 由官方 CLI 在可信主機刷新登入；工作輸出永遠不能回寫登入檔。 */
export function subscriptionIdentity(codexHome: string) {
  let cached: { at: number; identity: SubscriptionIdentity } | undefined;
  let pending: Promise<SubscriptionIdentity> | undefined;
  return async (refresh: boolean): Promise<SubscriptionIdentity> => {
    if (!refresh && cached && Date.now() - cached.at < 30000)
      return cached.identity;
    if (pending) return pending;
    pending = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const account = await Promise.race([
          readCodexAccount(codexHome, refresh),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), 35000);
          }),
        ]);
        if (account.allowed !== true)
          throw new AppError(
            429,
            account.allowed === false
              ? "Codex 訂閱額度已達上限"
              : "無法確認訂閱額度，暫停新的推論",
          );
        const auth = JSON.parse(
          await readFile(join(codexHome, "auth.json"), "utf8"),
        );
        const tokens = auth.tokens;
        if (
          !tokens ||
          typeof tokens.access_token !== "string" ||
          typeof tokens.account_id !== "string" ||
          !tokens.account_id
        )
          throw new AppError(
            503,
            "服務需要有效的 ChatGPT 訂閱登入，未使用 API 計費",
          );
        const identity: SubscriptionIdentity = {
          accessToken: tokens.access_token,
          accountId: tokens.account_id,
          secrets: Object.values(tokens).filter(
            (v): v is string => typeof v === "string",
          ),
          models: account.models.map((m) => m.id),
          defaultModel: account.models.find((m) => m.isDefault)?.id ?? "",
        };
        cached = { at: Date.now(), identity };
        return identity;
      } catch (error) {
        cached = undefined;
        if (error instanceof AppError && [429, 503].includes(error.statusCode))
          throw error;
        throw new AppError(503, "訂閱登入讀取或刷新失敗，請確認服務登入");
      } finally {
        if (timer) clearTimeout(timer);
        pending = undefined;
      }
    })();
    return pending;
  };
}
