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
import { z } from "zod";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({ lineSecret: "fictional-clarification-secret" }),
}));
import { db, reset, fixture, session, dashboardAction } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { CodexClassifier, Decisions, Triage } from "../server/triage.js";
import type { Runner } from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { threadHistory } from "../server/followup.js";
import type { Project, Task, TriageDecision } from "../shared/types.js";

let project: Project;
let app: Awaited<ReturnType<typeof buildApp>>;
let headers: Awaited<ReturnType<typeof session>>;
beforeEach(async () => {
  await reset();
  await fixture();
  project = await db.one<Project>("SELECT * FROM projects");
  app = await buildApp(db);
  headers = await session();
});
afterEach(() => app.close());
afterAll(() => db.close());

const question = {
  text: "是按了沒有下載，還是下載後內容不對？",
  choices: ["沒有下載", "內容不對"],
};
const directions = [
  {
    label: "保留現有匯出",
    summary: "沿用目前頁面匯出，補齊訂單日期",
    acceptance: ["匯出包含訂單日期"],
    recommended: true,
    reason: "維持現有操作，影響範圍較小",
  },
  {
    label: "新增彙總報表",
    summary: "新增按月份彙總的下載入口",
    acceptance: ["可下載每月彙總"],
    recommended: false,
    reason: "需要跨訂單分析時使用",
  },
];
async function propose(
  mode: "command" | "auto",
  patch: Partial<TriageDecision> = {},
  text = "請查 test/repo 的匯出功能",
) {
  await db.query("UPDATE groups SET trigger_mode=$1", [mode]);
  const id = randomUUID();
  const body = JSON.stringify({
    events: [
      {
        webhookEventId: id,
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: {
          id,
          type: "text",
          text: mode === "command" ? `/任務 ${text}` : text,
        },
      },
    ],
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/webhooks/line",
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-line-signature": createHmac(
            "sha256",
            "fictional-clarification-secret",
          )
            .update(body)
            .digest("base64"),
        },
      })
    ).statusCode,
  ).toBe(200);
  const github = new GitHub();
  github.context = vi.fn(async () => ({
    branches: { names: ["main"], defaultBranch: "main", truncated: false },
    branchError: null,
    sha: "fictional-sha",
    paths: [],
    files: {},
    truncated: false,
  }));
  await new Triage(
    db,
    {
      classify: async (input) => {
        const raw = {
          decisions: [
            {
              kind: "request",
              taskType: "query",
              projectId: project.id,
              title: "匯出需求",
              summary: "確認匯出功能的運作方式",
              acceptance: ["說明匯出功能"],
              sourceIds: [id],
              risks: [],
              missing: [],
              relatedTaskId: null,
              suggestions: [],
              question: null,
              assumptions: [],
              routing: {
                status: "clear",
                basis: "explicit",
                reason: "本次指名專案",
                evidence: [{ kind: "message", sourceId: id, quote: text }],
              },
              contextSourceIds: [],
              targetBranch: {
                name: "main",
                basis: "default",
                reason: "預設分支",
                evidence: [],
              },
              ...patch,
            },
          ],
        };
        const runner = {
          async upload() {},
          call: async () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({ final: JSON.stringify(raw) }),
          }),
        } as Runner;
        return new CodexClassifier(runner).classify(input);
      },
    },
    github,
    new Line(db),
    new Budget(db),
  ).process("group-a");
  return db.one<Task>("SELECT * FROM tasks WHERE $1=ANY(source_ids)", [id]);
}
const action = (
  t: Task,
  name: string,
  body: object = {},
  requestHeaders = headers,
) =>
  app.inject({
    method: "POST",
    url: `/api/tasks/${t.id}/actions`,
    headers: requestHeaders,
    payload: { action: name, version: t.version, ...body },
  });

describe.each(["command", "auto"] as const)(
  "%s 模式容錯修正模型輸出",
  (mode) => {
    it.each([
      "查詢方案",
      "問題與方案",
      "單一方案",
      "超過三項",
      "沒有推薦",
      "多個推薦",
      "缺少理由",
    ])("%s 仍成功判讀，不累加失敗並留下稽核", async (kind) => {
      const patch: Partial<TriageDecision> = {
        taskType: "change",
        kind: "clarification",
        suggestions: structuredClone(directions),
      };
      if (kind === "查詢方案") patch.taskType = "query";
      if (kind === "問題與方案") patch.question = question;
      if (kind === "單一方案") patch.suggestions = [directions[0]];
      if (kind === "超過三項")
        patch.suggestions = [
          ...directions,
          { ...directions[1], label: "第三項" },
          { ...directions[1], label: "第四項" },
        ];
      if (kind === "沒有推薦")
        patch.suggestions = directions.map((s) => ({
          ...s,
          recommended: false,
        }));
      if (kind === "多個推薦")
        patch.suggestions = [
          ...directions.map((s) => ({ ...s, recommended: true })),
        ].reverse();
      if (kind === "缺少理由")
        patch.suggestions = directions.map(({ reason, ...s }) => s);
      await db.query("UPDATE groups SET triage_failures=1");
      const t = await propose(mode, patch);
      expect(
        (await db.one("SELECT triage_failures FROM groups WHERE id='group-a'"))
          .triage_failures,
      ).toBe(0);
      expect(
        (
          await db.one("SELECT processed FROM messages WHERE id=$1", [
            t.source_ids[0],
          ])
        ).processed,
      ).toBe(true);
      const audits = await db.query(
        "SELECT detail FROM audit WHERE task_id=$1 AND kind='ai_output_adjusted'",
        [t.id],
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].detail).toContain("已調整 AI 輸出");
      if (["查詢方案", "問題與方案", "單一方案"].includes(kind)) {
        expect(t.suggestions).toEqual([]);
        expect(t.question).not.toBeNull();
        if (kind === "問題與方案") expect(t.question).toEqual(question);
        if (kind === "單一方案")
          expect(t.question?.text).toBe("是否照這個方向處理：保留現有匯出？");
      } else {
        expect(t.suggestions).toHaveLength(kind === "超過三項" ? 3 : 2);
        expect(t.suggestions.filter((s) => s.recommended)).toHaveLength(1);
        expect(t.suggestions[0].recommended).toBe(true);
        if (kind === "超過三項") expect(t.suggestions[2].label).toBe("第三項");
        if (kind === "多個推薦")
          expect(t.suggestions[0].label).toBe(directions[1].label);
        if (kind === "缺少理由")
          expect(t.suggestions.every((s) => s.reason === "AI 未說明理由")).toBe(
            true,
          );
      }
    });
  },
);

it("已回答查詢修改假設建立追問，保留原回答與版本並沿用對話串", async () => {
  const t = await propose("command", {
    assumptions: ["日期使用西元年", "沿用欄位順序"],
  });
  await db.query(
    "UPDATE tasks SET status='answered',answer='原回答內容' WHERE id=$1",
    [t.id],
  );
  const response = await action(t, "assumption", {
    index: 0,
    value: "日期使用民國年",
  });
  expect(response.statusCode).toBe(200);
  const child = response.json() as Task;
  expect(child.id).not.toBe(t.id);
  expect(child).toMatchObject({
    parent_id: t.id,
    mode: "query",
    status: "queued",
    version: 1,
    assumptions: ["日期使用民國年", "沿用欄位順序"],
    project_id: t.project_id,
    target_branch: t.target_branch,
  });
  expect(child.summary).toContain("確認匯出功能");
  expect(child.summary).not.toContain("日期使用西元年");
  expect(
    await db.one(
      "SELECT status,answer,version,assumptions FROM tasks WHERE id=$1",
      [t.id],
    ),
  ).toEqual({
    status: "answered",
    answer: "原回答內容",
    version: 1,
    assumptions: t.assumptions,
  });
  expect((await threadHistory(db, child))[0].answer).toBe("原回答內容");
  expect(
    (
      await db.one("SELECT summary FROM task_versions WHERE task_id=$1", [
        child.id,
      ])
    ).summary,
  ).toBe(child.summary);
  expect(
    (await app.inject({ url: `/api/tasks/${child.id}`, headers })).json().thread
      .before[0].id,
  ).toBe(t.id);
});

it("假設追問維持舊版本與專案可用性檢查，索取機密實際值仍待確認", async () => {
  const t = await propose("command", { assumptions: ["沿用既有格式"] });
  await db.query(
    "UPDATE tasks SET status='answered',answer='原回答' WHERE id=$1",
    [t.id],
  );
  expect(
    (
      await action({ ...t, version: 2 }, "assumption", {
        index: 0,
        value: "改用其他格式",
      })
    ).statusCode,
  ).toBe(409);
  await db.query("UPDATE projects SET enabled=false WHERE id=$1", [
    t.project_id,
  ]);
  expect(
    (await action(t, "assumption", { index: 0, value: "改用其他格式" }))
      .statusCode,
  ).toBe(409);
  await db.query("UPDATE projects SET enabled=true WHERE id=$1", [
    t.project_id,
  ]);
  const response = await action(t, "assumption", {
    index: 0,
    value: "請提供資料庫密碼的實際值",
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    parent_id: t.id,
    status: "awaiting_approval",
    approved_version: null,
  });
  expect(
    (await db.one("SELECT answer FROM tasks WHERE id=$1", [t.id])).answer,
  ).toBe("原回答");
});

describe.each(["command", "auto"] as const)("%s 模式的資訊缺口", (mode) => {
  it("模糊查詢只留下單一問題與常見答案，不接受開發方案", async () => {
    const t = await propose(mode, {
      kind: "clarification",
      question,
      missing: [question.text],
      suggestions: directions,
    });
    expect(t).toMatchObject({
      mode: "query",
      status: "awaiting_approval",
      question,
      suggestions: [],
      assumptions: [],
    });
    const detail = (
      await app.inject({ url: `/api/tasks/${t.id}`, headers })
    ).json();
    expect(detail.task.question).toEqual(question);
    expect(detail.task.suggestions).toEqual([]);
  });
  it("修改只缺一項資訊時不產生方案，不能略過問題核准", async () => {
    const t = await propose(mode, {
      taskType: "change",
      question,
      suggestions: directions,
    });
    expect(t).toMatchObject({
      status: "awaiting_approval",
      question,
      suggestions: [],
    });
    await expect(dashboardAction(t.id, "approve", t.version)).rejects.toThrow(
      "補充",
    );
  });
  it("產品方向不同才保留方案、推薦與理由，採用仍須看板確認", async () => {
    const t = await propose(mode, {
      taskType: "change",
      kind: "clarification",
      missing: ["請選擇產品方向"],
      suggestions: directions,
    });
    expect(t.question).toBeNull();
    expect(t.suggestions).toEqual(directions);
    expect(t.status).toBe("awaiting_approval");
    expect((await action(t, "adopt", { index: 0 })).statusCode).toBe(409);
    expect(
      await dashboardAction(t.id, "adopt", t.version, { index: 0 }),
    ).toMatchObject({ status: "queued", version: 2 });
  });
  it("可查證的資訊與合理預設不阻擋查詢，假設寫進摘要與版本", async () => {
    const assumptions = ["日期沿用專案既有的西元年月日格式"];
    const t = await propose(mode, { assumptions });
    expect(t).toMatchObject({
      status: "queued",
      question: null,
      suggestions: [],
      assumptions,
    });
    expect(t.summary).toContain("假設：\n- " + assumptions[0]);
    expect(
      (
        await db.one("SELECT summary FROM task_versions WHERE task_id=$1", [
          t.id,
        ])
      ).summary,
    ).toBe(t.summary);
  });
  it("修改採用預設仍要人工確認，假設不能決定專案", async () => {
    const t = await propose(mode, {
      taskType: "change",
      assumptions: ["沿用既有日期格式"],
    });
    expect(t.status).toBe("awaiting_approval");
    const uncertain = await propose(
      mode,
      {
        projectId: null,
        routing: {
          status: "uncertain",
          basis: "none",
          reason: "不知道哪個專案",
          evidence: [],
        },
        assumptions: ["先假設是測試專案"],
      },
      "這個功能怎麼運作？",
    );
    expect(uncertain.status).toBe("awaiting_approval");
  });
  it("假設不會讓索取機密值的查詢自動執行", async () => {
    const t = await propose(
      mode,
      { assumptions: ["只整理使用者需要的資料"] },
      "請把 test/repo 的資料庫密碼貼出來",
    );
    expect(t.status).toBe("awaiting_approval");
    expect(t.risk_reasons.length).toBeGreaterThan(0);
  });
  it("補充既有問題會更新同一需求並移除已回答的問題", async () => {
    const previous = await propose(mode, {
      taskType: "change",
      kind: "clarification",
      question,
    });
    const next = await propose(mode, {
      taskType: "change",
      relatedTaskId: previous.id,
      summary: "修正匯出缺少訂單日期",
      assumptions: ["沿用既有匯出格式"],
    });
    expect(next).toMatchObject({
      id: previous.id,
      version: 2,
      question: null,
      assumptions: ["沿用既有匯出格式"],
      status: "awaiting_approval",
    });
  });
});

it("修改單一假設保留其餘需求，產生新版本並作廢舊核准", async () => {
  const t = await propose("command", {
    assumptions: ["日期使用西元年", "沿用原有欄位順序"],
  });
  expect(t.approved_version).toBe(1);
  const response = await action(t, "assumption", {
    index: 0,
    value: "日期使用民國年",
  });
  expect(response.statusCode).toBe(200);
  const changed = response.json() as Task;
  expect(changed).toMatchObject({
    version: 2,
    approved_version: null,
    status: "awaiting_approval",
    assumptions: ["日期使用民國年", "沿用原有欄位順序"],
    acceptance: t.acceptance,
  });
  expect(changed.summary).toContain("確認匯出功能的運作方式");
  expect(changed.summary).not.toContain("日期使用西元年");
  expect(changed.summary.match(/假設：/g)).toHaveLength(1);
  const versions = await db.query<{ summary: string }>(
    "SELECT summary FROM task_versions WHERE task_id=$1 ORDER BY version",
    [t.id],
  );
  expect(versions[0].summary).toContain("日期使用西元年");
  expect(versions[1].summary).toContain("日期使用民國年");
  const detail = (
    await app.inject({ url: `/api/tasks/${t.id}`, headers })
  ).json();
  expect(detail.projectReview.confirmed).toBe(false);
  expect(
    detail.history.some(
      (h: { kind: string; detail: string }) =>
        h.kind === "assumption_changed" && h.detail.includes("日期使用民國年"),
    ),
  ).toBe(true);
  expect(
    (await action(t, "assumption", { index: 1, value: "新的欄位順序" }))
      .statusCode,
  ).toBe(409);
  const thread = await threadHistory(db, { parent_id: t.id });
  expect(thread[0].question).toContain("日期使用民國年");
});
it("重新查詢整份需求時，修改假設不會移除原題的人工審核風險", async () => {
  const t = await propose("command", { assumptions: ["沿用既有格式"] });
  await db.query(
    "UPDATE tasks SET status='answered',answer='原回答',risk_reasons='[\"索取機密實際值\"]' WHERE id=$1",
    [t.id],
  );
  const result = await action(t, "assumption", {
    index: 0,
    value: "改用表格整理",
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    parent_id: t.id,
    status: "awaiting_approval",
    approved_version: null,
    risk_reasons: ["索取機密實際值"],
  });
});
it("修改假設不會順便清除待回答的問題", async () => {
  const t = await propose("command", {
    question,
    assumptions: ["沿用原有欄位順序"],
  });
  const response = await action(t, "assumption", {
    index: 0,
    value: "訂單日期放第一欄",
  });
  expect(response.json().question).toEqual(question);
  expect(response.json().missing).toContain(question.text);
  await expect(dashboardAction(t.id, "approve", 2)).rejects.toThrow("補充");
});
it("整份需求編輯清除舊結構欄位，避免顯示與使用者改寫的摘要衝突", async () => {
  const t = await propose("command", {
    question,
    assumptions: ["沿用原有欄位順序"],
  });
  const response = await action(t, "amend", {
    summary: "匯出缺少訂單日期，請補上這個欄位",
    acceptance: ["匯出包含訂單日期"],
  });
  expect(response.json()).toMatchObject({
    version: 2,
    question: null,
    assumptions: [],
    status: "awaiting_approval",
  });
});
it("修改假設需登入與有效 CSRF，執行中或非法索引不可修改", async () => {
  const t = await propose("command", { assumptions: ["日期使用西元年"] });
  expect(
    (
      await action(
        t,
        "assumption",
        { index: 0, value: "日期使用民國年" },
        {} as typeof headers,
      )
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await action(
        t,
        "assumption",
        { index: 0, value: "日期使用民國年" },
        { ...headers, "x-csrf-token": "wrong" },
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (await action(t, "assumption", { index: 8, value: "日期使用民國年" }))
      .statusCode,
  ).toBe(409);
  expect(
    (await action(t, "assumption", { index: 0, value: "日期使用西元年" }))
      .statusCode,
  ).toBe(422);
  expect(
    (
      await action(t, "assumption", {
        index: 0,
        value: "密碼：fictional-secret",
      })
    ).statusCode,
  ).toBe(422);
  await db.query("UPDATE tasks SET status='running' WHERE id=$1", [t.id]);
  expect(
    (await action(t, "assumption", { index: 0, value: "日期使用民國年" }))
      .statusCode,
  ).toBe(409);
});
it("舊任務與可重跑遷移保留內容，預設沒有問題與假設", async () => {
  const t = await db.one<Task>(
    "INSERT INTO tasks(group_id,project_id,title,summary,dedupe_key) VALUES('group-a',$1,'舊需求','原本摘要','legacy') RETURNING *",
    [project.id],
  );
  await db.migrate();
  await db.migrate();
  expect(
    await db.one("SELECT summary,question,assumptions FROM tasks WHERE id=$1", [
      t.id,
    ]),
  ).toEqual({ summary: "原本摘要", question: null, assumptions: [] });
});
it("模型契約明確要求單一問題與假設，拒絕多個問題物件或超過三個答案", () => {
  const d = {
    kind: "clarification",
    projectId: project.id,
    taskType: "query",
    title: "查詢匯出",
    summary: "確認匯出問題",
    acceptance: ["回答問題"],
    sourceIds: ["source"],
    risks: [],
    missing: [],
    relatedTaskId: null,
    suggestions: [],
    question,
    assumptions: [],
    contextSourceIds: [],
    routing: {
      status: "uncertain",
      basis: "none",
      reason: "需補充",
      evidence: [],
    },
    targetBranch: {
      name: "main",
      basis: "default",
      reason: "預設分支",
      evidence: [],
    },
  };
  expect(Decisions.safeParse({ decisions: [d] }).success).toBe(true);
  expect(
    Decisions.safeParse({
      decisions: [
        { ...d, taskType: "change", question: null, suggestions: directions },
      ],
    }).success,
  ).toBe(true);
  expect(
    Decisions.safeParse({ decisions: [{ ...d, suggestions: directions }] })
      .success,
  ).toBe(true);
  expect(
    Decisions.safeParse({
      decisions: [
        {
          ...d,
          taskType: "change",
          question: null,
          suggestions: directions.map((s) => ({ ...s, recommended: true })),
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    Decisions.safeParse({
      decisions: [{ ...d, question: [question, question] }],
    }).success,
  ).toBe(false);
  expect(
    Decisions.safeParse({
      decisions: [
        { ...d, question: { ...question, choices: ["甲", "乙", "丙", "丁"] } },
      ],
    }).success,
  ).toBe(false);
  const schema = z.toJSONSchema(Decisions) as any;
  expect(schema.properties.decisions.items.required).toEqual(
    expect.arrayContaining(["question", "assumptions"]),
  );
});
