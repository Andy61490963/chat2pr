import { mkdir, writeFile, readdir, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { Database } from "./db.js";
import type { Line } from "./line.js";
import { config, secrets } from "./config.js";
export const backupTables = [
  "settings",
  "members",
  "projects",
  "groups",
  "group_projects",
  "group_memories",
  "project_knowledge",
  "tasks",
  "task_versions",
  "audit",
  "rag_references",
  "reservations",
  "usage",
  "notifications",
  "service_health",
] as const;
export async function cleanup(db: Database) {
  await db.query(
    "DELETE FROM query_report_images WHERE NOT query_report_image_visible(id)",
  );
  await db.query(
    "DELETE FROM image_observations o USING messages m WHERE o.message_id=m.id AND (m.revoked OR m.received_at<=message_retention_cutoff() OR m.image IS NULL OR o.source_hash<>encode(sha256(m.image),'hex'))",
  );
  await db.query(
    "UPDATE run_events SET detail=NULL WHERE detail IS NOT NULL AND NOT run_content_visible(run_id)",
  );
  await db.query(
    "UPDATE messages SET text=NULL,image=NULL,image_mime=NULL,user_id=NULL,processed=true WHERE received_at<=message_retention_cutoff() AND (text IS NOT NULL OR image IS NOT NULL OR image_mime IS NOT NULL OR user_id IS NOT NULL OR NOT processed)",
  );
  // 成員名稱只隨仍可讀的訊息保留；發話者清除後名稱一併刪除。
  await db.query(
    "DELETE FROM line_members lm WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.group_id=lm.group_id AND m.user_id=lm.user_id)",
  );
  await db.query("DELETE FROM sessions WHERE expires_at<now()");
  await db.query("DELETE FROM oauth_states WHERE expires_at<now()");
  await db.query("DELETE FROM pairing_codes WHERE expires_at<now()");
  await db.query(
    "DELETE FROM events WHERE received_at<now()-interval '90 days'",
  );
}
export async function downloadPendingImages(
  db: Database,
  line: Pick<Line, "image">,
) {
  const messages = await db.query<{ id: string }>(
    "SELECT id FROM messages WHERE type='image' AND image IS NULL AND NOT revoked AND content_attempts<3 AND received_at>message_retention_cutoff() ORDER BY received_at LIMIT 10",
  );
  for (const { id } of messages) {
    const claimed = await db.query(
      "UPDATE messages SET content_attempts=content_attempts+1 WHERE id=$1 AND image IS NULL AND NOT revoked AND content_attempts<3 AND received_at>message_retention_cutoff() RETURNING id",
      [id],
    );
    if (!claimed.length) continue;
    try {
      const content = await line.image(id);
      await db.query(
        "UPDATE messages SET image=$2,image_mime=$3 WHERE id=$1 AND NOT revoked AND received_at>message_retention_cutoff()",
        [id, content.data, content.mime],
      );
    } catch {
      await db.query(
        "INSERT INTO service_health(name,ok,detail) VALUES('images',false,'圖片下載失敗，會有限次重試；無法取得時交由人工確認') ON CONFLICT(name) DO UPDATE SET ok=false,detail=EXCLUDED.detail,checked_at=now()",
      );
    }
  }
}
export async function backup(db: Database) {
  const secret = secrets().sessionSecret;
  if (!secret) throw new Error("備份加密金鑰尚未設定");
  const folder = join(config().dataDir, "backups");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const snapshot = await db.transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const data: Record<string, unknown> = {};
    for (const table of backupTables)
      data[table] = (await c.query(`SELECT * FROM ${table}`)).rows;
    return data;
  });
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      iv,
    );
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ version: 3, tables: snapshot }), "utf8"),
    cipher.final(),
  ]);
  const name = `agentflow-${new Date().toISOString().slice(0, 10)}.afbackup`;
  await writeFile(
    join(folder, name),
    Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
    { mode: 0o600 },
  );
  const files = (await readdir(folder))
    .filter((f) => /^agentflow-\d{4}-\d{2}-\d{2}\.afbackup$/.test(f))
    .sort()
    .reverse();
  for (const f of files.slice(7)) await unlink(join(folder, f));
  await db.audit(
    null,
    "backup",
    "非原文資料備份完成；原始聊天、圖片、登入工作階段與執行憑證未納入",
  );
  return name;
}
export async function decodeBackup(path: string) {
  const data = await readFile(path),
    secret = secrets().sessionSecret;
  if (!secret) throw new Error("缺少原備份加密金鑰");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secret).digest(),
    data.subarray(0, 12),
  );
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString(),
  );
}
