import type { CodexAccount } from "./codex-account.js";
import { config, secrets } from "./config.js";
import { Database, type DbClient } from "./db.js";
import { AppError } from "./policy.js";
import {
  exhaustedSubscriptionQuota,
  reservedQuotaHold,
  runnerUnreachableQuota,
  storedQuotaKind,
  subscriptionGateName,
  subscriptionQuotaHold,
  unknownSubscriptionQuota,
  type QuotaHoldKind,
  type SubscriptionUsage,
} from "../shared/subscription-quota.js";

export { subscriptionGateName };
export type SubscriptionAccount = SubscriptionUsage &
  Pick<CodexAccount, "checkedAt">;
export type ReadSubscriptionAccount = () => Promise<SubscriptionAccount>;

export async function lockSubscriptionGate(c: DbClient) {
  await c.query("SELECT pg_advisory_xact_lock(73466)");
}

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
  constructor(message: string, readonly kind: QuotaHoldKind) {
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
      await lockSubscriptionGate(c);
      const cached = (
        await c.query<{ ok: boolean; detail: string; kind: QuotaHoldKind | null; fresh: boolean }>(
          `SELECT ok,detail,probe_info->>'kind' AS kind,checked_at>clock_timestamp()-CASE WHEN ok THEN interval '30 seconds' ELSE interval '60 seconds' END AS fresh
           FROM service_health WHERE name=$1`,
          [subscriptionGateName],
        )
      ).rows[0];
      if (cached?.fresh) return cached;

      const { reserve } = (
        await c.query<{ reserve: number }>(
          "SELECT COALESCE((value->>'codex_reserve_percent')::int,0) AS reserve FROM settings WHERE id=1",
        )
      ).rows[0];
      let hold: ReturnType<typeof subscriptionQuotaHold> = { kind: "unknown", detail: unknownSubscriptionQuota };
      try {
        const account = await this.readAccount();
        const age = Date.now() - Date.parse(account.checkedAt);
        if (Number.isFinite(age) && age >= -30000 && age <= 120000)
          hold = subscriptionQuotaHold(account, reserve);
      } catch (error) {
        const cause = error instanceof Error ? error.cause : null;
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED")
          hold = { kind: "runner_unreachable", detail: runnerUnreachableQuota };
      }
      const ok = hold === null;
      const detail = hold?.detail ?? "Codex 訂閱額度可用";
      const kind = hold?.kind ?? null;
      await c.query(
        `INSERT INTO service_health(name,ok,detail,probe_info,checked_at) VALUES($1,$2,$3,$4,clock_timestamp())
         ON CONFLICT(name) DO UPDATE SET ok=excluded.ok,detail=excluded.detail,probe_info=excluded.probe_info,checked_at=excluded.checked_at`,
        [subscriptionGateName, ok, detail, kind ? { kind } : null],
      );
      return { ok, detail, kind };
    });
    if (!state.ok) throw new SubscriptionBlocked(state.detail, storedQuotaKind(state.kind, state.detail));
  }

  async exhausted() {
    await this.db.transaction(async (c) => {
      await lockSubscriptionGate(c);
      await c.query(
        `INSERT INTO service_health(name,ok,detail,probe_info,checked_at)
         VALUES($1,false,$2,'{"kind":"exhausted"}',clock_timestamp())
         ON CONFLICT(name) DO UPDATE SET ok=false,detail=excluded.detail,probe_info=excluded.probe_info,checked_at=excluded.checked_at
         WHERE service_health.ok OR NOT COALESCE(service_health.probe_info->>'kind'='reserve',service_health.detail LIKE $3)`,
        [
          subscriptionGateName,
          exhaustedSubscriptionQuota,
          `${reservedQuotaHold}%`,
        ],
      );
    });
  }
}
