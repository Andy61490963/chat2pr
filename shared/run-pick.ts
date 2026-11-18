/**
 * 任務詳情「執行紀錄」要顯示哪一次執行。
 *
 * `pinned` 為 null 代表跟隨最新（`runs[0]`，伺服器依開始時間新到舊排序）：
 * 重試後新執行插在最前面，畫面要自動切過去。使用者手動選了舊紀錄才固定在那次；
 * 固定的那次已不在清單裡（超過最近 50 次）時退回最新。
 */
export function pickRun<T extends { id: string }>(
  runs: readonly T[],
  pinned: string | null,
): T | undefined {
  return (pinned ? runs.find((r) => r.id === pinned) : undefined) ?? runs[0];
}

/** 下拉選單選到某次執行時的新 pinned：選回最新那一列就恢復跟隨。 */
export function pinFor(runs: readonly { id: string }[], id: string) {
  return id === runs[0]?.id ? null : id;
}
