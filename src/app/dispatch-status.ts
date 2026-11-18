// 頁首的派工狀態。管理者看到的是可以切換的按鈕；一般成員不能切換，
// 只看狀態，文字不能出現「點此」，免得以為壞掉或沒有權限卻被叫去點。
export function dispatchStatus({
  paused,
  triagePaused,
  hold,
  admin,
}: {
  paused: boolean;
  triagePaused: boolean;
  /** 記憶體不足等原因自動暫停派工的說明；手動暫停時不看它。 */
  hold: string | null;
  admin: boolean;
}) {
  const label = paused
    ? "已暫停"
    : hold
      ? "派工自動暫停"
      : triagePaused
        ? "判讀暫停中"
        : "自動派工中";
  const state = paused
    ? "目前只接收訊息，不辨識與派工"
    : (hold ??
      (triagePaused
        ? "新需求判讀已暫停，已核准任務仍可執行"
        : "已確認修改與明確查詢會依序派工"));
  if (!admin)
    return { label, title: `${state}。切換由管理者在設定處理。` } as const;
  return {
    label,
    title: paused
      ? `${state}；點此開始`
      : hold
        ? hold
        : `${state}；點此暫停${triagePaused ? "派工" : ""}`,
    ariaLabel: paused ? "已暫停，點此開始自動派工" : "點此暫停派工",
  } as const;
}
