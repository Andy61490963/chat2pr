import { Database } from "./db.js";
import { config, secrets } from "./config.js";
import { buildApp } from "./app.js";
import { startJobs } from "./jobs.js";
import { startDiscord } from "./discord.js";
import { createDiscordGateway } from "./discord-gateway.js";
import { DiscordChatPlatform, discordRest } from "./discord-platform.js";
if (!/^\d+$/.test(config().adminId)) {
  console.error(
    "缺少擁有者：請在 .env 加上 ADMIN_GITHUB_ID=擁有者的 GitHub 數字 ID（查詢：gh api users/帳號 --jq .id），再重新啟動。",
  );
  process.exit(1);
}
const db = new Database(config().databaseUrl);
await db.migrate();
const { discordToken, discordApplicationId } = secrets();
const discordPlatform = discordToken ? new DiscordChatPlatform(discordRest(discordToken)) : undefined;
const jobs = await startJobs(db, { discord: discordPlatform });
const app = await buildApp(
  db,
  jobs.enqueueValidation,
  undefined,
  undefined,
  undefined,
  jobs.validationProgress,
);
await app.listen({ port: config().port, host: config().host });
const discord = startDiscord(db, discordToken, createDiscordGateway, discordPlatform, discordApplicationId);
console.log(`chat2pr 已啟動：http://${config().host}:${config().port}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void (async () => {
      await discord.stop();
      await app.close();
      await jobs.stop();
      await db.close();
      process.exit(0);
    })();
  });
