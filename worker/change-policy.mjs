// 同時提供開發提示與可信收集器使用，原始變更上限不可由專案修改。
export const MAX_CHANGE_FILES = 200;
export const MAX_CHANGE_BYTES = 10 * 1024 * 1024;
export const sourceVersionInstructions =
  "可信輸入 sourceVersion.baseCommit 才是來源遠端 SHA；容器 .git 是本機工作基底，git rev-parse HEAD 不能冒充遠端 SHA。內部驗收工具若需要本機 SHA，另外標為 localBaselineCommit；修改前後附件都要以 sourceCommit 記錄 sourceVersion.baseCommit，不要求容器具備遠端 Git 歷史。最終 before／PR head／merge 仍須由外部獨立工具驗證，不能在這次尚未建立 PR 的工作中宣稱完成。";

export const changeInstructions = `交付上限是全部變更合計 ${MAX_CHANGE_FILES} 個檔案、10 MiB（${MAX_CHANGE_BYTES} bytes），包含程式、圖片與報告；完成前請檢查檔數與原始大小，不能靠修改忽略規則或基底躲過收集。前端驗收仍要完整執行所要求的尺寸、資料及故障情境。完整矩陣 PNG、暫存伺服器與中介產物放在 /tmp；只把代表性真實截圖及完整但精簡的數值報告寫入 docs/。四種尺寸驗收通常提交每尺寸修改前／後各一張，共 8 張代表 PNG，保留圖中文字可讀性，避免重複複製整批截圖。數值報告須保留全部情境的斷言、失敗、量測、版本及截圖雜湊，不能刪掉失敗或只留成功結論。修改前須從可信基底取得，不能把相同畫面改檔名冒充前後。${sourceVersionInstructions}/tmp 會隨階段結束清除；若需求明定須永久保存全部原始截圖且無法在既有交付限制內完成，清楚回報衝突，不自行刪掉必要證據、略過驗收或提高上限。`;

/**
 * 收集時排除的規則，由伺服器依專案設定算好後傳入；語意見 shared/build-output.ts。
 * 只套用在基底沒有追蹤的新檔案。
 */
export function compileExcludes(patterns = []) {
  if (!Array.isArray(patterns) || patterns.length > 100)
    throw new Error("排除清單格式不合法");
  return patterns.map((rule) => {
    if (
      typeof rule !== "string" ||
      !rule ||
      rule.length > 200 ||
      rule.startsWith("/") ||
      /[\\?[\]!\s]/.test(rule)
    )
      throw new Error("排除清單格式不合法");
    const directory = rule.endsWith("/"),
      parts = rule.replace(/\/$/, "").split("/");
    if (parts.some((p) => !p || p === "." || p === ".."))
      throw new Error("排除清單格式不合法");
    return {
      rule,
      directory,
      anchored: parts.length > 1,
      parts: parts.map(
        (p) =>
          new RegExp(
            `^${p.replace(/[.+^${}()|]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
          ),
      ),
    };
  });
}

/** 回傳符合的規則與摘要用的群組（目錄規則是該目錄，檔名規則是所在目錄加規則）。 */
export function matchExclude(file, rules) {
  const segments = file.split("/");
  for (const r of rules) {
    if (r.directory) {
      const at = r.anchored
        ? segments.length > r.parts.length &&
          r.parts.every((re, i) => re.test(segments[i]))
          ? r.parts.length - 1
          : -1
        : segments.slice(0, -1).findIndex((s) => r.parts[0].test(s));
      if (at >= 0)
        return {
          rule: r.rule,
          group: `${segments.slice(0, at + 1).join("/")}/`,
          directory: true,
        };
      continue;
    }
    const hit = r.anchored
      ? segments.length === r.parts.length &&
        r.parts.every((re, i) => re.test(segments[i]))
      : r.parts[0].test(segments.at(-1));
    if (hit) {
      const dir = segments.slice(0, -1).join("/");
      return {
        rule: r.rule,
        group: r.anchored ? file : `${dir ? `${dir}/` : ""}${r.rule}`,
        directory: false,
      };
    }
  }
  return null;
}

// 超過上限時判斷「像不像建置產物」，只用來給建議，不會自動排除。
const BUILD_DIRECTORIES = new Set([
  "bin",
  "obj",
  "testresults",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  "out",
  "target",
  ".gradle",
  ".vs",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".angular",
  "artifacts",
]);
const BUILD_EXTENSIONS =
  /\.(dll|exe|pdb|so|dylib|o|a|lib|class|jar|war|pyc|nupkg|snupkg|whl|tsbuildinfo|cache|map)$/i;

/** 像建置產物時回傳建議加入排除清單的規則，否則回傳 null。 */
export function buildOutputHint(file) {
  const segments = file.split("/");
  const dir = segments
    .slice(0, -1)
    .find((segment) => BUILD_DIRECTORIES.has(segment.toLowerCase()));
  if (dir) return `${dir}/`;
  const extension = BUILD_EXTENSIONS.exec(segments.at(-1));
  return extension ? `*${extension[0]}` : null;
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 先檢查全部 metadata，通過才讀取檔案內容；失敗不刪除或裁切變更。 */
export function assertChangeLimits(files, excluded = { files: 0, bytes: 0 }) {
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
    .slice(0, 10);
  // 只有基底沒有的新檔案能靠排除清單處理；原本就追蹤的檔案不會被排除。
  const hint = (file) => (file.added ? buildOutputHint(file.path) : null);
  const hints = [...new Set(largest.map(hint).filter(Boolean))];
  const listed = largest.map(
    (file) =>
      `${JSON.stringify(file.path.slice(0, 160))}：${file.bytes} bytes（${megabytes(file.bytes)}${hint(file) ? "，像建置產物" : ""}）`,
  );
  const advice = hints.length
    ? `較大的檔案看起來像建置產物：請到看板專案頁進階設定的「收集時排除」加入 ${hints
        .slice(0, 5)
        .map((h) => `\`${h}\``)
        .join("、")} 後重試，或在專案的 .gitignore 忽略它們。`
    : "這些檔案不像建置產物：請保留完整數值報告與需求要求的代表截圖，將中介矩陣產物移出交付；確定是建置輸出時，可到看板專案頁進階設定的「收集時排除」加入其目錄。不能略過必要驗收或提高限制。";
  throw new Error(
    `${reasons.join("；")}。全部變更合計 ${files.length} 個檔案、${bytes} bytes。${excluded.files ? `已自動排除 ${excluded.files} 個建置產物檔案（${megabytes(excluded.bytes)}），不計入上限。` : ""}${listed.length ? `最大 ${listed.length} 個檔案：${listed.join("；")}。` : ""}未刪除任何檔案、未發布。${advice}`,
  );
}
