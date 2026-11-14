// 一鍵部署：npm run deploy。只在部署目錄執行；說明見 README〈升級〉。
// 用純 Node 撰寫，重裝相依套件時不會把自己正在使用的模組刪掉。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployPlan } from "./lib/deploy-plan.mjs";
import { publicHealth } from "./lib/public-health.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
process.chdir(root);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const target = "origin/main";
const app = "http://127.0.0.1:4310";
const runner = "http://127.0.0.1:4312";
const windows = process.platform === "win32";

class Stop extends Error {}
const stop = (message) => {
  throw new Stop(message);
};
const step = (text) => console.log(`\n▶ ${text}`);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** 執行指令並把輸出直接顯示出來；失敗就中止部署。 */
function run(command, commandArgs, { shell = false, what } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell,
    windowsHide: true,
  });
  if (result.status !== 0)
    stop(`${what ?? `${command} ${commandArgs.join(" ")}`} 失敗`);
}
/** 執行指令並取回輸出；失敗回傳 undefined。 */
function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
const git = (...gitArgs) =>
  capture("git", gitArgs) ?? stop(`git ${gitArgs.join(" ")} 失敗`);
const powershell = (code) =>
  capture("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    code,
  ]);
const sql = (query) =>
  capture("docker", [
    "compose",
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "agentflow",
    "-d",
    "agentflow",
    "-Atc",
    query,
  ]);
const localSecrets = () =>
  JSON.parse(readFileSync(".local/secrets.json", "utf8"));

async function request(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: String(error?.cause?.code ?? error?.message) };
  }
}
const runnerHealth = () =>
  request(`${runner}/health`, {
    headers: { "x-runner-key": localSecrets().runnerSecret ?? "" },
  });
async function until(check, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await wait(3000);
  }
}

// ── 主機程序（監督程序、執行器、通道）──────────────────────────────

function stopHost() {
  if (!windows) return;
  powershell(
    "$ErrorActionPreference='SilentlyContinue';" +
      "Stop-ScheduledTask -TaskName 'LINE-AgentFlow';" +
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'start-windows\\.mjs|runner-main\\.ts|scripts[\\\\/]tunnel\\.ts' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
  );
}
function startHost() {
  if (!windows) return;
  const started = powershell(
    "if (Get-ScheduledTask -TaskName 'LINE-AgentFlow' -ErrorAction SilentlyContinue) " +
      "{ Start-ScheduledTask -TaskName 'LINE-AgentFlow'; 'task' }",
  );
  if (started?.includes("task")) return;
  // 沒有註冊排程工作（尚未執行 npm run install:startup）：直接在背景啟動監督程序。
  spawn(process.execPath, ["scripts/start-windows.mjs"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}
/** 只結束執行器；監督程序會在 30 秒內用新程式重新啟動它。 */
function stopRunner() {
  if (!windows) return;
  powershell(
    "Get-NetTCPConnection -LocalPort 4312 -State Listen -ErrorAction SilentlyContinue | " +
      "Select-Object -ExpandProperty OwningProcess -Unique | " +
      "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
  );
}

// ── 冒煙測試 ────────────────────────────────────────────────────────

async function smoke() {
  step("冒煙測試");
  const results = [];
  const add = (name, ok, detail, warning = false) =>
    results.push({ name, ok, detail, warning });
  const expect = async (name, url, status, options) => {
    const response = await request(url, options);
    add(
      name,
      response.status === status,
      response.status
        ? `HTTP ${response.status}（預期 ${status}）`
        : `連不上：${response.body}`,
    );
    return response;
  };
  const post = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  };

  const health = await request(`${app}/health`);
  add(
    "app 與資料庫",
    health.status === 200 && health.body.includes('"ok":true'),
    health.status ? `HTTP ${health.status}` : `連不上：${health.body}`,
  );
  await expect("看板頁面", `${app}/`, 200);
  await expect("管理 API 需要登入", `${app}/api/state`, 401);
  await expect(
    "LINE Webhook 拒絕未簽章的請求",
    `${app}/webhooks/line`,
    401,
    post,
  );
  await expect(
    "GitHub Webhook 拒絕未簽章的請求",
    `${app}/webhooks/github`,
    401,
    post,
  );

  const runnerState = await runnerHealth();
  let instance = "";
  try {
    instance = JSON.parse(runnerState.body).instance ?? "";
  } catch {}
  add(
    "主機執行器",
    runnerState.status === 200 && instance === "production",
    runnerState.status === 200
      ? `instance=${instance}`
      : runnerState.status
        ? `HTTP ${runnerState.status}`
        : "沒有回應；請確認排程工作 LINE-AgentFlow 正在執行",
  );

  const { publicUrl } = localSecrets();
  if (publicUrl?.startsWith("https://")) {
    const outside = await publicHealth(publicUrl);
    add("對外入口 /health", outside.ok, outside.detail);
    let tunnel = { ok: false, detail: "讀不到 .local/tunnel-status.json" };
    try {
      const state = JSON.parse(
        readFileSync(".local/tunnel-status.json", "utf8"),
      );
      const fresh = Date.now() - Date.parse(state.checked_at) < 180000;
      tunnel = {
        ok: !!state.ok && fresh,
        detail: fresh ? String(state.detail ?? "") : "狀態超過 3 分鐘沒有更新",
      };
    } catch {}
    add("通道狀態檔", tunnel.ok, tunnel.detail);
  } else add("對外入口 /health", false, "尚未設定固定公開網址", true);

  const failing = sql(
    "SELECT name FROM service_health WHERE NOT ok ORDER BY 1",
  );
  add(
    "看板「系統」頁的檢查項目",
    failing === "",
    failing === undefined
      ? "查不到 service_health"
      : failing
        ? `異常：${failing.split(/\r?\n/).join("、")}`
        : "全部正常",
    true,
  );

  for (const item of results)
    console.log(
      `  ${item.ok ? "✔" : item.warning ? "⚠" : "✘"} ${item.name}${item.detail ? `：${item.detail}` : ""}`,
    );
  const failed = results.filter((item) => !item.ok && !item.warning);
  const warned = results.filter((item) => !item.ok && item.warning);
  if (warned.length)
    console.log(`\n有 ${warned.length} 項需要留意（不影響部署結果）。`);
  if (failed.length) stop(`冒煙測試有 ${failed.length} 項沒有通過`);
  console.log("\n冒煙測試通過。");
}

// ── 部署 ────────────────────────────────────────────────────────────

/** 第一階段：檢查、取得新版並切換程式；之後交給新版的指令檔做第二階段。 */
function prepare() {
  step("檢查部署目錄");
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty)
    stop(`部署目錄有未提交的修改，先還原或移到開發用的工作目錄：\n${dirty}`);

  // 擁有者沒有內建預設值；缺少時新版 app 不會啟動，部署前先擋下。
  if (
    !existsSync(".env") ||
    !/^ADMIN_GITHUB_ID=\d+\s*$/m.test(readFileSync(".env", "utf8"))
  )
    stop(
      "請先在 .env 加上 ADMIN_GITHUB_ID=擁有者的 GitHub 數字 ID（查詢：gh api users/帳號 --jq .id），再執行部署",
    );

  step("確認沒有排隊或執行中的任務");
  if (capture("docker", ["compose", "ps", "-q", "db"])) {
    const busy = sql(
      "SELECT (SELECT count(*) FROM tasks WHERE status IN ('queued','running','reviewing')) + (SELECT count(*) FROM runs WHERE completed_at IS NULL)",
    );
    if (busy === undefined) stop("查不到任務狀態，請確認資料庫容器正常");
    if (busy !== "0")
      stop(`還有 ${busy} 個排隊或執行中的任務；等它們結束後再部署`);
    console.log("  沒有進行中的任務。");
  } else console.log("  資料庫容器沒有執行，略過。");

  step(`取得 ${target}`);
  run("git", ["fetch", "origin", "--prune"]);
  const before = git("rev-parse", "HEAD");
  const after = git("rev-parse", target);
  if (before === after && !flag("--rebuild") && !flag("--restart-host")) {
    console.log(`  已經是最新版本（${after.slice(0, 7)}），只執行冒煙測試。`);
    return undefined;
  }
  if (before !== after) {
    console.log(
      git("log", "--oneline", "--no-decorate", `${before}..${after}`),
    );
    // 固定切到遠端的 main，不依賴本機 main 分支（它可能被別的工作目錄佔用）。
    run("git", ["switch", "--detach", target]);
  }
  return before;
}

/** 第二階段：由更新後的指令檔執行，確保建置與重啟的步驟跟著新版走。 */
async function apply(before) {
  const changed = git("diff", "--name-only", before, "HEAD")
    .split(/\r?\n/)
    .filter(Boolean);
  const plan = deployPlan(changed, { restartHost: flag("--restart-host") });
  const short = (sha) => sha.slice(0, 7);
  console.log(
    `\n${short(before)} → ${short(git("rev-parse", "HEAD"))}，${changed.length} 個檔案有變更。`,
  );
  if (!windows) console.log("  非 Windows 主機：主機程序請自行重啟。");

  let hostStopped = false;
  try {
    if (plan.host === "all") {
      step("停止主機程序（監督程序、執行器、通道）");
      stopHost();
      hostStopped = true;
    }
    if (plan.install || !existsSync("node_modules")) {
      step("安裝相依套件");
      run("npm", ["ci"], { shell: true, what: "npm ci" });
    }
    step("建置工作映像（沒有變更時直接使用快取）");
    run("docker", [
      "build",
      "-f",
      "worker/Dockerfile",
      "-t",
      "line-agentflow-worker:local",
      ".",
    ]);
    run("docker", [
      "build",
      "-f",
      "infra/source/Dockerfile",
      "-t",
      "line-agentflow-source:local",
      ".",
    ]);
    // 定期檢查的檢查容器與轉接器（#19）；執行器拒絕版本較舊的檢查映像。
    run("docker", [
      "build",
      "-f",
      "infra/check/Dockerfile",
      "-t",
      "line-agentflow-check:local",
      ".",
    ]);
    // 已啟用的 SQL Server 測試映像隨基底一起更新，避免沿用舊執行程式。
    if (
      spawnSync(
        "docker",
        ["image", "inspect", "line-agentflow-worker-mssql:local"],
        { stdio: "ignore", windowsHide: true },
      ).status === 0
    )
      run("docker", [
        "build",
        "-f",
        "worker/mssql.Dockerfile",
        "-t",
        "line-agentflow-worker-mssql:local",
        ".",
      ]);
    step("建置並重啟服務容器");
    run("docker", ["compose", "--profile", "full", "build"]);
    const up = () =>
      spawnSync("docker", ["compose", "--profile", "full", "up", "-d"], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
      }).status === 0;
    // 監督程序每 30 秒也會執行 up -d，剛好撞在一起時重試一次。
    if (!up()) {
      await wait(10000);
      if (!up()) stop("docker compose up 失敗");
    }
  } finally {
    if (hostStopped) {
      step("啟動主機程序");
      startHost();
    }
  }
  if (plan.host === "runner") {
    step("重啟主機執行器");
    stopRunner();
  }

  step("等待服務恢復");
  if (
    !(await until(
      async () => (await request(`${app}/health`)).status === 200,
      180,
    ))
  )
    stop("app 在 3 分鐘內沒有恢復，請查看 docker compose logs --tail 100 app");
  console.log("  app 已恢復。");
  if (!(await until(async () => (await runnerHealth()).status === 200, 150)))
    stop(
      "主機執行器沒有恢復，請查看 .local\\runner.log 與排程工作 LINE-AgentFlow",
    );
  console.log("  執行器已恢復。");
  if (plan.host === "all") {
    // 通道重新連線、狀態檔更新需要一點時間。
    await until(async () => {
      try {
        const state = JSON.parse(
          readFileSync(".local/tunnel-status.json", "utf8"),
        );
        return state.ok && Date.now() - Date.parse(state.checked_at) < 60000;
      } catch {
        return false;
      }
    }, 90);
  }
  await smoke();
  if (plan.workerChanged)
    console.log("\n工作映像有更新：到看板「專案」頁對受影響的專案重新驗證。");
  console.log(`\n部署完成：${short(git("rev-parse", "HEAD"))}`);
}

if (flag("--help") || flag("-h")) {
  console.log(
    [
      "用法：npm run deploy [-- 選項]",
      "",
      "  （無選項）       取得 origin/main、重建映像、重啟服務並執行冒煙測試",
      "  --restart-host   連同監督程序與通道一起重啟（更換入口設定後使用）；版本沒有變也會執行",
      "  --rebuild        版本沒有變也重新建置與重啟",
      "  --smoke-only     只執行冒煙測試，不更新程式（等同 npm run smoke）",
    ].join("\n"),
  );
  process.exit(0);
}

try {
  if (!existsSync(".local/secrets.json"))
    stop(
      "這個目錄沒有 .local/secrets.json，不是部署目錄。開發用的工作目錄不能執行部署。",
    );
  const resume = args.indexOf("--after");
  if (flag("--smoke-only")) await smoke();
  else if (resume >= 0) await apply(args[resume + 1]);
  else {
    const before = prepare();
    if (before === undefined) await smoke();
    else {
      // 程式已經換成新版：重新載入指令檔，後半段照新版的步驟執行。
      const next = spawnSync(
        process.execPath,
        [script, "--after", before, ...args],
        { cwd: root, stdio: "inherit" },
      );
      process.exit(next.status ?? 1);
    }
  }
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(`\n✘ ${error.message}`);
  process.exit(1);
}
