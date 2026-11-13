import { Database } from "../server/db.js";
import { config } from "../server/config.js";
import { backup } from "../server/maintenance.js";
const db = new Database(config().databaseUrl);
try {
  console.log("備份完成：", await backup(db));
} finally {
  await db.close();
}
