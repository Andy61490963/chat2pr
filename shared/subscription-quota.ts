export const subscriptionGateName = "codex_subscription_gate";
export const maxCodexReserve = 90;
export const reserveLabel = "保留給你個人使用";
export const unknownSubscriptionQuota =
  "無法確認 Codex 訂閱額度，已保留訊息與工作，稍後會重新檢查";
export const exhaustedSubscriptionQuota = "Codex 訂閱額度已達上限";
export const reservedQuotaHold = "已用到 chat2pr 可用的上限";

type QuotaWindow = { usedPercent: number; resetsAt: string | null };
export type SubscriptionUsage = {
  allowed: boolean | null;
  limits?: { windows: QuotaWindow[] }[];
};

const resetTime = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function resetNote(windows: QuotaWindow[]) {
  const times = windows.map((w) => Date.parse(w.resetsAt ?? ""));
  const latest = Math.max(...times.filter(Number.isFinite));
  if (!Number.isFinite(latest)) return "，重置時間待確認";
  const date = resetTime.format(latest).replace(/\s+/g, " ");
  return times.every(Number.isFinite)
    ? `，預計臺北時間 ${date} 重置`
    : `，已知視窗最晚於臺北時間 ${date} 重置，其餘重置時間待確認`;
}

/** 帳號許可與保留比例都要通過，才可開始新的訂閱工作。 */
export function subscriptionQuotaHold(
  account: SubscriptionUsage,
  reserve: number,
): string | null {
  const windows = account.limits?.flatMap((l) => l.windows) ?? [];
  const reached =
    reserve > 0
      ? windows.filter(
          (w) =>
            Number.isFinite(w.usedPercent) && w.usedPercent >= 100 - reserve,
        )
      : [];
  if (reached.length)
    return `${reservedQuotaHold}（保留 ${reserve}% 給你）${resetNote(reached)}，額度恢復或你調低保留比例至額度可用後會自動繼續。`;
  if (account.allowed === false)
    return (
      exhaustedSubscriptionQuota +
      resetNote(windows.filter((w) => w.usedPercent >= 100))
    );
  if (
    account.allowed !== true ||
    (reserve > 0 &&
      (!windows.length || windows.some((w) => !Number.isFinite(w.usedPercent))))
  )
    return unknownSubscriptionQuota;
  return null;
}
