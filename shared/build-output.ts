// 收集差異時自動排除的建置產物。比對規則實作在 worker/change-policy.mjs；
// 這裡只決定清單，伺服器把算好的完整清單交給收集器。

/** 預設排除清單；專案可在進階設定以「名稱/」加入、以「!名稱/」移除。 */
export const DEFAULT_COLLECT_EXCLUDES = [
  // .NET
  "bin/",
  "obj/",
  "TestResults/",
  // 前端
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  // Python
  "__pycache__/",
  ".pytest_cache/",
  "*.pyc",
] as const;

export const MAX_COLLECT_EXCLUDES = 50;

/**
 * 一條規則：`名稱/` 是任何層的同名目錄，`a/b/` 是從儲存庫根目錄起的目錄，
 * 不含 `/` 的是任何層的檔名，含 `/` 的是從根目錄起的路徑；`*` 比對同一層內的任意字元。
 * 開頭 `!` 表示從預設清單移除。不接受跳層、反斜線、絕對路徑與其他萬用字元。
 */
export function validCollectExclude(entry: string) {
  const rule = entry.startsWith("!") ? entry.slice(1) : entry;
  if (!rule || rule.length > 200 || /[\\?[\]!\s]/.test(rule)) return false;
  if (rule.startsWith("/")) return false;
  const parts = rule.replace(/\/$/, "").split("/");
  return parts.every(
    (p) => p && p !== "." && p !== ".." && p.toLowerCase() !== ".git",
  );
}

/** 預設清單套用專案的增減；結果去重並維持預設在前的順序。 */
export function effectiveCollectExcludes(adjustments: readonly string[] = []) {
  const list: string[] = [...DEFAULT_COLLECT_EXCLUDES];
  for (const raw of adjustments) {
    const entry = raw.trim();
    if (!validCollectExclude(entry)) continue;
    if (entry.startsWith("!")) {
      const removed = entry.slice(1);
      for (let i = list.indexOf(removed); i >= 0; i = list.indexOf(removed))
        list.splice(i, 1);
    } else if (!list.includes(entry)) list.push(entry);
  }
  return list;
}

/** 收集器回報的排除摘要：依目錄（或檔名規則）分組，最多列 30 組。 */
export interface ExcludedSummary {
  files: number;
  bytes: number;
  totalGroups: number;
  groups: Array<{ path: string; rule: string; files: number; bytes: number }>;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 一行摘要，給任務紀錄使用。 */
export function excludedSummary(e: ExcludedSummary, limit = 10) {
  const shown = e.groups
    .slice(0, limit)
    .map((g) => `${g.path}（${g.files} 個檔案）`);
  const rest = e.totalGroups - shown.length;
  return `共 ${e.files} 個檔案、${formatBytes(e.bytes)}：${shown.join("、")}${rest > 0 ? `，另有 ${rest} 組` : ""}`;
}
