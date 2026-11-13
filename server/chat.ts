import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { requireUser } from "./auth.js";
import { AppError } from "./policy.js";
import { memberNames } from "./line-members.js";
import type { ChatMessage, ChatPage } from "../shared/chat.js";

export function registerChat(app: FastifyInstance, db: Database) {
  app.get("/api/groups/:id/messages", async (req, reply): Promise<ChatPage> => {
    reply.header("Cache-Control", "no-store");
    await requireUser(db, req);
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(req.params);
    const { before } = z
      .object({ before: z.string().min(1).max(200).optional() })
      .parse(req.query);
    if (!(await db.one("SELECT 1 FROM groups WHERE id=$1", [id])))
      throw new AppError(404, "找不到群組");
    if (
      before &&
      !(await db.one("SELECT 1 FROM messages WHERE id=$1 AND group_id=$2", [
        before,
        id,
      ]))
    )
      throw new AppError(400, "訊息分頁已失效，請重新整理");
    const rows = await db.query<
      ChatMessage & { user_id: string | null; quoted_user_id: string | null }
    >(
      `
      SELECT m.id,m.type,m.received_at,m.revoked,
        CASE WHEN q.id IS NOT NULL THEN left(coalesce(nullif(q.text,''),
          CASE q.type WHEN 'image' THEN '圖片' WHEN 'sticker' THEN '貼圖' ELSE '附件' END),200) END AS quoted_text,
        CASE WHEN q.user_id IS NOT NULL THEN '成員 '||left(md5(q.group_id||':'||q.user_id),6) END AS quoted_sender,
        q.user_id AS quoted_user_id,
        m.received_at<=message_retention_cutoff() AS expired,
        CASE WHEN NOT m.revoked AND m.received_at>message_retention_cutoff() THEN m.text END AS text,
        CASE WHEN NOT m.revoked AND m.received_at>message_retention_cutoff() AND m.user_id IS NOT NULL
          THEN '成員 '||left(md5(m.group_id||':'||m.user_id),6) END AS sender,
        CASE WHEN NOT m.revoked AND m.received_at>message_retention_cutoff() THEN m.user_id END AS user_id,
        CASE WHEN NOT m.revoked AND m.received_at>message_retention_cutoff() THEN m.quoted_id END AS quoted_id,
        (NOT m.revoked AND m.received_at>message_retention_cutoff() AND m.image IS NOT NULL) AS has_image,
        CASE WHEN m.type='image' AND NOT m.revoked AND m.received_at>message_retention_cutoff()
          THEN CASE WHEN m.image IS NOT NULL THEN 'ready' WHEN m.content_attempts>=3 THEN 'failed' ELSE 'pending' END END AS image_state,
        CASE WHEN m.trigger_mode='chat' THEN 'chat' WHEN m.processed THEN 'processed' ELSE 'pending' END AS routing,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'status',t.status) ORDER BY t.created_at)
          FROM tasks t WHERE t.group_id=m.group_id AND m.id=ANY(t.source_ids)),'[]'::jsonb) AS tasks
      FROM messages m
        -- 引用內容只在兩則訊息都還能顯示（未撤回、未到期）時才帶出。
        LEFT JOIN messages q ON q.id=m.quoted_id AND q.group_id=m.group_id
          AND NOT m.revoked AND m.received_at>message_retention_cutoff()
          AND NOT q.revoked AND q.received_at>message_retention_cutoff()
      WHERE m.group_id=$1
        AND ($2::text IS NULL OR (m.received_at,m.id)<(SELECT received_at,id FROM messages WHERE id=$2 AND group_id=$1))
      ORDER BY m.received_at DESC,m.id DESC LIMIT 51`,
      [id, before ?? null],
    );
    const visible = rows.slice(0, 50);
    // LINE 使用者 ID 只在伺服器端用來查名稱，不回傳給瀏覽器。
    const names = await memberNames(
      db,
      id,
      visible.flatMap((m) =>
        [m.user_id, m.quoted_user_id].filter((v): v is string => !!v),
      ),
    );
    const messages = visible.map(({ user_id, quoted_user_id, ...m }) => ({
      ...m,
      sender: (user_id && names.get(user_id)) || m.sender,
      quoted_sender:
        (quoted_user_id && names.get(quoted_user_id)) || m.quoted_sender,
    }));
    return {
      messages: messages.reverse(),
      next: rows.length > 50 ? rows[49].id : null,
    };
  });
}
