import {
  ChannelType,
  Client,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionType,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  ComponentType,
  MessageType,
  Options,
  type GatewayDispatchPayload,
} from "discord.js";
import type { DiscordGateway, DiscordMessageEvent } from "./discord.js";

function messageAttachments(attachments: ReadonlyArray<{
  url: string;
  content_type?: string;
  filename: string;
  size: number;
}>) {
  return {
    images: attachments
      .filter((a) => a.content_type?.startsWith("image/"))
      .map((a) => a.url),
    documents: attachments
      .filter((a) => a.filename && !/^(?:image|audio|video)\//i.test(a.content_type ?? ""))
      .map((a) => ({ url: a.url, name: a.filename, size: a.size })),
  };
}

function textChannel(client: Client, id: string) {
  const channel = client.channels.cache.get(id);
  const thread =
    channel?.type === ChannelType.PublicThread ||
    channel?.type === ChannelType.PrivateThread ||
    channel?.type === ChannelType.AnnouncementThread
      ? channel
      : undefined;
  const parentChannel = thread?.parentId;
  const parent = parentChannel
    ? client.channels.cache.get(parentChannel)
    : channel;
  if (
    parent?.type !== ChannelType.GuildText &&
    parent?.type !== ChannelType.GuildAnnouncement
  )
    return;
  return {
    guildId: parent.guildId,
    name: `${parent.guild.name}／#${parent.name}`,
    ...(parentChannel && { parentChannel }),
  };
}

function receive(
  client: Client,
  packet: GatewayDispatchPayload,
  callbacks: Parameters<DiscordGateway["start"]>[1],
) {
  const emit = (event: DiscordMessageEvent) => void callbacks.event(event);
  switch (packet.t) {
    case GatewayDispatchEvents.MessageCreate: {
      const message = packet.d;
      if (
        !message.guild_id &&
        client.user &&
        message.author.id !== client.user.id &&
        !message.author.bot &&
        !message.webhook_id &&
        message.type === MessageType.Default
      ) {
        void callbacks.privateMessage?.({
          id: message.id,
          channel: message.channel_id,
          user: message.author.id,
          text: message.content,
        });
        return;
      }
      const channel = textChannel(client, message.channel_id);
      if (!client.user || !channel) return;
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
        name: channel.name,
        ...(channel.parentChannel && { parentChannel: channel.parentChannel }),
        author: {
          id: message.author.id,
          bot: message.author.bot,
          name:
            message.member?.nick ??
            message.author.global_name ??
            message.author.username,
        },
        text: message.content,
        ...messageAttachments(message.attachments),
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
    case GatewayDispatchEvents.InteractionCreate: {
      const interaction = packet.d;
      const id = interaction.channel?.id;
      const channel = id && textChannel(client, id);
      const user = interaction.member?.user;
      if (
        !client.user ||
        !interaction.guild_id ||
        !user ||
        user.bot ||
        !id ||
        !channel ||
        channel.guildId !== interaction.guild_id
      )
        return;
      const common = {
        id: interaction.id,
        token: interaction.token,
        applicationId: interaction.application_id,
        channel: id,
        name: channel.name,
        ...(channel.parentChannel && { parentChannel: channel.parentChannel }),
        botId: client.user.id,
        member: {
          id: user.id,
          name: interaction.member?.nick ?? user.global_name ?? user.username,
        },
      };
      if (
        interaction.type === InteractionType.MessageComponent &&
        interaction.data.component_type === ComponentType.Button &&
        interaction.message?.channel_id === id &&
        interaction.message.author.id === client.user.id
      ) {
        void callbacks.interaction?.({
          ...common,
          kind: "answer",
          data: interaction.data.custom_id,
        });
      }
      if (
        interaction.type === InteractionType.ApplicationCommand &&
        interaction.data.type === ApplicationCommandType.ChatInput
      ) {
        if (interaction.data.name === "進度")
          void callbacks.interaction?.({ ...common, kind: "progress" });
        if (interaction.data.name === "任務") {
          const input = interaction.data.options?.find(
            (option) => option.name === "需求",
          );
          if (input?.type === ApplicationCommandOptionType.String) {
            const option = interaction.data.options?.find((o) => o.name === "附件");
            const file = option?.type === ApplicationCommandOptionType.Attachment
              ? interaction.data.resolved?.attachments?.[option.value] : undefined;
            void callbacks.interaction?.({
              ...common,
              kind: "task",
              text: input.value,
              ...(file && messageAttachments([file])),
            });
          }
        }
      }
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
        ...(message.attachments && messageAttachments(message.attachments)),
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
            GatewayIntentBits.DirectMessages,
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
          if (active()) receive(current, packet, callbacks);
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
