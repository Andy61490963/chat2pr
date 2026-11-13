import {
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import sharp from "sharp";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ openaiKey: "fictional-classifier-key" }),
}));
import { db, reset, fixture } from "./helpers.js";
import { Triage, OpenAIClassifier } from "../server/triage.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import type {
  Group,
  Project,
  Message,
  TriageDecision,
} from "../shared/types.js";
beforeEach(reset);
afterAll(() => db.close());
afterEach(() => vi.unstubAllGlobals());
const decision = (overrides: Partial<TriageDecision> = {}): TriageDecision => ({
  kind: "request",
  projectId: null,
  title: "修正按鈕",
  summary: "把按鈕改成綠色",
  acceptance: ["按鈕顯示綠色"],
  sourceIds: ["m1"],
  risks: [],
  missing: [],
  relatedTaskId: null,
  suggestions: [],
  ...overrides,
});
async function setup(type = "text") {
  await fixture();
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: "e1",
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { id: "m1", type, text: "把按鈕改成綠色" },
      },
    ],
  });
  return {
    group: await db.one<Group>("SELECT * FROM groups"),
    project: await db.one<Project>("SELECT * FROM projects"),
    messages: await db.query<Message>("SELECT * FROM messages"),
    triage: new Triage(
      db,
      { classify: async () => [] },
      new GitHub(),
      new Line(db),
      new Budget(db),
    ),
  };
}
describe("需求判斷後的確定性關卡", () => {
  it("每日額度不足仍收訊，保留原文且不呼叫模型或累計辨識故障", async () => {
    const s = await setup();
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{daily_budget}','0')",
    );
    const classify = vi.fn(async () => [decision()]);
    const triage = new Triage(
      db,
      { classify },
      new GitHub(),
      new Line(db),
      new Budget(db),
    );
    await expect(triage.process(s.group.id)).rejects.toThrow("額度");
    expect(classify).not.toHaveBeenCalled();
    expect(await db.one("SELECT text,processed FROM messages")).toEqual({
      text: "把按鈕改成綠色",
      processed: false,
    });
    expect(
      (await db.one("SELECT triage_failures FROM groups")).triage_failures,
    ).toBe(0);
  });
  it("兩群組同時辨識時只取得各自專案、近期對話與任務", async () => {
    const s = await setup();
    const other = await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('另一專案','test/other',true,now()) RETURNING id",
    );
    await db.query(
      "INSERT INTO groups(id,name,enabled,trigger_mode) VALUES('group-b','第二群',true,'auto')",
    );
    await db.query(
      "INSERT INTO group_projects(group_id,project_id) VALUES('group-b',$1)",
      [other.id],
    );
    await db.query(
      "INSERT INTO messages(id,group_id,type,text,processed) VALUES('a-old','group-a','text','甲群歷史',true),('b-old','group-b','text','乙群歷史',true),('b-new','group-b','text','乙群需求',false)",
    );
    for (const [group, project, title] of [
      ["group-a", s.project.id, "甲群任務"],
      ["group-b", other.id, "乙群任務"],
    ])
      await db.query(
        "INSERT INTO tasks(project_id,group_id,title,summary,dedupe_key) VALUES($1,$2,$3,$3,$2)",
        [project, group, title],
      );
    const github = new GitHub();
    github.context = async (p) => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
      sha: p.repo,
      paths: [],
      files: {},
      truncated: false,
    });
    const seen: Parameters<
      import("../server/triage.js").Classifier["classify"]
    >[0][] = [];
    const triage = new Triage(
      db,
      {
        classify: async (input) => {
          seen.push(input);
          return [
            decision({
              kind: "ignore",
              sourceIds: input.messages.map((m) => m.id),
            }),
          ];
        },
      },
      github,
      new Line(db),
      new Budget(db),
    );
    await Promise.all([triage.process("group-a"), triage.process("group-b")]);
    expect(seen).toHaveLength(2);
    for (const input of seen) {
      const isA = input.messages[0].group_id === "group-a";
      const context = JSON.stringify(input.context);
      expect(context).toContain(isA ? "甲群歷史" : "乙群歷史");
      expect(context).not.toContain(isA ? "乙群歷史" : "甲群歷史");
      expect(input.tasks.map((t) => t.title)).toEqual([
        isA ? "甲群任務" : "乙群任務",
      ]);
      expect(
        (input.context as { projects: { sha: string }[] }).projects.map(
          (p) => p.sha,
        ),
      ).toEqual([isA ? "test/repo" : "test/other"]);
    }
  });
  it("圖片下載完成後辨識會帶入圖片，缺少憑證則停止並保留來源", async () => {
    const s = await setup("image"),
      line = new Line(db),
      github = new GitHub();
    github.context = async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
      sha: "base",
      paths: [],
      files: {},
      truncated: false,
    });
    line.image = async () => ({
      data: Buffer.from("picture-bytes"),
      mime: "image/png",
    });
    const classify = vi.fn(
      async (
        input: Parameters<
          import("../server/triage.js").Classifier["classify"]
        >[0],
      ) => {
        expect(input.messages[0].image?.toString()).toBe("picture-bytes");
        expect(input.messages[0].image_mime).toBe("image/png");
        throw Error("401 憑證失效");
      },
    );
    await expect(
      new Triage(db, { classify }, github, line, new Budget(db)).process(
        s.group.id,
      ),
    ).rejects.toThrow("401");
    expect((await db.one("SELECT processed FROM messages")).processed).toBe(
      false,
    );
    expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
    expect(
      await db.query("SELECT id FROM reservations WHERE NOT released"),
    ).toHaveLength(0);
  });
  it("大量圖片依成本擴大預留；呼叫中斷也保守記帳", async () => {
    const s = await setup("image");
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const budget = new Budget(db);
    const reservation = await budget.reserve(0.15);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Error("模擬網路中斷");
      }),
    );
    await expect(
      new OpenAIClassifier(budget).classify({
        messages: Array.from({ length: 60 }, () => ({
          ...s.messages[0],
          image,
          image_mime: "image/png",
        })),
        context: {},
        tasks: [],
        model: "gpt-5.4-mini",
        reservation,
      }),
    ).rejects.toThrow();
    const row = await db.one<{ amount: string; spent: string }>(
      "SELECT * FROM reservations WHERE id=$1",
      [reservation],
    );
    expect(Number(row.amount)).toBeGreaterThan(0.15);
    expect(Number(row.spent)).toBeGreaterThan(0.15);
    expect((await db.query("SELECT * FROM usage")).length).toBe(1);
  });
  it("空白決定不得吃掉來源，無法辨識的附件也不得標成閒聊", async () => {
    const s = await setup("image");
    await expect(
      s.triage.apply(
        s.group,
        [s.project],
        s.messages,
        [],
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("完整處理");
    expect(
      (await db.one<{ processed: boolean }>("SELECT processed FROM messages"))
        .processed,
    ).toBe(false);
    await s.triage.apply(
      s.group,
      [s.project],
      s.messages,
      [decision({ kind: "ignore" })],
      "00000000-0000-4000-8000-000000000001",
    );
    expect(
      (await db.one<{ status: string }>("SELECT status FROM tasks")).status,
    ).toBe("awaiting_approval");
  });
  it("連續辨識失敗三次停止呼叫並通知管理者，來源仍保留", async () => {
    const s = await setup();
    let calls = 0;
    const github = new GitHub();
    github.context = async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
      sha: "base",
      paths: [],
      files: {},
      truncated: false,
    });
    const t = new Triage(
      db,
      {
        classify: async () => {
          calls++;
          throw Error("供應商無法連線");
        },
      },
      github,
      new Line(db),
      new Budget(db),
    );
    for (let i = 0; i < 3; i++)
      await expect(t.process(s.group.id)).rejects.toThrow();
    await t.process(s.group.id);
    expect(calls).toBe(3);
    expect(
      (await db.query("SELECT * FROM notifications WHERE kind='triage'"))
        .length,
    ).toBe(1);
    expect(
      (await db.one<{ processed: boolean }>("SELECT processed FROM messages"))
        .processed,
    ).toBe(false);
  });
  it("明確低風險修改仍須人工確認目標專案", async () => {
    const s = await setup();
    await s.triage.apply(
      s.group,
      [s.project],
      s.messages,
      [decision()],
      "00000000-0000-4000-8000-000000000001",
    );
    expect(await db.one("SELECT status,approved_version FROM tasks")).toEqual({
      status: "awaiting_approval",
      approved_version: null,
    });
  });
  it("缺少驗收或有敏感需求必須待審核", async () => {
    const s = await setup();
    await s.triage.apply(
      s.group,
      [s.project],
      s.messages,
      [decision({ acceptance: [], summary: "修改付款驗證" })],
      "00000000-0000-4000-8000-000000000001",
    );
    const t = await db.one<{
      status: string;
      missing: string[];
      risk_reasons: string[];
    }>("SELECT * FROM tasks");
    expect(t.status).toBe("awaiting_approval");
    expect(t.missing.length).toBeGreaterThan(0);
    expect(t.risk_reasons.length).toBeGreaterThan(0);
  });
  it("圖片無法取得時不能僅憑 AI 自信派工", async () => {
    const s = await setup("image");
    await s.triage.apply(
      s.group,
      [s.project],
      s.messages,
      [decision()],
      "00000000-0000-4000-8000-000000000001",
    );
    expect(
      (await db.one<{ status: string }>("SELECT status FROM tasks")).status,
    ).toBe("awaiting_approval");
  });
  it("AI 引用別的群組來源時整批拒絕且保留訊息", async () => {
    const s = await setup();
    await expect(
      s.triage.apply(
        s.group,
        [s.project],
        s.messages,
        [decision({ sourceIds: ["other-group-message"] })],
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("來源");
    expect((await db.query("SELECT id FROM tasks")).length).toBe(0);
    expect(
      (await db.one<{ processed: boolean }>("SELECT processed FROM messages"))
        .processed,
    ).toBe(false);
  });
  it("判斷進行中被撤回的訊息不可派工", async () => {
    const s = await setup();
    await new Line(db).ingest({
      events: [
        {
          webhookEventId: "u",
          type: "unsend",
          source: { type: "group", groupId: "group-a" },
          unsend: { messageId: "m1" },
        },
      ],
    });
    await expect(
      s.triage.apply(
        s.group,
        [s.project],
        s.messages,
        [decision()],
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("來源訊息");
  });
});
