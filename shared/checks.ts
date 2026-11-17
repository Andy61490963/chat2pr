/**
 * 定期檢查：AI 或管理者寫好「怎麼檢查、怎樣算異常」，核准後由系統依排程執行，不再呼叫 AI。
 * 這裡是看板與伺服器共用的定義與純函式。
 */

export type CheckKind = "sql" | "http" | "tcp";
export type CheckStatus = "awaiting_approval" | "active" | "paused" | "failed";
export type CheckState = "unknown" | "ok" | "alert";
export type CheckNotify = "group" | "admin" | "both";

/** SQL 檢查的判定：取第一列的某個欄位（或回傳列數）與門檻比較；成立就是異常。 */
export interface SqlCondition {
  /** 欄位名稱；"$rows" 表示回傳的列數。 */
  column: string;
  op: ">" | ">=" | "<" | "<=" | "=" | "!=";
  value: number | string;
  /** 異常時列在通知中的欄位（例如機台編號），最多 10 筆。 */
  listColumn?: string;
}
/** HTTP 檢查：非 2xx 或逾時就是異常；有 contains 時，回應內容不含該字也算異常。 */
export interface HttpCondition {
  contains?: string;
}
export type CheckCondition =
  SqlCondition | HttpCondition | Record<string, never>;

export interface ScheduledCheck {
  id: string;
  group_id: string;
  project_id: string | null;
  name: string;
  kind: CheckKind;
  target: string;
  condition: CheckCondition;
  interval_minutes: number | null;
  daily_at: string | null;
  notify: CheckNotify;
  quiet_from: string | null;
  quiet_to: string | null;
  alert_text: string;
  recovered_text: string;
  rationale: string;
  investigate: boolean;
  status: CheckStatus;
  version: number;
  approved_version: number | null;
  approved_by: string | null;
  state: CheckState;
  consecutive_errors: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_investigated_at: string | null;
  source_task_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckRunView {
  id: number;
  version: number;
  started_at: string;
  duration_ms: number;
  outcome: "ok" | "alert" | "error";
  summary: string;
}

/** 最短間隔：避免檢查太頻繁拖垮資料庫或吃光推播額度。 */
export const minIntervalMinutes = 15;

const forbiddenSql =
  /\b(insert|update|delete|merge|exec|execute|drop|alter|create|truncate|grant|revoke|deny|backup|restore|shutdown|dbcc|openrowset|opendatasource|openquery|bulk|waitfor|use|declare|set|into)\b|xp_|sp_/i;

/**
 * SQL 檢查只允許單一 SELECT（或 WITH … SELECT）。
 * 拒絕多個語句、寫入、執行程序、SELECT INTO、暫存表與動態連線；執行時另外包在一定回滾的交易中。
 */
export function assertReadOnlySelect(sql: string): string | null {
  const text = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (!text) return "請填寫 SQL";
  if (text.length > 4000) return "SQL 太長，請在 4,000 字內";
  if (!/^(select|with)\b/i.test(text)) return "只能使用 SELECT 查詢";
  if (text.includes(";")) return "只能有一個查詢語句";
  if (/#\w/.test(text)) return "不能使用暫存表";
  const hit = forbiddenSql.exec(text.replace(/'[^']*'/g, "''"));
  if (hit) return `不能使用「${hit[0]}」，檢查只能讀取資料`;
  return null;
}

/** 「HH:MM」臺北時間。 */
const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isTime = (v: string) => hhmm.test(v);

/** 簡單的中文數字（一～九十九）或阿拉伯數字轉成整數。 */
function toNumber(v: string): number | null {
  if (/^\d+$/.test(v)) return Number(v);
  const digit: Record<string, number> = {
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const m = /^([一二兩三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(v);
  if (!m || !v) return null;
  if (!m[2]) return m[3] || !m[1] ? null : digit[m[1]];
  return (m[1] ? digit[m[1]] : 1) * 10 + (m[3] ? digit[m[3]] : 0);
}

/**
 * 從回答補問的文字讀出排程，例如「每 15 分鐘」「每兩小時」「每天 08:30」「每天下午三點半」。
 * 讀不出來或短於最短間隔時回傳 null，交由管理者在看板設定。
 */
export function parseSchedule(
  text: string,
): { intervalMinutes: number | null; dailyAt: string | null } | null {
  const s = text.replace(/\s+/g, "");
  const num = "(\\d+|[一二兩三四五六七八九十]+)";
  const interval = (minutes: number | null) =>
    minutes !== null && minutes >= minIntervalMinutes && minutes <= 10080
      ? { intervalMinutes: minutes, dailyAt: null }
      : null;
  if (/每(個)?半(個)?(小時|鐘頭)/.test(s)) return interval(30);
  let m = new RegExp(`每(?:隔)?${num}(?:個)?(分鐘|分|小時|鐘頭)`).exec(s);
  if (m) {
    const n = toNumber(m[1]);
    return interval(n === null ? null : m[2].startsWith("分") ? n : n * 60);
  }
  if (/每(個)?(小時|鐘頭)/.test(s)) return interval(60);
  m =
    /每(?:天|日)(?:的)?(凌晨|早上|上午|中午|下午|晚上)?(\d{1,2}):(\d{2})/.exec(
      s,
    );
  const daily = (period: string | undefined, h: number | null, min: number) => {
    if (h === null || h > 23 || min > 59) return null;
    const hour =
      (period === "下午" || period === "晚上") && h < 12
        ? h + 12
        : period === "中午" && h < 11
          ? h + 12
          : h;
    if (hour > 23) return null;
    return {
      intervalMinutes: null,
      dailyAt: `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
    };
  };
  if (m) return daily(m[1], Number(m[2]), Number(m[3]));
  m = new RegExp(
    `每(?:天|日)(?:的)?(凌晨|早上|上午|中午|下午|晚上)?${num}點(半|${num}分)?`,
  ).exec(s);
  if (m) {
    const min = !m[3] ? 0 : m[3] === "半" ? 30 : toNumber(m[4]);
    return min === null ? null : daily(m[1], toNumber(m[2]), min);
  }
  return null;
}

/** 補問是不是在問檢查頻率（多久一次、幾點檢查）。 */
export const asksForSchedule = (question: string) =>
  /多久|頻率|間隔|每隔|幾分鐘|幾小時|什麼時間|什麼時候|幾點/.test(question);

/** 臺北時間的分鐘數（0～1439）。 */
function taipeiMinutes(d: Date) {
  const t = new Date(d.getTime() + 8 * 3600000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

/** 下次執行時間：固定間隔從上次執行起算；每日時間則取下一個臺北時間的該時刻。 */
export function nextRunAt(
  c: Pick<ScheduledCheck, "interval_minutes" | "daily_at">,
  from: Date,
): Date {
  if (c.interval_minutes)
    return new Date(
      from.getTime() + Math.max(minIntervalMinutes, c.interval_minutes) * 60000,
    );
  const m = hhmm.exec(c.daily_at ?? "");
  if (!m) throw new Error("排程設定不正確");
  const target = Number(m[1]) * 60 + Number(m[2]);
  const now = taipeiMinutes(from);
  let delta = target - now;
  if (delta <= 0) delta += 1440;
  const next = new Date(from.getTime() + delta * 60000);
  next.setUTCSeconds(0, 0);
  return next;
}

/** 是否在靜音時段（臺北時間；可跨午夜）。 */
export function inQuietHours(
  c: Pick<ScheduledCheck, "quiet_from" | "quiet_to">,
  at: Date,
) {
  if (!c.quiet_from || !c.quiet_to) return false;
  const [f, t] = [c.quiet_from, c.quiet_to].map((v) => {
    const m = hhmm.exec(v);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  });
  if (f < 0 || t < 0 || f === t) return false;
  const now = taipeiMinutes(at);
  return f < t ? now >= f && now < t : now >= f || now < t;
}

const compare = (left: unknown, op: SqlCondition["op"], right: unknown) => {
  const l = Number(left),
    r = Number(right);
  const numeric = !Number.isNaN(l) && !Number.isNaN(r) && left !== null;
  const a = numeric ? l : String(left ?? ""),
    b = numeric ? r : String(right ?? "");
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case "=":
      return a === b;
    case "!=":
      return a !== b;
  }
};

/**
 * 在查詢結果的欄位中找出指定欄位：先精確比對，沒有再不分大小寫比對（恰好一個符合才算）。
 * SQL Server 回傳的欄位保留 SELECT 別名的大小寫，常和判定設定的大小寫不同。
 */
function resolveColumn(row: Record<string, unknown>, column: string) {
  if (Object.prototype.hasOwnProperty.call(row, column)) return column;
  const lower = column.toLowerCase();
  const hits = Object.keys(row).filter((k) => k.toLowerCase() === lower);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * SQL 結果判定：回傳是否異常與一句摘要（不含機密，最多列 10 筆）。
 * 有回傳資料、卻找不到判定欄位時丟出錯誤（試跑顯示執行失敗、排程計入錯誤），
 * 不再把找不到的欄位當成空值判定，以免監看靜默失效或一直誤報。
 */
export function evaluateSql(
  condition: SqlCondition,
  rows: Record<string, unknown>[],
): { alert: boolean; summary: string } {
  let column = condition.column;
  if (column !== "$rows" && rows.length > 0) {
    const found = resolveColumn(rows[0], column);
    if (found === null) {
      const keys = Object.keys(rows[0]);
      throw new Error(
        `查詢結果沒有欄位「${column}」，可用欄位：${keys.length ? keys.slice(0, 10).join("、") + (keys.length > 10 ? "…" : "") : "（無）"}（請修改判定欄位或 SELECT 別名）`,
      );
    }
    column = found;
  }
  const value = column === "$rows" ? rows.length : rows[0]?.[column];
  const alert = compare(value, condition.op, condition.value);
  // 列出欄位只影響通知內容；找不到時只提示，不讓它擋下整個檢查。
  const listColumn =
    condition.listColumn && rows.length > 0
      ? resolveColumn(rows[0], condition.listColumn)
      : (condition.listColumn ?? null);
  const listed = listColumn
    ? rows
        .map((r) => r[listColumn])
        .filter((v) => v !== null && v !== undefined)
        .slice(0, 10)
        .map((v) => String(v).slice(0, 40))
    : [];
  const missingList =
    condition.listColumn && rows.length > 0 && listColumn === null
      ? `（找不到列出欄位「${condition.listColumn}」）`
      : "";
  const label = condition.column === "$rows" ? "筆數" : condition.column;
  return {
    alert,
    summary: `${label}=${value === undefined ? "（無資料）" : String(value).slice(0, 80)}${listed.length ? `：${listed.join("、")}${rows.length > 10 ? "…" : ""}` : ""}${missingList}`,
  };
}

/**
 * 主機端暫時無法執行（執行器連不上、檢查環境建立失敗或啟動逾時）時，執行紀錄摘要的開頭。
 * 這類錯誤不計入連續失敗；看板用這個開頭辨認。不改資料表，仍記為 outcome='error'。
 */
export const hostUnavailablePrefix = "系統暫時無法執行（不計入連續失敗）：";
/** 主機端連續無法執行超過幾小時要提醒管理者處理（仍不暫停檢查）。 */
export const hostUnavailableAlertHours = 6;

/** 主機端暫時無法執行時的重試間隔（分鐘）：第 1、2、3 次 5／15／30 分鐘，之後 60 分鐘。 */
export function hostRetryMinutes(streak: number) {
  return [5, 15, 30][Math.max(0, streak - 1)] ?? 60;
}
