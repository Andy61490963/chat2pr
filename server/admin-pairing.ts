import type { ChatPlatformId } from "../shared/types.js";
import { groupPlatformLabels } from "../shared/status-glossary.js";
import { hash } from "./auth.js";
import type { Database, DbClient } from "./db.js";

export async function pairAdmin(
  db: Database,
  c: DbClient,
  platform: ChatPlatformId,
  user: string,
  text: string,
) {
  const match = /^配對\s+([a-f0-9]{16})$/i.exec(text.trim());
  if (!match) return false;
  // 配對與產生代碼都先鎖設定，避免兩個平台同時綁定或使用舊代碼。
  await c.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
  const found = await c.query(
    `UPDATE pairing_codes SET consumed_at=now()
     WHERE code_hash=$1 AND platform=$2 AND expires_at>now() AND consumed_at IS NULL RETURNING code_hash`,
    [hash(match[1].toLowerCase()), platform],
  );
  if (!found.rowCount) return false;
  await c.query(
    "UPDATE settings SET value=jsonb_set(value,ARRAY[$2::text],to_jsonb($1::text)) WHERE id=1",
    [user, platform === "line" ? "admin_line_id" : "admin_discord_id"],
  );
  await db.audit(
    null,
    "pairing",
    `管理者 ${groupPlatformLabels[platform]} 通知身分已綁定`,
    c,
  );
  return true;
}
