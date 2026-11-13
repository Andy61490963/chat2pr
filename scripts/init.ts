import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
await mkdir(".local", { recursive: true, mode: 0o700 });
if (!existsSync(".env"))
  await writeFile(
    ".env",
    `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\n`,
    { mode: 0o600 },
  );
console.log("本機環境設定已準備。請執行 npm run setup 填入服務憑證。");
if (!/^ADMIN_GITHUB_ID=\d+\s*$/m.test(await readFile(".env", "utf8")))
  console.log(
    "還沒有指定擁有者：請在 .env 加上 ADMIN_GITHUB_ID=擁有者的 GitHub 數字 ID（查詢：gh api users/帳號 --jq .id）。",
  );
