import { createHash, createHmac } from "node:crypto";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  GatewayDispatchEvents,
  GatewayOpcodes,
  InteractionType,
  Locale,
  type GatewayInteractionCreateDispatch,
} from "discord.js";

/** payload 是已簽章的 UTF-8 本文，可直接交給 Fastify 的 inject。 */
export interface SignedWebhookRequest {
  method: "POST";
  url: "/webhooks/line" | "/webhooks/github";
  headers: Record<string, string>;
  payload: string;
}

export function signedLineMessage(input: {
  secret: string;
  eventId: string;
  messageId: string;
  groupId: string;
  userId: string;
  timestamp: number;
  text: string;
}): SignedWebhookRequest {
  const payload = JSON.stringify({
    events: [
      {
        type: "message",
        webhookEventId: input.eventId,
        replyToken: createHash("sha256").update(input.eventId).digest("hex"),
        timestamp: input.timestamp,
        source: { type: "group", groupId: input.groupId, userId: input.userId },
        message: { type: "text", id: input.messageId, text: input.text },
      },
    ],
  });
  return {
    method: "POST",
    url: "/webhooks/line",
    headers: {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", input.secret)
        .update(payload)
        .digest("base64"),
    },
    payload,
  };
}

export function discordTaskInteraction(input: {
  applicationId: string;
  guildId: string;
  channelId: string;
  userId: string;
  interactionId: string;
  sequence: number;
  text: string;
}) {
  return {
    op: GatewayOpcodes.Dispatch,
    t: GatewayDispatchEvents.InteractionCreate,
    s: input.sequence,
    d: {
      type: InteractionType.ApplicationCommand,
      version: 1,
      id: input.interactionId,
      token: createHash("sha256").update(input.interactionId).digest("hex"),
      application_id: input.applicationId,
      guild_id: input.guildId,
      channel_id: input.channelId,
      channel: { id: input.channelId, type: ChannelType.GuildText },
      member: {
        user: {
          id: input.userId,
          username: "驗收成員",
          discriminator: "0",
          global_name: null,
          avatar: null,
        },
        roles: [],
        joined_at: "2026-01-01T00:00:00Z",
        flags: 0,
        permissions: "0",
        deaf: false,
        mute: false,
      },
      data: {
        id: "100000000000000009",
        type: ApplicationCommandType.ChatInput,
        name: "任務",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "需求",
            value: input.text,
          },
        ],
      },
      locale: Locale.ChineseTW,
      app_permissions: "0",
      entitlements: [],
      authorizing_integration_owners: {
        [ApplicationIntegrationType.GuildInstall]: input.guildId,
      },
      attachment_size_limit: 10 * 1024 * 1024,
    },
  } satisfies GatewayInteractionCreateDispatch;
}

export function signedGitHubPrMerged(input: {
  secret: string;
  deliveryId: string;
  repository: string;
  prNumber: number;
}): SignedWebhookRequest {
  const payload = JSON.stringify({
    action: "closed",
    number: input.prNumber,
    repository: { full_name: input.repository },
    pull_request: { number: input.prNumber, state: "closed", merged: true },
  });
  const signature = createHmac("sha256", input.secret)
    .update(payload)
    .digest("hex");
  return {
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": input.deliveryId,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    payload,
  };
}
