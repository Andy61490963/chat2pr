import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { requireUser } from "./auth.js";
import { AppError } from "./policy.js";
import { memberNames } from "./line-members.js";
import type { ChatMessage, ChatPage } from "../shared/chat.js";
import { type BotMessage, deliveryState } from "../shared/group-delivery.js";

/**
 * 一頁最多帶幾則機器人訊息；成員很少發言、機器人卻說很多時避免一次回傳過大。
 * 超過時不是丟掉較舊的，而是把本頁的成員訊息縮短（見 registerChat），讓較舊的機器人訊息落到下一頁。
 */
const botLimit = 200;

/**
 * 機器人送到本群組的訊息，時間範圍對齊成員訊息的分頁（分頁游標仍只看 messages）：
 * 上限是 before 那則（上一頁最舊一則）的時間，不含；下限是本頁最舊一則的時間，含。
 * 相鄰兩頁共用同一個界線，所以不重複也不遺漏；最後一頁（next 為 null）不設下限。
 * 時間比較都在 SQL 內完成，不把 received_at 傳回 JS（Date 只到毫秒，會漏掉同一毫秒的列）。
 * 最多取 botLimit+1 則（由舊到新），多出的那一則讓呼叫端知道超量了。
 */
async function botMessages(
  db: Database,
  groupId: string,
  before: string | null,
  oldest: string | null,
): Promise<BotMessage[]> {
  const rows = await db.query<{
    id: string;
    kind: string;
    task_id: string | null;
    task_title: string | null;
    created_at: string;
    text: string | null;
    sent_at: string | null;
    has_message_id: boolean;
    attempts: number;
    last_error: string | null;
  }>(
    `SELECT n.id,n.kind,n.task_id,t.title AS task_title,n.created_at,
       CASE WHEN n.created_at>message_retention_cutoff() THEN left(n.text,4500) END AS text,
       n.sent_at,n.sent_message_id IS NOT NULL AS has_message_id,n.attempts,n.last_error
     FROM notifications n LEFT JOIN tasks t ON t.id=n.task_id AND t.group_id=n.group_id
     WHERE n.group_id=$1
       AND ($2::text IS NULL OR n.created_at<(SELECT received_at FROM messages WHERE id=$2 AND group_id=$1))
       AND ($3::text IS NULL OR n.created_at>=(SELECT received_at FROM messages WHERE id=$3 AND group_id=$1))
     ORDER BY n.created_at DESC,n.id DESC LIMIT ${botLimit + 1}`,
    [groupId, before, oldest],
  );
  // 原始 last_error 與 LINE 訊息 ID 只在這裡用來判斷狀態，不回傳給瀏覽器。
  return rows.reverse().map((n) => ({
    id: n.id,
    kind: n.kind,
    task_id: n.task_id,
    task_title: n.task_title,
    created_at: n.created_at,
    text: n.text,
    delivery: deliveryState(n),
  }));
}

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
        coalesce(CASE WHEN q.id IS NOT NULL THEN left(coalesce(nullif(q.text,''),
          CASE q.type WHEN 'image' THEN '圖片' WHEN 'sticker' THEN '貼圖' ELSE '附件' END),200) END,
          left(bn.text,200)) AS quoted_text,
        CASE WHEN q.user_id IS NOT NULL THEN '成員 '||left(md5(q.group_id||':'||q.user_id),6)
          WHEN q.id IS NULL AND bn.text IS NOT NULL THEN '機器人' END AS quoted_sender,
        CASE WHEN q.id IS NULL THEN bn.id END AS quoted_bot_id,
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
        -- 引用機器人送到本群組的訊息（以 LINE 回傳的訊息 ID 對應）；同樣受保留期限限制。
        LEFT JOIN LATERAL (SELECT n.id,n.text FROM notifications n
          WHERE n.sent_message_id=m.quoted_id AND n.group_id=m.group_id
            AND n.created_at>message_retention_cutoff()
            AND NOT m.revoked AND m.received_at>message_retention_cutoff()
          ORDER BY n.created_at DESC LIMIT 1) bn ON true
      WHERE m.group_id=$1
        AND ($2::text IS NULL OR (m.received_at,m.id)<(SELECT received_at,id FROM messages WHERE id=$2 AND group_id=$1))
      ORDER BY m.received_at DESC,m.id DESC LIMIT 51`,
      [id, before ?? null],
    );
    let visible = rows.slice(0, 50);
    let next = rows.length > 50 ? rows[49].id : null;
    let bots = await botMessages(db, id, before ?? null, next);
    if (bots.length > botLimit && visible.length) {
      // 這段時間機器人訊息太多：把本頁成員訊息縮到「第 botLimit 新的機器人訊息」之後，
      // 下一頁從那裡接著，較舊的機器人訊息才不會因為上限被丟掉。
      const cut = await db.one<{ id: string }>(
        `SELECT m.id FROM messages m
         WHERE m.group_id=$1 AND m.id=ANY($2::text[])
           AND m.received_at>=(SELECT created_at FROM notifications WHERE id=$3)
         ORDER BY m.received_at,m.id LIMIT 1`,
        [id, visible.map((m) => m.id), bots[bots.length - botLimit].id],
      );
      // 本頁成員訊息全都比那則機器人訊息舊時，至少留最新一則，分頁才會往前推進。
      const keep = cut ? visible.findIndex((m) => m.id === cut.id) + 1 : 1;
      if (keep > 0 && (keep < visible.length || !next)) {
        visible = visible.slice(0, keep);
        next = visible[keep - 1].id;
        bots = await botMessages(db, id, before ?? null, next);
      }
    }
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
      // 縮不了（本頁沒有成員訊息可縮）時只留最新的 botLimit 則。
      bot_messages: bots.slice(-botLimit),
      next,
    };
  });
}
