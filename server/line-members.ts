import { z } from "zod";
import type { Database } from "./db.js";
import { secrets } from "./config.js";

const Profile = z.object({ displayName: z.string().min(1).max(100) });
const MAX_LOOKUPS = 20;

// 聊天室顯示 LINE 名稱：先用快取，過期或沒有才向 LINE 查群組成員資料。
// 查不到（成員已退出、未設定 Token、LINE 暫時失敗）時回傳空值，由呼叫端退回群組內代號。
export async function memberNames(
  db: Database,
  groupId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const cached = await db.query<{
    user_id: string;
    display_name: string;
    fresh: boolean;
  }>(
    "SELECT user_id,display_name,fetched_at>now()-interval '7 days' AS fresh FROM line_members WHERE group_id=$1 AND user_id=ANY($2)",
    [groupId, ids],
  );
  const names = new Map(cached.map((r) => [r.user_id, r.display_name]));
  const token = secrets().lineToken;
  if (!token) return names;
  const kind = groupId.startsWith("R") ? "room" : "group";
  const stale = ids
    .filter((id) => !cached.some((r) => r.user_id === id && r.fresh))
    .slice(0, MAX_LOOKUPS);
  await Promise.all(
    stale.map(async (id) => {
      try {
        const response = await fetch(
          `https://api.line.me/v2/bot/${kind}/${encodeURIComponent(groupId)}/member/${encodeURIComponent(id)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(4000),
          },
        );
        if (!response.ok) return;
        const profile = Profile.safeParse(await response.json());
        if (!profile.success) return;
        names.set(id, profile.data.displayName);
        await db.query(
          "INSERT INTO line_members(group_id,user_id,display_name) VALUES($1,$2,$3) ON CONFLICT(group_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,fetched_at=now()",
          [groupId, id, profile.data.displayName],
        );
      } catch {
        // 查詢失敗不影響聊天室，沿用快取或代號。
      }
    }),
  );
  return names;
}
