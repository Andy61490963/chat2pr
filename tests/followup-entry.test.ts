import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    lineSecret: "fictional-entry-secret",
    lineToken: "fictional-token",
  }),
}));
import { db, reset, fixture } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { dueTriageGroups } from "../server/triage-window.js";
import { followupAck, disabledAck } from "../server/group-replies.js";
import { Retrieval } from "../server/retrieval.js";
import type { Task, TriageDecision } from "../shared/types.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let parent: Task;
beforeEach(async () => {
  await reset();
  const project = await fixture();
  await db.query("UPDATE groups SET trigger_mode='command'");
  parent = await db.one<Task>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,answer,approved_version,dedupe_key)
    VALUES($1,'group-a','欄位用途','查詢 ch2 欄位','["說明用途"]','answered','query','ch2 是模具欄位',1,'parent') RETURNING *`,
    [project],
  );
  await db.query(
    `INSERT INTO notifications(task_id,kind,dedupe_key,text,group_id,sent_at,sent_message_id)
    VALUES($1,'group_answered','answer','欄位說明','group-a',now(),'bot-answer')`,
    [parent.id],
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  app = await buildApp(db);
});
afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

async function receive(
  text = "那 ch3 呢？",
  quote: string | undefined = "bot-answer",
  type = "text",
  id = randomUUID(),
) {
  const payload = JSON.stringify({
    events: [
      {
        webhookEventId: `event-${id}`,
        type: "message",
        replyToken: "fictional-reply",
        source: { type: "group", groupId: "group-a" },
        message: { id, type, text, quotedMessageId: quote },
      },
    ],
  });
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/line",
    payload,
    headers: {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", "fictional-entry-secret")
        .update(payload)
        .digest("base64"),
    },
  });
  expect(response.statusCode).toBe(200);
  return id;
}
const age = (seconds: number) =>
  db.query(
    "UPDATE groups SET first_pending_at=now()-make_interval(secs=>$1),last_pending_at=now()-make_interval(secs=>$1) WHERE id='group-a'",
    [seconds],
  );
function processor() {
  const github = new GitHub();
  github.context = vi.fn(async () => ({
    branches: { names: ["main"], defaultBranch: "main", truncated: false },
    branchError: null,
    sha: "fictional-sha",
    paths: [],
    files: {},
    truncated: false,
  }));
  const classify = vi.fn(
    async (
      input: Parameters<
        import("../server/triage.js").Classifier["classify"]
      >[0],
    ): Promise<TriageDecision[]> => [
      {
        kind: "request",
        taskType: "query",
        projectId: null,
        title: "ch3 用途",
        summary: "查詢 ch3 欄位用途",
        acceptance: ["說明 ch3 用途"],
        sourceIds: input.messages
          .filter((m) => !m.contextOnly)
          .map((m) => m.id),
        risks: [],
        missing: [],
        suggestions: [],
        relatedTaskId: null,
      },
    ],
  );
  const retrieval = new Retrieval(db);
  retrieval.lookup = vi.fn(async () => ({ hits: [], reason: "" }));
  return {
    classify,
    service: new Triage(
      db,
      { classify },
      github,
      new Line(db),
      new Budget(db),
      retrieval,
    ),
  };
}

it.each(["command", "auto"])(
  "%s 模式由簽章收訊接續查詢，立即回覆並保留前題",
  async (mode) => {
    await db.query("UPDATE groups SET trigger_mode=$1", [mode]);
    const id = await receive();
    expect(
      await db.one(
        "SELECT processed,trigger_mode,bot_reply FROM messages WHERE id=$1",
        [id],
      ),
    ).toEqual({ processed: false, trigger_mode: "command", bot_reply: true });
    expect(
      JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).messages[0]
        .text,
    ).toBe(followupAck);
    await age(5.1);
    const { service, classify } = processor();
    await service.process("group-a", true);
    expect(classify).toHaveBeenCalledOnce();
    expect(
      await db.one(
        "SELECT parent_id,project_id,target_branch,status FROM tasks WHERE $1=ANY(source_ids)",
        [id],
      ),
    ).toEqual({
      parent_id: parent.id,
      project_id: parent.project_id,
      target_branch: parent.target_branch,
      status: "queued",
    });
    expect(
      (await db.one("SELECT answer FROM tasks WHERE id=$1", [parent.id]))
        .answer,
    ).toBe(parent.answer);
  },
);

it.each(["他群", "無任務", "成員訊息", "未知訊息", "非文字"])(
  "指令模式引用%s不觸發",
  async (kind) => {
    let quote = "bot-answer";
    if (kind === "他群") {
      await db.query("INSERT INTO groups(id,name) VALUES('group-b','另一群')");
      await db.query("UPDATE notifications SET group_id='group-b'");
    }
    if (kind === "無任務")
      await db.query("UPDATE notifications SET task_id=NULL");
    if (kind === "成員訊息") {
      quote = "member";
      await db.query(
        "INSERT INTO messages(id,group_id,type,text,processed) VALUES('member','group-a','text','成員回答',true)",
      );
    }
    if (kind === "未知訊息") quote = "unknown";
    const id = await receive(
      "那 ch3 呢？",
      quote,
      kind === "非文字" ? "image" : "text",
    );
    expect(
      await db.one("SELECT processed,trigger_mode FROM messages WHERE id=$1", [
        id,
      ]),
    ).toEqual({ processed: true, trigger_mode: "chat" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await dueTriageGroups(db)).toEqual([]);
  },
);

it("停用群組不派工，立即說明停用", async () => {
  await db.query("UPDATE groups SET enabled=false");
  const id = await receive();
  expect(
    (await db.one("SELECT processed FROM messages WHERE id=$1", [id]))
      .processed,
  ).toBe(true);
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).messages[0]
      .text,
  ).toBe(disabledAck);
  expect(await dueTriageGroups(db)).toEqual([]);
});
it.each(["群組關閉", "總開關關閉"])(
  "%s時仍接收追問，但不回覆",
  async (kind) => {
    if (kind === "群組關閉")
      await db.query("UPDATE groups SET reply_mode='off'");
    else
      await db.query(
        "UPDATE settings SET value=value||'{\"group_replies\":false}'::jsonb",
      );
    const id = await receive();
    expect(
      (await db.one("SELECT processed FROM messages WHERE id=$1", [id]))
        .processed,
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("重送事件只回覆一次", async () => {
  const id = await receive();
  await receive("那 ch3 呢？", "bot-answer", "text", id);
  expect(fetch).toHaveBeenCalledOnce();
});
it("純追問等安靜五秒，連續追問重新計時", async () => {
  await receive();
  await age(4);
  expect(await dueTriageGroups(db)).toEqual([]);
  await age(5.1);
  expect(await dueTriageGroups(db)).toEqual([{ id: "group-a", fast: true }]);
  await receive("那 ch4 呢？");
  expect(await dueTriageGroups(db)).toEqual([]);
});
it.each(["指令需求", "一般文字", "圖片", "第一百零一則"])(
  "混有%s維持六十秒及五分鐘上限",
  async (kind) => {
    await receive();
    if (kind === "第一百零一則") {
      await db.query(
        "INSERT INTO messages(id,group_id,type,text,trigger_mode,bot_reply) SELECT 'extra-'||n,'group-a','text','接續問題','command',true FROM generate_series(1,100) n",
      );
    }
    if (["一般文字", "圖片"].includes(kind))
      await db.query("UPDATE groups SET trigger_mode='auto'");
    await receive(
      kind === "一般文字" ? "新需求" : "/任務 請調整首頁",
      "unrelated",
      kind === "圖片" ? "image" : "text",
    );
    await age(6);
    expect(await dueTriageGroups(db)).toEqual([]);
    await age(61);
    expect(await dueTriageGroups(db)).toEqual([{ id: "group-a", fast: false }]);
    await db.query(
      "UPDATE groups SET first_pending_at=now()-interval '301 seconds',last_pending_at=now()",
    );
    expect(await dueTriageGroups(db)).toEqual([{ id: "group-a", fast: false }]);
  },
);
it("排程後混入新需求時不提早判讀", async () => {
  await receive();
  await age(6);
  expect(await dueTriageGroups(db)).toHaveLength(1);
  await receive("/任務 調整首頁", "unrelated");
  const { service, classify } = processor();
  await service.process("group-a", true);
  expect(classify).not.toHaveBeenCalled();
});
it("明確追問不因檔案索引仍在建立而等五分鐘", async () => {
  await receive();
  await age(6);
  await db.query(
    "UPDATE settings SET value=value||'{\"rag_enabled\":true}'::jsonb",
  );
  await db.query(
    "INSERT INTO repo_indexes(project_id,phase,wanted_sha) VALUES($1,'indexing','fictional-sha') ON CONFLICT(project_id) DO UPDATE SET phase='indexing'",
    [parent.project_id],
  );
  const { service, classify } = processor();
  await service.process("group-a", true);
  expect(classify).toHaveBeenCalledOnce();
});
it.each(["paused", "triage_paused"])("%s時不排程追問", async (setting) => {
  await receive();
  await age(6);
  await db.query("UPDATE settings SET value=value||$1::jsonb", [
    JSON.stringify({ [setting]: true }),
  ]);
  expect(await dueTriageGroups(db)).toEqual([]);
});
