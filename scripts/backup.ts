import { Database } from "../server/db.js";
import { config } from "../server/config.js";
import { backup } from "../server/maintenance.js";
const db = new Database(config().databaseUrl);
try {
  // 第 4 版包含需求的單一補問與預設假設；格式版本由共用備份函式管理。
  console.log("備份完成：", await backup(db));
} finally {
  await db.close();
}
