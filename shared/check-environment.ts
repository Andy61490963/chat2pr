/**
 * 定期檢查的專用環境（#19）：保留、重用與清除規則。看板、應用程式與主機執行器共用的純函式。
 *
 * 一個檢查一個環境：檢查容器（拿連線機密、執行查詢）＋轉接器（只把一個連接埠轉到目標）＋專用內部網路。
 * 環境以「檢查 ID＋環境鍵」辨識；環境鍵由檢查版本與連線設定版本組成，任一改變就是新環境。
 */

export interface CheckEnvironmentPolicy {
  /** 閒置超過幾分鐘沒有使用就清除。 */
  idleMinutes: number;
  /** 同時保留的環境數上限；超過時先清最久沒用的。 */
  max: number;
}

export const defaultCheckEnvironmentPolicy: CheckEnvironmentPolicy = {
  idleMinutes: 120,
  max: 20,
};
export const checkEnvironmentLimits = {
  idleMinutes: { min: 10, max: 1440 },
  max: { min: 1, max: 100 },
};

export function checkEnvironmentPolicy(settings: {
  check_env_idle_minutes?: number;
  check_env_max?: number;
}): CheckEnvironmentPolicy {
  const clamp = (v: unknown, d: number, r: { min: number; max: number }) =>
    typeof v === "number" && Number.isInteger(v)
      ? Math.min(r.max, Math.max(r.min, v))
      : d;
  return {
    idleMinutes: clamp(
      settings.check_env_idle_minutes,
      defaultCheckEnvironmentPolicy.idleMinutes,
      checkEnvironmentLimits.idleMinutes,
    ),
    max: clamp(
      settings.check_env_max,
      defaultCheckEnvironmentPolicy.max,
      checkEnvironmentLimits.max,
    ),
  };
}

/**
 * 環境鍵：檢查定義版本＋（SQL 檢查）連線設定版本。
 * 修改檢查會提高版本；更新連線會改變 updated_at；第一次記下 SSH 主機金鑰也要換環境，
 * 舊環境裡的機密與主機金鑰設定才不會繼續被使用。
 */
export function checkEnvironmentKey(
  check: { version: number; kind: string },
  connection?: {
    updated_at: Date | string;
    ssh_host_key: string | null;
  } | null,
) {
  const base = `v${check.version}`;
  if (check.kind !== "sql" || !connection) return base;
  const at = new Date(connection.updated_at).getTime();
  return `${base}.c${at}.${connection.ssh_host_key ? "k" : "n"}`;
}

/** 執行器回報的一個保留中的環境。 */
export interface KeptEnvironment {
  checkId: string;
  key: string;
  createdAt: string;
  lastUsedAt: string;
}
export interface EnvironmentFailure {
  checkId: string;
  key: string;
  at: string;
  message: string;
}

export type RemovalReason = "stale" | "idle" | "limit" | "manual" | "broken";
export const removalText: Record<RemovalReason, string> = {
  stale: "檢查已修改、暫停、刪除或停用，或連線設定已更新",
  idle: "閒置逾時",
  limit: "保留數已達上限，先清最久沒用的",
  manual: "管理者手動清除",
  broken: "環境失去回應",
};

/**
 * 要清除哪些環境：不在有效清單（或環境鍵不同）→ 閒置逾時 → 超過上限時從最久沒用的開始。
 * reserve 是接下來要新建的數量，讓建立前先騰出位置。
 */
export function environmentsToRemove(
  kept: KeptEnvironment[],
  valid: Map<string, string> | null,
  policy: CheckEnvironmentPolicy,
  now: number,
  reserve = 0,
): { checkId: string; reason: RemovalReason }[] {
  const out: { checkId: string; reason: RemovalReason }[] = [];
  const left: KeptEnvironment[] = [];
  for (const e of kept) {
    if (valid && valid.get(e.checkId) !== e.key)
      out.push({ checkId: e.checkId, reason: "stale" });
    else if (now - Date.parse(e.lastUsedAt) > policy.idleMinutes * 60000)
      out.push({ checkId: e.checkId, reason: "idle" });
    else left.push(e);
  }
  const over = left.length + reserve - policy.max;
  if (over > 0)
    for (const e of [...left]
      .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt))
      .slice(0, over))
      out.push({ checkId: e.checkId, reason: "limit" });
  return out;
}

/** 看板顯示的環境狀態。 */
export type CheckEnvironmentView =
  | { state: "none" }
  | { state: "unknown"; detail: string }
  | {
      state: "kept";
      createdAt: string;
      lastUsedAt: string;
      expiresAt: string;
    }
  | { state: "failed"; at: string; message: string };

export function environmentView(
  key: string,
  kept: KeptEnvironment | undefined,
  failure: EnvironmentFailure | undefined,
  policy: CheckEnvironmentPolicy,
): CheckEnvironmentView {
  if (kept && kept.key === key)
    return {
      state: "kept",
      createdAt: kept.createdAt,
      lastUsedAt: kept.lastUsedAt,
      expiresAt: new Date(
        Date.parse(kept.lastUsedAt) + policy.idleMinutes * 60000,
      ).toISOString(),
    };
  if (failure && failure.key === key)
    return { state: "failed", at: failure.at, message: failure.message };
  return { state: "none" };
}
