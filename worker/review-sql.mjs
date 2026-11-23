import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { verifyReviewCopy } from "./trusted-changes.mjs";

// 只有可信 runner 能掛載這兩個路徑，新卷由工作使用者擁有。保留建置與還原快取。
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.includes("\n")) break;
}
const { command, changeManifest, collectExclude } = JSON.parse(input);
try {
  await mkdir("/tmp/home", { recursive: true });
  const copy = spawnSync("cp", [
    "-a", "--reflink=auto", "--no-preserve=ownership", "/candidate/.", "/workspace/",
  ], { stdio: ["ignore", "inherit", "inherit"] });
  if (copy.status !== 0)
    throw new Error("無法把唯讀候選複製到審查專用工作卷，請檢查磁碟空間與檔案權限");
  await verifyReviewCopy(changeManifest, { exclude: collectExclude ?? [] });
} catch (error) {
  console.error("測試環境問題：SQL Server 審查副本準備失敗。", error.message);
  process.exit(86);
}
const test = spawnSync("sh", ["-c", command], { stdio: ["ignore", "inherit", "inherit"] });
if (test.error) console.error("無法啟動 SQL Server 審查測試。", test.error.message);
process.exitCode = test.status ?? 1;
if (test.status === 0)
  await verifyReviewCopy(changeManifest, { exclude: collectExclude ?? [] });
