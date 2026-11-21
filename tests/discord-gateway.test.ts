import { afterEach, expect, it, vi } from "vitest";
import {
  ChannelType,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageType,
} from "discord.js";
import { createDiscordGateway } from "../server/discord-gateway.js";

const { clients, login } = vi.hoisted(() => ({
  clients: [] as Array<{
    options: { intents: number[] };
    emit(name: string, ...args: unknown[]): boolean;
  }>,
  login: vi.fn(async (_token: string) => ""),
}));
vi.mock("discord.js", async (original) => {
  const discord = await original<typeof import("discord.js")>();
  const { EventEmitter } = await import("node:events");
  class FakeClient extends EventEmitter {
    user = { id: "2" };
    channels = {
      cache: new Map([
        [
          "1",
          {
            type: discord.ChannelType.GuildText,
            name: "需求",
            guild: { name: "範例伺服器" },
          },
        ],
        ["10", { type: discord.ChannelType.PublicThread }],
      ]),
    };
    constructor(public options: { intents: number[] }) {
      super();
      clients.push(this);
    }
    login = login;
    destroy = vi.fn(async () => {});
  }
  return { ...discord, Client: FakeClient };
});

afterEach(() => {
  clients.length = 0;
  login.mockClear();
  vi.useRealTimers();
});

it("Gateway 只收文字頻道事件，保留暱稱、同頻道引用與圖片附件", async () => {
  const adapter = createDiscordGateway();
  const event = vi.fn(async () => {});
  const health = vi.fn(async () => {});
  adapter.start("虛構權杖", { event, health });
  try {
    const client = clients[0];
    expect(client.options.intents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]);
    const message = {
      id: "3",
      channel_id: "1",
      guild_id: "4",
      type: MessageType.Reply,
      content: "/任務 整理示範專案",
      author: { id: "5", username: "小禾" },
      member: { nick: "小林" },
      message_reference: { message_id: "6", channel_id: "1" },
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/1/7/example.png",
          content_type: "image/png",
        },
      ],
    };
    client.emit(Events.Raw, {
      t: GatewayDispatchEvents.MessageCreate,
      d: { ...message, channel_id: "10" },
    });
    expect(event).not.toHaveBeenCalled();
    client.emit(Events.Raw, {
      t: GatewayDispatchEvents.MessageCreate,
      d: message,
    });
    expect(event).toHaveBeenLastCalledWith({
      type: "create",
      id: "3",
      channel: "1",
      name: "範例伺服器／#需求",
      author: { id: "5", name: "小林", bot: undefined },
      botId: "2",
      text: message.content,
      quotedId: "6",
      images: [message.attachments[0].url],
    });
    client.emit(Events.Raw, {
      t: GatewayDispatchEvents.MessageUpdate,
      d: {
        ...message,
        edited_timestamp: "2026-11-21T00:00:00Z",
        content: "/任務 改整理版面",
        attachments: [],
      },
    });
    expect(event).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "update",
        id: "3",
        text: "/任務 改整理版面",
        images: [],
      }),
    );
    client.emit(Events.Raw, {
      t: GatewayDispatchEvents.MessageDelete,
      d: { id: "3", channel_id: "1" },
    });
    expect(event).toHaveBeenLastCalledWith({
      type: "delete",
      id: "3",
      channel: "1",
    });
  } finally {
    await adapter.stop();
  }
});

it("可恢復的斷線交由 Gateway 續接，工作階段終止後會另建連線", async () => {
  vi.useFakeTimers();
  const adapter = createDiscordGateway();
  const event = vi.fn(async () => {});
  const health = vi.fn(async () => {});
  adapter.start("虛構權杖", { event, health });
  try {
    const client = clients[0];
    client.emit(Events.ClientReady);
    expect(health).toHaveBeenLastCalledWith("connected");
    client.emit(Events.ShardReconnecting);
    expect(health).toHaveBeenLastCalledWith("disconnected");
    client.emit(Events.ShardResume);
    expect(health).toHaveBeenLastCalledWith("connected");
    expect(login).toHaveBeenCalledOnce();
    client.emit(Events.ShardDisconnect);
    expect(health).toHaveBeenLastCalledWith("disconnected");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(login).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(2);
  } finally {
    await adapter.stop();
  }
});
