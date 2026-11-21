// 專案頁表單與狀態呈現用的純函式；不依賴 React，方便以單元測試確認判斷規則。
// tests/project-form.test.ts 直接 import 這個檔案，所以不能用 `@/` 路徑別名（vitest 不解析）。
export { validateLabel, validationKind } from "../../shared/project-setup.js";
import { validateLabel, validationKind } from "../../shared/project-setup.js";
import type { Project } from "../../shared/types.js";

export function projectVerification(p: Project) {
  if (p.validation_progress) return "validating";
  if (p.repo_missing_at || validationKind(p) === "failed") return "failed";
  if (!p.validated_at || p.setup_input) return "unverified";
  // 重新驗證暫時失敗時，仍以先前通過的驗證範圍為準。
  const plan = p.setup_mode === "auto" ? p.setup_plan : null;
  if (plan?.verification === "partial" || plan?.verification === "build")
    return "partial";
  if (p.setup_mode !== "auto" && !p.test_command.trim()) return "partial";
  return "passed";
}

/** 連接埠欄位的檢查：空值或不是 1–65535 的整數時回傳提示，不能讓空值被當成 0 送出。 */
export function portError(value: string, label = "連接埠"): string {
  const v = value.trim();
  if (!v) return `${label}不可空白，請填 1–65535 的整數`;
  if (!/^\d+$/.test(v)) return `${label}請填 1–65535 的整數`;
  const n = Number(v);
  return n >= 1 && n <= 65535 ? "" : `${label}請填 1–65535 的整數`;
}

/**
 * 把驗證失敗的摘要拆成：第一行（重點）、說明、可收合的錯誤重點，以及建議。
 * 伺服器的格式是「分類：白話說明。\n錯誤重點：…\n建議：…。」；不是這個格式時照原文分行顯示。
 */
export function validationErrorParts(text: string): {
  headline: string;
  body: string[];
  detail: string[];
  advice: string[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const [headline = "", ...rest] = lines;
  const body: string[] = [];
  const detail: string[] = [];
  const advice: string[] = [];
  let inDetail = false;
  for (const line of rest) {
    if (/^建議[：:]/.test(line)) {
      inDetail = false;
      advice.push(line);
    } else if (/^錯誤重點[：:]/.test(line)) {
      inDetail = true;
      const value = line.replace(/^錯誤重點[：:]\s*/, "");
      if (value) detail.push(value);
    } else (inDetail ? detail : advice.length ? advice : body).push(line);
  }
  return { headline, body, detail, advice };
}

/** 專案表單裡會影響環境驗證的欄位（存檔後伺服器會清掉驗證結果、停用派工）。 */
export type ProjectFormFields = {
  repo: string;
  base_branch: string;
  image: string;
  setup_mode: string;
  sql_server: string;
  install_command: string;
  test_command: string;
  sensitive_paths: string;
  index_paths: string[];
};

/**
 * 既有專案改了執行設定或索引範圍：存檔後要重新驗證才能派工。
 * 只改名稱、說明或收集排除規則不算，與 server/app.ts 的 PUT /api/projects/:id 判斷一致。
 */
export function configChanged(
  p: Partial<Project>,
  form: ProjectFormFields,
): boolean {
  return (
    !!p.id &&
    (form.repo !== p.repo ||
      form.base_branch !== p.base_branch ||
      form.image !== p.image ||
      form.setup_mode !== (p.setup_mode ?? "manual") ||
      form.sql_server !== (p.sql_server ?? "auto") ||
      form.install_command !== p.install_command ||
      form.test_command !== p.test_command ||
      form.sensitive_paths !== (p.sensitive_paths?.join("\n") ?? "") ||
      JSON.stringify(form.index_paths) !== JSON.stringify(p.index_paths ?? []))
  );
}

/** 表單底部要不要提供「儲存並驗證環境」：新增專案，或改了需要重新驗證的設定。 */
export function offersValidation(
  p: Partial<Project>,
  form: ProjectFormFields,
): boolean {
  return !p.id || configChanged(p, form);
}

/**
 * 存檔後不自動驗證的原因；可以驗證時回 null。
 * 等你回答（setup_input）與詳情驗證按鈕的停用條件相同；找不到儲存庫的專案要先在詳情「重新檢查」或改選位置。
 */
export function autoValidateBlocked(
  p: Pick<Project, "setup_input" | "repo_missing_at">,
): string | null {
  if (p.repo_missing_at)
    return "GitHub 上仍找不到這個儲存庫，請在詳情按「重新檢查」或改選位置後再驗證";
  if (p.setup_input) return "AI 自動設定還在等你回答問題，請先在詳情回答";
  return null;
}

type SaveRequest = <T>(
  url: string,
  method?: string,
  body?: unknown,
) => Promise<T>;

/**
 * 儲存專案；validate 為真時，存檔成功後才排入環境驗證（走既有的佇列、鎖、預算與 config_version 檢查）。
 * 驗證沒排上不算儲存失敗：回傳存好的專案與要顯示的提示，呼叫端照樣關表單、打開詳情。
 * 存檔本身失敗時照常丟出錯誤，表單保持開著。
 */
export async function saveProject(
  request: SaveRequest,
  id: string | undefined,
  body: unknown,
  validate: boolean,
): Promise<{ saved: Project; notice: { text: string; error?: boolean } }> {
  const saved = await request<Project>(
    id ? `/api/projects/${id}` : "/api/projects",
    id ? "PUT" : "POST",
    body,
  );
  if (!validate) return { saved, notice: { text: "專案已儲存" } };
  const blocked = autoValidateBlocked(saved);
  if (blocked) return { saved, notice: { text: `專案已儲存；${blocked}` } };
  try {
    await request(`/api/projects/${saved.id}/validate`, "POST");
  } catch (e) {
    const reason = String(e)
      .replace(/^Error: /, "")
      .replace(/[。.]+$/, "");
    return {
      saved,
      notice: {
        error: true,
        text: `專案已儲存，但驗證沒有排上：${reason}，可在詳情按「${validateLabel(saved)}」重試`,
      },
    };
  }
  return {
    saved,
    notice: { text: "專案已儲存，已開始驗證環境，通過後會自動啟用派工" },
  };
}

/** 選儲存庫清單的三種狀態：載入中、讀取失敗（附伺服器原因）、成功（可能是空清單）。 */
export function repoListStatus(
  repos: unknown[] | null,
  error: string,
): { placeholder: string; error: string | null; empty: boolean } {
  if (error)
    return {
      placeholder: "無法取得儲存庫清單",
      error: `無法取得儲存庫清單：${error}`,
      empty: false,
    };
  if (!repos) return { placeholder: "載入中…", error: null, empty: false };
  return {
    placeholder: "選擇已安裝 GitHub App 的儲存庫",
    error: null,
    empty: repos.length === 0,
  };
}

/** 已被其他專案使用的儲存庫（不分大小寫，排除正在編輯的這筆）。 */
export function takenRepos(
  projects: { id: string; repo: string }[],
  editingId?: string | null,
): Set<string> {
  return new Set(
    projects.filter((p) => p.id !== editingId).map((p) => p.repo.toLowerCase()),
  );
}
