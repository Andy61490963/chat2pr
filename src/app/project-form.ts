// 專案頁表單與狀態呈現用的純函式；不依賴 React，方便以單元測試確認判斷規則。
// tests/project-form.test.ts 直接 import 這個檔案，所以不能用 `@/` 路徑別名（vitest 不解析）。
import { isRepoNotice } from "../../shared/project-setup.js";
import type { Project } from "../../shared/types.js";

/**
 * validation_error 代表什麼：
 * - failed：沒有通過驗證、留有失敗原因（和「從未驗證」分開，管理者才知道要先看原因）。
 * - transient：已驗證的專案重新驗證遇到暫時性問題，validated_at 仍在，沿用先前的設定。
 * - notice：儲存庫接回後請重新驗證的提醒，不是失敗。
 * 等你回答與找不到儲存庫另有標示，這裡回 null。
 */
export function validationKind(
  p: Pick<
    Project,
    "setup_input" | "repo_missing_at" | "validated_at" | "validation_error"
  >,
): "failed" | "transient" | "notice" | null {
  if (p.setup_input || p.repo_missing_at || !p.validation_error) return null;
  if (isRepoNotice(p.validation_error)) return "notice";
  return p.validated_at ? "transient" : "failed";
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

/** 已被其他專案使用的儲存庫（不分大小寫，排除正在編輯的這筆）。 */
export function takenRepos(
  projects: { id: string; repo: string }[],
  editingId?: string | null,
): Set<string> {
  return new Set(
    projects.filter((p) => p.id !== editingId).map((p) => p.repo.toLowerCase()),
  );
}
