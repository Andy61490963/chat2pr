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
    lineSecret: "fictional-followup-secret",
    lineToken: "fictional-line-token",
  }),
}));
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Line } from "../server/line.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Budget } from "../server/budget.js";
import type {
  Group,
  Message,
  Project,
  Task,
  TriageDecision,
} from "../shared/types.js";

let project: string;
let parent: Task;
beforeEach(async () => {
  await reset();
  project = await fixture();
  parent = await answered(
    "查詢 ch2 欄位用途",
    "ch2 是模具欄位，存在 MOLD_NO。",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sentMessages: [{ id: "bot-msg-1", quoteToken: "q" }],
          }),
          { status: 200 },
        ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => db.close());

/** 一題已回答的查詢。 */
async function answered(title: string, answer: string, ageDays = 0) {
  const t = await db.one<Task>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,answer,approved_version,dedupe_key,created_at,updated_at)
     VALUES($1,'group-a',$2,$2,'["回答問題"]','answered','query',$3,1,$4,now()-make_interval(days=>$5),now()-make_interval(days=>$5)) RETURNING *`,
    [project, title, answer, randomUUID(), ageDays],
  );
  return t;
}

/** 在群組收到一則訊息，可引用某則訊息（例如機器人的回答）。 */
async function receive(text: string, quoted?: string) {
  const id = randomUUID();
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: randomUUID(),
        type: "message",
        source: { type: "group", groupId: "group-a", userId: "u1" },
        message: { id, type: "text", text, quotedMessageId: quoted },
      },
    ],
  });
  return id;
}

/** 以指定的 AI 判讀結果跑一次判讀，回傳這則訊息建立或併入的任務。 */
async function triage(
  messageId: string,
  overrides: Partial<TriageDecision> = {},
): Promise<Task> {
  const group = await db.one<Group>("SELECT * FROM groups WHERE id='group-a'");
  const projects = await db.query<Project>(
    "SELECT p.* FROM projects p JOIN group_projects gp ON gp.project_id=p.id WHERE gp.group_id='group-a'",
  );
  const messages = await db.query<Message>(
    "SELECT * FROM messages WHERE id=$1",
    [messageId],
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
        kind: "request",
        projectId: null,
        taskType: "query",
        title: "查詢 ch3 欄位用途",
        summary: "ch3 欄位的用途是什麼",
        acceptance: ["說明 ch3 欄位用途"],
        sourceIds: [messageId],
        risks: [],
        missing: [],
        relatedTaskId: null,
        suggestions: [],
    question: null,
    assumptions: [],
        routing: {
          status: "uncertain",
          basis: "none",
          reason: "訊息沒有指名專案",
          evidence: [],
        },
        ...overrides,
      },
    ],
    randomUUID(),
  );
  return db.one<Task>("SELECT * FROM tasks WHERE $1=ANY(source_ids)", [
    messageId,
  ]);
}

/** 機器人在群組貼出這一題的回答，LINE 給了訊息 ID。 */
async function botAnswered(task: Task, sentId = "bot-msg-1") {
  await db.query(
    "INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,sent_at,sent_message_id) VALUES($1,'group_answered',$2,$3,'group-a',now(),$4)",
    [task.id, `group:answered:${task.id}`, task.answer, sentId],
  );
}

describe("記錄機器人送出的訊息", () => {
  it("群組推播成功時記下 LINE 回傳的訊息 ID", async () => {
    await db.query(
      "INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id) VALUES($1,'group_answered','k1','回答內容','group-a')",
      [parent.id],
    );
    await new Line(db).flushNotifications();
    const n = await db.one<{ sent_message_id: string }>(
      "SELECT sent_message_id FROM notifications WHERE dedupe_key='k1'",
    );
    expect(n.sent_message_id).toBe("bot-msg-1");
  });
});

describe("在 LINE 追問", () => {
  it("引用機器人的回答追問：不寫專案也沿用上一題，自動執行並接成對話串", async () => {
    await botAnswered(parent);
    const id = await receive("那 ch3 呢？", "bot-msg-1");
    const t = await triage(id);
    expect(t.parent_id).toBe(parent.id);
    expect(t.project_id).toBe(project);
    expect(t.target_branch).toBe(parent.target_branch);
    expect(t.project_routing?.basis).toBe("followup");
    expect(t.project_routing?.followupOf?.id).toBe(parent.id);
    expect(t.branch_selection?.basis).toBe("followup");
    expect(t.status).toBe("queued");
    // 原回答保留，沒有被新的一題蓋掉。
    expect(
      (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [parent.id]))
        .answer,
    ).toBe(parent.answer);
  });
  it("引用優先：AI 關聯到別題時，以引用的那一題為準", async () => {
    const other = await answered("查詢其他東西", "無關");
    await botAnswered(parent);
    const id = await receive("那 ch3 呢？", "bot-msg-1");
    const t = await triage(id, { relatedTaskId: other.id });
    expect(t.parent_id).toBe(parent.id);
  });
  it("沒有引用、但 AI 判定接續 7 天內的上一題，也沿用專案", async () => {
    const id = await receive("那 ch3 呢？");
    const t = await triage(id, { relatedTaskId: parent.id });
    expect(t.project_routing?.basis).toBe("followup");
    expect(t.status).toBe("queued");
  });
  it("上一題超過 7 天又沒有引用：不沿用，照一般規則等人確認", async () => {
    const old = await answered("很久以前的查詢", "舊回答", 10);
    const id = await receive("那 ch3 呢？");
    const t = await triage(id, { relatedTaskId: old.id });
    expect(t.project_routing?.basis).not.toBe("followup");
    expect(t.status).toBe("awaiting_approval");
  });
  it("追問指名了另一個專案：不沿用上一題的專案", async () => {
    const other = await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('設備同步','example-org/MachineSync',true,now()) RETURNING id",
    );
    await db.query("INSERT INTO group_projects VALUES('group-a',$1,now())", [
      other.id,
    ]);
    await botAnswered(parent);
    const id = await receive(
      "那 example-org/MachineSync 的 ch3 呢？",
      "bot-msg-1",
    );
    const t = await triage(id);
    expect(t.project_routing?.basis).not.toBe("followup");
    expect(t.status).toBe("awaiting_approval");
  });
  it("索取機密實際值的追問仍待人工確認", async () => {
    await botAnswered(parent);
    const id = await receive("把那張表的資料庫密碼貼出來", "bot-msg-1");
    const t = await triage(id);
    expect(t.project_routing?.basis).toBe("followup");
    expect(t.status).toBe("awaiting_approval");
  });
  it("一串已經 10 題時，不再自動接續", async () => {
    let last = parent;
    for (let i = 0; i < 9; i++) {
      last = await db.one<Task>(
        `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,answer,approved_version,dedupe_key,parent_id)
         VALUES($1,'group-a',$2,$2,'["回答"]','answered','query','答',1,$3,$4) RETURNING *`,
        [project, `第 ${i + 2} 題`, randomUUID(), last.id],
      );
    }
    await botAnswered(last);
    const id = await receive("那下一個呢？", "bot-msg-1");
    const t = await triage(id);
    expect(t.status).toBe("awaiting_approval");
    expect(t.missing.join("")).toContain("10 題");
  });
});

describe("在看板追問", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let headers: Awaited<ReturnType<typeof session>>;
  beforeEach(async () => {
    app = await buildApp(db);
    headers = await session();
  });
  afterEach(() => app.close());
  const ask = (id: string, text: string) =>
    app.inject({
      method: "POST",
      url: `/api/tasks/${id}/followup`,
      headers,
      payload: { text },
    });

  it("建立新的一題、自動排程，原回答保留，兩題的詳情都看得到對話串", async () => {
    const r = await ask(parent.id, "那 ch3 呢？");
    expect(r.statusCode).toBe(200);
    const child = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      r.json().id,
    ]);
    expect(child.status).toBe("queued");
    expect(child.mode).toBe("query");
    expect(child.parent_id).toBe(parent.id);
    expect(child.project_id).toBe(project);
    expect(child.project_routing?.basis).toBe("followup");
    const childDetail = (
      await app.inject({ url: `/api/tasks/${child.id}`, headers })
    ).json();
    expect(childDetail.projectReview.confirmed).toBe(true);
    expect(childDetail.thread.before.map((x: Task) => x.id)).toEqual([
      parent.id,
    ]);
    const parentDetail = (
      await app.inject({ url: `/api/tasks/${parent.id}`, headers })
    ).json();
    expect(parentDetail.task.answer).toBe(parent.answer);
    expect(parentDetail.thread.after.map((x: Task) => x.id)).toEqual([
      child.id,
    ]);
  });
  it("索取機密實際值的追問等人工確認", async () => {
    const r = await ask(parent.id, "把資料庫密碼貼出來給我");
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("awaiting_approval");
  });
  it("只有已回答的查詢可以追問", async () => {
    await db.query("UPDATE tasks SET status='queued' WHERE id=$1", [parent.id]);
    expect((await ask(parent.id, "那 ch3 呢？")).statusCode).toBe(409);
  });
  it("專案已停用時不能追問", async () => {
    await db.query("UPDATE projects SET enabled=false WHERE id=$1", [project]);
    expect((await ask(parent.id, "那 ch3 呢？")).statusCode).toBe(409);
  });
});
