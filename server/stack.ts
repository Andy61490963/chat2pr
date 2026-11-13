// 依儲存庫檔案判斷技術棧，替未設定命令的專案建議安裝與測試命令。
// 只看檔名，不讀內容；判斷不出來時回傳 null，由管理者自行填寫。
export interface StackSuggestion {
  stack: string;
  install: string;
  test: string;
  /** 工作容器是否已有此技術棧需要的工具鏈。 */
  supported: boolean;
}

const root = (paths: string[], pattern: RegExp) =>
  paths.filter((p) => !p.includes("/") && pattern.test(p));

export function suggestStack(paths: string[]): StackSuggestion | null {
  const sln = root(paths, /\.sln$/i)[0];
  if (sln || paths.some((p) => /\.csproj$/i.test(p)))
    return {
      stack: ".NET",
      install: sln ? `dotnet restore ${sln}` : "dotnet restore",
      test: `dotnet test ${sln ?? ""} --no-restore --filter "Category!=Integration"`
        .replace(/\s+/g, " ")
        .trim(),
      supported: true,
    };
  if (root(paths, /^package\.json$/).length)
    return {
      stack: "Node.js",
      install: root(paths, /^package-lock\.json$/).length
        ? "npm ci"
        : "npm install",
      test: "npm test",
      supported: true,
    };
  if (root(paths, /^(pyproject\.toml|requirements\.txt|setup\.py)$/).length) {
    const requirements = root(paths, /^requirements\.txt$/).length;
    return {
      stack: "Python",
      install: `python3 -m venv .venv && .venv/bin/pip install -q ${requirements ? "-r requirements.txt" : "-e ."} pytest`,
      test: ".venv/bin/python -m pytest -q",
      supported: true,
    };
  }
  if (root(paths, /^(pom\.xml|build\.gradle(\.kts)?)$/).length)
    return { stack: "Java", install: "", test: "", supported: false };
  if (root(paths, /^go\.mod$/).length)
    return { stack: "Go", install: "", test: "", supported: false };
  if (root(paths, /^Cargo\.toml$/).length)
    return { stack: "Rust", install: "", test: "", supported: false };
  return null;
}

export function missingTestMessage(suggestion: StackSuggestion | null) {
  const base =
    "尚未設定測試命令，無法確認 Codex 的修改能建置與測試。請在專案設定填寫測試命令；確定不需要測試時可填 true。";
  if (!suggestion) return base;
  if (!suggestion.supported)
    return `${base}偵測到 ${suggestion.stack} 專案，但工作容器沒有 ${suggestion.stack} 工具鏈，需先在 worker/Dockerfile 加入或改用專案專屬映像。`;
  return `${base}偵測到 ${suggestion.stack} 專案，建議安裝命令：${suggestion.install}；測試命令：${suggestion.test}`;
}
