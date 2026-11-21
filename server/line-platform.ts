import type {
  ChatPlatform,
  ChatReplyMessage,
  ChatReplyResult,
} from "./chat-platform.js";
import { pushLineMessage } from "./line-quota.js";

/** 同一個 LINE 回覆權杖只能使用一次，一批最多送五則。 */
export const lineReplyLimit = 5;

const lineText = (message: ChatReplyMessage) => {
  const text = typeof message === "string" ? message : message.text;
  const quick = typeof message === "string" ? null : message.quick;
  return {
    type: "text" as const,
    text,
    ...(quick?.length
      ? {
          quickReply: {
            items: quick.slice(0, 13).map((q) => ({
              type: "action",
              action: {
                type: "postback",
                label: q.label,
                data: q.data,
                displayText: q.displayText,
              },
            })),
          },
        }
      : {}),
  };
};

export class LineChatPlatform implements ChatPlatform {
  readonly capabilities = {
    monthlyPushQuota: true,
    buttons: true,
    replyToken: true,
  } as const;

  constructor(private readonly access: string | undefined) {}

  private pushAccess() {
    if (!this.access) throw new Error("尚未設定 LINE 權杖");
    return this.access;
  }

  async sendToGroup(
    groupId: string,
    message: ChatReplyMessage,
    retryKey: string,
  ) {
    const response = await pushLineMessage(
      this.pushAccess(),
      groupId,
      lineText(message),
      retryKey,
    );
    const sent = response.ok
      ? ((await response.json().catch(() => null)) as {
          sentMessages?: { id?: string }[];
        } | null)
      : null;
    return {
      messageId: sent?.sentMessages?.[0]?.id ?? null,
      newlyAccepted: response.ok,
    };
  }

  async replyToMessage(
    { replyToken }: { replyToken?: string },
    messages: ChatReplyMessage[],
  ): Promise<ChatReplyResult> {
    if (!this.access || !replyToken) return { ids: null, status: null };
    const sent = messages.slice(0, lineReplyLimit);
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken, messages: sent.map(lineText) }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!response) return { ids: null, status: null };
    const body = (await response.json().catch(() => null)) as {
      sentMessages?: { id?: unknown }[];
      message?: unknown;
    } | null;
    if (!response.ok)
      return { ids: null, status: response.status, message: body?.message };
    return {
      ids: sent.map((_, i) => {
        const id = body?.sentMessages?.[i]?.id;
        return typeof id === "string" ? id : null;
      }),
      status: response.status,
    };
  }

  async sendToAdmin(recipientId: string, text: string, retryKey: string) {
    await pushLineMessage(
      this.pushAccess(),
      recipientId,
      lineText(text),
      retryKey,
    );
  }
}
