export type ChatButton = { label: string; data: string; displayText: string };

export type ChatReplyMessage =
  string | { text: string; quick?: ChatButton[] | null };

export interface ChatReplyResult {
  /** 依訊息順序回傳 ID，未確認收件時為 null。 */
  ids: (string | null)[] | null;
  status: number | null;
  message?: unknown;
  /** 平台可能已經收下這次回覆。 */
  possiblyDelivered?: boolean;
}

export interface ChatPlatform {
  readonly capabilities: Readonly<{
    monthlyPushQuota: boolean;
    buttons: boolean;
    replyToken: boolean;
  }>;
  sendToGroup(
    groupId: string,
    message: ChatReplyMessage,
    retryKey: string,
    origin?: string,
  ): Promise<{
    messageId: string | null;
    /** 同一重試鍵先前已送達時為 false。 */
    newlyAccepted: boolean;
  }>;
  replyToMessage(
    target: { groupId?: string; messageId?: string; replyToken?: string },
    messages: ChatReplyMessage[],
  ): Promise<ChatReplyResult>;
  sendToAdmin(
    recipientId: string,
    text: string,
    retryKey: string,
  ): Promise<void>;
}

/** Discord 頻道與訊息使用同一個前綴，保留 LINE 原有的 ID。 */
export function discordId(id: string): `discord:${string}` {
  return `discord:${id}`;
}
