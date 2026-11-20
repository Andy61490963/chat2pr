import type { Project } from "./types.js";
import type { InstallReview } from "./install-plan.js";

/** 自動設定的依據及實際驗證方式；手動指令獨立保存，不被 AI 覆寫。 */
export interface SetupPlan {
  branch: string;
  sha: string;
  fingerprint: string;
  configVersion: number;
  install: string;
  test: string;
  verification: "tests" | "partial" | "build" | "needs_input";
  /** 測試用資料庫的來源；不需要資料庫時為 none。舊設定沒有這個欄位。 */
  dataSource?: "project" | "snapshot" | "inferred" | "none";
  /** 部分測試或推測結構時，沒有涵蓋到的範圍。 */
  limitations?: string;
  explanation: string;
  /** 只提供摘錄或略過的檔案與原因（系統記錄）；舊設定沒有這個欄位。 */
  omissions?: { path: string; reason: string }[];
  evidence: { path: string; quote: string }[];
  /** 測試需要 SQL Server 時的映像與判斷依據；不需要時沒有這個欄位。 */
  sqlServer?: SqlServerPlan;
  /** 工作映像缺少的系統套件與安裝前審查結果；不需要時沒有這個欄位。 */
  systemInstall?: InstallReview;
}

/**
 * 測試階段由系統在工作容器內啟動 SQL Server，並把 LocalDB 連線暫時導向它。
 * source=detected 是從專案檔與 CI 判斷，admin 是管理者在進階設定選「一律提供」。
 */
export interface SqlServerPlan {
  image: string;
  source: "detected" | "admin";
  reasons: { path: string; quote: string }[];
}

type Verified = Pick<SetupPlan, "verification" | "dataSource" | "limitations">;

const inferredCaution =
  "測試用的資料庫結構由 AI 推測，登記資料庫連線並擷取結構快照可提高可信度。";

/** 驗證結果的白話標示：看板狀態、專案詳情與 PR 共用，避免把部分驗證呈現成完整驗證。 */
export function verificationLabel(plan: Verified | null | undefined): {
  status: string;
  caution: string | null;
} {
  // 部分驗證與只有建置時也要說出結構是推測的：測試範圍被縮小，常常就是因為缺少真實資料庫，
  // 這時最需要提醒管理者登記資料庫連線。
  const inferred = plan?.dataSource === "inferred";
  const mark = (status: string, caution: string) =>
    inferred
      ? {
          status: `${status}（資料庫結構由 AI 推測）`,
          caution: `${caution}${/[。！？.!?]$/.test(caution) ? "" : "。"}${inferredCaution}`,
        }
      : { status, caution };
  if (plan?.verification === "build")
    return mark("建置通過；未執行自動測試", "僅確認可建置，未執行自動測試。");
  if (plan?.verification === "partial")
    return mark(
      "部分測試通過；AI 依環境限制縮小了測試範圍",
      `只執行了部分測試。未涵蓋：${plan.limitations?.trim() || "AI 未說明"}`,
    );
  if (plan?.dataSource === "inferred")
    return {
      status: "安裝與測試通過（資料庫結構由 AI 推測）",
      caution:
        "測試用的資料庫結構是 AI 從程式碼推測的，可能和真實資料庫不同。登記資料庫連線並擷取結構快照可提高可信度。",
    };
  if (plan?.dataSource === "snapshot")
    return { status: "安裝與測試通過（資料庫以結構快照模擬）", caution: null };
  return { status: "安裝與測試通過", caution: null };
}

/**
 * 儲存庫接回後寫進 validation_error 的提醒（server/repo-missing.ts）。這是「請重新驗證」的提示，
 * 不是驗證失敗；看板靠這兩句分辨，不能標成「驗證失敗」。
 */
export const repoNotice = {
  found:
    "GitHub 上又找得到這個儲存庫了；請重新驗證環境，再到群組重新勾選這個專案。",
  changed: "儲存庫已接回，但這段期間改過設定；請重新驗證環境後再啟用。",
} as const;

export const isRepoNotice = (text: string | null | undefined) =>
  text === repoNotice.found || text === repoNotice.changed;

/** 詳情側欄驗證按鈕的文字；存檔後提示重試時也用同一個名稱，管理者才找得到。 */
export function validateLabel(
  p: Pick<Project, "repo_missing_at" | "setup_mode">,
): string {
  if (p.repo_missing_at) return "重新檢查";
  return p.setup_mode === "auto" ? "AI 自動設定並驗證" : "驗證環境";
}
