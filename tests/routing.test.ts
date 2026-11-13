import { beforeEach, afterAll, describe, it, expect } from "vitest";
import { db, reset, fixture, dashboardAction } from "./helpers.js";
import { Triage } from "../server/triage.js";
import { Tasks } from "../server/tasks.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import { syncKnowledge } from "../server/jobs.js";
import type {
  Group,
  Message,
  Project,
  Task,
  TriageDecision,
} from "../shared/types.js";
beforeEach(reset);
afterAll(() => db.close());
const decision = (overrides: Partial<TriageDecision> = {}): TriageDecision => ({
  kind: "request",
  projectId: null,
  title: "修正報表",
  summary: "報表日期改為民國年",
  acceptance: ["報表日期顯示民國年"],
  sourceIds: ["m1"],
  risks: [],
  missing: [],
  relatedTaskId: null,
  suggestions: [],
  ...overrides,
});
async function setup(projectCount = 2) {
  await fixture();
  if (projectCount > 1) {
    const other = await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('報表系統','test/report',true,now()) RETURNING id",
    );
    await db.query(
      "INSERT INTO group_projects(group_id,project_id) VALUES('group-a',$1)",
      [other.id],
    );
  }
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: "e1",
        type: "message",
        source: { type: "group", groupId: "group-a", userId: "u1" },
        message: { id: "m1", type: "text", text: "報表日期請改民國年" },
      },
    ],
  });
  const group = await db.one<Group>("SELECT * FROM groups WHERE id='group-a'");
  const projects = await db.query<Project>(
    "SELECT * FROM projects ORDER BY name",
  );
  const messages = await db.query<Message>("SELECT * FROM messages");
  const triage = new Triage(
    db,
    { classify: async () => [] },
    new GitHub(),
    new Line(db),
    new Budget(db),
  );
  return { group, projects, messages, triage };
}
describe("多專案路由與群組記憶", () => {
  it("AI 指定群組內的專案時，修改任務仍需人工確認", async () => {
    const s = await setup();
    const report = s.projects.find((p) => p.repo === "test/report")!;
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision({ projectId: report.id })],
      crypto.randomUUID(),
    );
    const task = await db.one<Task>("SELECT * FROM tasks");
    expect(task.project_id).toBe(report.id);
    expect(task.status).toBe("awaiting_approval");
  });
  it("無法判斷專案時待管理者指定，指定時可一併記住", async () => {
    const s = await setup();
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision()],
      crypto.randomUUID(),
    );
    const task = await db.one<Task>("SELECT * FROM tasks");
    expect(task.project_id).toBeNull();
    expect(task.status).toBe("awaiting_approval");
    const tasks = new Tasks(db);
    await expect(tasks.action(task.id, "approve", 1, "管理者")).rejects.toThrow(
      "看板",
    );
    const report = s.projects.find((p) => p.repo === "test/report")!;
    const assigned = (await tasks.action(task.id, "assign", 1, "管理者", {
      project_id: report.id,
      remember: "報表相關需求改報表系統",
    })) as Task;
    expect(assigned.project_id).toBe(report.id);
    expect(assigned.version).toBe(2);
    const memory = await db.one<{ source: string; project_id: string }>(
      "SELECT * FROM group_memories",
    );
    expect(memory).toMatchObject({ source: "admin", project_id: report.id });
    await dashboardAction(task.id, "approve", 2);
    expect(
      (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [task.id])).status,
    ).toBe("queued");
  });
  it("不能指定群組未綁定的專案", async () => {
    const s = await setup();
    const outside = await db.one<{ id: string }>(
      "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('外部','test/outside',true,now()) RETURNING id",
    );
    await expect(
      s.triage.apply(
        s.group,
        s.projects,
        s.messages,
        [decision({ projectId: outside.id })],
        crypto.randomUUID(),
      ),
    ).resolves.toBeUndefined();
    expect(await db.one("SELECT project_id,status FROM tasks")).toEqual({project_id: null,status: "awaiting_approval"});
    const task = await db.one<Task>(
      "INSERT INTO tasks(group_id,title,summary,dedupe_key) VALUES('group-a','t','s','k') RETURNING *",
    );
    await expect(
      new Tasks(db).action(task.id, "assign", 1, "管理者", {
        project_id: outside.id,
      }),
    ).rejects.toThrow("未綁定");
  });
  it("聊天要求記住時寫入群組記憶，不建立任務", async () => {
    const s = await setup();
    const report = s.projects.find((p) => p.repo === "test/report")!;
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [
        decision({
          kind: "memory",
          projectId: report.id,
          summary: "報表相關都改報表系統",
          acceptance: [],
        }),
      ],
      crypto.randomUUID(),
    );
    expect(await db.query("SELECT * FROM tasks")).toHaveLength(0);
    const memory = await db.one<{ source: string; source_message_id: string }>(
      "SELECT * FROM group_memories",
    );
    expect(memory).toMatchObject({ source: "chat", source_message_id: "m1" });
  });
  it("AI 自行歸納的記憶與需求並存、標示來源、不重複，關閉後不再寫入", async () => {
    const s = await setup();
    const report = s.projects.find((p) => p.repo === "test/report")!;
    const learned = decision({
      kind: "memory",
      title: "inferred",
      projectId: report.id,
      summary: "報表日期相關需求都改報表系統",
      acceptance: [],
    });
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision({ projectId: report.id }), learned],
      crypto.randomUUID(),
    );
    expect(await db.query("SELECT id FROM tasks")).toHaveLength(1);
    const memory = await db.one<{ source: string; content: string }>(
      "SELECT * FROM group_memories",
    );
    expect(memory).toMatchObject({
      source: "ai",
      content: "報表日期相關需求都改報表系統",
    });
    const again = async () => {
      await db.query("UPDATE messages SET processed=false");
      await s.triage.apply(
        s.group,
        s.projects,
        s.messages,
        [{ ...learned, summary: " 報表日期相關需求 都改報表系統 " }],
        crypto.randomUUID(),
      );
    };
    await again();
    expect(await db.query("SELECT id FROM group_memories")).toHaveLength(1);
    await db.query("DELETE FROM group_memories");
    await db.query(
      "UPDATE settings SET value=value || '{\"auto_memory\":false}'::jsonb",
    );
    await again();
    expect(await db.query("SELECT id FROM group_memories")).toHaveLength(0);
  });
  it("AI 判斷為查詢時建立查詢任務，管理者可在核准前切換類型", async () => {
    const s = await setup();
    const report = s.projects.find((p) => p.repo === "test/report")!;
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision({ projectId: report.id, taskType: "query", risks: ["權限"] })],
      crypto.randomUUID(),
    );
    const task = await db.one<Task>("SELECT * FROM tasks");
    expect(task.mode).toBe("query");
    expect(task.status).toBe("awaiting_approval");
    await new Tasks(db).action(task.id, "mode", task.version, "管理者", {
      mode: "change",
    });
    const after = await db.one<Task>("SELECT * FROM tasks");
    expect(after.mode).toBe("change");
    expect(after.version).toBe(task.version + 1);
    await expect(
      new Tasks(db).action(task.id, "mode", task.version, "管理者", {
        mode: "other",
      }),
    ).rejects.toThrow();
  });
  it("未提供類型的舊判讀結果視為修改程式", async () => {
    const s = await setup();
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision({ projectId: s.projects[0].id })],
      crypto.randomUUID(),
    );
    expect((await db.one<Task>("SELECT * FROM tasks")).mode).toBe("change");
  });
  it("只綁一個專案時，AI 未指定仍須確認專案", async () => {
    const s = await setup(1);
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision()],
      crypto.randomUUID(),
    );
    const task = await db.one<Task>("SELECT * FROM tasks");
    expect(task.project_id).toBeNull();
    expect(task.status).toBe("awaiting_approval");
  });
});
describe("AI 建議方案", () => {
  const options = [
    {
      label: "加寬 L0 即時看板",
      summary: "調整 WIP/L0/CUR.css",
      acceptance: ["欄位最小寬度 120px"],
    },
    {
      label: "加寬全部 WIP 看板",
      summary: "調整共用樣式",
      acceptance: ["所有 WIP 頁欄位加寬"],
    },
    {
      label: "欄位可拖曳調寬",
      summary: "加入拖曳調整",
      acceptance: ["可拖曳欄位邊界"],
    },
  ];
  async function pending() {
    const s = await setup();
    const target = s.projects.find((p) => p.repo === "test/repo")!;
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [
        decision({
          kind: "clarification",
          projectId: target.id,
          acceptance: [],
          missing: ["請確認哪個頁面"],
          suggestions: options,
        }),
      ],
      crypto.randomUUID(),
    );
    return db.one<Task>("SELECT * FROM tasks");
  }
  it("待確認的需求保存三個方案，私訊引導看板確認", async () => {
    const task = await pending();
    expect(task.status).toBe("awaiting_approval");
    expect(task.suggestions).toHaveLength(3);
    const n = await db.one<{ text: string; quick_replies: { data: string }[] }>(
      "SELECT * FROM notifications WHERE task_id=$1",
      [task.id],
    );
    expect(n.text).toContain("看板");
    expect(n.text).toContain("test/repo");
    expect(n.quick_replies ?? []).toEqual([]);
  });
  it("採用方案會存成新版本並直接排程", async () => {
    const task = await pending();
    const adopted = (await dashboardAction(task.id, "adopt", 1, {
      index: 1,
    })) as Task;
    expect(adopted).toMatchObject({
      status: "queued",
      version: 2,
      approved_version: 2,
      missing: [],
      suggestions: [],
      acceptance: ["所有 WIP 頁欄位加寬"],
    });
    expect(adopted.summary).toContain("加寬全部 WIP 看板");
  });
  it("已配對的管理者點擊 LINE 舊按鈕也只能到看板確認", async () => {
    const task = await pending();
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{admin_line_id}','\"U-admin\"')",
    );
    const postback = (id: string, user: string) => ({
      events: [
        {
          webhookEventId: id,
          type: "postback",
          source: { type: "user", userId: user },
          postback: { data: `adopt:${task.id}:1:0` },
        },
      ],
    });
    await new Line(db).ingest(postback("p1", "U-someone"));
    expect(
      (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [task.id])).status,
    ).toBe("awaiting_approval");
    await new Line(db).ingest(postback("p2", "U-admin"));
    const after = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      task.id,
    ]);
    expect(after.status).toBe("awaiting_approval");
    expect(after.version).toBe(1);
    const reply = await db.one<{ text: string }>(
      "SELECT text FROM notifications WHERE kind='adopt'",
    );
    expect(reply.text).toContain("看板確認流程");
  });
});
describe("碎片化對話與專案記憶", () => {
  async function second(s: Awaited<ReturnType<typeof setup>>) {
    await new Line(db).ingest({
      events: [
        {
          webhookEventId: "e2",
          type: "message",
          source: { type: "group", groupId: "group-a", userId: "u1" },
          message: { id: "m2", type: "text", text: "手機版也要" },
        },
      ],
    });
    return db.query<Message>("SELECT * FROM messages WHERE id='m2'");
  }
  it("補充尚未開始的需求時併入同一張任務成為新版本", async () => {
    const s = await setup();
    const report = s.projects.find((p) => p.repo === "test/report")!;
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [
        decision({
          kind: "clarification",
          projectId: report.id,
          missing: ["哪個頁面？"],
        }),
      ],
      crypto.randomUUID(),
    );
    const first = await db.one<Task>("SELECT * FROM tasks");
    await s.triage.apply(
      s.group,
      s.projects,
      await second(s),
      [
        decision({
          sourceIds: ["m2"],
          relatedTaskId: first.id,
          projectId: report.id,
          summary: "報表日期改民國年，手機版也要",
          acceptance: ["桌機與手機都顯示民國年"],
        }),
      ],
      crypto.randomUUID(),
    );
    const tasks = await db.query<Task>("SELECT * FROM tasks");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: first.id,
      version: 2,
      status: "awaiting_approval",
      approved_version: null,
      summary: "報表日期改民國年，手機版也要",
    });
    expect([...tasks[0].source_ids].sort()).toEqual(["m1", "m2"]);
  });
  it("原需求已開始時另開追加事項，不改動進行中的版本", async () => {
    const s = await setup();
    const report = s.projects.find((p) => p.repo === "test/report")!;
    const running = await db.one<Task>(
      "INSERT INTO tasks(project_id,group_id,title,summary,status,approved_version,dedupe_key) VALUES($1,'group-a','原需求','原內容','running',1,'r') RETURNING *",
      [report.id],
    );
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision({ relatedTaskId: running.id, projectId: report.id })],
      crypto.randomUUID(),
    );
    const added = await db.one<Task>("SELECT * FROM tasks WHERE parent_id=$1", [
      running.id,
    ]);
    expect(added.status).toBe("awaiting_approval");
    expect(
      (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [running.id]))
        .version,
    ).toBe(1);
  });
  it("沒說完的訊息保留待下一批，等太久則轉人工確認", async () => {
    const s = await setup();
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision({ kind: "defer" })],
      crypto.randomUUID(),
    );
    expect(
      (await db.one<Message>("SELECT * FROM messages WHERE id='m1'")).processed,
    ).toBe(false);
    expect(await db.query("SELECT * FROM tasks")).toHaveLength(0);
    const g = await db.one<{ ahead: boolean }>(
      "SELECT last_pending_at>now() AS ahead FROM groups WHERE id='group-a'",
    );
    expect(g.ahead).toBe(true);
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [decision({ kind: "defer" })],
      crypto.randomUUID(),
      ["m1"],
    );
    const task = await db.one<Task>("SELECT * FROM tasks");
    expect(task.status).toBe("awaiting_approval");
    expect(task.missing).toContain("訊息看起來沒有說完，請確認需求");
  });
  it("聊天要求寫入 AGENTS.md 必須先確認專案；管理者已指定的規範維持同步", async () => {
    const s = await setup();
    const report = s.projects.find((p) => p.repo === "test/report")!;
    await s.triage.apply(
      s.group,
      s.projects,
      s.messages,
      [
        decision({
          kind: "knowledge",
          projectId: report.id,
          summary: "日期一律顯示民國年",
          acceptance: [],
        }),
      ],
      crypto.randomUUID(),
    );
    expect(await db.query("SELECT status,mode FROM tasks")).toEqual([{status: "awaiting_approval", mode: "change"}]);
    expect(await db.query("SELECT id FROM project_knowledge")).toHaveLength(0);
    await db.query("INSERT INTO project_knowledge(project_id,group_id,content,source) VALUES($1,'group-a','日期一律顯示民國年','admin')", [report.id]);
    const github = new GitHub();
    const sent: string[][] = [];
    github.knowledgePr = async (_p, items) => {
      sent.push(items.map((i) => i.content));
      return {
        number: 9,
        html_url: "https://github.com/test/report/pull/9",
      } as Awaited<ReturnType<GitHub["knowledgePr"]>>;
    };
    await syncKnowledge(db, github, new Line(db), report.id);
    expect(sent).toEqual([["日期一律顯示民國年"]]);
    const k = await db.one<{ status: string; pr_number: number }>(
      "SELECT * FROM project_knowledge",
    );
    expect(k).toMatchObject({ status: "in_pr", pr_number: 9 });
    await syncKnowledge(db, github, new Line(db), report.id);
    expect(sent).toHaveLength(1);
  });
});
