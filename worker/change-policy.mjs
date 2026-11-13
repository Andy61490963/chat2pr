// 同時提供開發提示與可信收集器使用，原始變更上限不可由專案修改。
export const MAX_CHANGE_FILES = 200;
export const MAX_CHANGE_BYTES = 10 * 1024 * 1024;
export const sourceVersionInstructions =
  "可信輸入 sourceVersion.baseCommit 才是來源遠端 SHA；容器 .git 是本機工作基底，git rev-parse HEAD 不能冒充遠端 SHA。內部驗收工具若需要本機 SHA，另外標為 localBaselineCommit；修改前後附件都要以 sourceCommit 記錄 sourceVersion.baseCommit，不要求容器具備遠端 Git 歷史。最終 before／PR head／merge 仍須由外部獨立工具驗證，不能在這次尚未建立 PR 的工作中宣稱完成。";

export const changeInstructions = `交付上限是全部變更合計 ${MAX_CHANGE_FILES} 個檔案、10 MiB（${MAX_CHANGE_BYTES} bytes），包含程式、圖片與報告；完成前請檢查檔數與原始大小，不能靠修改忽略規則或基底躲過收集。前端驗收仍要完整執行所要求的尺寸、資料及故障情境。完整矩陣 PNG、暫存伺服器與中介產物放在 /tmp；只把代表性真實截圖及完整但精簡的數值報告寫入 docs/。四種尺寸驗收通常提交每尺寸修改前／後各一張，共 8 張代表 PNG，保留圖中文字可讀性，避免重複複製整批截圖。數值報告須保留全部情境的斷言、失敗、量測、版本及截圖雜湊，不能刪掉失敗或只留成功結論。修改前須從可信基底取得，不能把相同畫面改檔名冒充前後。${sourceVersionInstructions}/tmp 會隨階段結束清除；若需求明定須永久保存全部原始截圖且無法在既有交付限制內完成，清楚回報衝突，不自行刪掉必要證據、略過驗收或提高上限。`;

/** 先檢查全部 metadata，通過才讀取檔案內容；失敗不刪除或裁切變更。 */
export function assertChangeLimits(files) {
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (files.length <= MAX_CHANGE_FILES && bytes <= MAX_CHANGE_BYTES) return;
  const reasons = [];
  if (files.length > MAX_CHANGE_FILES)
    reasons.push(`檔案數 ${files.length} 超過 ${MAX_CHANGE_FILES} 個檔案上限`);
  if (bytes > MAX_CHANGE_BYTES)
    reasons.push(
      `變更內容 ${bytes} bytes 超過 10 MiB（${MAX_CHANGE_BYTES} bytes）上限`,
    );
  const largest = files
    .filter((file) => file.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, 5)
    .map(
      (file) =>
        `${JSON.stringify(file.path.slice(0, 160))}：${file.bytes} bytes`,
    );
  throw new Error(
    `${reasons.join("；")}。全部變更合計 ${files.length} 個檔案、${bytes} bytes。${largest.length ? `最大 ${largest.length} 個檔案：${largest.join("；")}。` : ""}未刪除任何檔案、未發布。請保留完整數值報告與需求要求的代表截圖，將中介矩陣產物移出交付；不能略過必要驗收或提高限制。`,
  );
}
