import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  unlinkSync,
  mkdirSync,
  closeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
mkdirSync(".local", { recursive: true });
const lock = resolve(".local/supervisor.pid");
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  try {
    process.kill(pid, 0);
    process.exit(0);
  } catch {
    unlinkSync(lock);
  }
}
const fd = openSync(lock, "wx");
writeFileSync(fd, String(process.pid));
closeSync(fd);
const children = new Map();
let stopping = false,
  busy = false;
const launch = (name, script) => {
  if (children.has(name)) return;
  const log = openSync(resolve(".local", name + ".log"), "a");
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  children.set(name, child);
  closeSync(log);
  child.on("exit", () => children.delete(name));
};
const note = (text) => {
  try {
    appendFileSync(
      resolve(".local/supervisor.log"),
      `${new Date().toISOString()} ${text}\n`,
    );
  } catch {}
};
// Docker 沒有回應時自己把 Docker Desktop 叫起來，不依賴它的「登入時啟動」設定。
// 引擎啟動要一兩分鐘，所以每三分鐘最多嘗試一次。
let dockerStartedAt = 0;
const startDocker = () => {
  if (process.platform !== "win32" || Date.now() - dockerStartedAt < 180000)
    return;
  const exe = [process.env.ProgramFiles, process.env.ProgramW6432]
    .filter(Boolean)
    .map((base) => resolve(base, "Docker/Docker/Docker Desktop.exe"))
    .find((path) => existsSync(path));
  if (!exe) return;
  dockerStartedAt = Date.now();
  note("Docker 沒有回應，啟動 Docker Desktop。");
  try {
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  } catch {}
};
const tick = async () => {
  if (busy || stopping) return;
  busy = true;
  try {
    if (
      spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 10000,
      }).status !== 0
    ) {
      startDocker();
      return;
    }
    const up = spawnSync(
      "docker",
      ["compose", "--profile", "full", "up", "-d"],
      { cwd: root, windowsHide: true, stdio: "ignore", timeout: 60000 },
    );
    if (up.status !== 0) return;
    let runnerActive = false;
    try {
      const s = JSON.parse(readFileSync(".local/secrets.json", "utf8"));
      runnerActive = (
        await fetch("http://127.0.0.1:4312/health", {
          headers: { "x-runner-key": s.runnerSecret },
          signal: AbortSignal.timeout(3000),
        })
      ).ok;
    } catch {}
    if (!runnerActive) launch("runner", "server/runner-main.ts");
    if (!children.has("tunnel")) {
      try {
        const s = JSON.parse(readFileSync(".local/secrets.json", "utf8"));
        // 與 server/tunnel-provider.ts 的判斷一致：選了自備入口就不啟動內建通道。
        const cloudflare = s.cloudflareTunnelToken || s.cloudflareConfig;
        const provider =
          s.tunnelProvider ?? (cloudflare ? "cloudflare" : "ngrok");
        const configured =
          provider === "cloudflare"
            ? cloudflare
            : provider === "ngrok" && s.ngrokToken;
        if (s.publicUrl && configured) launch("tunnel", "scripts/tunnel.ts");
      } catch {}
    }
  } finally {
    busy = false;
  }
};
process.on("exit", () => {
  try {
    if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  } catch {}
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    for (const child of children.values()) child.kill();
    process.exit(0);
  });
await tick();
setInterval(() => void tick(), 30000);
