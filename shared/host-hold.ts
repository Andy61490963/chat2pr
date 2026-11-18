/**
 * 看板判斷「主機記憶體不足而自動暫停派工」的純函式。
 *
 * 伺服器的 `hostHold`（server/capacity.ts）只採用兩分鐘內的 `host_resources` 檢查結果；
 * 看板放寬到三分鐘，留一次輪詢的誤差。排程器只在有排隊任務時才檢查主機資源，
 * 佇列清空後異常列會停在 ok=false，所以一定要看新鮮度，否則橫幅會一直掛著。
 */
export const HOST_HEALTH = "host_resources";
export const HOST_HOLD_FRESH_MS = 3 * 60_000;

export interface HealthRow {
  name: string;
  ok: boolean;
  detail: string;
  checked_at: string;
}

/**
 * 記憶體不足暫停派工時回傳原因（`host_resources` 的 detail，去掉句尾標點，看板會接著補一句）；
 * 正常或結果過期時為 null。
 */
export function memoryHold(
  health: readonly HealthRow[] | undefined,
  now = Date.now(),
): string | null {
  const h = health?.find((x) => x.name === HOST_HEALTH);
  if (!h || h.ok) return null;
  const at = new Date(h.checked_at).getTime();
  if (!Number.isFinite(at) || now - at > HOST_HOLD_FRESH_MS) return null;
  return h.detail.replace(/[。；，\s]+$/, "") || "主機記憶體不足，暫停派新工作";
}
