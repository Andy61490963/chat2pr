import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, DbClient } from "./db.js";
import { recordHealth } from "./health.js";
import { fetchLine } from "./line-http.js";
import { redact } from "./policy.js";
import {
  LINE_QUOTA,
  expiredNote,
  isMonthlyLimit,
  quotaExhaustedDetail,
  quotaShortPrefix,
  quotaUsageOf,
  quotaUsageText,
} from "../shared/line-quota.js";

/**
 * LINE 每月推播額度用完的處理。
 * - 推播回 429 且訊息寫明 monthly limit：不算失敗次數。先查額度 API：群組撞到、但還剩 1 則以上時，
 *   只是剩下的不夠這個群組的人數，本輪略過其餘群組，私訊另依保留額度判斷。剩 0 則或私訊也撞到，才整個暫停。
 * - 群組推播依人數計費：剩餘則數要用 line_quota 說明裡的用量減掉，與群組人數（groups.member_count）比較，
 *   不能只看 used<limit。flush 每送一則就在本地加上用掉的則數，不必每則都查 API。
 * - 暫停期間由每小時的連線檢查（或管理者按「檢查連線」）查 quota API，有剩餘額度才解除；
 *   不自己用日期猜重置時間，方案升級或 LINE 換月時區不同也能正確恢復。
 * - 解除時與管理者按「重送」時，先把過時的通知標成已過期，避免新月份額度被舊訊息吃光。
 */

/** 推播撞到每月上限；flush 收到後本輪立即停止，這則通知不算失敗次數。 */
export class LineQuotaExhausted extends Error {
  constructor() {
    super(quotaExhaustedDetail);
  }
}

/** 補問、結案結果、待處理失敗與檢查異常優先使用群組額度。檢查異常的前綴由 notifyCheck 固定產生。 */
export const importantLineGroupNotice = `(n.kind IN ('group_question','group_ready','group_merged','group_answered','group_failed','group_no_changes')
  OR (n.kind='group_check' AND n.text LIKE '⚠️ %'))`;

export class LinePushRejected extends Error {}

// 測試私訊、通知排程與額度同步共用同一把鎖，避免同時計入同一份剩餘額度。
export const linePushLockId = 73467;

export async function withLinePushLock<T>(db: Database, run: () => Promise<T>) {
  const client = await db.pool.connect();
  try {
    const { rows: [{ locked }] } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [linePushLockId],
    );
    if (!locked) return;
    try {
      return await run();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [linePushLockId]);
    }
  } finally {
    client.release();
  }
}

export async function pushLineMessage(
  access: string,
  to: string,
  messages: { type: "text"; text: string }[],
  retryKey: string,
) {
  const response = await fetchLine("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
      "X-Line-Retry-Key": retryKey,
    },
    body: JSON.stringify({ to, messages }),
    signal: AbortSignal.timeout(10000),
  });
  if (
    response.ok ||
    (response.status === 409 && response.headers.get("x-line-accepted-request-id"))
  )
    return response;
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
  } | null;
  if (isMonthlyLimit(response.status, body?.message))
    throw new LineQuotaExhausted();
  const Failure = response.status >= 400 && response.status < 500 ? LinePushRejected : Error;
  throw new Failure(
    response.status === 429
      ? "LINE 推播太頻繁，稍後會再送（429）"
      : `LINE 通知失敗（${response.status}）`,
  );
}

export function recordLinePush(db: Database, error?: string) {
  return db.query(
    `INSERT INTO service_health(name,ok,detail) VALUES('notifications',$1,$2)
     ON CONFLICT(name) DO UPDATE SET ok=$1,detail=$2,checked_at=now()`,
    [error === undefined, error ?? "最近一次 LINE 通知已送達"],
  );
}

/** 額度用完、推播暫停中。 */
export async function lineQuotaBlocked(db: Database) {
  const r = await db.one<{ ok: boolean }>(
    "SELECT ok FROM service_health WHERE name=$1",
    [LINE_QUOTA],
  );
  return r ? !r.ok : false;
}

/** line_quota 說明裡記的本月用量；沒查過或說明沒有用量時回 null。 */
export async function lineQuotaUsage(db: Database) {
  const r = await db.one<{ detail: string }>(
    "SELECT detail FROM service_health WHERE name=$1",
    [LINE_QUOTA],
  );
  return quotaUsageOf(r?.detail);
}

/**
 * 記下額度用完。line_quota 刻意不在 health.ts 的 critical 清單：那會再排一則私訊，這時送不出去。
 * 說明一定要帶「本月已用 X／上限 Y 則」：先用呼叫端給的，再沿用原本說明裡的；都沒有時
 * （例如從沒成功查過額度）用 access 查一次，查用量的 API 不計推播額度。查不到才只寫「已用完」。
 */
export async function markQuotaExhausted(
  db: Database,
  usage?: { limit: number | null; used: number } | null,
  access?: string,
) {
  const kept =
    usage ??
    (await lineQuotaUsage(db)) ??
    (access ? await fetchLineQuota(access).catch(() => null) : null);
  await recordHealth(
    db,
    LINE_QUOTA,
    false,
    kept
      ? `${quotaExhaustedDetail}（${quotaUsageText(kept)}）`
      : quotaExhaustedDetail,
    { trackOutage: true },
  );
  // 額度封鎖後無法再向 LINE 確認先前中斷的批次，讓群組下一次的免費回覆能領取。
  await db.query(
    `UPDATE notifications n SET line_digest_id=NULL FROM groups g WHERE g.id=n.group_id AND g.platform='line'
       AND n.sent_at IS NULL AND n.line_digest_id IS NOT NULL`,
  );
}

/**
 * 推播途中更新本地估算的用量（flush 每推一則就加上群組人數或 1，不必每則都查 API）。
 * 只改仍可推播時的說明：已封鎖時說明是「額度已用完（用量）」，由 markQuotaExhausted 負責。
 */
export async function saveQuotaUsage(
  db: Database,
  usage: { limit: number | null; used: number },
  client: DbClient = db.pool,
) {
  await client.query(
    `INSERT INTO service_health(name,ok,detail) VALUES($1,true,$2)
     ON CONFLICT(name) DO UPDATE SET detail=EXCLUDED.detail WHERE service_health.ok`,
    [LINE_QUOTA, quotaUsageText(usage)],
  );
}

const MemberCount = z.object({ count: z.number().int().nonnegative() });
/**
 * 群組（C 開頭）或多人聊天室（R 開頭）的人數，用來判斷剩餘推播額度夠不夠送群組通知。
 * 讀人數的 API 不計推播額度；結果快取在 groups.member_count，24 小時更新一次。
 * 讀不到時沿用上次讀到的人數、一小時後再試；從沒讀到過就是未知（null）。
 */
export async function groupMemberCount(
  db: Database,
  groupId: string,
  access: string,
) {
  const row = await db.one<{ member_count: number | null; fresh: boolean }>(
    "SELECT member_count,COALESCE(member_count_at>now()-interval '24 hours',false) AS fresh FROM groups WHERE id=$1 AND platform='line'",
    [groupId],
  );
  if (!row) return null;
  if (row.fresh) return row.member_count;
  let count: number | null = null;
  try {
    const response = await fetch(
      `https://api.line.me/v2/bot/${groupId.startsWith("R") ? "room" : "group"}/${encodeURIComponent(groupId)}/members/count`,
      {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (response.ok) {
      const parsed = MemberCount.safeParse(
        await response.json().catch(() => null),
      );
      if (parsed.success) count = parsed.data.count;
    }
  } catch {
    // LINE 暫時連不上：當成讀不到。
  }
  if (count === null) {
    await db.query(
      "UPDATE groups SET member_count_at=now()-interval '23 hours' WHERE id=$1 AND platform='line'",
      [groupId],
    );
    return row.member_count;
  }
  await db.query(
    "UPDATE groups SET member_count=$2,member_count_at=now() WHERE id=$1 AND platform='line'",
    [groupId, count],
  );
  return count;
}

/**
 * LINE 以每月上限拒絕某群組的推播，額度 API 卻顯示還剩 remaining 則：這個群組實際要的比 remaining 多
 * （人數讀不到，或 LINE 的用量統計有落差）。記下「至少 remaining+1 人」並視為剛更新，
 * 24 小時內不再對這個群組撞 429；額度變多（換月、升級方案）時自然又能送。
 */
export async function markGroupTooLarge(
  db: Database,
  groupId: string,
  remaining: number,
) {
  await db.query(
    "UPDATE groups SET member_count=GREATEST(COALESCE(member_count,0),$2),member_count_at=now() WHERE id=$1 AND platform='line'",
    [groupId, remaining + 1],
  );
}

/**
 * 未送通知是否已過時（需先 LEFT JOIN tasks t）：
 * - 管理者私訊：超過 24 小時（看板鈴鐺本來就有同樣內容，改送一則彙整）。
 * - group_waiting／group_received：超過 6 小時，或任務已不在等待中。
 * - group_question：任務不再等回答、問題已清掉，或不是目前版本的提問（與 answers.ts questionByQuote 相同條件）。
 * - group_failed：任務已不是 failed，或同一任務之後又有新的失敗說明（每次失敗各一則，只送最新的）。
 * - group_resumed（自動接續）：超過 6 小時、接續已結束（任務不在排隊、執行或等待額度中），或不是目前版本的接續。
 * - group_no_changes：超過 24 小時，或這個版本的任務已不再是已回覆。
 * - 其他群組通知：超過 24 小時。
 */
export const staleNotification = `COALESCE(CASE
  WHEN n.group_id IS NULL THEN n.created_at<now()-interval '24 hours'
  WHEN n.kind='group_waiting' THEN n.created_at<now()-interval '6 hours' OR t.status IS NULL OR t.status NOT IN ('queued','budget_wait')
  WHEN n.kind='group_received' THEN n.created_at<now()-interval '6 hours' OR t.status IS NULL OR t.status<>'awaiting_approval'
  WHEN n.kind='group_question' THEN t.status IS NULL OR t.status<>'awaiting_approval' OR t.question IS NULL OR n.dedupe_key<>'group:question:'||t.id||':'||t.version
  WHEN n.kind='group_failed' THEN t.status IS NULL OR t.status<>'failed'
    OR EXISTS(SELECT 1 FROM notifications f WHERE f.task_id=n.task_id AND f.kind='group_failed' AND (f.created_at,f.id)>(n.created_at,n.id))
  WHEN n.kind='group_resumed' THEN n.created_at<now()-interval '6 hours' OR t.status IS NULL OR t.status NOT IN ('queued','running','reviewing','budget_wait') OR n.dedupe_key<>'group:resumed:'||t.id||':'||t.version
  WHEN n.kind='group_no_changes' THEN n.created_at<now()-interval '24 hours' OR t.status IS NULL OR t.status<>'answered' OR n.dedupe_key<>'group:no_changes:'||t.id||':'||t.version
  ELSE n.created_at<now()-interval '24 hours'
END,false)`;

/** LINE 推播的對象：目前的管理者私訊，或已登記為 LINE 的群組。通知使用別名 n。 */
export const lineNotificationTarget = `((n.group_id IS NULL AND COALESCE(
  (SELECT value->>'admin_notify_platform' FROM settings WHERE id=1),'line')='line') OR EXISTS(
  SELECT 1 FROM groups g WHERE g.id=n.group_id AND g.platform='line'
))`;

/**
 * 把過時的未送通知標成 sent_at=now()、last_error='已過期，未補送'（比照群組回覆關閉時的作法，
 * 看板仍查得到）。過期的管理者私訊不逐則補送，改排一則彙整。正在推送的列（被鎖住）略過。
 */
export async function expireStaleNotifications(c: DbClient) {
  const rows = (
    await c.query<{ group_id: string | null }>(
      `UPDATE notifications u SET sent_at=now(),last_error=$1
       FROM (SELECT n.id FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id
         WHERE n.sent_at IS NULL AND (n.group_id IS NULL OR n.line_digest_id IS NULL)
           AND ${lineNotificationTarget} AND ${staleNotification} FOR UPDATE OF n SKIP LOCKED) s
       WHERE u.id=s.id RETURNING u.group_id`,
      [expiredNote],
    )
  ).rows;
  const direct = rows.filter((r) => !r.group_id).length;
  if (direct)
    await c.query(
      "INSERT INTO notifications(kind,dedupe_key,text) VALUES('line_backlog',$1,$2) ON CONFLICT DO NOTHING",
      [
        `line_backlog:${randomUUID()}`,
        `有 ${direct} 則通知沒能及時用 LINE 送出，已不再補送，請到看板鈴鐺查看。`,
      ],
    );
  return rows.length;
}

/**
 * 群組恢復推播前，把因剩餘額度不夠群組人數而略過、現在已過時的通知標成已過期。原因：這種略過不會進入 line_quota 封鎖，
 * syncLineQuota 解除封鎖時的 expireStaleNotifications 管不到；不先清掉，換月後會把幾週前的說明推給整個群組。
 * 其他群組仍可用 /進度（7 天內）取回。
 */
export async function expireQuotaHeld(c: DbClient, group: string) {
  await c.query(
    `UPDATE notifications u SET sent_at=now(),last_error=$1
     FROM (SELECT n.id FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id
       WHERE n.sent_at IS NULL AND n.group_id=$2
         AND ${lineNotificationTarget} AND n.last_error LIKE $3||'%' AND ${staleNotification}
       FOR UPDATE OF n SKIP LOCKED) s
     WHERE u.id=s.id`,
    [expiredNote, group, quotaShortPrefix],
  );
}

/** 讀本月推播上限與用量；這兩支 API 不計入推播額度。limit=null 代表方案沒有上限。 */
export async function fetchLineQuota(access: string) {
  const get = (path: string) =>
    fetchLine(`https://api.line.me/v2/bot/message/${path}`, {
      headers: { Authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(10000),
    });
  const [quota, consumption] = await Promise.all([
    get("quota"),
    get("quota/consumption"),
  ]);
  if (!quota.ok || !consumption.ok)
    throw new Error(
      `讀不到本月推播用量（${quota.ok ? consumption.status : quota.status}）`,
    );
  const q = (await quota.json().catch(() => null)) as {
    type?: unknown;
    value?: unknown;
  } | null;
  const used = (await consumption.json().catch(() => null)) as {
    totalUsage?: unknown;
  } | null;
  // 看不懂的回應不能當成「上限 0」：那會誤判額度用完、把推播整個停掉。
  const limit =
    q?.type === "none"
      ? null
      : q?.type === "limited" && typeof q.value === "number"
        ? q.value
        : undefined;
  if (limit === undefined || typeof used?.totalUsage !== "number")
    throw new Error("讀不到本月推播用量（LINE 回應格式不符）");
  return { limit, used: used.totalUsage };
}

/**
 * 查額度並更新 line_quota：有剩餘額度（或方案沒有上限）才解除暫停，解除前先清掉過時的通知；
 * 用完就維持（或開始）暫停。讀不到用量時不改變暫停狀態，只更新確認時間。
 */
export async function syncLineQuota(db: Database, access: string) {
  await withLinePushLock(db, () => refreshLineQuota(db, access));
}

async function refreshLineQuota(db: Database, access: string) {
  let usage: Awaited<ReturnType<typeof fetchLineQuota>>;
  try {
    usage = await fetchLineQuota(access);
  } catch (e) {
    // 暫停中維持「已用完（用量）」的說明；仍可推播時寫出查詢錯誤，但保留上次查到的用量，
    // 否則之後撞到上限時說明會少了用量。
    const last = await lineQuotaUsage(db);
    const error = redact(String(e));
    await db.query(
      "UPDATE service_health SET detail=CASE WHEN ok THEN $2 ELSE detail END,checked_at=now() WHERE name=$1",
      [
        LINE_QUOTA,
        last ? `${error}（上次查到${quotaUsageText(last)}）` : error,
      ],
    );
    return;
  }
  const text = quotaUsageText(usage);
  // 至少還有 1 則才解除整體暫停，之後群組按人數、私訊按保留比例判斷。
  if (usage.limit !== null && usage.used >= usage.limit) {
    await markQuotaExhausted(db, usage);
    return;
  }
  if (await lineQuotaBlocked(db))
    await db.transaction((c) => expireStaleNotifications(c));
  await recordHealth(db, LINE_QUOTA, true, text, { trackOutage: true });
}
