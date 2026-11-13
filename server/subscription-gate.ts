import type { CodexAccount } from "./codex-account.js";
import { config, secrets } from "./config.js";
import { Database } from "./db.js";
import { AppError } from "./policy.js";

export const subscriptionGateName = "codex_subscription_gate";
export type SubscriptionAccount = Pick<CodexAccount, "allowed" | "checkedAt">;
export type ReadSubscriptionAccount = () => Promise<SubscriptionAccount>;

/** 只讀帳號額度，不建立推論；強制略過執行器的舊快取。 */
export async function readSubscriptionAccount(
  runnerKey = secrets().runnerSecret ?? "",
): Promise<SubscriptionAccount> {
  const response = await fetch(`${config().runnerUrl}/codex/account?fresh=1`, {
    headers: { "x-runner-key": runnerKey },
    signal: AbortSignal.timeout(35000),
  });
  if (!response.ok) throw new Error("無法讀取 Codex 訂閱額度");
  return response.json() as Promise<SubscriptionAccount>;
}

export class SubscriptionBlocked extends AppError {
  constructor(message: string) {
    super(429, message);
  }
}

/** 共用資料庫狀態可跨判讀、開發及服務重啟；未知額度不視為可使用。 */
export class SubscriptionGate {
  constructor(
    private db: Database,
    private readAccount: ReadSubscriptionAccount = readSubscriptionAccount,
  ) {}

  async ensure() {
    // 不在交易內拋出阻擋錯誤，以免剛寫入的額度狀態被 rollback。
    const state = await this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(73466)");
      const cached = (
        await c.query<{ ok: boolean; detail: string; fresh: boolean }>(
          `SELECT ok,detail,checked_at>clock_timestamp()-CASE WHEN ok THEN interval '30 seconds' ELSE interval '60 seconds' END AS fresh
           FROM service_health WHERE name=$1`,
          [subscriptionGateName],
        )
      ).rows[0];
      if (cached?.fresh) return cached;

      let ok = false;
      let detail = "無法確認 Codex 訂閱額度，已保留訊息與工作；稍後重新檢查";
      try {
        const account = await this.readAccount();
        const age = Date.now() - Date.parse(account.checkedAt);
        if (Number.isFinite(age) && age >= -30000 && age <= 120000) {
          ok = account.allowed === true;
          if (ok) detail = "Codex 訂閱額度可用";
          else if (account.allowed === false)
            detail = "Codex 訂閱額度已達上限，已保留訊息與工作；等待額度恢復";
        }
      } catch {
        // 網路錯誤、登入失效與未知回應皆不能當成額度充足。
      }
      await c.query(
        `INSERT INTO service_health(name,ok,detail,checked_at) VALUES($1,$2,$3,clock_timestamp())
         ON CONFLICT(name) DO UPDATE SET ok=excluded.ok,detail=excluded.detail,checked_at=excluded.checked_at`,
        [subscriptionGateName, ok, detail],
      );
      return { ok, detail };
    });
    if (!state.ok) throw new SubscriptionBlocked(state.detail);
  }

  async exhausted() {
    await this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(73466)");
      await c.query(
        `INSERT INTO service_health(name,ok,detail,checked_at)
         VALUES($1,false,'Codex 訂閱額度已達上限，已保留訊息與工作；等待額度恢復',clock_timestamp())
         ON CONFLICT(name) DO UPDATE SET ok=false,detail=excluded.detail,checked_at=excluded.checked_at`,
        [subscriptionGateName],
      );
    });
  }
}
