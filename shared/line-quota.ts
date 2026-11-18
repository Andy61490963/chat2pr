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
  "LINE 推播額度用完，群組回覆與私訊暫停，看板通知照常";
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

/**
 * 一則推播用掉幾則額度：群組推播依群組人數計費（人數未知時當 1），私訊（members 為 undefined）1 則。
 * 這也是「剩餘額度夠不夠送這則」的門檻。
 */
export function pushCost(members?: number | null) {
  return Math.max(1, members ?? 1);
}

/** 剩餘額度不足某群組人數、本輪略過時寫進 last_error 的字；不加 attempts。 */
export const quotaShortForGroup = (
  remaining: number,
  members: number | null,
) =>
  members === null
    ? `推播額度剩 ${remaining} 則，不足這個群組的人數，額度恢復後再送`
    : `推播額度剩 ${remaining} 則，不足這個群組 ${members} 人，額度恢復後再送`;

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

/**
 * 設定頁「LINE 推播（群組回覆與私訊）」卡片要顯示什麼。抽成純函式，
 * 讓「額度用完時停用重送與測試通知、改顯示額度說明」可以不渲染畫面就測。
 */
export function linePushPanel(
  health: { name: string; ok: boolean; detail?: string }[] | undefined,
  failures: { direct: number; group: number; stale: number },
) {
  const blocked = quotaBlocked(health);
  const usage = quotaUsageOf(
    health?.find((h) => h.name === LINE_QUOTA)?.detail,
  );
  const failed = failures.direct + failures.group;
  return {
    blocked,
    usage: usage
      ? usage.limit === null
        ? `本月已用 ${usage.used} 則（方案沒有上限）`
        : `本月已用 ${usage.used}／上限 ${usage.limit}`
      : null,
    notice: blocked
      ? `${quotaRetryBlocked}。群組的「收到」與看板鈴鐺照常；每小時會向 LINE 確認額度，恢復後自動續送暫停期間排隊的通知，過時的訊息不補送。`
      : null,
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
    testDisabled: blocked,
    confirm: retryDescription(failures),
  };
}
