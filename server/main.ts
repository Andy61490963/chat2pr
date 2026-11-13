import { Database } from "./db.js";
import { config } from "./config.js";
import { buildApp } from "./app.js";
import { startJobs } from "./jobs.js";
if (!/^\d+$/.test(config().adminId)) {
  console.error(
    "缺少擁有者：請在 .env 加上 ADMIN_GITHUB_ID=擁有者的 GitHub 數字 ID（查詢：gh api users/帳號 --jq .id），再重新啟動。",
  );
  process.exit(1);
}
const db = new Database(config().databaseUrl);
await db.migrate();
const jobs = await startJobs(db);
const app = await buildApp(db, jobs.enqueueValidation);
await app.listen({ port: config().port, host: config().host });
console.log(`LINE-AgentFlow 已啟動：http://${config().host}:${config().port}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void (async () => {
      await app.close();
      await jobs.stop();
      await db.close();
      process.exit(0);
    })();
  });
