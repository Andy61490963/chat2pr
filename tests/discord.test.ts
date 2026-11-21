import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db, fixture, reset, session } from "./helpers.js";
import {
  startDiscord,
  type DiscordGateway,
  type DiscordMessageEvent,
} from "../server/discord.js";
import { discordId } from "../server/chat-platform.js";
import { cleanup, downloadPendingImages } from "../server/maintenance.js";
import { Line } from "../server/line.js";
import { dueTriageGroups } from "../server/triage-window.js";
import { Triage } from "../server/triage.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import { buildApp } from "../server/app.js";
import { discordServiceText } from "../shared/status-glossary.js";

const channel = "100000000000000001";
const group = discordId(channel);
const botId = "100000000000000002";
const author = { id: "100000000000000003", name: "小林" };
const imageUrl =
  "https://cdn.discordapp.com/attachments/100000000000000001/100000000000000004/example.png";
const secondImageUrl =
  "https://cdn.discordapp.com/attachments/100000000000000001/100000000000000005/example.png";

function create(
  id: string,
  fields: Partial<Extract<DiscordMessageEvent, { type: "create" }>> = {},
) {
  return {
    type: "create",
    id,
    channel,
    botId,
    author,
    name: "範例伺服器／#需求",
    text: "請整理示範專案的按鈕。",
    images: [],
    ...fields,
  } satisfies DiscordMessageEvent;
}

let stop: (() => Promise<void>) | undefined;
function fakeGateway() {
  let callbacks!: Parameters<DiscordGateway["start"]>[1];
  const gateway = {
    start: vi.fn<DiscordGateway["start"]>((_token, handlers) => {
      callbacks = handlers;
    }),
    stop: vi.fn(async () => {}),
  };
  stop = startDiscord(db, "虛構權杖", () => gateway).stop;
  return { gateway, ...callbacks };
}

beforeEach(reset);
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

it("未設定權杖時不建立 Gateway，LINE 仍可建立群組並收訊", async () => {
  const make = vi.fn<() => DiscordGateway>();
  stop = startDiscord(db, undefined, make).stop;
  await stop();
  expect(make).not.toHaveBeenCalled();
  expect(
    await db.one("SELECT ok,detail FROM service_health WHERE name='discord'"),
  ).toEqual({
    ok: false,
    detail: discordServiceText.unconfigured,
  });
  await new Line(db).ingest({
    events: [
      {
        type: "message",
        webhookEventId: "範例事件",
        source: { groupId: "範例群組", type: "group" },
        message: {
          id: "範例訊息",
          type: "text",
          text: "小林正在整理示範專案。",
        },
      },
    ],
  });
  expect(
    await db.one("SELECT platform FROM groups WHERE id='範例群組'"),
  ).toEqual({ platform: "line" });
  expect(await db.one("SELECT text FROM messages WHERE id='範例訊息'")).toEqual(
    { text: "小林正在整理示範專案。" },
  );
});

it("Gateway 斷線與重連會更新服務狀態，程式關閉時會關閉連線", async () => {
  const { gateway, health } = fakeGateway();
  expect(gateway.start).toHaveBeenCalledOnce();
  await health("connected");
  expect(
    await db.one("SELECT ok,detail FROM service_health WHERE name='discord'"),
  ).toEqual({
    ok: true,
    detail: discordServiceText.connected,
  });
  await health("disconnected");
  expect(
    await db.one("SELECT ok,detail FROM service_health WHERE name='discord'"),
  ).toEqual({
    ok: false,
    detail: discordServiceText.disconnected,
  });
  await health("connected");
  expect(
    await db.one("SELECT ok FROM service_health WHERE name='discord'"),
  ).toEqual({ ok: true });
  await stop?.();
  stop = undefined;
  expect(gateway.stop).toHaveBeenCalledOnce();
});

it("忽略機器人訊息，新頻道停用且保留文字、附圖、發言者與引用", async () => {
  const { event } = fakeGateway();
  await event(create("20", { author: { ...author, bot: true } }));
  await event(create("21", { author: { ...author, id: botId } }));
  expect(await db.query("SELECT id FROM groups")).toEqual([]);
  await event(create("22", { images: [imageUrl, secondImageUrl] }));
  await event(create("22", { images: [imageUrl, secondImageUrl] }));
  await event(create("23", { quotedId: "22", text: "這是示範專案的補充。" }));
  expect(
    await db.one("SELECT platform,name,enabled FROM groups WHERE id=$1", [
      group,
    ]),
  ).toEqual({
    platform: "discord",
    name: "範例伺服器／#需求",
    enabled: false,
  });

  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#21804e" },
  })
    .png()
    .toBuffer();
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array(png), {
        headers: { "content-type": "image/png" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const lineImage = vi.fn();
  await downloadPendingImages(db, { image: lineImage });
  expect(lineImage).not.toHaveBeenCalled();
  for (const url of [imageUrl, secondImageUrl])
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ redirect: "error" }),
    );

  const app = await buildApp(db);
  try {
    const response = await app.inject({
      url: `/api/groups/${encodeURIComponent(group)}/messages`,
      headers: await session(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toHaveLength(4);
    expect(response.json().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: discordId("22"),
          sender: "小林",
          type: "text",
          routing: "chat",
        }),
        expect.objectContaining({
          type: "image",
          has_image: true,
          sender: "小林",
        }),
        expect.objectContaining({
          id: discordId("23"),
          quoted_id: discordId("22"),
          quoted_sender: "小林",
          quoted_text: "請整理示範專案的按鈕。",
        }),
      ]),
    );
    expect(response.body).not.toContain(imageUrl);
  } finally {
    await app.close();
  }

  await db.query("UPDATE messages SET received_at=now()-interval '31 days'");
  await cleanup(db);
  expect(
    await db.query(
      "SELECT id FROM messages WHERE sender_name IS NOT NULL OR image_source_url IS NOT NULL OR image IS NOT NULL",
    ),
  ).toEqual([]);
});

it("指令觸發可用任務前綴或提及機器人，排程同時選出 LINE 和 Discord", async () => {
  const { event } = fakeGateway();
  const project = await fixture();
  const name = `${"範例".repeat(50)}／#${"需求".repeat(50)}`;
  await event(create("30", { name }));
  const app = await buildApp(db);
  try {
    const response = await app.inject({
      method: "PUT",
      url: `/api/groups/${encodeURIComponent(group)}`,
      headers: await session(),
      payload: {
        name,
        enabled: true,
        project_ids: [project],
        trigger_mode: "command",
      },
    });
    expect(response.statusCode).toBe(200);
  } finally {
    await app.close();
  }
  await event(create("31", { text: "小林正在整理按鈕。" }));
  await event(create("32", { text: "/任務 整理按鈕" }));
  await event(create("33", { text: `<@${botId}> 整理版面` }));
  await event(create("34", { text: "/任務清單還沒整理完" }));
  await new Line(db).ingest({
    events: [
      {
        type: "message",
        webhookEventId: "範例並行事件",
        source: { groupId: "group-a", type: "group" },
        message: { id: "line-demo", type: "text", text: "請整理示範專案。" },
      },
    ],
  });
  await db.query(
    "UPDATE groups SET last_pending_at=now()-interval '61 seconds'",
  );
  expect((await dueTriageGroups(db)).map((row) => row.id).sort()).toEqual(
    [group, "group-a"].sort(),
  );

  const github = new GitHub();
  github.context = async () => ({
    branches: { names: ["main"], defaultBranch: "main", truncated: false },
    branchError: null,
    sha: "fixture-base",
    paths: [],
    files: {},
    truncated: false,
  });
  const classify = vi.fn(async () => [
    {
      kind: "ignore" as const,
      projectId: null,
      title: "",
      summary: "",
      acceptance: [],
      sourceIds: [discordId("32"), discordId("33")],
      risks: [],
      missing: [],
      relatedTaskId: null,
      suggestions: [],
    },
  ]);
  await new Triage(
    db,
    { classify },
    github,
    new Line(db),
    new Budget(db),
  ).process(group, true);
  expect(classify).toHaveBeenCalledOnce();
  expect(
    await db.query(
      "SELECT id FROM messages WHERE group_id=$1 AND trigger_mode='command' AND processed ORDER BY id",
      [group],
    ),
  ).toEqual(["32", "33"].map((id) => ({ id: discordId(id) })));
});

it("判讀途中收到編輯時，舊內容不能結算", async () => {
  const { event } = fakeGateway();
  const project = await fixture();
  await event(create("50"));
  await db.query(
    "UPDATE groups SET enabled=true,trigger_mode='auto' WHERE id=$1",
    [group],
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES($1,$2)",
    [group, project],
  );
  await event(create("51"));

  const github = new GitHub();
  github.context = async () => ({
    branches: { names: ["main"], defaultBranch: "main", truncated: false },
    branchError: null,
    sha: "fixture-base",
    paths: [],
    files: {},
    truncated: false,
  });
  const classify = async () => {
    await event({
      type: "update",
      id: "51",
      channel,
      editedAt: "2026-11-21T00:00:00Z",
      botId,
      text: "請改為整理手冊。",
    });
    return [
      {
        kind: "ignore" as const,
        projectId: null,
        title: "",
        summary: "",
        acceptance: [],
        sourceIds: [discordId("51")],
        risks: [],
        missing: [],
        relatedTaskId: null,
        suggestions: [],
      },
    ];
  };
  const triage = new Triage(
    db,
    { classify },
    github,
    new Line(db),
    new Budget(db),
  );
  await expect(triage.process(group)).rejects.toThrow("來源訊息已改變");
  expect(
    await db.one("SELECT text,processed FROM messages WHERE id=$1", [
      discordId("51"),
    ]),
  ).toEqual({
    text: "請改為整理手冊。",
    processed: false,
  });
});

it("編輯替換待判讀內容，已判讀的編輯與刪除會使相關工作回到人工確認", async () => {
  const { event } = fakeGateway();
  const project = await fixture();
  await event(create("40"));
  await db.query(
    "UPDATE groups SET enabled=true,trigger_mode='auto' WHERE id=$1",
    [group],
  );
  await event(create("41", { images: [imageUrl, secondImageUrl] }));
  const message = discordId("41");
  const readMessage = () =>
    db.one(
      "SELECT text,processed,revoked,needs_source_review FROM messages WHERE id=$1",
      [message],
    );
  await event({
    type: "update",
    id: "41",
    channel,
    editedAt: "2026-11-21T00:00:00Z",
    botId,
    text: "請先整理版面。",
  });
  expect(await readMessage()).toEqual({
    text: "請先整理版面。",
    processed: false,
    revoked: false,
    needs_source_review: false,
  });
  await db.query(
    "UPDATE messages SET processed=true WHERE discord_message_id=$1",
    [message],
  );
  const task = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,status,approved_version,source_ids,dedupe_key) VALUES($1,$2,'整理版面','整理示範專案的版面','queued',1,$3,'範例任務') RETURNING id",
    [project, group, [message, `${message}:image:100000000000000005`]],
  );
  const readTask = () =>
    db.one(
      "SELECT status,version,approved_version,missing FROM tasks WHERE id=$1",
      [task.id],
    );
  const edit = {
    type: "update",
    id: "41",
    channel,
    editedAt: "2026-11-21T00:00:01Z",
    botId,
    text: "請只整理首頁。",
    images: [imageUrl],
  } as const;
  await event(edit);
  await event(edit);
  expect(await readMessage()).toEqual({
    text: "請只整理首頁。",
    processed: false,
    revoked: false,
    needs_source_review: true,
  });
  expect(await readTask()).toEqual({
    status: "awaiting_approval",
    version: 2,
    approved_version: null,
    missing: ["來源訊息已編輯，請重新確認需求"],
  });
  expect(
    await db.one("SELECT revoked,image_source_url FROM messages WHERE id=$1", [
      `${message}:image:100000000000000005`,
    ]),
  ).toEqual({
    revoked: true,
    image_source_url: null,
  });

  await event({ type: "delete", id: "41", channel });
  await event({ type: "delete", id: "41", channel });
  await event(create("41"));
  expect(await readMessage()).toEqual({
    text: null,
    processed: true,
    revoked: true,
    needs_source_review: true,
  });
  expect(await readTask()).toEqual({
    status: "awaiting_approval",
    version: 3,
    approved_version: null,
    missing: [
      "來源訊息已編輯，請重新確認需求",
      "來源訊息已撤回，請重新確認需求",
    ],
  });
  expect(
    await db.one(
      "SELECT first_pending_at,last_pending_at FROM groups WHERE id=$1",
      [group],
    ),
  ).toEqual({ first_pending_at: null, last_pending_at: null });
  expect(
    await db.query("SELECT kind FROM audit WHERE task_id=$1 ORDER BY id", [
      task.id,
    ]),
  ).toEqual([{ kind: "message_edit" }, { kind: "unsend" }]);
});
