import { splitQueryAnswer } from "../shared/query-answer.js";
import { discordDeliveryNotes } from "../shared/status-glossary.js";
import { maxPushAttempts, repliesOffNote } from "../shared/group-delivery.js";
import type { Database, DbClient } from "./db.js";
import {
  discordRetryMs,
  discordStatus,
  type DiscordChatPlatform,
} from "./discord-platform.js";
import { claimingNote, type QuickReply } from "./group-replies.js";
import { config } from "./config.js";
import { prepareDigest } from "./line-private.js";
import { linePrivateDefaults } from "../shared/line-private.js";

export function discordDeliveryError(error: unknown) {
  switch (discordStatus(error)) {
    case 401:
      return discordDeliveryNotes.token;
    case 403:
      return discordDeliveryNotes.permission;
    case 404:
      return discordDeliveryNotes.missing;
    case 400:
      return discordDeliveryNotes.content;
    case 429:
      return discordDeliveryNotes.rate;
    default:
      return discordDeliveryNotes.unavailable;
  }
}

export async function deferDiscordNotices(
  c: DbClient,
  ids: string[],
  delay: number,
) {
  await c.query(
    `UPDATE notifications SET sent_at=NULL,discord_retry_at=clock_timestamp()+$2::double precision*interval '1 millisecond',
       last_error=$3 WHERE id=ANY($1::uuid[])`,
    [ids, delay, discordDeliveryNotes.rate],
  );
}

async function sendNotice(
  c: DbClient,
  id: string,
  send: () => Promise<string | null>,
) {
  let messageId: string | null;
  try {
    messageId = await send();
  } catch (error) {
    const delay = discordRetryMs(error);
    if (delay !== null) await deferDiscordNotices(c, [id], delay);
    else
      await c.query(
        "UPDATE notifications SET attempts=attempts+1,last_error=$2,discord_retry_at=NULL WHERE id=$1",
        [id, discordDeliveryError(error)],
      );
    return;
  }
  await c.query(
    `UPDATE notifications SET sent_at=now(),sent_message_id=$2,attempts=attempts+1,
       last_error=NULL,discord_retry_at=NULL WHERE id=$1`,
    [id, messageId],
  );
}

const due = `n.sent_at IS NULL AND n.attempts<$1 AND
  (n.discord_retry_at IS NULL OR n.discord_retry_at<=now())`;

export async function flushDiscordNotifications(
  db: Database,
  platform: DiscordChatPlatform,
) {
  const settings = await db.settings();
  await db.transaction(async (c) => {
    await c.query(
      `UPDATE notifications n SET sent_at=now(),last_error=$1
       FROM (SELECT n.id FROM notifications n JOIN groups g ON g.id=n.group_id
         WHERE g.platform='discord' AND n.sent_at IS NULL AND ($2 OR g.reply_mode='off' OR g.left_at IS NOT NULL)
         FOR UPDATE OF n SKIP LOCKED) stopped WHERE stopped.id=n.id`,
      [repliesOffNote, settings.group_replies === false],
    );
  });
  if (settings.group_replies !== false) {
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await sendNextGroup(db, platform, seen);
      if (!id) break;
      seen.push(id);
    }
  }

  if (
    settings.admin_notify_platform !== "discord" ||
    !settings.admin_discord_id
  )
    return;
  await flushDiscordPrivate(db, platform, settings);
}

async function sendNextGroup(
  db: Database,
  platform: DiscordChatPlatform,
  seen: string[],
) {
  return db.transaction(async (c) => {
    const {
      rows: [n],
    } = await c.query<{
      id: string;
      channel_id: string;
      kind: string;
      text: string;
      origin: string | null;
      quick_replies: QuickReply[] | null;
    }>(
      // 撤回只移除引用，目的地仍是原頻道或討論串。較新的補送要先結算，才決定是否推播舊通知。
      `SELECT n.id,n.kind,n.text,n.quick_replies,COALESCE(target.thread_id,g.id) AS channel_id,
         COALESCE(CASE WHEN NOT direct.revoked THEN COALESCE(direct.discord_reply_message_id,direct.discord_message_id) END,
           source.message_id) AS origin
       FROM notifications n JOIN groups g ON g.id=n.group_id
       LEFT JOIN tasks t ON t.id=n.task_id AND t.group_id=g.id
       LEFT JOIN messages direct ON direct.id=n.source_message_id AND direct.group_id=g.id
       CROSS JOIN LATERAL (
         SELECT CASE WHEN n.source_message_id IS NOT NULL
           THEN COALESCE(n.discord_thread_id,direct.discord_thread_id) ELSE t.discord_thread_id END AS thread_id
       ) target
       LEFT JOIN LATERAL (
         SELECT COALESCE(m.discord_reply_message_id,m.discord_message_id) AS message_id
         FROM unnest(t.source_ids) WITH ORDINALITY AS s(id,pos)
         JOIN messages m ON m.id=s.id AND m.group_id=g.id
         WHERE NOT m.revoked AND m.discord_thread_id IS NOT DISTINCT FROM target.thread_id
           AND (m.discord_reply_message_id IS NOT NULL OR m.discord_message_id IS NOT NULL)
         ORDER BY s.pos LIMIT 1
       ) source ON true
       WHERE g.platform='discord' AND g.reply_mode<>'off' AND g.left_at IS NULL AND ${due}
       AND n.id<>ALL($2::uuid[])
       AND (n.kind IN ('group_received','group_waiting') OR NOT EXISTS (
         SELECT 1 FROM notifications p WHERE p.task_id=n.task_id AND p.group_id=n.group_id
           AND p.created_at>=n.created_at AND p.sent_at IS NOT NULL
           AND p.sent_message_id IS NULL AND p.last_error=$3
       ))
       AND COALESCE((SELECT (value->>'group_replies')::boolean FROM settings WHERE id=1),true)
       ORDER BY n.created_at,n.id LIMIT 1 FOR UPDATE OF g,n SKIP LOCKED`,
      [maxPushAttempts, seen, claimingNote],
    );
    if (!n) return;
    if (n.kind === "group_received" && !n.origin) {
      await c.query(
        "UPDATE notifications SET sent_at=now(),last_error=$2 WHERE id=$1",
        [n.id, discordDeliveryNotes.origin],
      );
      return n.id;
    }
    await sendNotice(c, n.id, async () => {
      if (n.kind === "group_received" && n.origin) {
        await platform.react(n.channel_id, n.origin);
        // 反應沒有自己的訊息識別碼，原文仍屬於群組成員。
        return null;
      }
      const result = await platform.sendToGroup(
        n.channel_id,
        {
          text:
            n.kind === "group_answered"
              ? splitQueryAnswer(n.text).body
              : n.text,
          quick: n.quick_replies,
        },
        n.id,
        n.origin ?? undefined,
      );
      return result.messageId;
    });
    return n.id;
  });
}

/**
 * 管理者私訊與 LINE 共用摘要流程：只送需要動手的事、超過 24 小時不補送、10 分鐘內最多一則。
 * 原本逐則送出，切到 Discord 時曾把好幾天前排隊的 90 則舊通知一次送出（#207）。
 */
async function flushDiscordPrivate(
  db: Database,
  platform: DiscordChatPlatform,
  settings: Awaited<ReturnType<Database["settings"]>>,
) {
  const recipient = settings.admin_discord_id;
  if (!recipient) return;
  const digest = await prepareDigest(
    db,
    settings.line_private_mode ?? linePrivateDefaults.line_private_mode,
  );
  if (!digest) return;
  try {
    await platform.sendToAdmin(recipient, digest.text, digest.id);
  } catch (error) {
    await db.transaction(async (c) => {
      const delay = discordRetryMs(error);
      if (delay !== null) await deferDiscordNotices(c, digest.itemIds, delay);
      else
        await c.query(
          `UPDATE notifications SET attempts=attempts+1,last_error=$2
           WHERE id=ANY($1::uuid[]) AND sent_at IS NULL`,
          [digest.itemIds, discordDeliveryError(error)],
        );
    });
    return;
  }
  await db.query(
    `UPDATE notifications SET sent_at=$3,attempts=attempts+1,discord_retry_at=NULL,
       last_error=CASE WHEN id=ANY($2::uuid[]) THEN NULL ELSE '已留在看板鈴鐺' END
     WHERE id=ANY($1::uuid[])`,
    [digest.itemIds, digest.itemIds.slice(0, 5), new Date()],
  );
}
