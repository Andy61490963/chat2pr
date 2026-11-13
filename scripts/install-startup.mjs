import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
if (process.platform !== "win32") throw Error("此啟動設定僅適用 Windows。");
const dir = dirname(fileURLToPath(import.meta.url));
const code =
  `$PSScriptRoot='${dir.replaceAll("'", "''")}';\n` +
  readFileSync(join(dir, "install-startup.ps1"), "utf8").replace(/^\uFEFF/, "");
const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", code], {
  windowsHide: true,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
