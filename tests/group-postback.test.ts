import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac, randomUUID } from "node:crypto";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "fictional-postback-secret",
    lineToken: "fictional-line-token",
  }),
}));
import { db, reset, fixture } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Line } from "../server/line.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Budget } from "../server/budget.js";
import { askInGroup } from "../server/answers.js";
import {
  answerAck,
  answerHeldAck,
  commandAck,
  pausedAck,
  staleAnswerAck,
  triageDuplicateText,
  triageIgnoredText,
  triageKnownMemoryText,
  triageRememberedText,
  triageStoppedAck,
} from "../server/group-replies.js";
import type {
  Group,
  Message,
  Project,
  Task,
  TriageDecision,
} from "../shared/types.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let project: string;
let pushes: { to: string; messages: any[] }[];
let replies: { token: string; texts: string[] }[];

// service_health 不在 reset() 清除的資料表裡；留著會讓推播被當成額度用完。
const clearHealth = () =>
  db.query(
    "DELETE FROM service_health WHERE name IN ('line_quota','notifications','codex_subscription_gate')",
  );

beforeEach(async () => {
  await reset();
  await clearHealth();
  project = await fixture();
  app = await buildApp(db);
  pushes = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (String(url).endsWith("/v2/bot/message/push")) {
        pushes.push({ to: body.to, messages: body.messages });
        return Response.json({ sentMessages: [{ id: "fictional-push-id" }] });
      }
      if (String(url).endsWith("/v2/bot/message/reply")) {
        replies.push({
          token: body.replyToken,
          texts: body.messages.map((m: { text: string }) => m.text),
        });
        return Response.json({ sentMessages: [] });
      }
      return Response.json({});
    }),
  );
});
afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
  await clearHealth();
});
afterAll(() => db.close());

async function webhook(event: Record<string, unknown>) {
  const payload = JSON.stringify({ events: [event] });
  const r = await app.inject({
    method: "POST",
    url: "/webhooks/line",
    payload,
    headers: {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", "fictional-postback-secret")
        .update(payload)
        .digest("base64"),
    },
  });
  expect(r.statusCode).toBe(200);
}
/** 群組成員點了快速回覆按鈕。eventId 相同代表 LINE 重送同一個事件。 */
const postback = (
  data: string,
  opts: { group?: string; eventId?: string } = {},
) =>
  webhook({
    webhookEventId: opts.eventId ?? `event-${randomUUID()}`,
    type: "postback",
    replyToken: `fictional-reply-${randomUUID()}`,
    source: {
      type: "group",
      groupId: opts.group ?? "group-a",
      userId: "fictional-member",
    },
    postback: { data },
  });
const message = (id: string, text: string, group = "group-a") =>
  webhook({
    webhookEventId: `event-${id}`,
    type: "message",
    replyToken: `fictional-reply-${id}`,
    source: { type: "group", groupId: group, userId: "fictional-member" },
    message: { id, type: "text", text },
  });

const clear = {
  status: "clear",
  basis: "explicit",
  reason: "訊息指名專案",
  evidence: [],
  bindingVersion: 1,
};
const longChoice = "下載後打開的內容和畫面上看到的不一樣，少了訂單日期欄位";
const fakeToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";

/** 一個在群組等回答的需求（已排入群組補問）。 */
async function asking(
  mode: "query" | "change",
  choices: string[] = ["沒有下載", longChoice],
) {
  const t = await db.one<Task>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,missing,question,project_routing,dedupe_key)
     VALUES($1,'group-a','匯出問題','匯出怪怪的','["說明匯出問題"]','awaiting_approval',$2,'["是按了沒下載，還是內容不對？"]',
     $3,$4,$5) RETURNING *`,
    [
      project,
      mode,
      JSON.stringify({ text: "是按了沒下載，還是內容不對？", choices }),
      JSON.stringify(clear),
      randomUUID(),
    ],
  );
  await askInGroup(db.pool, t!);
  return t!;
}
const reload = async (id: string) =>
  (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [id]))!;
const lastReply = () => replies.at(-1)?.texts;

describe("補問的常見答案按鈕", () => {
  it("推播帶 quickReply：每個常見答案一個按鈕，標籤截到 20 字，data 綁定任務與版本", async () => {
    const t = await asking("query");
    await new Line(db).flushNotifications();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].to).toBe("group-a");
    const [m] = pushes[0].messages;
    expect(m.type).toBe("text");
    expect(m.text).toContain("是按了沒下載，還是內容不對？");
    // 按鈕在群組有新訊息後就會消失，仍要說明可以用「回覆」作答。
    expect(m.text).toContain("也可以直接「回覆」這則訊息回答");
    expect(m.quickReply.items).toEqual([
      {
        type: "action",
        action: {
          type: "postback",
          label: "沒有下載",
          data: `answer:${t.id}:${t.version}:0`,
          displayText: "沒有下載",
        },
      },
      {
        type: "action",
        action: {
          type: "postback",
          label: Array.from(longChoice).slice(0, 20).join(""),
          data: `answer:${t.id}:${t.version}:1`,
          displayText: longChoice,
        },
      },
    ]);
    expect(Array.from(m.quickReply.items[1].action.label)).toHaveLength(20);
    for (const item of m.quickReply.items)
      expect(item.action.data.length).toBeLessThanOrEqual(300);
  });

  it("沒有常見答案時不帶按鈕；含憑證格式的選項不給按鈕", async () => {
    await asking("query", []);
    const withSecret = await asking("query", ["沒有下載", fakeToken]);
    await new Line(db).flushNotifications();
    expect(pushes).toHaveLength(2);
    const plain = pushes.find((p) => !p.messages[0].quickReply)!;
    expect(plain.messages[0].text).toContain("直接「回覆」這則訊息回答就可以");
    const buttons = pushes.find((p) => p.messages[0].quickReply)!.messages[0]
      .quickReply.items;
    expect(buttons.map((b: any) => b.action.data)).toEqual([
      `answer:${withSecret.id}:${withSecret.version}:0`,
    ]);
  });
});

describe("在群組點常見答案作答", () => {
  it("查詢：同群組、正確版本的按鈕被收下，產生新版本並直接繼續；重送同一事件不會再套用", async () => {
    const t = await asking("query");
    const eventId = `event-${randomUUID()}`;
    await postback(`answer:${t.id}:${t.version}:1`, { eventId });
    const after = await reload(t.id);
    expect(after.version).toBe(t.version + 1);
    expect(after.question).toBeNull();
    expect(after.status).toBe("queued");
    // 以任務上的選項原文作答，不是按鈕的截短標籤。
    expect(after.summary).toContain(`回答：${longChoice}`);
    expect(after.source_ids).toContain(`postback:${eventId}`);
    expect(lastReply()).toEqual([answerAck]);
    const audit = await db.one<{ detail: string }>(
      "SELECT detail FROM audit WHERE task_id=$1 AND kind='question_answered'",
      [t.id],
    );
    expect(audit!.detail).toContain("群組成員（LINE）");

    await postback(`answer:${t.id}:${t.version}:1`, { eventId });
    expect((await reload(t.id)).version).toBe(t.version + 1);
    expect(replies).toHaveLength(1);

    // 另一個人再點同一個舊按鈕：版本已變，不再套用，並說明這題已回答。
    await postback(`answer:${t.id}:${t.version}:0`);
    expect((await reload(t.id)).version).toBe(t.version + 1);
    expect(lastReply()).toEqual([staleAnswerAck]);
  });

  it("修改：產生新版本，仍停在等管理者確認", async () => {
    const t = await asking("change");
    await postback(`answer:${t.id}:${t.version}:0`);
    const after = await reload(t.id);
    expect(after.version).toBe(t.version + 1);
    expect(after.status).toBe("awaiting_approval");
    expect(after.approved_version).toBeNull();
    expect(after.question).toBeNull();
    expect(lastReply()).toEqual([answerHeldAck]);
    expect(
      await db.query(
        "SELECT 1 FROM notifications WHERE task_id=$1 AND kind='approval'",
        [t.id],
      ),
    ).toHaveLength(1);
  });

  it("別群組的按鈕、舊版本、不存在或含憑證的索引都不改任務；群組停用時忽略", async () => {
    const t = await asking("query", ["沒有下載", fakeToken]);
    await db.query(
      "INSERT INTO groups(id,name,enabled,trigger_mode) VALUES('group-b','另一個群組',true,'command')",
    );
    await postback(`answer:${t.id}:${t.version}:0`, { group: "group-b" });
    await postback(`answer:${t.id}:${t.version + 1}:0`);
    await postback(`answer:${t.id}:${t.version - 1}:0`);
    await postback(`answer:${t.id}:${t.version}:5`);
    await postback(`answer:${t.id}:${t.version}:1`);
    expect(await reload(t.id)).toMatchObject({
      version: t.version,
      status: "awaiting_approval",
      question: t.question,
    });
    expect(replies.map((r) => r.texts)).toEqual(
      Array(5).fill([staleAnswerAck]),
    );

    // 格式不符的 data 不回覆、不處理。
    await postback(`answer:not-a-task:${t.version}:0`);
    await postback(`adopt:${t.id}:${t.version}:0`);
    expect(replies).toHaveLength(5);

    await db.query("UPDATE groups SET enabled=false WHERE id='group-a'");
    await postback(`answer:${t.id}:${t.version}:0`);
    expect(replies).toHaveLength(5);
    expect((await reload(t.id)).version).toBe(t.version);
  });

  it("群組不回覆或總開關關閉時仍收下回答，但不回覆", async () => {
    const t = await asking("query");
    await db.query("UPDATE groups SET reply_mode='off' WHERE id='group-a'");
    await postback(`answer:${t.id}:${t.version}:0`);
    expect((await reload(t.id)).version).toBe(t.version + 1);
    expect(replies).toHaveLength(0);

    const u = await asking("query");
    await db.query("UPDATE groups SET reply_mode='results' WHERE id='group-a'");
    await db.query(
      `UPDATE settings SET value=value||'{"group_replies":false}'::jsonb WHERE id=1`,
    );
    await postback(`answer:${u.id}:${u.version}:0`);
    expect((await reload(u.id)).version).toBe(u.version + 1);
    expect(replies).toHaveLength(0);
  });
});

describe("判讀停止時的「收到」", () => {
  it("群組判讀連續失敗三次後，/任務 的「收到」說明判讀暫停；系統暫停仍優先", async () => {
    await db.query("UPDATE groups SET trigger_mode='command'");
    await message("m1", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([commandAck]);

    await db.query("UPDATE groups SET triage_failures=3 WHERE id='group-a'");
    await message("m2", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([triageStoppedAck]);

    await db.query(
      `UPDATE settings SET value=value||'{"paused":true}'::jsonb WHERE id=1`,
    );
    await message("m3", "/任務 調整按鈕顏色");
    expect(lastReply()).toEqual([pausedAck]);
  });
});

describe("/任務 沒有建立新任務時回報群組", () => {
  const decide = (
    kind: TriageDecision["kind"],
    sourceIds: string[],
    extra: Partial<TriageDecision> = {},
  ): TriageDecision => ({
    kind,
    projectId: null,
    title: "判讀結果",
    summary: "",
    acceptance: [],
    sourceIds,
    risks: [],
    missing: [],
    relatedTaskId: null,
    suggestions: [],
    ...extra,
  });
  /** 收一則群組訊息（不帶 reply token），再用指定的判讀結果處理所有未處理訊息。 */
  async function triage(
    id: string,
    text: string,
    make: (ids: string[]) => TriageDecision[],
  ) {
    await new Line(db).ingest({
      events: [
        {
          webhookEventId: `event-${id}`,
          type: "message",
          source: { type: "group", groupId: "group-a", userId: "fictional" },
          message: { id, type: "text", text },
        },
      ],
    });
    await rerun(make);
  }
  async function rerun(make: (ids: string[]) => TriageDecision[]) {
    const group = (await db.one<Group>(
      "SELECT * FROM groups WHERE id='group-a'",
    ))!;
    const projects = await db.query<Project>(
      "SELECT p.* FROM projects p JOIN group_projects gp ON gp.project_id=p.id WHERE gp.group_id='group-a'",
    );
    const messages = await db.query<Message>(
      "SELECT * FROM messages WHERE group_id='group-a' AND NOT processed AND trigger_mode<>'chat' ORDER BY received_at,id",
    );
    await new Triage(
      db,
      { classify: async () => [] },
      new GitHub(),
      new Line(db),
      new Budget(db),
    ).apply(
      group,
      projects,
      messages,
      make(messages.map((m) => m.id)),
      randomUUID(),
    );
  }
  const notices = () =>
    db.query<{
      task_id: string | null;
      kind: string;
      dedupe_key: string;
      text: string;
    }>(
      "SELECT task_id,kind,dedupe_key,text FROM notifications WHERE group_id='group-a' ORDER BY created_at,dedupe_key",
    );
  const related = async () =>
    (await db.one<{ id: string }>(
      "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,dedupe_key) VALUES($1,'group-a','匯出少了訂單日期','摘要','[]','queued','dedupe-related') RETURNING id",
      [project],
    ))!.id;

  it("指令模式的 /任務 判成重複、記住、無事項時各排一則說明；重複判讀不重複排", async () => {
    await db.query("UPDATE groups SET trigger_mode='command'");
    const relatedId = await related();
    await triage("c1", "/任務 匯出少了訂單日期", (ids) => [
      decide("duplicate", ids, { relatedTaskId: relatedId }),
    ]);
    await triage("c2", "/任務 記住：報工相關都改測試專案", (ids) => [
      decide("memory", ids, {
        title: "explicit",
        summary: "報工相關需求都改測試專案",
        projectId: project,
      }),
    ]);
    await triage("c3", "/任務 記住：報工相關需求都改 測試專案", (ids) => [
      decide("memory", ids, {
        title: "explicit",
        summary: "報工相關需求都改測試專案",
        projectId: project,
      }),
    ]);
    await triage("c4", "/任務 謝謝", (ids) => [decide("ignore", ids)]);
    expect(await notices()).toEqual([
      {
        task_id: relatedId,
        kind: "group_triage",
        dedupe_key: "group:triage:duplicate:c1",
        text: triageDuplicateText("匯出少了訂單日期"),
      },
      {
        task_id: null,
        kind: "group_triage",
        dedupe_key: "group:triage:memory:c2",
        text: triageRememberedText("報工相關需求都改測試專案"),
      },
      {
        task_id: null,
        kind: "group_triage",
        dedupe_key: "group:triage:memory:c3",
        text: triageKnownMemoryText,
      },
      {
        task_id: null,
        kind: "group_triage",
        dedupe_key: "group:triage:ignore:c4",
        text: triageIgnoredText,
      },
    ]);
    expect(triageDuplicateText("匯出少了訂單日期")).toBe(
      "這則和「匯出少了訂單日期」是同一件事，已記在那題，處理完會一起回報，不用重新提出。",
    );
    expect(triageRememberedText("報工相關需求都改測試專案")).toBe(
      "已記住：報工相關需求都改測試專案",
    );
    expect(triageIgnoredText).toBe(
      "這則沒有看到要處理的事項，請在 /任務 後寫清楚要查或要改什麼。",
    );

    // 同一則訊息再判讀一次（例如交易重試）：不會再排第二則。
    await db.query("UPDATE messages SET processed=false WHERE id='c4'");
    await rerun((ids) => [decide("ignore", ids)]);
    expect(await notices()).toHaveLength(4);

    // 推播送到群組，是純文字（不帶按鈕）。
    await new Line(db).flushNotifications();
    expect(pushes.map((p) => p.to)).toEqual(Array(4).fill("group-a"));
    expect(pushes[3].messages).toEqual([
      { type: "text", text: triageIgnoredText },
    ]);
  });

  it("記住的內容較長時只回前 100 字", async () => {
    await db.query("UPDATE groups SET trigger_mode='command'");
    const long = `報工相關需求都改測試專案，${"並且保留既有欄位".repeat(20)}`;
    await triage("c1", "/任務 記住這條規則", (ids) => [
      decide("memory", ids, { title: "explicit", summary: long }),
    ]);
    const [n] = await notices();
    expect(n.text).toBe(`已記住：${long.slice(0, 100)}`);
  });

  it("自動模式的訊息、AI 自行歸納的記憶、同一則另有需求時都不排", async () => {
    // 自動模式：一般訊息被判成無事項，不打擾群組。
    await triage("a1", "今天午餐吃什麼", (ids) => [decide("ignore", ids)]);
    expect(await notices()).toHaveLength(0);

    await db.query("UPDATE groups SET trigger_mode='command'");
    await triage("c1", "/任務 報工的畫面都在測試專案", (ids) => [
      decide("ignore", ids),
      decide("memory", ids, {
        title: "inferred",
        summary: "報工畫面在測試專案",
        projectId: project,
      }),
    ]);
    // 無事項照常說明，AI 自行歸納的記憶不說；記憶仍有寫入。
    expect((await notices()).map((n) => n.dedupe_key)).toEqual([
      "group:triage:ignore:c1",
    ]);
    expect(
      await db.query("SELECT 1 FROM group_memories WHERE source='ai'"),
    ).toHaveLength(1);

    const relatedId = await related();
    await triage("c2", "/任務 匯出少了訂單日期，另外謝謝", (ids) => [
      decide("ignore", ids),
      decide("duplicate", ids, { relatedTaskId: relatedId }),
    ]);
    // 同一則訊息另有重複判定：不再說「沒有看到要處理的事項」。
    expect((await notices()).map((n) => n.dedupe_key)).toEqual([
      "group:triage:ignore:c1",
      "group:triage:duplicate:c2",
    ]);
  });

  it("群組不回覆或總開關關閉時不排", async () => {
    await db.query(
      "UPDATE groups SET trigger_mode='command',reply_mode='off' WHERE id='group-a'",
    );
    await triage("c1", "/任務 謝謝", (ids) => [decide("ignore", ids)]);
    expect(await notices()).toHaveLength(0);

    await db.query("UPDATE groups SET reply_mode='results' WHERE id='group-a'");
    await db.query(
      `UPDATE settings SET value=value||'{"group_replies":false}'::jsonb WHERE id=1`,
    );
    await triage("c2", "/任務 謝謝", (ids) => [decide("ignore", ids)]);
    expect(await notices()).toHaveLength(0);

    // 「全部」模式同樣會排。
    await db.query(
      `UPDATE settings SET value=value||'{"group_replies":true}'::jsonb WHERE id=1`,
    );
    await db.query("UPDATE groups SET reply_mode='all' WHERE id='group-a'");
    await triage("c3", "/任務 謝謝", (ids) => [decide("ignore", ids)]);
    expect((await notices()).map((n) => n.dedupe_key)).toEqual([
      "group:triage:ignore:c3",
    ]);
  });
});
