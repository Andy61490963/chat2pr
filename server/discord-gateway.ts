import {
  ChannelType,
  Client,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageType,
  Options,
  type GatewayDispatchPayload,
} from "discord.js";
import type { DiscordGateway, DiscordMessageEvent } from "./discord.js";

function imageUrls(
  attachments: ReadonlyArray<{ url: string; content_type?: string }>,
) {
  return attachments
    .filter((attachment) => attachment.content_type?.startsWith("image/"))
    .map((attachment) => attachment.url);
}

function receive(
  client: Client,
  packet: GatewayDispatchPayload,
  emit: (event: DiscordMessageEvent) => void,
) {
  switch (packet.t) {
    case GatewayDispatchEvents.MessageCreate: {
      const message = packet.d;
      const channel = client.channels.cache.get(message.channel_id);
      if (
        !client.user ||
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      )
        return;
      if (
        message.webhook_id ||
        (message.type !== MessageType.Default &&
          message.type !== MessageType.Reply)
      )
        return;
      const reference = message.message_reference;
      emit({
        type: "create",
        id: message.id,
        channel: message.channel_id,
        name: `${channel.guild.name}／#${channel.name}`,
        author: {
          id: message.author.id,
          bot: message.author.bot,
          name:
            message.member?.nick ??
            message.author.global_name ??
            message.author.username,
        },
        text: message.content,
        images: imageUrls(message.attachments),
        quotedId:
          message.type === MessageType.Reply &&
          (!reference?.channel_id ||
            reference.channel_id === message.channel_id)
            ? reference?.message_id
            : undefined,
        botId: client.user.id,
      });
      break;
    }
    case GatewayDispatchEvents.MessageUpdate: {
      const message = packet.d;
      if (
        !client.user ||
        !message.guild_id ||
        !message.edited_timestamp ||
        (message.content === undefined && message.attachments === undefined)
      )
        return;
      emit({
        type: "update",
        id: message.id,
        channel: message.channel_id,
        editedAt: message.edited_timestamp,
        botId: client.user.id,
        text: message.content,
        images: message.attachments && imageUrls(message.attachments),
      });
      break;
    }
    case GatewayDispatchEvents.MessageDelete:
      emit({ type: "delete", id: packet.d.id, channel: packet.d.channel_id });
      break;
    case GatewayDispatchEvents.MessageDeleteBulk:
      for (const id of packet.d.ids)
        emit({ type: "delete", id, channel: packet.d.channel_id });
      break;
  }
}

export function createDiscordGateway(): DiscordGateway {
  let client: Client | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  return {
    start(token, callbacks) {
      const connect = () => {
        if (stopped) return;
        const current = new Client({
          makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            MessageManager: 0,
          }),
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
          ],
        });
        client = current;
        const active = () => !stopped && client === current;
        const report = (state: "connected" | "disconnected") => {
          if (active()) void callbacks.health(state);
        };
        const retryConnection = () => {
          if (!active() || retry) return;
          report("disconnected");
          // 失去工作階段或登入失敗後，以新 Gateway 用戶端重試。
          retry = setTimeout(() => {
            retry = undefined;
            void current
              .destroy()
              .catch(() => {})
              .then(connect);
          }, 30_000);
        };
        current.on(Events.Raw, (packet: GatewayDispatchPayload) => {
          if (active())
            receive(current, packet, (event) => {
              void callbacks.event(event);
            });
        });
        current.on(Events.ClientReady, () => report("connected"));
        current.on(Events.ShardReady, () => report("connected"));
        current.on(Events.ShardResume, () => report("connected"));
        // 可以恢復的連線由 discord.js 自動重連，並補收工作階段中暫存的事件。
        current.on(Events.ShardReconnecting, () => report("disconnected"));
        current.on(Events.ShardDisconnect, retryConnection);
        current.on(Events.ShardError, () => {
          if (!current.isReady()) report("disconnected");
        });
        current.on(Events.Error, () => {
          if (!current.isReady()) report("disconnected");
        });
        void current.login(token).catch(retryConnection);
      };
      connect();
    },
    async stop() {
      stopped = true;
      clearTimeout(retry);
      await client?.destroy().catch(() => {});
    },
  };
}
