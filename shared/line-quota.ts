import {
  linePrivateDefaults,
  linePrivateQuotaHold,
  linePrivateQuotaNotes,
} from "./line-private.js";

/**
 * LINE 每月推播額度的共用文字與判讀。伺服器（推播、重送、測試通知、連線檢查）與看板共用，
 * 避免同一件事在不同地方說法不一。額度狀態存在 service_health 的 line_quota，
 * 刻意不併進 'line' 檢查：解除暫停要求 'line' 正常，額度用完時收訊與「收到」其實照常。
 */
export const LINE_QUOTA = "line_quota";

/** 推播撞到每月上限時寫進 line_quota 的說明。 */
export const quotaExhaustedDetail =
  "LINE 本月推播額度已用完，下個月初重置；群組的『收到』與看板鈴鐺不受影響";
/** 額度用完時拒絕重送的理由。 */
export const quotaRetryBlocked =
  "LINE 本月推播額度已用完，額度恢復前重送也會失敗";
/** 額度用完時拒絕測試通知的理由：問題不在權杖，不要叫管理者去重設。 */
export const quotaTestBlocked = "LINE 本月推播額度已用完，權杖沒有問題";
/** 鈴鐺清單頂端的提示。 */
export const quotaBellNotice =
  "LINE 推播額度用完，群組有人發言時會補送重要通知，看板通知照常";
/** 過期、不再補送的通知寫進 last_error 的字。 */
export const expiredNote = "已過期，未補送";

/** LINE 推播失敗回應是否為「每月額度用完」：只有 429 且訊息寫明 monthly limit 才算。 */
export function isMonthlyLimit(status: number, message: unknown) {
  return (
    status === 429 &&
    typeof message === "string" &&
    /monthly limit/i.test(message)
  );
}

/** 「本月已用 X／上限 Y 則」；沒有上限的方案只寫已用量。 */
export function quotaUsageText(usage: { limit: number | null; used: number }) {
  return usage.limit === null
    ? `本月已用 ${usage.used} 則，方案沒有推播上限`
    : `本月已用 ${usage.used}／上限 ${usage.limit} 則`;
}

/** 從 line_quota 的說明取出用量，看板顯示「本月已用 X／上限 Y」。 */
export function quotaUsageOf(detail: string | undefined) {
  const m = detail?.match(/本月已用 (\d+)(?:／上限 (\d+))? 則/);
  return m ? { used: Number(m[1]), limit: m[2] ? Number(m[2]) : null } : null;
}

/**
 * 本月還能推幾則：null 是不知道（還沒查過額度），Infinity 是方案沒有上限。
 * 用量來自 line_quota 的說明（quotaUsageText 的格式）。
 */
export function quotaRemaining(
  usage: { limit: number | null; used: number } | null,
) {
  if (!usage) return null;
  return usage.limit === null
    ? Infinity
    : Math.max(0, usage.limit - usage.used);
}

/** 已達八成或這次推播會跨過八成時，額度留給重要通知。 */
export function lineQuotaLow(usage: { limit: number | null; used: number } | null, cost = 0) {
  if (usage?.limit == null) return false;
  const threshold = usage.limit * 4;
  return usage.used * 5 >= threshold || (usage.used + cost) * 5 > threshold;
}

/**
 * 一則推播用掉幾則額度：群組推播依群組人數計費（人數未知時當 1），私訊（members 為 undefined）1 則。
 * 這也是「剩餘額度夠不夠送這則」的門檻。
 */
export function pushCost(members?: number | null) {
  return Math.max(1, members ?? 1);
}

/** quotaShortForGroup 的開頭：額度恢復時用它找出「因額度不夠而略過」的通知，先清掉過時的再續送。 */
export const quotaShortPrefix = "推播額度剩 ";

/** 剩餘額度不足某群組人數、本輪略過時寫進 last_error 的字；不加 attempts。 */
export const quotaShortForGroup = (
  remaining: number,
  members: number | null,
) =>
  members === null
    ? `${quotaShortPrefix}${remaining} 則，不足這個群組的人數，額度恢復後再送`
    : `${quotaShortPrefix}${remaining} 則，不足這個群組 ${members} 人，額度恢復後再送`;

/** line_quota 健康項：ok=false 代表額度用完、推播暫停。 */
export function quotaBlocked(
  health: { name: string; ok: boolean }[] | undefined,
) {
  return !!health?.some((h) => h.name === LINE_QUOTA && !h.ok);
}

/** 重送確認框的說明。 */
export function retryDescription(f: {
  direct: number;
  group: number;
  stale: number;
}) {
  const skipped = f.stale ? `；已過期的 ${f.stale} 則略過` : "";
  return `會重送私訊 ${f.direct} 則、群組 ${f.group} 則（群組依人數計入額度）${skipped}。`;
}

const quotaCalendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function quotaDisplay(
  usage: ReturnType<typeof quotaUsageOf>,
  sample?: { ok: boolean; detail?: string; checked_at?: string },
) {
  if (!usage) return { usage: null, forecast: null };
  const amount =
    usage.limit === null
      ? `${usage.used} 則（方案沒有上限）`
      : `${usage.used}／上限 ${usage.limit}`;
  const checkedAt = new Date(sample?.checked_at ?? "");
  const checkedDay = Number.isFinite(checkedAt.getTime())
    ? quotaCalendar.format(checkedAt)
    : null;
  if (checkedDay && !quotaCalendar.format(new Date()).startsWith(checkedDay.slice(0, 7))) {
    return { usage: "尚未取得本月推播用量", forecast: null };
  }
  if (sample?.detail?.includes("上次查到")) {
    return { usage: `上次查到已用 ${amount}，本月用量待確認`, forecast: null };
  }
  const summary = { usage: `本月已用 ${amount}`, forecast: null };
  if (
    !checkedDay || !sample?.ok || usage.used === 0 ||
    usage.limit === null || usage.used >= usage.limit
  ) {
    return summary;
  }
  const [year, month, day] = checkedDay.split("-").map(Number);
  const projectedDay = Math.ceil((day * usage.limit) / usage.used);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    usage: summary.usage,
    forecast:
      projectedDay <= lastDay
        ? `按本月平均每日用量，預估 ${month} 月 ${projectedDay} 日用完。`
        : "按本月平均每日用量，預估本月不會用完。",
  };
}

/**
 * 設定頁「LINE 推播（群組回覆與私訊）」卡片要顯示什麼。抽成純函式，
 * 讓「額度用完時停用重送與測試通知、改顯示額度說明」可以不渲染畫面就測。
 */
export function linePushPanel(
  health: { name: string; ok: boolean; detail?: string; checked_at?: string }[] | undefined,
  failures: { direct: number; group: number; stale: number },
  reserve: number = linePrivateDefaults.line_group_reserve_percent,
) {
  const blocked = quotaBlocked(health);
  const sample = health?.find((h) => h.name === LINE_QUOTA);
  const usage = quotaUsageOf(sample?.detail);
  const failed = failures.direct + failures.group;
  const privateHold = linePrivateQuotaHold(usage, reserve);
  return {
    blocked,
    ...quotaDisplay(usage, sample),
    notice: blocked
      ? `${quotaRetryBlocked}。群組有人發言時，會在回覆中帶上待送的重要通知摘要。看板鈴鐺照常，系統每小時向 LINE 確認額度，恢復後會續送仍有效的通知。`
      : privateHold ? linePrivateQuotaNotes[privateHold] : null,
    failed,
    failedText: failed
      ? `有 ${failed} 則通知重試 3 次仍送不出去（私訊 ${failures.direct} 則、群組 ${failures.group} 則）。${
          blocked
            ? "額度恢復前重送也會失敗，恢復後再重送。"
            : "請先用「服務連線」確認 LINE 正常，再重送。"
        }`
      : null,
    // 額度用完時重送只會再失敗、測試通知只會白打一次推播。
    retryDisabled: blocked,
    testDisabled: blocked || !!privateHold || quotaRemaining(usage) === 0,
    confirm: retryDescription(failures),
  };
}
