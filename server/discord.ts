import type { Database, DbClient } from "./db.js";
import { discordId } from "./chat-platform.js";
import { discordImageUrl } from "./chat-image.js";
import { invalidateMessageSources } from "./message-sources.js";
import { isTaskCommand } from "../shared/chat.js";
import { redact } from "./policy.js";
import { discordServiceText } from "../shared/status-glossary.js";
import { recordHealth } from "./health.js";
import { clearEmptyTriageWindow } from "./triage-window.js";

type Source = { id: string; channel: string };
export type DiscordMessageEvent =
  | (Source & {
      type: "create";
      name: string;
      author: { id: string; name: string; bot?: boolean };
      text: string;
      images: readonly string[];
      quotedId?: string;
      botId: string;
    })
  | (Source & {
      type: "update";
      editedAt: string;
      text?: string;
      images?: readonly string[];
      botId: string;
    })
  | (Source & { type: "delete" });

type ExistingMessage = {
  id: string;
  user_id: string | null;
  sender_name: string | null;
  text: string | null;
  quoted_id: string | null;
  image_source_url: string | null;
  discord_edited_at: Date | null;
  revoked: boolean;
  processed: boolean;
  trigger_mode: string;
  needs_source_review: boolean;
  expired: boolean;
};

type Group = { enabled: boolean; trigger_mode: "auto" | "command" };

function messageRows(id: string, text: string, urls: readonly string[]) {
  const images = urls.flatMap((raw) => {
    const url = discordImageUrl(raw);
    return url
      ? [
          {
            id: `${id}:image:${new URL(url).pathname.split("/")[3]}`,
            text: null,
            url,
          },
        ]
      : [];
  });
  // 只有圖片時，第一張沿用原訊息識別碼，讓引用仍能找到它。
  const first = text ? undefined : images.shift();
  return [{ id, text: text || null, url: first?.url ?? null }, ...images];
}

const attachmentKey = (url: string | null) =>
  url ? new URL(url).pathname : null;

export async function ingestDiscord(db: Database, event: DiscordMessageEvent) {
  if (
    event.type === "create" &&
    (event.author.bot || event.author.id === event.botId)
  )
    return;
  const groupId = discordId(event.channel);
  const id = discordId(event.id);
  const editedAt = event.type === "update" ? new Date(event.editedAt) : null;
  if (editedAt && !Number.isFinite(editedAt.getTime())) return;

  await db.transaction(async (c) => {
    if (event.type === "create") {
      await c.query(
        "INSERT INTO groups(id,name,platform,reply_mode) VALUES($1,$2,'discord','off') ON CONFLICT DO NOTHING",
        [groupId, redact(event.name)],
      );
    }
    // 與群組設定及判讀結算採相同的加鎖順序，讓編輯、撤回與入列各自完整生效。
    const group = (
      await c.query<Group>(
        "SELECT enabled,trigger_mode FROM groups WHERE id=$1 AND platform='discord' FOR UPDATE",
        [groupId],
      )
    ).rows[0];
    if (!group) return;
    const existing = (
      await c.query<ExistingMessage>(
        `SELECT id,user_id,sender_name,text,quoted_id,image_source_url,discord_edited_at,revoked,processed,trigger_mode,needs_source_review,
         received_at<=message_retention_cutoff() AS expired
       FROM messages WHERE discord_message_id=$1 AND group_id=$2 ORDER BY id FOR UPDATE`,
        [id, groupId],
      )
    ).rows;
    const original = existing.find((row) => row.id === id);
    if (event.type === "create" ? original : !original || original.revoked)
      return;
    if (event.type === "delete") {
      const ids = existing.filter((row) => !row.revoked).map((row) => row.id);
      await clearDiscordMessages(c, ids);
      await invalidateMessageSources(
        db,
        c,
        groupId,
        ids,
        `${id}:delete`,
        "撤回",
      );
      await clearEmptyTriageWindow(c, groupId);
      return;
    }
    if (
      event.type === "update" &&
      (!original ||
        original.expired ||
        (original.discord_edited_at && editedAt! <= original.discord_edited_at))
    )
      return;

    const text =
      event.text === undefined ? (original?.text ?? "") : redact(event.text);
    const urls =
      event.images ?? existing.flatMap((row) => row.image_source_url ?? []);
    const rows = messageRows(id, text, urls);
    const previous = new Map(
      existing.filter((row) => !row.revoked).map((row) => [row.id, row]),
    );
    if (event.type === "update") {
      const changed =
        rows.length !== previous.size ||
        rows.some((row) => {
          const old = previous.get(row.id);
          return (
            !old ||
            old.text !== row.text ||
            attachmentKey(old.image_source_url) !== attachmentKey(row.url)
          );
        });
      if (!changed) {
        await c.query("UPDATE messages SET discord_edited_at=$2 WHERE id=$1", [
          id,
          editedAt,
        ]);
        return;
      }
      await invalidateMessageSources(
        db,
        c,
        groupId,
        [...previous.keys()],
        `${id}:edit:${event.editedAt}`,
        "編輯",
      );
      const current = new Set(rows.map((row) => row.id));
      await clearDiscordMessages(
        c,
        [...previous.keys()].filter((key) => !current.has(key)),
      );
    }

    const review =
      event.type === "update" &&
      [...previous.values()].some(
        (row) =>
          row.needs_source_review ||
          (row.processed && row.trigger_mode !== "chat"),
      );
    const user =
      event.type === "create" ? discordId(event.author.id) : original!.user_id;
    const sender =
      event.type === "create"
        ? redact(event.author.name)
        : original!.sender_name;
    const quoted =
      event.type === "create"
        ? event.quotedId
          ? discordId(event.quotedId)
          : null
        : original!.quoted_id;
    const command =
      isTaskCommand(text) ||
      text.includes(`<@${event.botId}>`) ||
      text.includes(`<@!${event.botId}>`);
    const eligible =
      group.enabled && (group.trigger_mode === "auto" || command);
    for (const row of rows) {
      await c.query(
        `INSERT INTO messages(id,group_id,discord_message_id,discord_edited_at,user_id,sender_name,type,text,quoted_id,
          image_source_url,trigger_mode,processed,needs_source_review,received_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE((SELECT received_at FROM messages WHERE id=$3),now()))
         ON CONFLICT(id) DO UPDATE SET discord_edited_at=EXCLUDED.discord_edited_at,user_id=EXCLUDED.user_id,
          sender_name=EXCLUDED.sender_name,type=EXCLUDED.type,text=EXCLUDED.text,quoted_id=EXCLUDED.quoted_id,
          image=CASE WHEN messages.image_source_url=EXCLUDED.image_source_url THEN messages.image END,
          image_mime=CASE WHEN messages.image_source_url=EXCLUDED.image_source_url THEN messages.image_mime END,
          image_source_url=EXCLUDED.image_source_url,content_attempts=0,trigger_mode=EXCLUDED.trigger_mode,processed=EXCLUDED.processed,
          revoked=false,batch_id=NULL,needs_source_review=EXCLUDED.needs_source_review,content_revision=messages.content_revision+1`,
        [
          row.id,
          groupId,
          id,
          editedAt,
          user,
          sender,
          row.url ? "image" : row.text ? "text" : "attachment",
          row.text,
          row.id === id ? quoted : null,
          row.url,
          eligible ? (command ? "command" : "auto") : "chat",
          !eligible,
          review,
        ],
      );
    }
    if (eligible)
      await c.query(
        "UPDATE groups SET first_pending_at=COALESCE(first_pending_at,now()),last_pending_at=now() WHERE id=$1",
        [groupId],
      );
    else if (event.type === "update") await clearEmptyTriageWindow(c, groupId);
  });
}

async function clearDiscordMessages(c: DbClient, ids: string[]) {
  if (ids.length)
    await c.query(
      `UPDATE messages SET text=NULL,image=NULL,image_mime=NULL,image_source_url=NULL,user_id=NULL,sender_name=NULL,
     quoted_id=NULL,revoked=true,processed=true,content_revision=content_revision+1 WHERE id=ANY($1::text[])`,
      [ids],
    );
}

export interface DiscordGateway {
  start(
    token: string,
    callbacks: {
      event(event: DiscordMessageEvent): Promise<void>;
      health(state: "connecting" | "connected" | "disconnected"): Promise<void>;
    },
  ): void;
  stop(): Promise<void>;
}

export function startDiscord(
  db: Database,
  token: string | undefined | null,
  createGateway: () => DiscordGateway,
) {
  let gateway: DiscordGateway | undefined;
  let messages = Promise.resolve();
  let health = Promise.resolve();
  const report = (state: keyof typeof discordServiceText) => {
    health = health.then(() =>
      recordHealth(
        db,
        "discord",
        state === "connected",
        discordServiceText[state],
      ).catch(() => {
        console.warn("無法保存 Discord 連線狀態，請確認資料庫連線。");
      }),
    );
    return health;
  };
  if (!token) void report(token === null ? "configError" : "unconfigured");
  else {
    void report("connecting");
    try {
      gateway = createGateway();
      gateway.start(token, {
        event(event) {
          messages = messages
            .then(() => ingestDiscord(db, event))
            .catch(() => {
              console.warn("無法保存 Discord 訊息，請確認資料庫連線。");
            });
          return messages;
        },
        health: report,
      });
    } catch {
      void report("disconnected");
    }
  }
  return {
    async stop() {
      await gateway?.stop();
      await Promise.all([messages, health]);
    },
  };
}
