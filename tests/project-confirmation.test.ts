import { beforeEach, afterEach, afterAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { db, reset, fixture, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import type {
  Group,
  Message,
  Project,
  Task,
  TriageDecision,
} from "../shared/types.js";
import type { RoutingSource } from "../shared/project-routing.js";
let app: FastifyInstance;
let headers: Awaited<ReturnType<typeof session>>;
let project: Project;
beforeEach(async () => {
  await reset();
  await fixture();
  project = await db.one<Project>("SELECT * FROM projects");
  headers = await session();
  app = await buildApp(db);
});
afterEach(async () => {
  await app.close();
});
afterAll(() => db.close());
async function propose(
  overrides: Partial<TriageDecision> = {},
  sources: RoutingSource[] = [],
  text = "請查報工的機台欄位用途",
) {
  const messageId = randomUUID();
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: randomUUID(),
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { id: messageId, type: "text", text },
      },
    ],
  });
  const d: TriageDecision = {
    kind: "request",
    projectId: project.id,
    taskType: "query",
    title: "確認機台欄位用途",
    summary: text,
    acceptance: ["解釋兩個欄位的用途及讀取來源"],
    sourceIds: [messageId],
    risks: [],
    missing: [],
    relatedTaskId: null,
    suggestions: [],
    ...overrides,
  };
  if (d.routing?.basis === "explicit")
    d.routing.evidence = [
      { kind: "message", sourceId: messageId, quote: text },
    ];
  const triage = new Triage(
    db,
    { classify: async () => [] },
    new GitHub(),
    new Line(db),
    new Budget(db),
  );
  const group = await db.one<Group>("SELECT * FROM groups WHERE id='group-a'");
  const projects = await db.query<Project>(
    "SELECT p.* FROM projects p JOIN group_projects gp ON gp.project_id=p.id WHERE gp.group_id='group-a'",
  );
  const messages = await db.query<Message>(
    "SELECT * FROM messages WHERE id=$1",
    [messageId],
  );
  await triage.apply(
    group,
    projects,
    messages,
    [d],
    randomUUID(),
    [],
    undefined,
    [],
    undefined,
    sources,
  );
  return (await app.inject({ url: "/api/state", headers }))
    .json()
    .tasks.find((t: Task) => t.source_ids.includes(messageId)) as Task;
}
const explicit = () =>
  ({
    status: "clear",
    basis: "explicit",
    reason: "需求明確指定 test/repo",
    evidence: [],
  }) as const;
const source = (): RoutingSource => ({
  id: "機台欄位來源",
  projectId: project.id,
  path: "src/machine.cs",
  sha: "base-sha",
  text: "機台代碼用於讀取設備資料並對應生產機台編號。",
});
const evidenceRoute = () =>
  ({
    status: "clear",
    basis: "repository",
    reason: "此專案實作了題目中的機台欄位",
    evidence: [{ kind: "repo", sourceId: source().id, quote: source().text }],
  }) as const;
async function action(
  task: Task,
  kind = "approve",
  extra: Record<string, unknown> = {},
) {
  const detail = (
    await app.inject({ url: `/api/tasks/${task.id}`, headers })
  ).json();
  return app.inject({
    method: "POST",
    url: `/api/tasks/${task.id}/actions`,
    headers,
    payload: {
      action: kind,
      version: task.version,
      project_id: task.project_id,
      binding_version: detail.projectReview.binding_version,
      config_version: detail.projectReview.config_version,
      target_branch: detail.task.target_branch,
      ...extra,
    },
  });
}
it("唯一綁定不等於選對專案，沒有建議或證據都要確認", async () => {
  const unknown = await propose({ projectId: null });
  expect(unknown.project_id).toBeNull();
  expect(unknown.status).toBe("awaiting_approval");
  const guessed = await propose();
  expect(guessed.status).toBe("awaiting_approval");
  expect(guessed.approved_version).toBeNull();
});
it("明確指名的修改仍需看板確認，核准保存完整版本與操作者", async () => {
  const t = await propose(
    { taskType: "change", routing: { ...explicit(), evidence: [] } },
    [],
    "請修改 test/repo 的機台欄位",
  );
  expect(t.status).toBe("awaiting_approval");
  const missing = await app.inject({
    method: "POST",
    url: `/api/tasks/${t.id}/actions`,
    headers,
    payload: { action: "approve", version: t.version },
  });
  expect(missing.statusCode).toBe(409);
  expect((await action(t)).statusCode).toBe(200);
  const detail = (
    await app.inject({ url: `/api/tasks/${t.id}`, headers })
  ).json();
  expect(detail.task.status).toBe("queued");
  expect(detail.projectReview.confirmed).toBe(true);
  expect(detail.projectReview.confirmation).toMatchObject({
    kind: "manual",
    project_id: project.id,
    version: t.version,
    config_version: project.config_version,
    mode: "change",
    actor: "1000001",
  });
});
it("本次明確指定唯一綁定專案的查詢可自動排程", async () => {
  const task = await propose(
    { routing: { ...explicit(), evidence: [] } },
    [],
    "請查 test/repo 的機台欄位",
  );
  expect(task.status).toBe("queued");
  const detail = (
    await app.inject({ url: `/api/tasks/${task.id}`, headers })
  ).json();
  expect(detail.projectReview.confirmation.kind).toBe("evidence");
});
it("未指名但有唯一實際檔案證據的查詢可自動排程並留下引用", async () => {
  const task = await propose(
    {
      routing: { ...evidenceRoute(), evidence: [...evidenceRoute().evidence] },
    },
    [source()],
  );
  expect(task.status).toBe("queued");
  const detail = (
    await app.inject({ url: `/api/tasks/${task.id}`, headers })
  ).json();
  expect(detail.contextEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: "routing",
        path: "src/machine.cs",
        index_sha: "base-sha",
      }),
    ]),
  );
});
it.each(["虛構來源", "虛構引文", "無證據", "有衝突"])(
  "%s 的查詢不能自動執行",
  async (variant) => {
    const routing: NonNullable<TriageDecision["routing"]> = {
      ...evidenceRoute(),
      evidence: [...evidenceRoute().evidence],
    };
    if (variant === "虛構來源")
      routing.evidence[0] = { ...routing.evidence[0], sourceId: "不存在" };
    if (variant === "虛構引文")
      routing.evidence[0] = {
        ...routing.evidence[0],
        quote: "這段引文實際上並不存在於本次的專案檔案",
      };
    if (variant === "無證據") routing.evidence = [];
    if (variant === "有衝突") routing.status = "conflict";
    expect((await propose({ routing }, [source()])).status).toBe(
      "awaiting_approval",
    );
  },
);
it("多個專案含相同引文時，不能聲稱唯一匹配", async () => {
  const other = await db.one<Project>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('其他專案','test/other',true,now()) RETURNING *",
  );
  await db.query("INSERT INTO group_projects VALUES('group-a',$1,now())", [
    other.id,
  ]);
  const task = await propose(
    {
      routing: { ...evidenceRoute(), evidence: [...evidenceRoute().evidence] },
    },
    [source(), { ...source(), id: "另一來源", projectId: other.id }],
  );
  expect(task.status).toBe("awaiting_approval");
});
it("指名未綁定專案時保留需求待確認，不改派唯一候選", async () => {
  const task = await propose(
    { projectId: randomUUID(), routing: { ...explicit(), evidence: [] } },
    [],
    "請查 other/unbound 的機台欄位",
  );
  expect(task.project_id).toBeNull();
  expect(task.project_routing?.status).toBe("conflict");
  expect(task.status).toBe("awaiting_approval");
});
it("專案明確的查詢：AI 列的風險只提醒，要求交出機密實際值才待人工審核", async () => {
  const task = await propose(
    { routing: { ...explicit(), evidence: [] }, risks: ["機密"] },
    [],
    "請查 test/repo 的機台欄位",
  );
  expect(task.status).toBe("queued");
  const secret = await propose(
    { routing: { ...explicit(), evidence: [] } },
    [],
    "請把 test/repo 的資料庫密碼貼出來",
  );
  expect(secret.status).toBe("awaiting_approval");
});
it("指名另一個已登記但未綁定的專案，即使 AI 提供錯誤候選的檔案證據也攔下", async () => {
  await db.query(
    "INSERT INTO projects(name,repo) VALUES('機台後端','test/unbound')",
  );
  const task = await propose(
    {
      routing: { ...evidenceRoute(), evidence: [...evidenceRoute().evidence] },
    },
    [source()],
    "請查機台後端的機台欄位",
  );
  expect(task.status).toBe("awaiting_approval");
  expect(task.project_routing?.status).toBe("conflict");
});
it("採用方案需要同時確認專案，不能由舊請求直接核准", async () => {
  const task = await propose({
    taskType: "change",
    kind: "clarification",
    missing: ["選方案"],
    suggestions: [
      {
        label: "方案一",
        summary: "調整機台欄位提示文字",
        acceptance: ["提示文字清楚"],
      },
    ],
  });
  const rejected = await app.inject({
    method: "POST",
    url: `/api/tasks/${task.id}/actions`,
    headers,
    payload: { action: "adopt", version: task.version, index: 0 },
  });
  expect(rejected.statusCode).toBe(409);
  const adopted = await action(task, "adopt", { index: 0 });
  expect(adopted.statusCode).toBe(200);
  expect(adopted.json()).toMatchObject({
    version: 2,
    approved_version: 2,
    status: "queued",
  });
});
it("類型切換會作廢查詢自動核准，舊核准與重試不能繞過", async () => {
  const task = await propose(
    { routing: { ...explicit(), evidence: [] } },
    [],
    "請查 test/repo 的機台欄位",
  );
  const changed = await action(task, "mode", { mode: "change" });
  expect(changed.json()).toMatchObject({
    version: 2,
    approved_version: null,
    status: "awaiting_approval",
  });
  expect((await action(task)).statusCode).toBe(409);
  await db.query("UPDATE tasks SET status='failed' WHERE id=$1", [task.id]);
  expect((await action(changed.json(), "retry")).statusCode).toBe(409);
});
it.each(["綁定", "專案設定", "基底分支"])(
  "%s 改變後舊頁面核准失效，任務退回待審核",
  async (change) => {
    const task = await propose({ taskType: "change" });
    const old = (
      await app.inject({ url: `/api/tasks/${task.id}`, headers })
    ).json().projectReview;
    expect((await action(task)).statusCode).toBe(200);
    if (change === "綁定") {
      const response = await app.inject({
        method: "PUT",
        url: "/api/groups/group-a",
        headers,
        payload: { name: "測試群組", enabled: false, project_ids: [] },
      });
      expect(response.statusCode).toBe(200);
    } else {
      const response = await app.inject({
        method: "PUT",
        url: `/api/projects/${project.id}`,
        headers,
        payload: {
          ...project,
          enabled: false,
          install_command:
            change === "專案設定" ? "echo changed" : project.install_command,
          base_branch: change === "基底分支" ? "develop" : project.base_branch,
        },
      });
      expect(response.statusCode).toBe(200);
    }
    const detail = (
      await app.inject({ url: `/api/tasks/${task.id}`, headers })
    ).json();
    expect(detail.task.status).toBe("awaiting_approval");
    expect(detail.projectReview.confirmed).toBe(false);
    const stale = await action(detail.task, "approve", {
      project_id: project.id,
      binding_version: old.binding_version,
      config_version: old.config_version,
      target_branch: task.target_branch,
    });
    expect(stale.statusCode).toBe(409);
  },
);
it("LINE 舊採用按鈕只引導看板，通知不再提供直接派工按鈕", async () => {
  const task = await propose({ taskType: "change" });
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{admin_line_id}','\"U-admin\"')",
  );
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: randomUUID(),
        type: "postback",
        source: { type: "user", userId: "U-admin" },
        postback: { data: `adopt:${task.id}:1:0` },
      },
    ],
  });
  const detail = (
    await app.inject({ url: `/api/tasks/${task.id}`, headers })
  ).json();
  expect(detail.task.status).toBe("awaiting_approval");
  const notices = await db.query<{ text: string; quick_replies: unknown }>(
    "SELECT text,quick_replies FROM notifications WHERE task_id=$1",
    [task.id],
  );
  expect(
    notices.every(
      (n) =>
        !n.quick_replies ||
        (Array.isArray(n.quick_replies) && !n.quick_replies.length),
    ),
  ).toBe(true);
  expect(notices.some((n) => n.text.includes("看板確認流程"))).toBe(true);
});

it("指名專案但另外提到分支時先核對分支，不會自動使用預設值查詢", async () => {
  const task = await propose(
    { routing: { ...explicit(), evidence: [] } },
    [],
    "請查 test/repo 的 develop 分支，確認機台欄位用途",
  );
  expect(task.status).toBe("awaiting_approval");
  expect(task.branch_selection?.reason).toContain(project.base_branch);
  const detail = (
    await app.inject({ url: `/api/tasks/${task.id}`, headers })
  ).json();
  expect(detail.projectReview.base_branch).toBe(project.base_branch);
  expect(detail.projectReview.confirmed).toBe(false);
});

it("新增綁定也會作廢舊確認，但保留原本仍有綁定的目標", async () => {
  const task = await propose({ taskType: "change" });
  expect((await action(task)).statusCode).toBe(200);
  const other = await db.one<Project>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('新專案','test/new',true,now()) RETURNING *",
  );
  const response = await app.inject({
    method: "PUT",
    url: "/api/groups/group-a",
    headers,
    payload: {
      name: "測試群組",
      enabled: true,
      project_ids: [project.id, other.id],
    },
  });
  expect(response.statusCode).toBe(200);
  const detail = (
    await app.inject({ url: `/api/tasks/${task.id}`, headers })
  ).json();
  expect(detail.task).toMatchObject({
    project_id: project.id,
    status: "awaiting_approval",
    approved_version: null,
  });
  expect(detail.projectReview.confirmed).toBe(false);
  expect((await action(task)).statusCode).toBe(409);
});

it("舊工作尚未完成清理時不能重新確認，清理完成後才能核准", async () => {
  const task = await propose({ taskType: "change" });
  await db.query(
    "INSERT INTO runs(task_id,version,model,deadline) VALUES($1,1,'測試模型',now()+interval '10 minutes')",
    [task.id],
  );
  const pending = await action(task);
  expect(pending.statusCode).toBe(409);
  expect(pending.json().error).toContain("清理");
  await db.query("UPDATE runs SET completed_at=now() WHERE task_id=$1", [
    task.id,
  ]);
  expect((await action(task)).statusCode).toBe(200);
});

it("升級只退回缺少有效確認的舊待執行任務，保留歷史與新確認且可重複遷移", async () => {
  const legacy = await propose({ taskType: "change" });
  await db.query(
    "UPDATE tasks SET status='queued',approved_version=version WHERE id=$1",
    [legacy.id],
  );
  const verified = await propose(
    { routing: { ...explicit(), evidence: [] } },
    [],
    "請查 test/repo 的機台欄位",
  );
  const history = await propose({ taskType: "change" });
  await db.query(
    "UPDATE tasks SET status='answered',mode='query',answer='舊版歷史報告' WHERE id=$1",
    [history.id],
  );
  await db.query(
    "DELETE FROM rag_migrations WHERE name='project_confirmation_v1'",
  );
  await db.migrate();
  const first = (
    await app.inject({ url: `/api/tasks/${legacy.id}`, headers })
  ).json();
  expect(first.task).toMatchObject({
    status: "awaiting_approval",
    approved_version: null,
    version: legacy.version + 1,
  });
  expect(
    (await app.inject({ url: `/api/tasks/${verified.id}`, headers })).json()
      .task.status,
  ).toBe("queued");
  expect(
    (await app.inject({ url: `/api/tasks/${history.id}`, headers })).json()
      .task,
  ).toMatchObject({ status: "answered", answer: "舊版歷史報告" });
  await db.migrate();
  expect(
    (await app.inject({ url: `/api/tasks/${legacy.id}`, headers })).json().task
      .version,
  ).toBe(first.task.version);
});
