import { Database } from "./db.js";
import { config } from "./config.js";
const db = new Database(config().databaseUrl);
await db.migrate();
await db.close();
console.log("資料庫結構已更新");
