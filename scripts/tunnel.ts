import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { secrets, secretsPath } from "../server/config.js";
import {
  metricsPort,
  tunnelPlan,
  type TunnelPlan,
} from "../server/tunnel-provider.js";
import { publicHealth } from "./lib/public-health.mjs";

// 狀態檔放在機密設定檔旁邊，app 從同一個位置讀取。
const dir = dirname(secretsPath);
const statusFile = join(dir, "tunnel-status.json");
const connected = "固定 HTTPS 入口已連線";
const report = (ok: boolean, detail: string) =>
  writeFile(
    statusFile,
    JSON.stringify({ ok, detail, checked_at: new Date().toISOString() }),
  );

const settings = secrets();
await mkdir(dir, { recursive: true });
const port = metricsPort();
const plan = tunnelPlan(settings, port);

if (plan.provider === "external") {
  // 入口由自備程序維護，狀態檔也由它更新；這裡不能覆寫。
  console.log(plan.detail);
} else if (plan.provider === "none") {
  await report(false, plan.detail);
  console.error(plan.detail);
} else if (plan.provider === "ngrok") await runNgrok(plan);
else runCloudflare(plan, settings.publicUrl!);

async function runNgrok(plan: Extract<TunnelPlan, { provider: "ngrok" }>) {
  try {
    const { default: ngrok } = await import("@ngrok/ngrok");
    const listener = await ngrok.forward({
      addr: "http://127.0.0.1:4310",
      authtoken: plan.authtoken,
      domain: plan.hostname,
    });
    await report(true, connected);
    console.log("固定 HTTPS 入口已啟動（ngrok）。");
    const stop = async () => {
      await listener.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    setInterval(() => void report(true, connected), 60000);
  } catch {
    await report(
      false,
      "ngrok 連線失敗，請檢查登入憑證、固定網址與免費額度；不會自動升級付費方案",
    );
    console.error("ngrok 連線失敗，請檢查設定與免費額度。");
    process.exit(1);
  }
}

function cloudflaredPath() {
  const local = join(
    dir,
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
  return (
    [process.env.CLOUDFLARED_PATH, local].find(
      (path) => path && existsSync(path),
    ) ?? "cloudflared"
  );
}

function processName(pid: number) {
  try {
    return process.platform === "win32"
      ? execFileSync(
          "tasklist",
          ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
          { encoding: "utf8", windowsHide: true },
        )
      : execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
          encoding: "utf8",
        });
  } catch {
    return "";
  }
}

/** 上一個通道程序被強制結束時，cloudflared 會留下來佔住狀態連接埠；先收掉它。 */
function stopLeftover(pidFile: string) {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (
      Number.isInteger(pid) &&
      pid > 0 &&
      /cloudflared/i.test(processName(pid))
    )
      process.kill(pid);
  } catch {
    // 沒有紀錄或程序已不存在。
  }
  rmSync(pidFile, { force: true });
}

function runCloudflare(
  plan: Extract<TunnelPlan, { provider: "cloudflare" }>,
  publicUrl: string,
) {
  const pidFile = join(dir, "cloudflared.pid");
  const binary = cloudflaredPath();
  let child: ChildProcess | undefined;
  let stopping = false;
  let restarts = 0;
  stopLeftover(pidFile);

  const start = () => {
    if (stopping) return;
    const current = spawn(binary, plan.args, {
      env: { ...process.env, ...plan.env },
      stdio: "inherit",
      windowsHide: true,
    });
    child = current;
    if (current.pid) writeFileSync(pidFile, String(current.pid));
    current.on("error", async (error: NodeJS.ErrnoException) => {
      await report(
        false,
        error.code === "ENOENT"
          ? "找不到 cloudflared，請先安裝（winget install Cloudflare.cloudflared）或設定 CLOUDFLARED_PATH"
          : "cloudflared 無法啟動，請查看 tunnel.log",
      );
      console.error(`cloudflared 無法啟動：${error.code ?? error.message}`);
      process.exit(1);
    });
    current.on("exit", (code) => {
      if (child === current) child = undefined;
      if (stopping) return;
      restarts += 1;
      const wait = Math.min(60000, 5000 * restarts);
      console.error(
        `cloudflared 已結束（代碼 ${code}），${wait / 1000} 秒後重新啟動。`,
      );
      setTimeout(start, wait);
    });
  };

  const check = async () => {
    let ready = false;
    try {
      ready = (
        await fetch(`http://127.0.0.1:${port}/ready`, {
          signal: AbortSignal.timeout(5000),
        })
      ).ok;
    } catch {
      // 狀態連接埠沒有回應：cloudflared 尚未啟動完成或已結束。
    }
    if (!ready)
      return report(
        false,
        "Cloudflare Tunnel 尚未連線，請檢查網路、通道權杖或設定檔",
      );
    const health = await publicHealth(publicUrl);
    if (health.ok) restarts = 0;
    await report(
      health.ok,
      health.ok
        ? connected
        : `Cloudflare Tunnel 已連線，但公開網址沒有回應（${health.detail}）；請確認通道的公開主機名稱指向 http://127.0.0.1:4310`,
    );
  };

  const stop = () => {
    stopping = true;
    child?.kill();
    rmSync(pidFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  start();
  console.log("固定 HTTPS 入口啟動中（Cloudflare Tunnel）。");
  setTimeout(() => void check(), 8000);
  setInterval(() => void check(), 30000);
}
