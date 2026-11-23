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
import { db, reset, fixture, session } from "./helpers.js";
import { Triage, OpenAIClassifier, type Classifier } from "../server/triage.js";
import { dueTriageGroups } from "../server/triage-window.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import { buildApp } from "../server/app.js";
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
  it("同頻道兩筆各帶三份文件的指令分輪判讀，各自保留三份完整來源", async () => {
    await fixture();
    const github = new GitHub();
    github.context = async () => ({ sha: "base", paths: [], files: {}, truncated: false,
      branches: { names: ["main"], defaultBranch: "main", truncated: false }, branchError: null });
    for (const id of ["a", "b"]) {
      await db.query(`INSERT INTO messages(id,group_id,type,text,discord_message_id,trigger_mode,received_at)
        VALUES($1,'group-a','text','/任務 依附件更新規格',$1,'command',now()-interval '3 minutes')`, [id]);
      await db.query(`INSERT INTO messages(id,group_id,type,text,document_name,discord_message_id,trigger_mode,received_at)
        SELECT $1||'-'||n,'group-a','document',$1||' 規格 '||n,n||'.txt',$1,'command',
          (SELECT received_at FROM messages WHERE id=$1) FROM generate_series(1,3) n`, [id]);
    }
    const seen: string[][] = [];
    const classify: Classifier["classify"] = async ({ messages }) => {
      const root = messages.find((m) => m.type === "text")!;
      seen.push(messages.filter((m) => m.type === "document").map((m) => m.text!));
      return [decision({ title: "規格 " + root.id, sourceIds: [root.id] })];
    };
    const service = new Triage(db, { classify }, github, new Line(db), new Budget(db));
    await service.process("group-a");
    expect((await db.query("SELECT id FROM messages WHERE NOT processed"))).toHaveLength(4);
    await service.process("group-a");
    expect(seen).toEqual([["a 規格 1", "a 規格 2", "a 規格 3"], ["b 規格 1", "b 規格 2", "b 規格 3"]]);
    const tasks = await db.query<{source_ids: string[]; missing: string[]}>("SELECT source_ids,missing FROM tasks ORDER BY title");
    expect(tasks.map((t) => t.source_ids.sort())).toEqual([["a", "a-1", "a-2", "a-3"], ["b", "b-1", "b-2", "b-3"]]);
    expect(tasks.flatMap((t) => t.missing).join(" ")).not.toContain("四份");
  });
  it.each(["ignore", "memory"] as const)(
    "替身判讀回傳 %s 與同事分工原因時，管理者能在看板查到原因",
    async (kind) => {
      const s = await setup();
      await db.query("UPDATE messages SET text=$1 WHERE id='m1'", [
        "@小禾 你處理範例看板的按鈕，相關問題以後都找範例看板專案。",
      ]);
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
        decision({
          kind,
          noTaskReason: "coworker_assignment",
          title: kind === "memory" ? "inferred" : "",
          summary: kind === "memory" ? "按鈕問題由範例看板專案處理。" : "",
          acceptance: [],
        }),
      ]);
      await new Triage(
        db,
        { classify },
        github,
        new Line(db),
        new Budget(db),
      ).process(s.group.id);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
      expect(
        await db.one("SELECT processed FROM messages WHERE id='m1'"),
      ).toEqual({ processed: true });
      expect(await db.query("SELECT content FROM group_memories")).toHaveLength(
        kind === "memory" ? 1 : 0,
      );
      const app = await buildApp(db);
      try {
        const response = await app.inject({
          url: "/api/state",
          headers: await session(),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().activity).toContainEqual(
          expect.objectContaining({
            kind: "triage_skipped",
            task_id: null,
            detail: "你在「測試群組」的訊息屬於同事之間的分工，系統未建立任務。",
          }),
        );
      } finally {
        await app.close();
      }
    },
  );
  it.each([false, true])(
    "未定案的討論不轉成任務（已等候到期：%s）",
    async (expired) => {
      const s = await setup();
      await s.triage.apply(
        s.group,
        [s.project],
        s.messages,
        [decision({ kind: "defer", noTaskReason: "undecided_discussion" })],
        crypto.randomUUID(),
        expired ? ["m1"] : [],
      );
      expect(await db.query("SELECT id FROM tasks")).toHaveLength(0);
      expect(
        await db.one("SELECT processed FROM messages WHERE id='m1'"),
      ).toEqual({ processed: expired });
      expect(
        await db.one("SELECT detail FROM audit WHERE kind='triage_skipped'"),
      ).toEqual({
        detail: expired
          ? "你在「測試群組」的討論尚未定案，系統未建立任務。"
          : "你在「測試群組」的討論尚未定案，系統會等新訊息，或在滿 15 分鐘時再判讀一次。",
      });
    },
  );
  it.each(["到期", "新訊息", "普通片段重試", "到期時普通片段仍在等候"] as const)(
    "未定案討論依群組排程處理（%s）",
    async (scenario) => {
      const s = await setup();
      const line = new Line(db);
      const send = (id: string, text: string) =>
        line.ingest({
          events: [
            {
              webhookEventId: id,
              type: "message",
              source: { type: "group", groupId: s.group.id },
              message: { id, type: "text", text },
            },
          ],
        });
      await db.query(
        "UPDATE messages SET text='先朝這版改？我還想跟小林討論。' WHERE id='m1'",
      );
      if (scenario === "普通片段重試" || scenario === "到期時普通片段仍在等候")
        await send("m2", "還有報表的部分");
      const ageWindow = () =>
        db.query(
          "UPDATE groups SET first_pending_at=now()-interval '5 minutes',last_pending_at=now()-interval '1 minute'",
        );
      const github = new GitHub();
      github.context = async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
        sha: "fictional-base",
        paths: [],
        files: {},
        truncated: false,
      });
      const classify = vi.fn(
        async ({ messages }: Parameters<Classifier["classify"]>[0]) =>
          messages
            .filter((m) => !m.contextOnly)
            .map((m) =>
              decision({
                kind: "defer",
                noTaskReason: m.id === "m1" ? "undecided_discussion" : null,
                sourceIds: [m.id],
              }),
            ),
      );
      const triage = new Triage(db, { classify }, github, line, new Budget(db));
      const process = () => triage.process(s.group.id, true);
      await ageWindow();
      await process();
      expect(classify).toHaveBeenCalledTimes(1);
      if (scenario === "新訊息") {
        await send("m2", "小林補了一個做法，大家還在討論。");
      } else if (scenario === "到期") {
        for (const minutes of [5, 10, 14]) {
          await db.query(
            "UPDATE messages SET received_at=now()-make_interval(mins=>$1) WHERE id='m1'",
            [minutes],
          );
          await ageWindow();
          expect(await dueTriageGroups(db, s.group.id)).toEqual([]);
          await process();
        }
        expect(classify).toHaveBeenCalledTimes(1);
      }
      const deadline =
        scenario === "到期" || scenario === "到期時普通片段仍在等候";
      if (deadline) {
        await db.query(
          "UPDATE messages SET received_at=now()-interval '15 minutes 1 second' WHERE id='m1'",
        );
      } else {
        await ageWindow();
      }
      expect(await dueTriageGroups(db, s.group.id)).toHaveLength(1);
      await process();
      expect(classify).toHaveBeenCalledTimes(2);
      expect(classify.mock.calls[1][0].messages.map((m) => m.id)).toEqual(
        deadline
          ? ["m1"]
          : scenario === "新訊息"
            ? ["m1", "m2"]
            : ["m2"],
      );
      if (deadline) {
        expect(classify.mock.calls[1][0].context).toMatchObject({
          mustDecide: ["m1"],
        });
        expect(await db.query("SELECT id FROM tasks")).toEqual([]);
        expect(await dueTriageGroups(db, s.group.id)).toEqual([]);
        await process();
        expect(classify).toHaveBeenCalledTimes(2);
      }
    },
  );
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
      branches: { names: ["main"], defaultBranch: "main", truncated: false },
      branchError: null,
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
