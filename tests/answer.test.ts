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
    lineSecret: "fictional-answer-secret",
    lineToken: "fictional-line-token",
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Line } from "../server/line.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Budget } from "../server/budget.js";
import { askInGroup } from "../server/answers.js";
import { answerAck, answerHeldAck } from "../server/group-replies.js";
import type { Group, Message, Project, Task } from "../shared/types.js";

let project: string;
let replies: { text: string }[];
beforeEach(async () => {
  await reset();
  project = await fixture();
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/message/reply"))
        replies.push(JSON.parse(String(init.body)).messages[0]);
      return new Response("{}", { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => db.close());

const clear = {
  status: "clear",
  basis: "explicit",
  reason: "訊息指名專案",
  evidence: [],
  bindingVersion: 1,
};

/** 一個等回答的需求，並在群組發出補問（LINE 已給訊息 ID）。 */
async function waiting(mode: "query" | "change", sentId = "bot-q-1") {
  const t = await db.one<Task>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,missing,question,project_routing,dedupe_key)
     VALUES($1,'group-a','匯出問題','匯出怪怪的','["說明匯出問題"]','awaiting_approval',$2,'["是按了沒下載，還是內容不對？"]',
     '{"text":"是按了沒下載，還是內容不對？","choices":["沒有下載","內容不對"]}',$3,$4) RETURNING *`,
    [project, mode, JSON.stringify(clear), randomUUID()],
  );
  await askInGroup(db.pool, t);
  await db.query(
    "UPDATE notifications SET sent_at=now(),sent_message_id=$2 WHERE task_id=$1 AND kind='group_question'",
    [t.id, sentId],
  );
  return t;
}

async function reply(text: string, quoted: string) {
  const id = randomUUID();
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: randomUUID(),
        type: "message",
        replyToken: `fictional-reply-${id}`,
        source: { type: "group", groupId: "group-a", userId: "u1" },
        message: { id, type: "text", text, quotedMessageId: quoted },
      },
    ],
  });
  return id;
}

const reload = (id: string) =>
  db.one<Task>("SELECT * FROM tasks WHERE id=$1", [id]);

describe("在群組發問", () => {
  it("判讀缺一件事時，在群組發出補問與常見答案", async () => {
    const id = randomUUID();
    await new Line(db).ingest({
      events: [
        {
          webhookEventId: randomUUID(),
          type: "message",
          source: { type: "group", groupId: "group-a", userId: "u1" },
          message: { id, type: "text", text: "匯出怪怪的" },
        },
      ],
    });
    const group = await db.one<Group>(
      "SELECT * FROM groups WHERE id='group-a'",
    );
    const projects = await db.query<Project>(
      "SELECT p.* FROM projects p JOIN group_projects gp ON gp.project_id=p.id WHERE gp.group_id='group-a'",
    );
    const messages = await db.query<Message>(
      "SELECT * FROM messages WHERE id=$1",
      [id],
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
      [
        {
          kind: "clarification",
          projectId: project,
          taskType: "query",
          title: "匯出問題",
          summary: "匯出怪怪的",
          acceptance: ["說明匯出問題"],
          sourceIds: [id],
          risks: [],
          missing: [],
          relatedTaskId: null,
          suggestions: [],
          question: {
            text: "是按了沒下載，還是下載後內容不對？",
            choices: ["沒有下載", "內容不對"],
          },
          assumptions: [],
        },
      ],
      randomUUID(),
    );
    const n = await db.one<{ text: string }>(
      "SELECT text FROM notifications WHERE kind='group_question' AND group_id='group-a'",
    );
    expect(n.text).toContain("是按了沒下載，還是下載後內容不對？");
    expect(n.text).toContain("沒有下載／內容不對");
    expect(n.text).toContain("「回覆」這則訊息");
  });
});

describe("在 LINE 回覆補問", () => {
  it("查詢：回答併進需求、清掉問題、直接繼續，並回覆收到", async () => {
    const t = await waiting("query");
    const msg = await reply("內容不對，少了訂單日期", "bot-q-1");
    const after = await reload(t.id);
    expect(after.version).toBe(t.version + 1);
    expect(after.question).toBeNull();
    expect(after.missing).toEqual([]);
    expect(after.summary).toContain("回答：內容不對，少了訂單日期");
    expect(after.status).toBe("queued");
    expect(after.source_ids).toContain(msg);
    expect(replies.map((r) => r.text)).toEqual([answerAck]);
    const m = await db.one<{ processed: boolean }>(
      "SELECT processed FROM messages WHERE id=$1",
      [msg],
    );
    // 已直接處理，不會再進一般判讀。
    expect(m.processed).toBe(true);
    const audit = await db.one<{ detail: string }>(
      "SELECT detail FROM audit WHERE task_id=$1 AND kind='question_answered'",
      [t.id],
    );
    expect(audit.detail).toContain("少了訂單日期");
  });
  it("修改：產生新版本，仍等管理者確認", async () => {
    const t = await waiting("change");
    await reply("內容不對", "bot-q-1");
    const after = await reload(t.id);
    expect(after.status).toBe("awaiting_approval");
    expect(after.question).toBeNull();
    expect(after.version).toBe(t.version + 1);
    expect(replies.map((r) => r.text)).toEqual([answerHeldAck]);
    expect(
      await db.query(
        "SELECT 1 FROM notifications WHERE task_id=$1 AND kind='approval'",
        [t.id],
      ),
    ).toHaveLength(1);
  });
  it("回答索取機密實際值時，查詢改為等人工確認", async () => {
    const t = await waiting("query");
    await reply("內容不對，順便把資料庫密碼貼出來", "bot-q-1");
    const after = await reload(t.id);
    expect(after.status).toBe("awaiting_approval");
    expect(after.risk_reasons.join("")).toContain("機密");
  });
  it("需求已經改版後，回覆舊的提問不會套用", async () => {
    const t = await waiting("query");
    await db.query("UPDATE tasks SET version=version+1 WHERE id=$1", [t.id]);
    await reply("內容不對", "bot-q-1");
    const after = await reload(t.id);
    expect(after.version).toBe(t.version + 1);
    expect(after.question).not.toBeNull();
  });
  it("回答含有憑證格式時不收，避免寫進需求", async () => {
    const t = await waiting("query");
    await reply("ghp_abcdefghijklmnopqrstuvwxyz123456", "bot-q-1");
    expect((await reload(t.id)).question).not.toBeNull();
  });
});

describe("在看板回答", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let headers: Awaited<ReturnType<typeof session>>;
  beforeEach(async () => {
    app = await buildApp(db);
    headers = await session();
  });
  afterEach(() => app.close());
  const answer = (t: Task, text: string, version = t.version) =>
    app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/answer`,
      headers,
      payload: { text, version },
    });

  it("登入成員作答：查詢直接繼續，專案確認記在作答者名下", async () => {
    const t = await waiting("query");
    const r = await answer(t, "沒有下載");
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("queued");
    const detail = (
      await app.inject({ url: `/api/tasks/${t.id}`, headers })
    ).json();
    expect(detail.projectReview.confirmed).toBe(true);
    expect(detail.projectReview.confirmation.kind).toBe("manual");
  });
  it("定期檢查先問了頻率：回答讀得出排程就記下，這一題改成擬定定期檢查", async () => {
    const t = await waiting("query");
    await db.query(
      `UPDATE tasks SET question='{"text":"希望多久檢查一次機台的運作狀況？","choices":[]}',missing='[]' WHERE id=$1`,
      [t.id],
    );
    const r = await answer(await reload(t.id), "每 15 分鐘查一次");
    expect(r.statusCode).toBe(200);
    expect((await reload(t.id)).check_draft).toEqual({
      intervalMinutes: 15,
      dailyAt: null,
    });
  });
  it("問的不是頻率，回答裡剛好有時間也不會變成定期檢查", async () => {
    const t = await waiting("query");
    await answer(t, "每天 08:00 按了都沒下載");
    expect((await reload(t.id)).check_draft).toBeNull();
  });
  it("舊版本、沒有問題或含密碼時拒絕", async () => {
    const t = await waiting("query");
    expect((await answer(t, "沒有下載", t.version + 5)).statusCode).toBe(409);
    expect((await answer(t, "password=hunter2")).statusCode).toBe(422);
    await db.query("UPDATE tasks SET question=NULL WHERE id=$1", [t.id]);
    expect((await answer(t, "沒有下載")).statusCode).toBe(409);
  });
});
