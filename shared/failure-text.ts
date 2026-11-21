import { reservedQuotaHold } from "./subscription-quota.js";

/**
 * 看板拆解任務失敗說明（`tasks.last_error`）用的純函式。
 *
 * 失敗說明由 `server/failure.ts` 的 `failureNotice` 組成，格式固定為：
 *
 * ```
 * 分類標籤（X階段）：白話說明（已自動重試一次，仍然失敗）。
 * 錯誤重點：…（可能多行）
 * 建議：建議處理。
 * ```
 *
 * 「（X階段）」「（已自動重試…）」與「錯誤重點」段都可能沒有。
 * 改了 `failureNotice` 的格式或 `categoryLabels` 的標籤，這裡要一起改
 * （`tests/failure-text.test.ts` 會拿 `failureNotice` 的實際輸出比對）。
 * 標籤刻意在這裡另存一份，看板不 import 伺服器程式。
 */

export type FailureCategory =
  "transient" | "environment" | "project" | "config" | "system";

/** 與 `server/failure.ts` 的 `categoryLabels` 相同。 */
export const failureLabels: Record<FailureCategory, string> = {
  transient: "暫時性問題",
  environment: "環境問題",
  project: "專案問題",
  config: "設定問題",
  system: "系統問題",
};

export interface ParsedFailure {
  category: FailureCategory;
  /** 第一行去掉句號：「設定問題（測試階段）：缺少必要的連線或憑證設定」。 */
  headline: string;
  /** 白話說明（不含分類標籤）。 */
  plain: string;
  /** 錯誤重點；沒有時為空字串。 */
  detail: string;
  /** 建議處理（不含「建議：」與句尾句號）。 */
  action: string;
}

const actionLine = /\n建議：([^\n]+)$/;
const detailMark = "\n錯誤重點：";

/** 拆解失敗說明；不是 `failureNotice` 格式（舊資料、「AI 等你回答」等）時回傳 null。 */
export function parseFailure(
  lastError: string | null | undefined,
): ParsedFailure | null {
  if (!lastError) return null;
  const text = lastError.replace(/^Error: /, "").trimEnd();
  const tail = text.match(actionLine);
  if (!tail || tail.index === undefined) return null;
  const head = text.slice(0, tail.index);
  const firstBreak = head.indexOf("\n");
  const first = firstBreak < 0 ? head : head.slice(0, firstBreak);
  const rest = firstBreak < 0 ? "" : head.slice(firstBreak);
  const category = (Object.keys(failureLabels) as FailureCategory[]).find((c) =>
    first.startsWith(failureLabels[c]),
  );
  if (!category) return null;
  const label = first.match(/^[^：]{1,40}：/);
  if (!label) return null;
  const headline = first.replace(/。$/, "");
  const plain = headline.slice(label[0].length);
  if (rest && !rest.startsWith(detailMark)) return null;
  return {
    category,
    headline,
    plain,
    detail: rest ? rest.slice(detailMark.length).trim() : "",
    action: tail[1].trim().replace(/。$/, ""),
  };
}

/** 失敗說明裡最該顯示的一句：可解析時是白話說明，否則是第一行。 */
export function failureBrief(lastError: string | null | undefined) {
  if (!lastError) return "";
  return (
    parseFailure(lastError)?.plain ??
    lastError.replace(/^Error: /, "").split("\n")[0]
  );
}

/**
 * 重試大概也會一樣失敗、要先改設定的分類：主按鈕不放「重試」。
 * 暫時性問題與系統問題（含無法解析）重試合理，維持「重試」為主按鈕。
 */
export const fixFirst = (category: FailureCategory | undefined) =>
  category === "config" || category === "environment" || category === "project";

/** 看板上可以直接前往的頁面。 */
export type FixPage = "projects" | "settings" | "system" | "groups";

const pages: [FixPage, RegExp][] = [
  ["projects", /專案頁/],
  ["settings", /「設定」|設定頁/],
  ["system", /「系統|系統頁/],
  ["groups", /群組頁/],
];

/** 建議文字指向的頁面（取最先提到的那一個）；沒有指向任何頁面時為 null。 */
export function fixPage(text: string | null | undefined): FixPage | null {
  if (!text) return null;
  let best: { page: FixPage; at: number } | null = null;
  for (const [page, pattern] of pages) {
    const at = text.search(pattern);
    if (at >= 0 && (!best || at < best.at)) best = { page, at };
  }
  return best?.page ?? null;
}

export const fixPageLabels: Record<FixPage, string> = {
  projects: "前往專案設定",
  settings: "前往設定",
  system: "前往系統頁",
  groups: "前往群組設定",
};

/**
 * 失敗卡片的主動作（收件匣與任務詳情共用）：
 * - retry：主按鈕「重試」。
 * - amend：主按鈕「縮小需求範圍」，打開補充需求編輯；重試留作次要。
 * - page：主按鈕前往建議指向的頁面（只有管理者看得到，成員改用「詳情」）。
 * - detail：要先處理，但建議沒有指向任何頁面，主按鈕是「詳情」。
 */
export type PrimaryFix =
  | { kind: "retry" }
  | { kind: "amend" }
  | { kind: "page"; page: FixPage }
  | { kind: "detail" };

/** 「執行期間任務、群組或專案的設定被變更」：確認後直接重試就是主要動作。 */
const changedDuringRun = /執行期間.*設定被變更/;
/** 「工作沒有在單次執行的時間限制內完成」：建議首要是縮小需求範圍，不是去改設定。 */
const timedOut = /時間限制/;

export function primaryFix(parsed: ParsedFailure | null): PrimaryFix {
  if (!parsed) return { kind: "retry" };
  if (changedDuringRun.test(parsed.plain)) return { kind: "retry" };
  if (timedOut.test(parsed.plain)) return { kind: "amend" };
  if (!fixFirst(parsed.category)) return { kind: "retry" };
  const page = fixPage(parsed.action);
  return page ? { kind: "page", page } : { kind: "detail" };
}

/**
 * 等待額度（budget_wait）的恢復說明：依保留原因說明什麼時候會自動繼續。
 * `lastError` 是伺服器保留工作時寫入的原因，`aiMode` 是目前的 AI 模式。
 */
export function waitHint(
  lastError: string | null | undefined,
  aiMode: "api" | "subscription",
) {
  if (lastError?.includes("今日執行次數"))
    return "今日執行次數已用完：臺北時間午夜後，或管理者提高每日次數後自動繼續。";
  if (aiMode === "api") return "API 模式預估額度不足：臺北時間隔日自動繼續。";
  if (lastError?.replace(/^Error: /, "").startsWith(reservedQuotaHold))
    return null;
  // 訂閱額度查不到（網路或登入問題）時伺服器也會保留工作，這時不是額度用完。
  if (lastError?.includes("無法確認"))
    return "暫時無法確認 Codex 訂閱額度：系統會定期重新檢查，確認可用後自動繼續。";
  return "Codex 訂閱額度已達上限：額度恢復後自動繼續。";
}
