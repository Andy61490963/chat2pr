import { EventEmitter } from "node:events";
import {
  ChannelType,
  Events,
  GatewayDispatchEvents,
  GatewayOpcodes,
} from "discord.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { Database } from "../server/db.js";
import { createDiscordGateway } from "../server/discord-gateway.js";
import {
  discordTaskInteraction,
  signedGitHubPrMerged,
  signedLineMessage,
} from "../scripts/acceptance/flows/signed-events.js";

const keys = vi.hoisted(() => ({
  lineSecret: "ExampleLineKey266",
  githubWebhookSecret: "ExampleMergeKey266",
}));
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => keys,
  config: () => ({ publicUrl: "https://acceptance.invalid" }),
}));
// 驗收到收件與驗章為止，資料庫交易由記憶體替身接手。
vi.mock("../server/db.js");
const gatewayEvents = new EventEmitter();
const guildId = "100000000000000001";
const channelId = "100000000000000002";
const applicationId = "100000000000000003";
vi.mock("discord.js", async (original) => ({
  ...(await original<typeof import("discord.js")>()),
  Client: class {
    user = { id: applicationId };
    channels = {
      cache: new Map([
        [
          channelId,
          {
            type: ChannelType.GuildText,
            guildId,
            name: "需求",
            guild: { name: "驗收群組" },
          },
        ],
      ]),
    };
    on = gatewayEvents.on.bind(gatewayEvents);
    async login() {}
    async destroy() {
      gatewayEvents.removeAllListeners();
    }
  },
}));

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp(new Database(""));
});
afterAll(async () => {
  await app?.close();
});

it("LINE 群組文字保留來源與原文，原始本文通過路由驗章，改一個位元組即拒收", async () => {
  const input = {
    groupId: `C${"1".repeat(32)}`,
    userId: `U${"2".repeat(32)}`,
    eventId: "驗收查詢事件",
    messageId: "11001",
    timestamp: 1790000000000,
    text: '「範例清單」的狀態 "完成" 是什麼意思？\n請舉例。',
  };
  const request = signedLineMessage({ ...input, secret: keys.lineSecret });
  expect(request.url).toBe("/webhooks/line");
  expect(request.headers["x-line-signature"]).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  expect(JSON.parse(request.payload).events).toEqual([
    expect.objectContaining({
      webhookEventId: input.eventId,
      timestamp: input.timestamp,
      type: "message",
      source: { type: "group", groupId: input.groupId, userId: input.userId },
      message: { type: "text", id: input.messageId, text: input.text },
      replyToken: expect.stringMatching(/^[a-zA-Z0-9]+$/),
    }),
  ]);
  expect((await app.inject(request)).statusCode).toBe(200);
  expect(
    (await app.inject({ ...request, payload: request.payload + " " }))
      .statusCode,
  ).toBe(401);
});

it("GitHub 合併通知帶有投遞識別碼、儲存庫與 PR 編號，改動本文會被拒收", async () => {
  const request = signedGitHubPrMerged({
    secret: keys.githubWebhookSecret,
    deliveryId: "00000000-0000-4000-8000-000000000027",
    repository: "example-org/sample-board",
    prNumber: 27,
  });
  expect(request.url).toBe("/webhooks/github");
  expect(request.headers).toMatchObject({
    "x-github-event": "pull_request",
    "x-github-delivery": "00000000-0000-4000-8000-000000000027",
    "x-hub-signature-256": expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
  });
  expect(JSON.parse(request.payload)).toMatchObject({
    action: "closed",
    repository: { full_name: "example-org/sample-board" },
    pull_request: { number: 27, state: "closed", merged: true },
  });
  expect((await app.inject(request)).statusCode).toBe(200);
  expect(
    (await app.inject({ ...request, payload: request.payload + " " }))
      .statusCode,
  ).toBe(401);
});

it("Discord Gateway 把 INTERACTION_CREATE 分派為指定頻道成員的／任務需求", async () => {
  const interaction = vi.fn(async () => {});
  const gateway = createDiscordGateway();
  gateway.start("虛構的驗收權杖", {
    event: vi.fn(),
    health: vi.fn(),
    interaction,
  });
  try {
    const input = {
      guildId,
      channelId,
      applicationId,
      userId: "100000000000000004",
      interactionId: "100000000000000005",
      sequence: 7,
      text: "請更新範例清單標題",
    };
    const packet = discordTaskInteraction(input);
    expect(packet).toMatchObject({
      op: GatewayOpcodes.Dispatch,
      t: GatewayDispatchEvents.InteractionCreate,
      s: 7,
    });
    gatewayEvents.emit(Events.Raw, packet);
    expect(interaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "task",
        id: input.interactionId,
        applicationId,
        channel: channelId,
        member: expect.objectContaining({ id: input.userId }),
        text: input.text,
        token: expect.stringMatching(/^[a-zA-Z0-9]+$/),
      }),
    );
  } finally {
    await gateway.stop();
  }
});
