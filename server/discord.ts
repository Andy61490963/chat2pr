import type { Database, DbClient } from "./db.js";
import { discordId } from "./chat-platform.js";
import { discordImageUrl } from "./chat-image.js";
import { invalidateMessageSources } from "./message-sources.js";
import { isProgressCommand, isTaskCommand } from "../shared/chat.js";
import { containsCredential, redact } from "./policy.js";
import { discordServiceText } from "../shared/status-glossary.js";
import { recordHealth } from "./health.js";
import { clearEmptyTriageWindow } from "./triage-window.js";
import { applyAnswer, questionByQuote } from "./answers.js";
import {
  detailRequest,
  groupRepliesOn,
  type ReplyMode,
} from "./group-replies.js";
import {
  handleDiscordInteraction,
  handleDiscordPrivate,
  replyDiscordText,
  registerDiscordCommands,
  type DiscordInteraction,
  type DiscordPrivateMessage,
} from "./discord-interactions.js";
import type { DiscordChatPlatform } from "./discord-platform.js";

type Source = { id: string; channel: string };
export type DiscordMessageEvent =
  | (Source & {
      type: "create";
      name: string;
      author: { id: string; name: string; bot?: boolean };
      text: string;
      images: readonly string[];
      quotedId?: string;
      /** 斜線指令以互動識別碼保存，另記下可供群組回覆的原始互動訊息。 */
      interactionReplyId?: string | null;
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

type Group = {
  enabled: boolean;
  trigger_mode: "auto" | "command";
  reply_mode: ReplyMode;
  replies: boolean;
};

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

  return db.transaction(async (c) => {
    if (event.type === "create") {
      await c.query(
        "INSERT INTO groups(id,name,platform,reply_mode) VALUES($1,$2,'discord','off') ON CONFLICT DO NOTHING",
        [groupId, redact(event.name)],
      );
    }
    // 與群組設定及判讀結算採相同的加鎖順序，讓編輯、撤回與入列各自完整生效。
    const group = (
      await c.query<Group>(
        `SELECT enabled,trigger_mode,reply_mode,${groupRepliesOn} AS replies
         FROM groups WHERE id=$1 AND platform='discord' FOR UPDATE`,
        [groupId],
      )
    ).rows[0];
    if (!group) return;
    const existing = (
      await c.query<ExistingMessage>(
        `SELECT id,user_id,sender_name,text,quoted_id,image_source_url,discord_edited_at,revoked,processed,trigger_mode,needs_source_review,
         received_at<=message_retention_cutoff() AS expired
       FROM messages WHERE (id=$1 OR discord_message_id=$1) AND group_id=$2 ORDER BY id FOR UPDATE`,
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

    const quote =
      event.type === "create" && event.quotedId
        ? discordId(event.quotedId)
        : original?.quoted_id;
    const quotedNotice =
      quote &&
      (
        await c.query<{ kind: string; answer: string | null }>(
          `SELECT n.kind,t.answer FROM notifications n JOIN tasks t ON t.id=n.task_id
         WHERE n.sent_message_id=$1 AND n.group_id=$2 AND t.group_id=$2 LIMIT 1`,
          [quote, groupId],
        )
      ).rows[0];
    const sensitive =
      quotedNotice &&
      quotedNotice.kind === "group_question" &&
      containsCredential(event.text ?? "");
    const text = sensitive
      ? "[已略過含憑證的回答]"
      : event.text === undefined
        ? (original?.text ?? "")
        : redact(event.text);
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
    const progress = isProgressCommand(text);
    const detail =
      quotedNotice &&
      quotedNotice.kind === "group_answered" &&
      !!quotedNotice.answer &&
      detailRequest.test(text);
    const asked =
      !progress &&
      !sensitive &&
      event.type === "create" &&
      group.enabled &&
      quote &&
      text.trim() &&
      quotedNotice &&
      quotedNotice.kind === "group_question" &&
      (await questionByQuote(c, groupId, quote));
    const botReply =
      !!quotedNotice && !!text.trim() && !progress && !detail && !sensitive;
    const eligible =
      group.enabled &&
      !sensitive &&
      !progress &&
      !detail &&
      (group.trigger_mode === "auto" || command || botReply);
    for (const row of rows) {
      await c.query(
        `INSERT INTO messages(id,group_id,discord_message_id,discord_edited_at,user_id,sender_name,type,text,quoted_id,
          image_source_url,trigger_mode,processed,needs_source_review,received_at,bot_reply,discord_reply_message_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE((SELECT received_at FROM messages WHERE id=$3),now()),$14,$15)
         ON CONFLICT(id) DO UPDATE SET discord_edited_at=EXCLUDED.discord_edited_at,user_id=EXCLUDED.user_id,
          sender_name=EXCLUDED.sender_name,type=EXCLUDED.type,text=EXCLUDED.text,quoted_id=EXCLUDED.quoted_id,
          image=CASE WHEN messages.image_source_url=EXCLUDED.image_source_url THEN messages.image END,
          image_mime=CASE WHEN messages.image_source_url=EXCLUDED.image_source_url THEN messages.image_mime END,
          image_source_url=EXCLUDED.image_source_url,content_attempts=0,trigger_mode=EXCLUDED.trigger_mode,processed=EXCLUDED.processed,
          revoked=false,batch_id=NULL,needs_source_review=EXCLUDED.needs_source_review,bot_reply=EXCLUDED.bot_reply,
          content_revision=messages.content_revision+1`,
        [
          row.id,
          groupId,
          event.type === "create" && event.interactionReplyId !== undefined
            ? null
            : id,
          editedAt,
          user,
          sender,
          row.url ? "image" : row.text ? "text" : "attachment",
          row.text,
          row.id === id ? quoted : null,
          row.url,
          eligible ? (command || botReply ? "command" : "auto") : "chat",
          !eligible || !!asked,
          review,
          row.id === id && botReply,
          event.type === "create" && event.interactionReplyId
            ? discordId(event.interactionReplyId)
            : null,
        ],
      );
    }
    if (asked) {
      const result = await applyAnswer(
        db,
        c,
        asked,
        text,
        "群組成員（Discord）",
        false,
        id,
      );
      if (group.replies && group.reply_mode !== "off")
        return { answer: result.status } as const;
    } else if (eligible)
      await c.query(
        "UPDATE groups SET first_pending_at=COALESCE(first_pending_at,now()),last_pending_at=now() WHERE id=$1",
        [groupId],
      );
    else if (event.type === "update") await clearEmptyTriageWindow(c, groupId);
    if (
      event.type === "create" &&
      group.replies &&
      group.reply_mode !== "off"
    ) {
      if (progress) return { progress: group.enabled } as const;
      if (sensitive) return { credential: true } as const;
      if (detail && group.enabled)
        return { detail: quotedNotice.answer! } as const;
    }
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
      interaction?(event: DiscordInteraction): Promise<void>;
      privateMessage?(event: DiscordPrivateMessage): Promise<void>;
      health(state: "connecting" | "connected" | "disconnected"): Promise<void>;
    },
  ): void;
  stop(): Promise<void>;
}

export function startDiscord(
  db: Database,
  token: string | undefined | null,
  createGateway: () => DiscordGateway,
  platform?: DiscordChatPlatform,
  applicationId?: string,
) {
  let gateway: DiscordGateway | undefined;
  let messages = Promise.resolve();
  let health = Promise.resolve();
  let registration: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  const handle = (work: Promise<void>) => {
    const settled = work
      .catch(() => {
        console.warn("無法完成 Discord 回應，請確認資料庫連線與機器人權限。");
      })
      .finally(() => inFlight.delete(settled));
    inFlight.add(settled);
    return settled;
  };
  const report = (state: keyof typeof discordServiceText) => {
    if (state === "connected" && platform && applicationId && !registration) {
      registration = registerDiscordCommands(
        platform.rest,
        applicationId,
      ).catch(() => {
        registration = undefined;
        console.warn(
          "無法註冊 Discord 斜線指令，請確認應用程式 ID 與機器人設定。",
        );
      });
    }
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
            .then(async () => {
              const reply = await ingestDiscord(db, event);
              if (reply && platform)
                void handle(replyDiscordText(db, platform, event, reply));
            })
            .catch(() => {
              console.warn("無法保存 Discord 訊息，請確認資料庫連線。");
            });
          return messages;
        },
        interaction:
          platform &&
          ((event) =>
            event.kind === "answer" || event.applicationId === applicationId
              ? handle(handleDiscordInteraction(db, platform, event))
              : Promise.resolve()),
        privateMessage:
          platform &&
          ((event) => handle(handleDiscordPrivate(db, platform, event))),
        health: report,
      });
    } catch {
      void report("disconnected");
    }
  }
  return {
    async stop() {
      await gateway?.stop();
      await Promise.all([messages, health, registration]);
      await Promise.all(inFlight);
    },
  };
}
