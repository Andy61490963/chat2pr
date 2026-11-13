import { z } from "zod";
import type { Database } from "./db.js";
import { secrets } from "./config.js";

const Summary = z.object({ groupName: z.string().min(1).max(100) });

// 群組名稱以 LINE 為準：收到訊息與每小時維護時同步，一小時內不重複查詢。
// 多人聊天室（R 開頭）沒有名稱；未設定 Token 或查詢失敗時保留目前名稱。
export async function syncGroupNames(db: Database, only?: string[]) {
  const token = secrets().lineToken;
  if (!token) return;
  const groups = await db.query<{ id: string }>(
    `SELECT id FROM groups WHERE id LIKE 'C%'
       AND (name_synced_at IS NULL OR name_synced_at<now()-interval '1 hour')
       AND ($1::text[] IS NULL OR id=ANY($1))
     ORDER BY name_synced_at NULLS FIRST LIMIT 20`,
    [only ?? null],
  );
  for (const { id } of groups) {
    try {
      const response = await fetch(
        `https://api.line.me/v2/bot/group/${encodeURIComponent(id)}/summary`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(4000),
        },
      );
      if (!response.ok) continue;
      const summary = Summary.safeParse(await response.json());
      if (!summary.success) continue;
      await db.query(
        "UPDATE groups SET name=$2,name_synced_at=now() WHERE id=$1",
        [id, summary.data.groupName],
      );
    } catch {
      // LINE 暫時無法連線時保留目前名稱，下次再同步。
    }
  }
}

// 機器人被加進新群組時通知管理者去綁專案並啟用；群組預設停用，不講就沒人知道。
// 先等名稱同步，通知才叫得出群組名；同步不到（多人聊天室、未設定 Token）最多等兩分鐘。
export async function announceNewGroups(db: Database) {
  await db.query(
    `WITH fresh AS (
       UPDATE groups SET announced_at=now()
       WHERE announced_at IS NULL AND left_at IS NULL
         AND (name_synced_at IS NOT NULL OR created_at<now()-interval '2 minutes')
       RETURNING id,name,enabled)
     INSERT INTO notifications(kind,dedupe_key,text)
     SELECT 'group_new','group_new:'||id,'機器人加入了新群組「'||name||'」，目前尚未啟用。請到群組頁綁定專案並啟用，才會開始接收需求。'
     FROM fresh WHERE NOT enabled ON CONFLICT DO NOTHING`,
  );
}
