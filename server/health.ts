import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";

// 會讓收訊、派工或通知停擺的服務；其餘項目只在設定頁顯示，不另外通知。
const critical: Record<string, string> = {
  line: "LINE",
  github: "GitHub App",
  codex: "Codex 訂閱登入",
  openai: "OpenAI API",
  runner: "隔離執行器",
  tunnel: "HTTPS 入口",
  host_resources: "主機資源",
};

/**
 * 寫入服務狀態；重要服務由正常變異常、或由異常恢復時通知管理者一次。
 * 第一次觀察只建立基準不通知。confirm 用於每分鐘檢查的項目：連續兩次異常才通知，避免瞬斷洗版。
 */
export async function recordHealth(
  db: Database,
  name: string,
  ok: boolean,
  detail: string,
  options: { confirm?: boolean } = {},
) {
  const [before] = await db.query<{
    was: boolean | null;
    told: boolean | null;
  }>(
    `WITH old AS (SELECT ok,notified_ok FROM service_health WHERE name=$1),
     saved AS (INSERT INTO service_health(name,ok,detail) VALUES($1,$2,$3)
       ON CONFLICT(name) DO UPDATE SET ok=$2,detail=$3,checked_at=now() RETURNING 1)
     SELECT (SELECT ok FROM old) AS was,(SELECT notified_ok FROM old) AS told FROM saved`,
    [name, ok, detail],
  );
  const label = critical[name];
  if (!label) return;
  const was = before?.was ?? null;
  const baseline = before?.told ?? was;
  if (baseline === null || baseline === ok) {
    if (before?.told !== ok)
      await db.query("UPDATE service_health SET notified_ok=$2 WHERE name=$1", [
        name,
        ok,
      ]);
    return;
  }
  if (!ok && options.confirm && was !== false) return;
  const marked = await db.query(
    "UPDATE service_health SET notified_ok=$2 WHERE name=$1 AND notified_ok IS DISTINCT FROM $2 RETURNING name",
    [name, ok],
  );
  if (!marked.length) return;
  // 上面的更新已保證每次狀態轉換只會走到這裡一次，所以每次轉換都要發。
  // 不能用時段去重：一小時內異常、恢復、再異常，最後一則會停在「已恢復」。
  await db.query(
    "INSERT INTO notifications(kind,dedupe_key,text) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [
      ok ? "service_up" : "service_down",
      `service:${name}:${ok ? "up" : "down"}:${randomUUID()}`,
      ok
        ? `服務已恢復：${label}`
        : `服務異常：${label}（${detail}）。恢復前相關功能會停擺，請到設定頁查看。`,
    ],
  );
}
