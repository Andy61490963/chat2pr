import { Database } from "./db.js";
import { config } from "./config.js";
import { buildApp } from "./app.js";
import { startJobs } from "./jobs.js";
import { discordConnection } from "./discord-connection.js";
import { createDiscordGateway } from "./discord-gateway.js";
if (!/^\d+$/.test(config().adminId)) {
  console.error(
    "缺少擁有者：請在 .env 加上 ADMIN_GITHUB_ID=擁有者的 GitHub 數字 ID（查詢：gh api users/帳號 --jq .id），再重新啟動。",
  );
  process.exit(1);
}
const db = new Database(config().databaseUrl);
await db.migrate();
const discord = discordConnection(db, createDiscordGateway);
const jobs = await startJobs(db, { discord: discord.platform });
const app = await buildApp(
  db,
  jobs.enqueueValidation,
  undefined,
  undefined,
  undefined,
  jobs.validationProgress,
  () => void discord.refresh(),
);
await app.listen({ port: config().port, host: config().host });
await discord.refresh();
// 本機設定頁也能更新 Discord，容器若稍晚看到新檔，可在下一輪補套用。
const discordRefresh = setInterval(() => void discord.refresh(), 5000);
console.log(`chat2pr 已啟動：http://${config().host}:${config().port}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void (async () => {
      clearInterval(discordRefresh);
      await discord.stop();
      await app.close();
      await jobs.stop();
      await db.close();
      process.exit(0);
    })();
  });
