import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { db, fixture, reset, session } from "./helpers.js";
import {
  ingestDiscord,
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
import {
  discordDeliveryNotes,
  discordServiceText,
} from "../shared/status-glossary.js";
import {
  DiscordChatPlatform,
  type DiscordRest,
} from "../server/discord-platform.js";
import { answerPostbackData, askInGroup } from "../server/answers.js";
import { notifyGroup } from "../server/group-replies.js";
import type { Task } from "../shared/types.js";

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
function fakeGateway(platform?: DiscordChatPlatform, applicationId?: string) {
  let callbacks!: Parameters<DiscordGateway["start"]>[1];
  const gateway = {
    start: vi.fn<DiscordGateway["start"]>((_token, handlers) => {
      callbacks = handlers;
    }),
    stop: vi.fn(async () => {}),
  };
  stop = startDiscord(
    db,
    "虛構權杖",
    () => gateway,
    platform,
    applicationId,
  ).stop;
  return { gateway, ...callbacks };
}

beforeEach(reset);
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

const sourceId = "100000000000000010";
const applicationId = "100000000000000011";
const interactionReplyId = "100000000000000012";
const dmChannel = "100000000000000013";
const interaction = {
  id: "100000000000000014",
  // 路由會把權杖做網址編碼；用英數字的虛構值，預期的路徑才對得上。
  token: "fictional-interaction-token",
  applicationId,
  channel,
  name: "範例伺服器／#需求",
  member: author,
  botId,
};

function fakeRest() {
  let nextId = 100000000000000100n;
  const rest = {
    get: vi.fn<DiscordRest["get"]>(async () => ({ id: interactionReplyId })),
    patch: vi.fn<DiscordRest["patch"]>(async () => ({
      id: interactionReplyId,
    })),
    put: vi.fn<DiscordRest["put"]>(async () => null),
    post: vi.fn<DiscordRest["post"]>(async (route) => {
      if (route === "/users/@me/channels") return { id: dmChannel };
      return { id: String(nextId++) };
    }),
  };
  return { rest, platform: new DiscordChatPlatform(rest) };
}

async function discordTask() {
  await ingestDiscord(db, create(sourceId));
  await db.query(
    "UPDATE groups SET enabled=true,reply_mode='all',trigger_mode='command' WHERE id=$1",
    [group],
  );
  return db.one<Task>(
    `INSERT INTO tasks(group_id,title,summary,dedupe_key,source_ids,question)
     VALUES($1,'整理示範專案','調整按鈕','範例需求',$2,$3) RETURNING *`,
    [
      group,
      [discordId(sourceId)],
      JSON.stringify({
        text: "要調整哪個按鈕？",
        choices: ["查詢按鈕", "取消按鈕"],
      }),
    ],
  );
}

it("Discord 群組送出補問、查詢答案、完成與失敗，收到需求只在原訊息加反應", async () => {
  const { rest, platform } = fakeRest();
  const task = await discordTask();
  await askInGroup(db.pool, task);
  for (const kind of ["received", "answered", "ready", "failed", "waiting"])
    await notifyGroup(
      db.pool,
      task.id,
      kind,
      `範例:${kind}`,
      "示範專案的群組通知",
    );
  await new Line(db, platform).flushNotifications();

  expect(rest.put).toHaveBeenCalledExactlyOnceWith(
    `/channels/${channel}/messages/${sourceId}/reactions/${encodeURIComponent("✅")}/@me`,
  );
  expect(rest.post).toHaveBeenCalledTimes(5);
  for (const [route, options] of rest.post.mock.calls) {
    expect(route).toBe(`/channels/${channel}/messages`);
    expect(options?.body).toMatchObject({
      message_reference: { message_id: sourceId },
      allowed_mentions: { parse: [], replied_user: false },
    });
  }
  expect(
    rest.post.mock.calls.map(([, options]) => options?.body),
  ).toContainEqual(
    expect.objectContaining({
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 2,
              label: "查詢按鈕",
              custom_id: answerPostbackData(task, 0),
            },
            {
              type: 2,
              style: 2,
              label: "取消按鈕",
              custom_id: answerPostbackData(task, 1),
            },
          ],
        },
      ],
    }),
  );
  const rows = await db.query<{
    kind: string;
    sent_at: Date;
    sent_message_id: string | null;
  }>(
    "SELECT kind,sent_at,sent_message_id FROM notifications WHERE group_id=$1",
    [group],
  );
  expect(rows).toHaveLength(6);
  for (const row of rows) {
    expect(row.sent_at).toBeInstanceOf(Date);
    if (row.kind === "group_received") expect(row.sent_message_id).toBeNull();
    else expect(row.sent_message_id).toMatch(/^discord:\d+$/);
  }
});

it("Discord 按鈕只接受同頻道的現行版本，回覆機器人的補問也能作答", async () => {
  const { platform, rest } = fakeRest();
  const gateway = fakeGateway(platform);
  const task = await discordTask();
  await askInGroup(db.pool, task);
  await new Line(db, platform).flushNotifications();
  const otherChannel = "100000000000000015";
  await gateway.event(create("100000000000000016", { channel: otherChannel }));
  await db.query("UPDATE groups SET enabled=true WHERE id=$1", [
    discordId(otherChannel),
  ]);
  const button = {
    ...interaction,
    kind: "answer" as const,
    data: answerPostbackData(task, 0),
  };
  await gateway.interaction?.({ ...button, channel: otherChannel });
  expect(
    (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [task.id])).version,
  ).toBe(task.version);
  await gateway.interaction?.(button);
  await gateway.interaction?.({ ...button, id: "100000000000000017" });
  const answered = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    task.id,
  ]);
  expect(answered).toMatchObject({
    version: task.version + 1,
    question: null,
    status: "awaiting_approval",
  });
  expect(answered.summary).toContain("回答：查詢按鈕");
  expect(rest.patch.mock.calls.at(-1)?.[1]?.body).toMatchObject({
    content: expect.stringContaining("這題已經回答過"),
  });

  const next = await db.one<Task>(
    "UPDATE tasks SET question=$2 WHERE id=$1 RETURNING *",
    [task.id, JSON.stringify(task.question)],
  );
  await askInGroup(db.pool, next);
  await new Line(db, platform).flushNotifications();
  const question = await db.one<{ sent_message_id: string }>(
    "SELECT sent_message_id FROM notifications WHERE dedupe_key=$1",
    [`group:question:${next.id}:${next.version}`],
  );
  await gateway.event(
    create("100000000000000018", {
      quotedId: question.sent_message_id.slice("discord:".length),
      text: "取消按鈕",
    }),
  );
  expect(
    await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [task.id]),
  ).toMatchObject({
    version: next.version + 1,
    question: null,
    summary: expect.stringContaining("回答：取消按鈕"),
  });
});

it("Discord 註冊斜線指令，進度透過互動取回補問，任務指令使用同一條收訊流程", async () => {
  const { platform, rest } = fakeRest();
  const gateway = fakeGateway(platform, applicationId);
  await gateway.health("connected");
  expect(rest.put).toHaveBeenCalledWith(
    `/applications/${applicationId}/commands`,
    {
      body: [
        expect.objectContaining({ name: "任務" }),
        expect.objectContaining({ name: "進度" }),
      ],
    },
  );
  const task = await discordTask();
  await askInGroup(db.pool, task);
  await gateway.interaction?.({ ...interaction, kind: "progress" });
  expect(rest.patch.mock.calls[0][1]?.body).toMatchObject({
    content: expect.stringContaining("整理示範專案"),
  });
  expect(rest.post).toHaveBeenCalledWith(
    `/webhooks/${applicationId}/${interaction.token}`,
    expect.objectContaining({
      body: expect.objectContaining({
        content: expect.stringContaining("要調整哪個按鈕"),
      }),
    }),
  );
  expect(
    rest.post.mock.calls.every(([route]) => !route.startsWith("/channels/")),
  ).toBe(true);
  expect(
    await db.one(
      "SELECT sent_message_id,last_error FROM notifications WHERE task_id=$1",
      [task.id],
    ),
  ).toEqual({
    sent_message_id: expect.stringMatching(/^discord:\d+$/),
    last_error: null,
  });

  const requestId = "100000000000000019";
  await gateway.interaction?.({
    ...interaction,
    id: requestId,
    kind: "task",
    text: "請查詢示範專案",
  });
  await gateway.event({
    type: "update",
    id: interactionReplyId,
    channel,
    botId,
    text: "已記下這則需求。",
    editedAt: "2026-11-20T00:00:00.000Z",
  });
  expect(
    await db.one(
      "SELECT text,trigger_mode,processed,discord_reply_message_id FROM messages WHERE id=$1",
      [discordId(requestId)],
    ),
  ).toEqual({
    text: "/任務 請查詢示範專案",
    trigger_mode: "command",
    processed: false,
    discord_reply_message_id: discordId(interactionReplyId),
  });
});

it("Discord 依 429 的等待秒數延後群組送訊，不增加失敗次數，之後可以續送", async () => {
  const { platform, rest } = fakeRest();
  const task = await discordTask();
  await askInGroup(db.pool, task);
  rest.post.mockRejectedValueOnce({ status: 429, retry_after: 45.5 });
  const line = new Line(db, platform);
  const before = Date.now();
  await line.flushNotifications();
  const queued = await db.one<{
    attempts: number;
    discord_retry_at: Date;
    last_error: string;
  }>(
    "SELECT attempts,discord_retry_at,last_error FROM notifications WHERE task_id=$1",
    [task.id],
  );
  expect(queued.attempts).toBe(0);
  expect(queued.last_error).toBe(discordDeliveryNotes.rate);
  expect(queued.discord_retry_at.getTime()).toBeGreaterThanOrEqual(
    before + 45_500,
  );
  await line.flushNotifications();
  expect(rest.post).toHaveBeenCalledTimes(1);
  await db.query(
    "UPDATE notifications SET discord_retry_at=now()-interval '1 second' WHERE task_id=$1",
    [task.id],
  );
  await line.flushNotifications();
  expect(
    await db.one(
      "SELECT attempts,last_error,sent_message_id FROM notifications WHERE task_id=$1",
      [task.id],
    ),
  ).toEqual({
    attempts: 1,
    last_error: null,
    sent_message_id: expect.stringMatching(/^discord:\d+$/),
  });
});

it("Discord 查詢回覆可在指令模式引用追問，送達失敗會出現在聊天室與任務詳情", async () => {
  const { platform, rest } = fakeRest();
  const gateway = fakeGateway(platform);
  const task = await discordTask();
  await notifyGroup(
    db.pool,
    task.id,
    "answered",
    "範例查詢",
    "示範專案已提供查詢結果",
  );
  const line = new Line(db, platform);
  await line.flushNotifications();
  const sent = await db.one<{ sent_message_id: string }>(
    "SELECT sent_message_id FROM notifications WHERE task_id=$1",
    [task.id],
  );
  const followup = "100000000000000022";
  await gateway.event(
    create(followup, {
      quotedId: sent.sent_message_id.slice("discord:".length),
      text: "那取消按鈕呢？",
    }),
  );
  expect(
    await db.one(
      "SELECT quoted_id,bot_reply,trigger_mode,processed FROM messages WHERE id=$1",
      [discordId(followup)],
    ),
  ).toEqual({
    quoted_id: sent.sent_message_id,
    bot_reply: true,
    trigger_mode: "command",
    processed: false,
  });

  await askInGroup(db.pool, task);
  rest.post.mockRejectedValue({ status: 403 });
  for (let i = 0; i < 3; i++) await line.flushNotifications();
  const expected = {
    kind: "group_question",
    delivery: {
      status: "failed",
      reason: "error",
      note: discordDeliveryNotes.permission,
    },
  };
  const app = await buildApp(db);
  try {
    const headers = await session();
    const chat = await app.inject({
      url: `/api/groups/${encodeURIComponent(group)}/messages`,
      headers,
    });
    const detail = await app.inject({ url: `/api/tasks/${task.id}`, headers });
    expect(chat.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(chat.json().bot_messages).toContainEqual(
      expect.objectContaining(expected),
    );
    expect(detail.json().groupDeliveries).toContainEqual(
      expect.objectContaining(expected),
    );
  } finally {
    await app.close();
  }
});

it("管理者切換到 Discord 後，以有效私訊代碼配對並送出通知，不呼叫 LINE", async () => {
  const app = await buildApp(db);
  try {
    const { platform, rest } = fakeRest();
    const gateway = fakeGateway(platform);
    const headers = await session();
    const switched = await app.inject({
      method: "PUT",
      url: "/api/settings/admin-notifications",
      headers,
      payload: { admin_notify_platform: "discord" },
    });
    expect(switched.statusCode).toBe(200);
    const pair = () =>
      app.inject({ method: "POST", url: "/api/pairing", headers });
    const receiver = {
      id: "100000000000000020",
      user: author.id,
      channel: dmChannel,
    };
    const expired = (await pair()).json().code;
    await db.query(
      "UPDATE pairing_codes SET expires_at=now()-interval '1 second'",
    );
    await gateway.privateMessage?.({ ...receiver, text: `配對 ${expired}` });
    expect((await db.settings()).admin_discord_id).toBeFalsy();

    const code = (await pair()).json().code;
    const line = new Line(db, platform);
    await line.ingest({
      events: [
        {
          type: "message",
          webhookEventId: "示範錯誤平台事件",
          source: { type: "user", userId: "範例 LINE 使用者" },
          message: { id: "示範配對訊息", type: "text", text: `配對 ${code}` },
        },
      ],
    });
    expect((await db.settings()).admin_line_id).toBeNull();
    await gateway.privateMessage?.({
      ...receiver,
      id: "100000000000000021",
      text: `配對 ${code}`,
    });
    await gateway.privateMessage?.({
      ...receiver,
      id: "100000000000000023",
      user: "100000000000000024",
      text: `配對 ${code}`,
    });
    expect((await db.settings()).admin_discord_id).toBe(discordId(author.id));
    const state = await app.inject({ url: "/api/state", headers });
    expect(state.json().settings).toMatchObject({
      admin_notify_platform: "discord",
      admin_discord_id: "已綁定",
    });
    expect(
      await db.one(
        "SELECT detail FROM audit WHERE kind='settings' ORDER BY id DESC LIMIT 1",
      ),
    ).toMatchObject({
      detail: expect.stringContaining("由 LINE 改成 Discord"),
    });

    await db.query(
      `UPDATE settings SET value=value||'{"admin_line_id":"虛構 LINE 管理者"}' WHERE id=1`,
    );
    await db.query(`INSERT INTO notifications(kind,dedupe_key,text) VALUES
      ('approval','範例待確認','待確認示範專案'),('failed','範例失敗','示範專案處理失敗'),
      ('input_required','範例補問','請確認示範專案的補問')`);
    rest.post.mockClear();
    const lineFetch = vi.fn();
    vi.stubGlobal("fetch", lineFetch);
    await line.flushNotifications();
    expect(lineFetch).not.toHaveBeenCalled();
    expect(rest.post.mock.calls.map(([route]) => route)).toEqual(
      Array.from({ length: 3 }, () => [
        "/users/@me/channels",
        `/channels/${dmChannel}/messages`,
      ]).flat(),
    );
    expect(
      await db.one(
        "SELECT count(*)::int AS count FROM notifications WHERE group_id IS NULL AND sent_at IS NOT NULL",
      ),
    ).toEqual({ count: 3 });
  } finally {
    await app.close();
  }
});

it("未設定權杖時不建立 Gateway，LINE 仍可建立群組並收訊", async () => {
  const make = vi.fn<() => DiscordGateway>();
  stop = startDiscord(db, undefined, make).stop;
  await stop();
  expect(make).not.toHaveBeenCalled();
  expect(
    await db.one("SELECT ok,detail FROM service_health WHERE name='discord'"),
  ).toEqual({
    // 選用功能：沒設定記為正常，冒煙測試不會列為異常；設定頁仍依說明顯示「尚未設定」。
    ok: true,
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
