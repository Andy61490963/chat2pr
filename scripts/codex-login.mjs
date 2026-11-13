// 以服務專用的 CODEX_HOME 登入 ChatGPT，不與個人 Codex App 共用登入檔。
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(root, process.env.CODEX_SERVICE_HOME ?? ".codex-service");
mkdirSync(home, { recursive: true });
const cli = createRequire(import.meta.url).resolve(
  "@openai/codex/bin/codex.js",
);
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [cli, "login", ...args], {
  stdio: "inherit",
  env: { ...process.env, CODEX_HOME: home },
});
process.exit(result.status ?? 1);
