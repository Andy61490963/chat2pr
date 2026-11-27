import {
  REST,
  RateLimitError,
  Routes,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord.js";
import { createHash } from "node:crypto";
import type { ChatPlatform, ChatReplyMessage } from "./chat-platform.js";
import { discordId } from "./chat-platform.js";
import { groupText } from "./group-replies.js";

export type DiscordRest = Pick<REST, "get" | "post" | "put" | "patch">;

export const discordRest = (token: string) =>
  new REST({
    timeout: 5000,
    retries: 0,
    rejectOnRateLimit: () => true,
  }).setToken(token);

export function discordRetryMs(error: unknown) {
  if (error instanceof RateLimitError)
    return Math.max(
      1,
      error.retryAfter,
      error.sublimitTimeout,
      error.timeToReset,
    );
  if (discordStatus(error) !== 429) return null;
  const after = (error as { retry_after?: unknown }).retry_after;
  return typeof after === "number" && Number.isFinite(after)
    ? Math.max(1, Math.ceil(after * 1000))
    : 1000;
}

export function discordStatus(error: unknown) {
  if (error instanceof RateLimitError) return 429;
  if (typeof error !== "object" || !error || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

export const rawDiscordId = (id: string) => id.replace(/^discord:/, "");

export function discordMessage(
  message: ChatReplyMessage,
): RESTPostAPIChannelMessageJSONBody {
  const { text, quick } =
    typeof message === "string" ? { text: message, quick: null } : message;
  return {
    content: groupText(text, 2000).replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g,
      "",
    ),
    allowed_mentions: { parse: [], replied_user: false },
    ...(quick?.length
      ? {
          components: [
            {
              type: 1,
              components: quick.slice(0, 5).map((button) => ({
                type: 2,
                style: 2,
                label: button.label,
                custom_id: button.data,
              })),
            },
          ],
        }
      : {}),
  };
}

export function discordMessageId(result: unknown) {
  if (
    typeof result === "object" &&
    result &&
    "id" in result &&
    typeof result.id === "string"
  )
    return discordId(result.id);
  throw new Error("Discord 未回傳訊息識別碼");
}

export class DiscordChatPlatform implements ChatPlatform {
  readonly capabilities = {
    monthlyPushQuota: false,
    buttons: true,
    replyToken: false,
  };

  constructor(readonly rest: DiscordRest) {}

  async startThread(channel: string, anchor: string, name: string) {
    return discordMessageId(await this.rest.post(Routes.threads(channel, anchor), { body: { name } }));
  }

  async sendToGroup(
    groupId: string,
    message: ChatReplyMessage,
    retryKey: string,
    origin?: string,
  ) {
    const channel = rawDiscordId(groupId);
    const nonce = createHash("sha256")
      .update(retryKey)
      .digest("hex")
      .slice(0, 25);
    const result = await this.rest.post(Routes.channelMessages(channel), {
      body: {
        ...discordMessage(message),
        nonce,
        enforce_nonce: true,
        ...(origin && {
          message_reference: {
            message_id: rawDiscordId(origin),
            fail_if_not_exists: false,
          },
        }),
      },
    });
    return { messageId: discordMessageId(result), newlyAccepted: true };
  }

  async react(groupId: string, origin: string) {
    await this.rest.put(
      Routes.channelMessageOwnReaction(
        rawDiscordId(groupId),
        rawDiscordId(origin),
        encodeURIComponent("✅"),
      ),
    );
  }

  async replyToMessage(
    { groupId, messageId }: { groupId?: string; messageId?: string },
    messages: ChatReplyMessage[],
  ) {
    if (!groupId || !messageId) return { ids: null, status: null };
    const ids: string[] = [];
    for (const [index, message] of messages.entries()) {
      const result = await this.sendToGroup(
        groupId,
        message,
        `reply:${messageId}:${index}`,
        messageId,
      );
      ids.push(result.messageId);
    }
    return { ids, status: 200 };
  }

  async sendToAdmin(recipientId: string, text: string, retryKey: string) {
    const channel = discordMessageId(
      await this.rest.post(Routes.userChannels(), {
        body: { recipient_id: rawDiscordId(recipientId) },
      }),
    );
    await this.sendToGroup(channel, text, `admin:${recipientId}:${retryKey}`);
  }
}
