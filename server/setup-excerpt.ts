/**
 * 送給 AI 的檔案太長時只保留原文行，不改寫：AI 引用的 evidence 必須能在摘錄中逐字找到。
 * 呼叫端必須先對完整內容做機密掃描，再呼叫這裡摘錄，避免漏掉省略段落中的憑證。
 */
type Range = { start: number; end: number; stopWhenFull?: boolean };

function lineExcerpt(
  source: string,
  limit: number,
  marker: string,
  ranges: (lines: string[]) => Range[],
  trailing?: string,
) {
  if (Buffer.byteLength(source) <= limit) return source;
  const lines = source.split("\n"),
    selected = new Set<number>();
  // 每個不連續段落最多加一個省略標記，計入同一個位元組上限。
  let remaining = limit - (trailing ? Buffer.byteLength(`\n${trailing}`) : 0);
  const markerSize = Buffer.byteLength(marker);
  for (const { start, end, stopWhenFull } of ranges(lines))
    for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) {
      if (selected.has(i)) continue;
      const size = Buffer.byteLength(lines[i]) + 1 + markerSize;
      if (size > remaining) {
        if (stopWhenFull) break;
        continue;
      }
      selected.add(i);
      remaining -= size;
    }
  if (!selected.size) return "";
  let previous = -1;
  const text = [...selected]
    .sort((a, b) => a - b)
    .map((i) => {
      const prefix = i > previous + 1 ? marker : "";
      previous = i;
      return prefix + lines[i];
    })
    .join("\n");
  return trailing && !selected.has(lines.length - 1)
    ? `${text}\n${trailing}`
    : text;
}

/** 符合條件的每一行連同前後幾行列為優先段落。 */
function around(
  lines: string[],
  match: RegExp | ((line: string) => boolean),
  before: number,
  after: number,
) {
  const ranges: Range[] = [];
  lines.forEach((line, i) => {
    if (typeof match === "function" ? match(line) : match.test(line))
      ranges.push({ start: i - before, end: i + after });
  });
  return ranges;
}

/** 說明文件只是輔助依據；優先保留安裝與測試附近的原文，限制送給 AI 的資料量。 */
export function setupReadmeExcerpt(source: string, limit: number) {
  // 先取標題，再取命令與操作說明；不會只保留開頭而漏掉尾端的測試手順。
  return lineExcerpt(source, limit, "\n[此處省略說明文件內容]\n", (lines) => [
    { start: 0, end: 5 },
    ...around(
      lines,
      /(?:\b(?:install|restore|test|build|setup|prerequisites|quick\s*start|npm|pnpm|dotnet|pytest|docker)\b|安裝|測試|建置|環境|啟動|還原|相依)/i,
      2,
      18,
    ),
    { start: 0, end: lines.length },
  ]);
}

export type BuildFileKind = "solution" | "msbuild" | "ci" | "other";

export function buildFileKind(path: string): BuildFileKind {
  if (/\.(sln|slnx)$/i.test(path)) return "solution";
  if (
    /\.(csproj|fsproj|vbproj)$/i.test(path) ||
    /(^|\/)Directory\.[^/]+\.(props|targets)$/i.test(path)
  )
    return "msbuild";
  if (
    /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path) ||
    /(^|\/)\.gitlab-ci\.yml$/i.test(path)
  )
    return "ci";
  return "other";
}

// 依檔案種類挑出安裝與測試需要的原文行，與測試有關的行最先保留（大型方案的測試專案常排在最後）；
// 其餘依開頭順序補到上限為止。
const testRelated = /test|spec|xunit|nunit/i;
const priorities: Record<
  Exclude<BuildFileKind, "other">,
  { pattern: RegExp; before: number; after: number }
> = {
  // 方案檔：專案清單（含測試專案路徑）與版本標頭。
  solution: {
    pattern:
      /^\s*(?:Microsoft Visual Studio Solution File|#\s*Visual Studio|VisualStudioVersion|MinimumVisualStudioVersion|Project\(|EndProject\s*$)|<\/?(?:Solution|Folder|Project)\b/,
    before: 0,
    after: 1,
  },
  // 專案檔與 Directory.*.props：目標框架、SDK、套件與專案參考、是否為測試專案。
  msbuild: {
    pattern:
      /<\/?(?:Project|Sdk|Import|TargetFrameworks?|OutputType|IsTestProject|IsPackable|PackageReference|PackageVersion|GlobalPackageReference|ProjectReference|ManagePackageVersionsCentrally|CentralPackageTransitivePinningEnabled|RuntimeIdentifiers?|LangVersion|Nullable|UseWPF|UseWindowsForms)\b/,
    before: 0,
    after: 3,
  },
  // CI：工作名稱、執行步驟、映像、服務與安裝、建置、測試命令。
  ci: {
    pattern:
      /^\S[^#:]*:\s*$|\b(?:runs-on|steps|run|uses|with|script|before_script|services|image|container|env|working-directory|install|restore|build|test|setup|npm|pnpm|yarn|dotnet|pytest|pip|poetry|uv|make|docker|msbuild|vstest)\b/i,
    before: 1,
    after: 8,
  },
};

export const buildExcerptReason: Record<BuildFileKind, string> = {
  solution: "方案檔過大，僅提供專案清單相關原文，其餘內容已省略",
  msbuild: "專案檔過大，僅提供目標框架、套件與專案參考相關原文，其餘內容已省略",
  ci: "CI 設定過大，僅提供安裝、建置、測試相關步驟原文，其餘內容已省略",
  other: "檔案過大，僅提供開頭一段原文，其後內容已截斷",
};

/** 大型建置設定依種類摘錄；回傳空字串代表連一行原文都放不進上限。 */
export function setupBuildExcerpt(path: string, source: string, limit: number) {
  const kind = buildFileKind(path),
    rule = kind === "other" ? null : priorities[kind];
  return lineExcerpt(
    source,
    limit,
    "\n[此處省略建置設定內容]\n",
    (lines) => [
      { start: 0, end: 3 },
      ...(rule
        ? [
            ...around(
              lines,
              (line) => rule.pattern.test(line) && testRelated.test(line),
              rule.before,
              rule.after,
            ),
            ...around(lines, rule.pattern, rule.before, rule.after),
          ]
        : []),
      { start: 0, end: lines.length, stopWhenFull: true },
    ],
    "[以下建置設定內容已截斷]",
  );
}
