import type { Project } from "../shared/types.js";
import type { SetupPlan, SqlServerPlan } from "../shared/project-setup.js";
import { AppError, redact } from "./policy.js";

export const DEFAULT_WORKER_IMAGE = "line-agentflow-worker:local";
export const SQLSERVER_WORKER_IMAGE = "line-agentflow-worker-mssql:local";
/** worker/mssql/sqlserver.mjs 的結果行與「測試環境問題」退出碼。 */
export const ENVIRONMENT_MARK = "AGENTFLOW_TEST_ENVIRONMENT ";
export const ENVIRONMENT_EXIT = 86;
const MAX_COMMAND = 8000;

// 存取 SQL Server 的 .NET 套件；EF Core 的 SqlServer 提供者含 NetTopologySuite 等延伸套件。
const SQL_PACKAGE =
  /<Package(?:Reference|Version)\b[^>]*\bInclude\s*=\s*"((?:Microsoft|System)\.Data\.SqlClient|Microsoft\.EntityFrameworkCore\.SqlServer(?:\.[A-Za-z.]+)?)"/gi;
const TEST_PROJECT =
  /<PackageReference\b[^>]*\bInclude\s*=\s*"(?:Microsoft\.NET\.Test\.Sdk|xunit(?:\.v3)?|NUnit|MSTest(?:\.TestFramework)?)"|<IsTestProject>\s*true\s*<\/IsTestProject>/i;
const CI_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.gitlab-ci\.yml$/i;
const CI_SQLSERVER =
  /mcr\.microsoft\.com\/mssql\/server[^\s"']*|\(localdb\)\\{1,2}[A-Za-z0-9_.$-]+|\bMSSQLLocalDB\b|\bsqllocaldb\b|setup-sql(?:server)?@[^\s"']+/i;

type Reason = { path: string; quote: string };

const dirOf = (file: string) => file.split("/").slice(0, -1).join("/");
function resolveRelative(from: string, include: string) {
  const parts = dirOf(from).split("/").filter(Boolean);
  for (const piece of include.replace(/\\/g, "/").split("/")) {
    if (!piece || piece === ".") continue;
    if (piece === "..") parts.pop();
    else parts.push(piece);
  }
  return parts.join("/");
}

/**
 * 從固定版本的方案、專案檔、套件設定與 CI 判斷測試是否需要 SQL Server。
 * 依據：測試專案（或它參照的專案）使用 SQL Server 用戶端套件，或 CI 準備 SQL Server／LocalDB。
 * 只看實際檔案內容，回傳可對照原文的依據；不需要時回傳空陣列。
 */
export function detectSqlServer(files: Record<string, string>): Reason[] {
  const projects = Object.keys(files).filter((p) => /\.csproj$/i.test(p));
  // Directory.Packages.props／Directory.Build.props 套用到同目錄以下的所有專案。
  const shared = Object.keys(files).filter((p) =>
    /(^|\/)Directory\.(?:Build|Packages)\.props$/i.test(p),
  );
  const sqlPackages = new Map<string, Reason>();
  for (const file of [...projects, ...shared]) {
    const match = [...files[file].matchAll(SQL_PACKAGE)][0];
    if (match) sqlPackages.set(file, { path: file, quote: match[0] });
  }
  const usesSql = (
    project: string,
    seen = new Set<string>(),
  ): Reason | null => {
    if (seen.has(project)) return null;
    seen.add(project);
    const own = sqlPackages.get(project);
    if (own) return own;
    for (const props of shared) {
      const scope = dirOf(props);
      // 中央套件版本只宣告版本；專案本身仍需引用同名套件才算使用。
      if (
        (!scope || project.startsWith(`${scope}/`)) &&
        /Directory\.Build\.props$/i.test(props) &&
        sqlPackages.has(props)
      )
        return sqlPackages.get(props)!;
    }
    for (const ref of (files[project] ?? "").matchAll(
      /<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+\.csproj)"/gi,
    )) {
      const target = resolveRelative(project, ref[1]);
      const found = usesSql(target, seen);
      if (found) return found;
    }
    return null;
  };
  const reasons: Reason[] = [];
  for (const project of projects) {
    if (!TEST_PROJECT.test(files[project])) continue;
    const found = usesSql(project);
    if (!found) continue;
    const testQuote = TEST_PROJECT.exec(files[project])![0];
    reasons.push({ path: project, quote: testQuote });
    if (!reasons.some((r) => r.path === found.path && r.quote === found.quote))
      reasons.push(found);
  }
  for (const [file, content] of Object.entries(files)) {
    if (!CI_FILE.test(file)) continue;
    const match = CI_SQLSERVER.exec(content);
    if (match) reasons.push({ path: file, quote: match[0] });
  }
  return reasons.slice(0, 10);
}

/**
 * AI 自動設定時決定是否提供 SQL Server 與使用的映像。
 * - 管理者選「不提供」：一律不提供。
 * - 管理者選「一律提供」：預設映像改用 SQL Server 映像；自訂映像照用（須含 agentflow-sqlserver）。
 * - 自動：偵測到需要，而且映像是預設或 SQL Server 映像時才提供；自訂映像由管理者負責，不自動更換。
 */
export function sqlServerPlan(
  project: Pick<Project, "image" | "sql_server">,
  files: Record<string, string>,
): SqlServerPlan | null {
  const mode = project.sql_server ?? "auto";
  if (mode === "never") return null;
  const reasons = detectSqlServer(files);
  if (mode === "always")
    return {
      image:
        project.image === DEFAULT_WORKER_IMAGE
          ? SQLSERVER_WORKER_IMAGE
          : project.image,
      source: "admin",
      reasons,
    };
  if (
    !reasons.length ||
    ![DEFAULT_WORKER_IMAGE, SQLSERVER_WORKER_IMAGE].includes(project.image)
  )
    return null;
  return { image: SQLSERVER_WORKER_IMAGE, source: "detected", reasons };
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * 測試命令外包一層：先在同一個容器啟動 SQL Server、導向 LocalDB 連線，結束時還原。
 * 只在測試階段使用；安裝階段沒有資料庫。
 */
export function sqlServerTestCommand(
  plan: Pick<SetupPlan, "sqlServer" | "dataSource">,
  command: string,
) {
  if (!plan.sqlServer) return command;
  const wrapped = `if ! command -v agentflow-sqlserver >/dev/null 2>&1; then printf '%s\\n' '${ENVIRONMENT_MARK}{"ok":false,"stage":"image","reason":"工作映像沒有 SQL Server 測試工具 agentflow-sqlserver，請以最新 worker/mssql.Dockerfile 重建映像"}'; exit ${ENVIRONMENT_EXIT}; fi; exec agentflow-sqlserver run${plan.dataSource === "snapshot" ? " --snapshot" : ""} -- sh -c ${quote(command)}`;
  if (wrapped.length > MAX_COMMAND)
    throw new AppError(
      422,
      "測試命令過長，加上 SQL Server 測試環境後超過執行器上限；請縮短測試命令",
    );
  return wrapped;
}

export type EnvironmentReport = {
  ok: boolean;
  stage?: string;
  reason?: string;
  redirected?: string[];
  databases?: string[];
};

/** 讀出測試輸出中最後一行測試環境結果；沒有時回傳 null。 */
export function testEnvironment(output: string): EnvironmentReport | null {
  const lines = output
    .split("\n")
    .filter((line) => line.startsWith(ENVIRONMENT_MARK));
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1].slice(ENVIRONMENT_MARK.length));
  } catch {
    return null;
  }
}

/**
 * SQL Server 起不來或建庫失敗時的白話說明：標明是測試環境問題，列出因此跳過的測試。
 * 不是這種情況時回傳 null，照一般測試失敗處理。
 */
export function environmentFailure(
  plan: Pick<SetupPlan, "sqlServer" | "test"> | null | undefined,
  result: { exitCode: number; stdout: string; stderr: string },
) {
  if (!plan?.sqlServer || result.exitCode !== ENVIRONMENT_EXIT) return null;
  const report = testEnvironment(result.stdout);
  if (!report || report.ok) return null;
  const what =
    report.stage === "database"
      ? "容器內的 SQL Server 已啟動，但建立測試資料庫失敗"
      : report.stage === "image"
        ? "工作映像缺少 SQL Server 測試工具"
        : "容器內的 SQL Server 沒有啟動成功";
  const evidence = plan.sqlServer.reasons
    .map((r) => r.path)
    .filter((p, i, all) => all.indexOf(p) === i)
    .join("、");
  return `測試環境問題（不是程式沒過）：${what}。原因：${redact(report.reason ?? "未提供").slice(0, 800)}\n已跳過的測試：測試命令「${plan.test.slice(0, 300)}」整個沒有執行${evidence ? `；需要 SQL Server 的依據：${evidence}` : ""}。`;
}
