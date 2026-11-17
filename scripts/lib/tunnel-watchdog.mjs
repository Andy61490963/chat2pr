import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { opensConsoleWindow } from "./startup-task.mjs";

/**
 * 外部通道看門狗（Windows 主機監督程式 start-windows.mjs 每 30 秒呼叫一次）。
 *
 * 正式入口若由儲存庫外的通道程序維護（例如 .local 底下的 Cloudflare 監督程式，
 * 由獨立的排程工作啟動），那個程序每 30 秒寫一次 .local/tunnel-status.json。
 * 檔案超過 3 分鐘沒更新，代表外部監督程式停了：被主控台中斷結束時，
 * Windows 排程工作的「失敗後重試」不會觸發，入口會一直斷著（部署後驗收時發生）。
 * 這時找出動作指向本目錄 .local 通道腳本的排程工作，重新啟動它。
 */

export const STALE_MS = 3 * 60 * 1000;
export const RETRY_MS = 3 * 60 * 1000;
const STATUS_FILE = ".local/tunnel-status.json";

/** 狀態檔是否過期；沒有狀態檔回傳 null（沒有外部通道，不處理）。 */
export function statusAge(text, now = Date.now()) {
  if (text === undefined) return null;
  try {
    const at = Date.parse(JSON.parse(text).checked_at);
    return Number.isFinite(at) ? now - at : Infinity;
  } catch {
    return Infinity;
  }
}

const norm = (path) =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * 從排程工作清單（每行「工作路徑|工作名稱|執行檔 參數」）找出啟動本目錄外部通道的工作：
 * 動作參數指向 <root>/.local/ 底下、檔名含 cloudflare 或 tunnel 的腳本。
 */
export function findTunnelTask(listing, root) {
  const local = `${norm(root)}/.local/`;
  for (const line of listing.split(/\r?\n/)) {
    const [path, name, ...rest] = line.split("|");
    if (!path || !name) continue;
    const raw = rest.join("|");
    const action = norm(raw.replace(/"/g, ""));
    const at = action.indexOf(local);
    if (at < 0) continue;
    const script = action.slice(at + local.length).split(/\s/)[0];
    if (/cloudflare|tunnel/.test(script) && !script.includes("/"))
      return {
        path: path.trim(),
        name: name.trim(),
        visible: opensConsoleWindow(raw),
      };
  }
  return null;
}

const quote = (value) => `'${value.replace(/'/g, "''")}'`;

function powershell(command, run) {
  return run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
    ],
    { windowsHide: true, encoding: "utf8", timeout: 30000 },
  );
}

/**
 * 建立看門狗。deps 可替換讀檔、執行指令與時間，方便測試。
 * 回傳的 check() 每次巡檢呼叫；需要時重新啟動外部通道的排程工作並回傳說明文字。
 */
export function tunnelWatchdog({
  root,
  note,
  platform = process.platform,
  read = (path) => readFileSync(path, "utf8"),
  run = spawnSync,
  now = () => Date.now(),
}) {
  let lastAttempt = 0;
  let task;
  let warnedVisible = false;
  return function check() {
    if (platform !== "win32") return null;
    let text;
    try {
      text = read(resolve(root, STATUS_FILE));
    } catch {
      return null;
    }
    const age = statusAge(text, now());
    if (age === null || age < STALE_MS) return null;
    if (now() - lastAttempt < RETRY_MS) return null;
    lastAttempt = now();
    if (!task) {
      const list = powershell(
        "Get-ScheduledTask | ForEach-Object { $t = $_; foreach ($a in $t.Actions) { '{0}|{1}|{2} {3}' -f $t.TaskPath, $t.TaskName, $a.Execute, $a.Arguments } }",
        run,
      );
      task = list.status === 0 ? findTunnelTask(list.stdout ?? "", root) : null;
    }
    const minutes = Number.isFinite(age) ? Math.round(age / 60000) : "?";
    if (!task) {
      note(
        `外部通道狀態檔已 ${minutes} 分鐘沒有更新，但找不到啟動它的排程工作，請手動檢查。`,
      );
      return "not-found";
    }
    const started = powershell(
      `Start-ScheduledTask -TaskPath ${quote(task.path)} -TaskName ${quote(task.name)}`,
      run,
    );
    if (started.status === 0) {
      note(
        `外部通道狀態檔已 ${minutes} 分鐘沒有更新，重新啟動排程工作「${task.name}」。` +
          (task.visible && !warnedVisible
            ? "這個工作會開出可見的主控台視窗，視窗被關掉通道就會斷線；建議把動作改成經 conhost.exe --headless 執行（見部署手冊〈自備入口〉）。"
            : ""),
      );
      if (task.visible) warnedVisible = true;
      return "restarted";
    }
    note(
      `外部通道狀態檔已 ${minutes} 分鐘沒有更新，重新啟動排程工作「${task.name}」失敗：${String(
        started.stderr ?? "",
      )
        .trim()
        .slice(0, 300)}`,
    );
    // 工作可能被改名或刪除；下次重新尋找。
    task = undefined;
    return "failed";
  };
}
