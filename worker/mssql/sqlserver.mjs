#!/usr/bin/env node
// 測試階段專用：在同一個工作容器啟動本機 SQL Server，把專案寫死的 LocalDB 連線暫時導向它，
// 執行測試命令後還原檔案、停止資料庫並刪除資料檔。容器沒有網路，不會連到任何外部資料庫；
// sa 密碼每次隨機產生，只存在這個容器的環境變數。
//
// 用法：agentflow-sqlserver run [--snapshot] -- 命令 [參數...]
// 結果以一行 `AGENTFLOW_TEST_ENVIRONMENT {JSON}` 寫到標準輸出；SQL Server 起不來或建庫失敗時
// 不執行測試命令，以退出碼 86 結束，讓系統標示為「測試環境問題」而不是程式沒過。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENVIRONMENT_MARK = "AGENTFLOW_TEST_ENVIRONMENT ";
export const ENVIRONMENT_EXIT = 86;
export const SERVER = "127.0.0.1,1433";
const SQLSERVR = "/opt/mssql/bin/sqlservr";
const SQLCMD = "/opt/mssql-tools18/bin/sqlcmd";
const DATA = "/workspace/obj/agentflow-sql";
const STATE = "/workspace/obj/agentflow-sqlserver";

// `(localdb)\MSSQLLocalDB`、`(localdb)\\v11.0`（字串跳脫）、`(localdb)\.\共用執行個體`。
// 每次建立新的 RegExp：全域旗標的 lastIndex 會在不同呼叫之間殘留。
const localDb = () => /\(localdb\)(?:\\{1,2}\.)?\\{1,2}[A-Za-z0-9_.$-]+/gi;
// 連線字串所在的字串常值或設定值邊界：引號、XML 標記、換行。
const BOUNDARY = /["'`<>\r\n]/;
const TEXT_FILE =
  /\.(?:cs|csx|vb|fs|fsx|json|config|xml|runsettings|props|targets|settings|ya?ml|ini|env)$/i;
const SKIP_DIRS = new Set([
  ".git",
  ".vs",
  ".idea",
  "obj",
  "bin",
  "node_modules",
  "packages",
  "TestResults",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const DATABASE_NAME = /^[A-Za-z0-9_.$-]{1,128}$/;

/**
 * 把一段文字中的 LocalDB 連線改寫成容器內 SQL Server 的 sa 帳號連線。
 * 只改同一個字串常值（引號或標記之間）裡的連線字串，Windows 整合驗證改成關閉。
 */
export function rewriteLocalDb(text, password) {
  const databases = new Set();
  let count = 0,
    out = "",
    cursor = 0;
  for (const match of text.matchAll(localDb())) {
    if (match.index < cursor) continue;
    let start = match.index;
    while (start > cursor && !BOUNDARY.test(text[start - 1])) start--;
    let end = match.index + match[0].length;
    while (end < text.length && !BOUNDARY.test(text[end])) end++;
    let segment = text.slice(start, end);
    // AttachDbFilename 指向 Windows 上的 .mdf，容器內無法附加；改用同名資料庫並事先建立。
    const attach = /AttachDbFilename\s*=\s*([^;]*);?/i.exec(segment);
    let attachedName = "";
    if (attach) {
      attachedName = path.basename(
        attach[1].replace(/\\+/g, "/").trim(),
        path.extname(attach[1].trim()),
      );
      segment = segment.replace(attach[0], "");
    }
    segment = segment
      .replace(
        localDb(),
        `${SERVER};User ID=sa;Password=${password};TrustServerCertificate=True`,
      )
      .replace(
        /(Integrated\s+Security|Trusted_Connection)\s*=\s*[A-Za-z]+/gi,
        "$1=False",
      );
    let named = false;
    for (const db of segment.matchAll(
      /(?:Database|Initial\s+Catalog)\s*=\s*([^;]*)/gi,
    )) {
      const name = db[1].trim();
      named = true;
      if (DATABASE_NAME.test(name)) databases.add(name);
    }
    if (!named && attachedName && DATABASE_NAME.test(attachedName)) {
      segment = `${segment.replace(/;?\s*$/, "")};Initial Catalog=${attachedName}`;
      databases.add(attachedName);
    }
    count += [...text.slice(start, end).matchAll(localDb())].length;
    out += text.slice(cursor, start) + segment;
    cursor = end;
  }
  if (!count) return { text, count: 0, databases: [] };
  return { text: out + text.slice(cursor), count, databases: [...databases] };
}

/** 找出工作目錄中含 LocalDB 連線的文字檔（不進入建置產物、套件與 Git 目錄，不跟隨符號連結）。 */
export function findLocalDbFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        const text = fs.readFileSync(full, "utf8");
        if (localDb().test(text)) found.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** 依備份清單把檔案還原成改寫前的位元組；清單在改寫前寫入，中斷後下次執行也能還原。 */
export function restoreFiles(root, state) {
  const manifest = path.join(state, "manifest.json");
  if (!fs.existsSync(manifest)) return [];
  const entries = JSON.parse(fs.readFileSync(manifest, "utf8"));
  for (const rel of entries) {
    const backup = path.join(state, "backup", rel);
    if (fs.existsSync(backup)) fs.copyFileSync(backup, path.join(root, rel));
  }
  fs.rmSync(state, { recursive: true, force: true });
  return entries;
}

/** 備份後改寫；回傳改寫的檔案與連線字串中提到的資料庫。 */
export function redirectFiles(root, state, password) {
  const files = findLocalDbFiles(root);
  const databases = new Set();
  const changed = [];
  fs.mkdirSync(path.join(state, "backup"), { recursive: true });
  for (const rel of files) {
    const full = path.join(root, rel);
    const original = fs.readFileSync(full);
    const result = rewriteLocalDb(original.toString("utf8"), password);
    if (!result.count) continue;
    const backup = path.join(state, "backup", rel);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, original);
    changed.push(rel);
    fs.writeFileSync(
      path.join(state, "manifest.json"),
      JSON.stringify(changed),
    );
    fs.writeFileSync(full, result.text);
    for (const db of result.databases) databases.add(db);
  }
  return { files: changed, databases: [...databases] };
}

const report = (value) =>
  process.stdout.write(`${ENVIRONMENT_MARK}${JSON.stringify(value)}\n`);

function sqlcmd(password, args, timeoutMs = 60000) {
  const r = spawnSync(
    SQLCMD,
    ["-C", "-S", SERVER, "-U", "sa", "-l", "5", ...args],
    {
      env: { ...process.env, SQLCMDPASSWORD: password },
      encoding: "utf8",
      timeout: timeoutMs,
    },
  );
  return {
    ok: r.status === 0,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tail = (file) => {
  try {
    return fs.readFileSync(file, "utf8").slice(-1500);
  } catch {
    return "";
  }
};

async function startServer(password, log, timeoutMs) {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const fd = fs.openSync(log, "w");
  const server = spawn(SQLSERVR, [], {
    env: {
      ...process.env,
      ACCEPT_EULA: "Y",
      MSSQL_PID: "Developer",
      MSSQL_SA_PASSWORD: password,
      MSSQL_TCP_PORT: "1433",
      // 只聽本機：測試容器在「完全開放」網路模式下會接上共用網路，不能讓其他容器連進來。
      // 每個容器有自己的網路命名空間與工作卷，同時執行的任務不會搶同一個連接埠或資料檔。
      MSSQL_IP_ADDRESS: "127.0.0.1",
      // 工作容器只有 2 GiB；留一半給建置與測試程序。
      MSSQL_MEMORY_LIMIT_MB:
        process.env.AGENTFLOW_SQLSERVER_MEMORY_MB ?? "1024",
    },
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  let exited = false;
  server.once("exit", () => (exited = true));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(Math.max(0, Math.min(2000, deadline - Date.now())));
    if (exited || Date.now() >= deadline) break;
    if (sqlcmd(password, ["-b", "-Q", "SET NOCOUNT ON; SELECT 1"], 10000).ok)
      return server;
  }
  stopServer(server);
  throw new Error(
    exited
      ? `SQL Server 程序啟動後結束。${tail(log)}`
      : `SQL Server 在 ${Math.round(timeoutMs / 1000)} 秒內沒有就緒。${tail(log)}`,
  );
}

function stopServer(server) {
  if (!server || server.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => server.kill("SIGKILL"), 15000);
    server.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

/** 有結構快照時，為連線字串提到的資料庫建立空白資料庫並依 README 順序套用。 */
function prepareDatabases(password, databases, snapshot) {
  const dir = path.join(process.env.AGENTFLOW_ENV_DIR ?? "", "database");
  const files = snapshot
    ? ["schema.sql", "reference-data.sql"].filter((f) =>
        fs.existsSync(path.join(dir, f)),
      )
    : [];
  for (const db of databases) {
    const quoted = db.replace(/]/g, "]]");
    const created = sqlcmd(password, [
      "-b",
      "-Q",
      `IF DB_ID(N'${db.replace(/'/g, "''")}') IS NULL CREATE DATABASE [${quoted}]`,
    ]);
    if (!created.ok)
      throw new Error(
        `建立測試資料庫 ${db} 失敗：${created.output.slice(-800)}`,
      );
    // 不加 -b：個別物件失敗時仍繼續套用其餘批次（見 docs/agents/project-environment.md）。
    for (const file of files)
      sqlcmd(password, ["-d", db, "-i", path.join(dir, file)], 600000);
  }
  return files;
}

async function run(argv) {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  if (!command.length) {
    process.stderr.write(
      "用法：agentflow-sqlserver run [--snapshot] -- 命令\n",
    );
    return 2;
  }
  const root = process.cwd();
  const snapshot = options.includes("--snapshot");
  const timeoutMs =
    Number(process.env.AGENTFLOW_SQLSERVER_TIMEOUT_SECONDS ?? 150) * 1000;
  // 上一次在測試途中被強制結束時，先把改寫過的檔案還原。
  const leftover = restoreFiles(root, STATE);
  fs.mkdirSync(STATE, { recursive: true });
  const password = `Af1!${randomBytes(18).toString("hex")}`;
  const log = path.join(STATE, "sqlserver.log");
  let server, redirected;
  try {
    try {
      server = await startServer(password, log, timeoutMs);
    } catch {
      // 第一次啟動偶爾會因資源競爭失敗；清掉資料檔重來一次。
      server = await startServer(password, log, timeoutMs);
    }
  } catch (e) {
    report({ ok: false, stage: "start", reason: String(e.message ?? e) });
    await cleanup(root, server);
    return ENVIRONMENT_EXIT;
  }
  try {
    redirected = redirectFiles(root, STATE, password);
    // 連線字串提到的資料庫先建成空白資料庫；有快照時再套用結構，沒有時交給專案自己的遷移或建庫腳本。
    const applied = prepareDatabases(password, redirected.databases, snapshot);
    report({
      ok: true,
      server: SERVER,
      redirected: redirected.files,
      databases: redirected.databases,
      snapshot: applied,
      ...(leftover.length ? { restoredLeftover: leftover } : {}),
    });
  } catch (e) {
    report({ ok: false, stage: "database", reason: String(e.message ?? e) });
    await cleanup(root, server);
    return ENVIRONMENT_EXIT;
  }
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      MSSQL_SA_PASSWORD: password,
      SQLCMDPASSWORD: password,
      AGENTFLOW_SQLSERVER: SERVER,
      AGENTFLOW_SQLSERVER_CONNECTION: `Server=${SERVER};User ID=sa;Password=${password};TrustServerCertificate=True`,
      // 減少常駐建置節點，避免和 SQL Server 一起超過程序數上限。
      MSBUILDDISABLENODEREUSE: "1",
    },
  });
  const forward = (signal) => child.kill(signal);
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);
  const code = await new Promise((resolve) => {
    child.once("error", (e) => {
      process.stderr.write(`無法執行測試命令：${e.message}\n`);
      resolve(127);
    });
    child.once("exit", (status, signal) =>
      resolve(status ?? (signal ? 143 : 1)),
    );
  });
  await cleanup(root, server);
  return code;
}

async function cleanup(root, server) {
  try {
    restoreFiles(root, STATE);
  } finally {
    await stopServer(server);
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(STATE, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
) {
  const [action, ...rest] = process.argv.slice(2);
  if (action !== "run") {
    process.stderr.write(
      "用法：agentflow-sqlserver run [--snapshot] -- 命令\n",
    );
    process.exit(2);
  }
  run(rest).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e?.stack ?? e}\n`);
      process.exit(1);
    },
  );
}
