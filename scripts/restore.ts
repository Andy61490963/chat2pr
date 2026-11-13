import { Database } from "../server/db.js";
import { config } from "../server/config.js";
import { decodeBackup, backupTables } from "../server/maintenance.js";
const file = process.argv[2];
if (!file) throw Error("請指定加密備份路徑；還原只接受空白資料庫。");
const snapshot = await decodeBackup(file);
if (![1, 2, 3, 4].includes(snapshot.version) || !snapshot.tables)
  throw Error("不支援的備份格式");
const optionalInLegacy = new Set([
  "rag_references",
  "group_projects",
  "group_memories",
  "project_knowledge",
]);
// 第 3 版起才備份成員名單；更早的備份沒有這張表，還原後只有擁有者能登入。
const withoutMembers = snapshot.version < 3 && !("members" in snapshot.tables);
const withoutClarification = snapshot.version < 4;
const db = new Database(config().databaseUrl);
try {
  await db.migrate();
  await db.transaction(async (c) => {
    for (const table of backupTables.filter((t) => t !== "settings")) {
      if ((await c.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount)
        throw Error("目的資料庫不是空白，已停止還原；請建立新的資料庫。");
    }
    const defaults = (await c.query("DELETE FROM settings RETURNING value"))
      .rows[0].value;
    for (const table of backupTables) {
      if (
        snapshot.version === 1 &&
        optionalInLegacy.has(table) &&
        !(table in snapshot.tables)
      )
        continue;
      if (table === "members" && withoutMembers) continue;
      if (!Array.isArray(snapshot.tables[table]))
        throw Error("備份資料表不完整");
      const rows = snapshot.tables[table];
      if (!rows.length) continue;
      // 只寫回快照當時的欄位。升級新增的欄位由目前資料表套用預設值。
      const { rows: columns } = await c.query<{ name: string }>(
        "SELECT quote_ident(attname) AS name FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attname=ANY($2::text[]) ORDER BY attnum",
        [table, Object.keys(rows[0])],
      );
      if (!columns.length) throw Error("備份資料表缺少必要欄位");
      const fields = columns.map((col) => col.name).join(",");
      await c.query(
        `INSERT INTO ${table} (${fields}) SELECT ${fields} FROM json_populate_recordset(NULL::${table},$1)`,
        [JSON.stringify(rows)],
      );
    }
    // 較早的備份以 groups.project_id 保存單一綁定，直接沿用可辨識的對應。
    if (snapshot.version === 1 && !("group_projects" in snapshot.tables)) {
      await c.query(
        "INSERT INTO group_projects(group_id,project_id) SELECT id,project_id FROM groups WHERE project_id IS NOT NULL ON CONFLICT DO NOTHING",
      );
      await c.query(
        "UPDATE groups SET project_id=NULL WHERE project_id IS NOT NULL",
      );
    }
    await c.query(
      "UPDATE settings SET value=$1::jsonb || value || '{\"paused\":true}'::jsonb",
      [defaults],
    );
    await c.query("UPDATE groups SET enabled=false");
    await c.query("UPDATE projects SET enabled=false,validated_at=NULL");
    await c.query("UPDATE reservations SET released=true");
    await c.query(
      "UPDATE tasks SET status='failed',last_error='由備份還原，重試前須核對遠端結果' WHERE status IN ('running','reviewing','queued')",
    );
    for (const table of ["audit", "usage"])
      await c.query(
        `SELECT setval(pg_get_serial_sequence('${table}','id'),COALESCE((SELECT max(id) FROM ${table}),0)+1,false)`,
      );
  });
  console.log("還原完成。系統維持暫停，請重新驗證專案與遠端 PR 後啟用。");
  if (snapshot.version === 1 && !("group_projects" in snapshot.tables))
    console.log(
      "這份舊備份缺少多專案綁定與記憶，請核對群組綁定與記憶後再啟用。",
    );
  if (withoutMembers)
    console.log(
      "這份備份沒有成員名單，目前只有擁有者能登入；請到看板重新加入其他管理者與成員。",
    );
  if (withoutClarification)
    console.log(
      "這份舊備份沒有結構化的補問與假設；原需求摘要仍保留，請在任務詳情核對。",
    );
} finally {
  await db.close();
}
