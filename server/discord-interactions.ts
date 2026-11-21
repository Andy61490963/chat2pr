import { Routes } from "discord.js";
import type { Database, DbClient } from "./db.js";
import type { ChatReplyMessage } from "./chat-platform.js";
import { discordId } from "./chat-platform.js";
import {
  discordMessage,
  discordMessageId,
  discordRetryMs,
  rawDiscordId,
  type DiscordChatPlatform,
  type DiscordRest,
} from "./discord-platform.js";
import {
  deferDiscordNotices,
  discordDeliveryError,
} from "./discord-notifications.js";
import { ingestDiscord, type DiscordMessageEvent } from "./discord.js";
import { answerByPostback, answerPostback } from "./answers.js";
import { pairAdmin } from "./admin-pairing.js";
import { splitQueryAnswer } from "../shared/query-answer.js";
import {
  answerAck,
  answerHeldAck,
  claimPendingGroupReplies,
  credentialAnswerAck,
  disabledAck,
  groupRepliesOn,
  lineChunks,
  lockGroupReplyClaim,
  progressMoreNote,
  progressSummary,
  progressTasks,
  staleAnswerAck,
  supersedeOlderGroupReplies,
} from "./group-replies.js";

export type DiscordInteraction = {
  id: string;
  token: string;
  applicationId: string;
  channel: string;
  name: string;
  member: { id: string; name: string };
  botId: string;
} & (
  | { kind: "task"; text: string }
  | { kind: "progress" }
  | { kind: "answer"; data: string }
);

export type DiscordPrivateMessage = {
  id: string;
  channel: string;
  user: string;
  text: string;
};

export async function registerDiscordCommands(
  rest: DiscordRest,
  applicationId: string,
) {
  await rest.put(Routes.applicationCommands(applicationId), {
    body: [
      {
        name: "任務",
        description: "提供要查詢或修改的需求",
        contexts: [0],
        options: [
          {
            type: 3,
            name: "需求",
            description: "請說明要查什麼或改什麼",
            required: true,
            max_length: 1900,
          },
        ],
      },
      {
        name: "進度",
        description: "查看本頻道的任務進度及未送達的回覆",
        contexts: [0],
      },
    ],
  });
}

export async function handleDiscordPrivate(
  db: Database,
  platform: DiscordChatPlatform,
  event: DiscordPrivateMessage,
) {
  if (!/^配對(?:\s|$)/u.test(event.text.trim())) return;
  const paired = await db.transaction((c) =>
    pairAdmin(db, c, "discord", discordId(event.user), event.text),
  );
  await platform.sendToGroup(
    discordId(event.channel),
    paired
      ? "管理者 Discord 通知已配對。請回到看板查看通知設定。"
      : "無法完成配對，代碼可能有誤、已使用或已過期。請在看板選擇 Discord 並重新產生配對碼。",
    `pairing:${event.id}`,
  );
}

type SendProgress = (
  message: ChatReplyMessage,
  noticeId?: string,
) => Promise<string>;
const repliesOff =
  "這個頻道已關閉群組回覆，無法取回進度。請管理者到看板的群組頁開啟回覆。";

async function restoreDiscordReplies(
  c: DbClient,
  ids: string[],
  error: unknown,
) {
  const delay = discordRetryMs(error);
  if (delay !== null) await deferDiscordNotices(c, ids, delay);
  else
    await c.query(
      "UPDATE notifications SET sent_at=NULL,last_error=$2 WHERE id=ANY($1::uuid[])",
      [ids, discordDeliveryError(error)],
    );
}

async function replyWithProgress(
  db: Database,
  groupId: string,
  send: SendProgress,
) {
  const { summary, pending } = await db.transaction(async (c) => {
    const group = (
      await c.query<{ enabled: boolean; replies: boolean }>(
        `SELECT enabled,reply_mode<>'off' AND ${groupRepliesOn} AS replies
       FROM groups WHERE id=$1 AND platform='discord' AND left_at IS NULL FOR UPDATE`,
        [groupId],
      )
    ).rows[0];
    if (!group?.enabled || !group.replies)
      return {
        summary: group?.enabled ? repliesOff : disabledAck,
        pending: undefined,
      };
    const { tasks, total } = await progressTasks(c, groupId);
    const pending = await claimPendingGroupReplies(c, groupId, 4, "discord");
    return {
      summary: progressSummary(tasks, total, pending.replies.length),
      pending,
    };
  });
  const claim = pending?.claim;

  try {
    await send(summary);
  } catch (error) {
    if (claim)
      await db.transaction(async (c) => {
        const rows = await lockGroupReplyClaim(c, claim);
        if (rows.length)
          await restoreDiscordReplies(
            c,
            rows.map((row) => row.id),
            error,
          );
      });
    throw error;
  }
  if (!pending || !claim) return;

  const { replies, remaining } = pending;
  for (const [index, notice] of replies.entries()) {
    await db.transaction(async (c) => {
      // 每則獨立送出並結算，只鎖通知列。回收與推播會略過正在送的通知。
      const [row] = await lockGroupReplyClaim(c, {
        ids: [notice.id],
        claimedAt: claim.claimedAt,
      });
      if (!row?.valid) return;
      let id: string;
      try {
        id = await send(
          {
            text:
              remaining && index === replies.length - 1
                ? `${notice.text}\n\n${progressMoreNote(remaining)}`
                : notice.text,
            quick: notice.quick_replies,
          },
          notice.id,
        );
      } catch (error) {
        await restoreDiscordReplies(c, [notice.id], error);
        return;
      }
      await c.query(
        "UPDATE notifications SET sent_message_id=$2,last_error=NULL,discord_retry_at=NULL WHERE id=$1",
        [notice.id, id],
      );
      await supersedeOlderGroupReplies(c, groupId, [notice.id], "discord");
    });
  }
}

type TextReply = NonNullable<Awaited<ReturnType<typeof ingestDiscord>>>;

export async function replyDiscordText(
  db: Database,
  platform: DiscordChatPlatform,
  event: DiscordMessageEvent,
  reply: TextReply,
) {
  const group = discordId(event.channel);
  const origin = discordId(event.id);
  if ("progress" in reply) {
    await replyWithProgress(
      db,
      group,
      async (message, id) =>
        (
          await platform.sendToGroup(
            group,
            message,
            id ?? `progress:${event.id}`,
            origin,
          )
        ).messageId,
    );
    return;
  }
  const messages =
    "answer" in reply
      ? [reply.answer === "queued" ? answerAck : answerHeldAck]
      : "credential" in reply
        ? [credentialAnswerAck]
        : lineChunks(splitQueryAnswer(reply.detail).body, 5, 1850);
  await platform.replyToMessage(
    { groupId: group, messageId: origin },
    messages,
  );
}

export async function handleDiscordInteraction(
  db: Database,
  platform: DiscordChatPlatform,
  event: DiscordInteraction,
) {
  const rest = platform.rest;
  const groupId = discordId(event.channel);
  const original = Routes.webhookMessage(
    event.applicationId,
    event.token,
    "@original",
  );
  const edit = async (message: ChatReplyMessage) =>
    discordMessageId(
      await rest.patch(original, {
        auth: false,
        body: discordMessage(message),
      }),
    );

  const group = (
    await db.query<{ enabled: boolean; replies: boolean }>(
      `SELECT enabled,reply_mode<>'off' AND ${groupRepliesOn} AS replies
     FROM groups WHERE id=$1 AND platform='discord' AND left_at IS NULL`,
      [groupId],
    )
  )[0];
  const visible = event.kind !== "answer" && group?.enabled && group.replies;
  await rest.post(Routes.interactionCallback(event.id, event.token), {
    auth: false,
    body: { type: 5, ...(visible ? {} : { data: { flags: 64 } }) },
  });
  try {
    if (event.kind === "progress") {
      // 公開回覆的訊息識別碼可供頻道成員引用；關閉回覆時只回覆發出指令的人。
      if (!visible) await edit(group?.enabled ? repliesOff : disabledAck);
      else
        await replyWithProgress(db, groupId, async (message, noticeId) =>
          noticeId
            ? discordMessageId(
                await rest.post(
                  Routes.webhook(event.applicationId, event.token),
                  {
                    auth: false,
                    query: new URLSearchParams({ wait: "true" }),
                    body: discordMessage(message),
                  },
                ),
              )
            : edit(message),
        );
      return;
    }
    if (event.kind === "answer") {
      const status = await db.transaction(async (c) => {
        if (!answerPostback.test(event.data)) return null;
        const current = await c.query(
          "SELECT id FROM groups WHERE id=$1 AND platform='discord' AND enabled AND left_at IS NULL FOR UPDATE",
          [groupId],
        );
        if (!current.rowCount) return null;
        const task = await answerByPostback(
          db,
          c,
          groupId,
          event.data,
          discordId(event.id),
          "群組成員（Discord）",
        );
        return task?.status;
      });
      await edit(
        !status
          ? staleAnswerAck
          : status === "queued"
            ? answerAck
            : answerHeldAck,
      );
      return;
    }
    if (!event.text.trim()) {
      await edit("需求沒有內容。請重新使用 /任務，填寫要查詢或修改的事項。");
      return;
    }
    const anchor = visible
      ? discordMessageId(await rest.get(original, { auth: false }))
      : undefined;
    await ingestDiscord(db, {
      type: "create",
      id: event.id,
      channel: event.channel,
      name: event.name,
      interactionReplyId: anchor ? rawDiscordId(anchor) : null,
      author: event.member,
      text: `/任務 ${event.text.trim()}`,
      images: [],
      botId: event.botId,
    });
    await edit(
      group?.enabled
        ? "已記下這則需求。可以用 /進度 查看處理狀態。"
        : disabledAck,
    );
  } catch (error) {
    await edit(discordDeliveryError(error)).catch(() => {});
    throw error;
  }
}
