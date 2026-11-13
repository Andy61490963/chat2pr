import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "fictional-waiting-secret",
    lineToken: "fictional-line-token",
  }),
}));
import { db, reset, fixture } from "./helpers.js";
import { Line } from "../server/line.js";
import {
  commandAck,
  followupAck,
  lineChunks,
  tellGroupWaiting,
} from "../server/group-replies.js";
import type { Task } from "../shared/types.js";

let project: string;
let replies: { messages: { text: string }[] }[];
beforeEach(async () => {
  await reset();
  project = await fixture();
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/message/reply"))
        replies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => db.close());

async function answeredQuery(answer: string) {
  const t = await db.one<Task>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,answer,approved_version,dedupe_key)
     VALUES($1,'group-a','查詢 ch2','ch2 是什麼','["說明"]','answered','query',$2,1,$3) RETURNING *`,
    [project, answer, randomUUID()],
  );
  await db.query(
    "INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,sent_at,sent_message_id) VALUES($1,'group_answered',$2,'重點','group-a',now(),'bot-a-1')",
    [t.id, `group:answered:${t.id}`],
  );
  return t;
}

async function say(
  text: string,
  message: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: randomUUID(),
        type: "message",
        replyToken: `fictional-reply-${id}`,
        source: { type: "group", groupId: "group-a", userId: "u1" },
        message: { id, type: "text", text, ...message },
      },
    ],
  });
  return id;
}

describe("回覆「詳細」看完整內容", () => {
  it("分段回覆完整回答，不建立任務、不進判讀", async () => {
    const answer = `## 先看重點\n\n結論。\n\n## 詳細資訊\n\n${"細節段落。".repeat(200)}`;
    await answeredQuery(answer);
    const before = (await db.query("SELECT id FROM tasks")).length;
    const id = await say("詳細", { quotedMessageId: "bot-a-1" });
    expect(replies).toHaveLength(1);
    expect(replies[0].messages.map((m) => m.text).join("\n\n")).toContain(
      "細節段落。",
    );
    expect((await db.query("SELECT id FROM tasks")).length).toBe(before);
    const m = await db.one<{ processed: boolean; trigger_mode: string }>(
      "SELECT processed,trigger_mode FROM messages WHERE id=$1",
      [id],
    );
    expect(m).toEqual({ processed: true, trigger_mode: "chat" });
  });
  it("太長時切成最多 5 則，最後註明省略", () => {
    const chunks = lineChunks(
      Array.from(
        { length: 40 },
        (_, i) => `第 ${i} 段${"字".repeat(1000)}`,
      ).join("\n\n"),
    );
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.length <= 4500)).toBe(true);
    expect(chunks[4]).toContain("後面省略");
  });
});

describe("指令模式下 @機器人 也能提出需求", () => {
  beforeEach(() =>
    db.query("UPDATE groups SET trigger_mode='command' WHERE id='group-a'"),
  );
  it("提及機器人時視同 /任務 並回覆收到", async () => {
    const id = await say("@機器人 幫我查 ch2 的用途", {
      mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] },
    });
    const m = await db.one<{ trigger_mode: string; processed: boolean }>(
      "SELECT trigger_mode,processed FROM messages WHERE id=$1",
      [id],
    );
    expect(m).toEqual({ trigger_mode: "command", processed: false });
    expect(replies[0].messages[0].text).toBe(commandAck);
  });
  it("提及其他人時照舊當一般聊天", async () => {
    const id = await say("@小明 午餐吃什麼", {
      mention: { mentionees: [{ index: 0, length: 3, userId: "u2" }] },
    });
    const m = await db.one<{ trigger_mode: string }>(
      "SELECT trigger_mode FROM messages WHERE id=$1",
      [id],
    );
    expect(m.trigger_mode).toBe("chat");
    expect(replies).toHaveLength(0);
  });
});

describe("收到時附上預估時間", () => {
  it("同專案有查詢耗時紀錄時，引用追問的回覆寫出大約幾分鐘", async () => {
    const t = await answeredQuery("回答");
    for (const minutes of [2, 3, 4])
      await db.query(
        "INSERT INTO runs(task_id,version,status,model,deadline,started_at,completed_at) VALUES($1,1,'done','m',now(),now()-make_interval(mins=>$2),now())",
        [t.id, minutes],
      );
    await say("那 ch3 呢？", { quotedMessageId: "bot-a-1" });
    expect(replies[0].messages[0].text).toBe(
      followupAck.replace(/。$/, "，大約 3 分鐘。"),
    );
  });
  it("沒有紀錄時不寫時間", async () => {
    await answeredQuery("回答");
    await say("那 ch3 呢？", { quotedMessageId: "bot-a-1" });
    expect(replies[0].messages[0].text).toBe(followupAck);
  });
});

describe("工作被保留時告訴群組", () => {
  it("同一群組 6 小時內只說一次；群組不回覆時不說", async () => {
    const t = await answeredQuery("回答");
    await tellGroupWaiting(db, t.id, "quota");
    await tellGroupWaiting(db, t.id, "daily");
    const rows = await db.query<{ text: string }>(
      "SELECT text FROM notifications WHERE kind='group_waiting'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("額度恢復後會自動繼續");
    await db.query("DELETE FROM notifications WHERE kind='group_waiting'");
    await db.query("UPDATE groups SET reply_mode='off' WHERE id='group-a'");
    await tellGroupWaiting(db, t.id, "paused");
    expect(
      await db.query("SELECT 1 FROM notifications WHERE kind='group_waiting'"),
    ).toHaveLength(0);
  });
});
