import { Database } from "../server/db.js";
import { config } from "../server/config.js";
import { backup } from "../server/maintenance.js";
const db = new Database(config().databaseUrl);
try {
  // 第 5 版包含待挑選清單；格式版本由共用備份函式管理。
  console.log("備份完成：", await backup(db));
} finally {
  await db.close();
}
