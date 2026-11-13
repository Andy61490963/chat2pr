/** Git 分支名稱；保留中文與斜線，不接受 SHA、標籤路徑或特殊修訂語法。 */
export function validTargetBranch(name: string) {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    name !== "@" &&
    !name.startsWith("-") &&
    !name.startsWith("refs/") &&
    !/[\x00-\x20\x7f~^:?*\[\\]/u.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    name
      .split("/")
      .every(
        (part) =>
          !!part &&
          !part.startsWith(".") &&
          !part.endsWith(".") &&
          !part.endsWith(".lock"),
      )
  );
}
export interface BranchCatalog {
  names: string[];
  defaultBranch: string;
  truncated: boolean;
}
export interface BranchDecision {
  name: string | null;
  basis: "default" | "explicit" | "uncertain";
  reason: string;
  evidence: { sourceId: string; quote: string }[];
}
export interface TaskBranchSelection {
  basis: "default" | "explicit" | "uncertain" | "manual";
  reason: string;
  sourceIds: string[];
}
