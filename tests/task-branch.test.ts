import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { GitHub, BranchUnavailable } from "../server/github.js";
import { Triage } from "../server/triage.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { db, reset, fixture, session } from "./helpers.js";
import type {
  Project,
  Task,
  TriageDecision,
  Group,
  Message,
} from "../shared/types.js";
import type { BranchDecision } from "../shared/task-branch.js";

let app: Awaited<ReturnType<typeof buildApp>>,
  headers: Awaited<ReturnType<typeof session>>,
  project: Project;
const catalog = {
  names: ["main", "develop", "release/2026", "修正/機台欄位"],
  defaultBranch: "develop",
  truncated: false,
};
beforeEach(async () => {
  await reset();
  const id = await fixture();
  project = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [id]);
  headers = await session();
  app = await buildApp(db);
  vi.spyOn(GitHub.prototype, "branches").mockResolvedValue(catalog);
  vi.spyOn(GitHub.prototype, "base").mockImplementation(async (p) => {
    if (!catalog.names.includes(p.base_branch))
      throw new BranchUnavailable(p.base_branch);
    return "a".repeat(40);
  });
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});
afterAll(() => db.close());
async function task() {
  return db.one<Task>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,dedupe_key) VALUES($1,'group-a','確認機台欄位','調整機台提示文字','[\"顯示正確提示\"]',$2) RETURNING *",
    [project.id, randomUUID()],
  );
}
async function detail(id: string) {
  return (await app.inject({ url: `/api/tasks/${id}`, headers })).json();
}
async function action(
  t: Task,
  action: string,
  extra: Record<string, unknown> = {},
) {
  const d = await detail(t.id);
  return app.inject({
    method: "POST",
    url: `/api/tasks/${t.id}/actions`,
    headers,
    payload: {
      action,
      version: t.version,
      project_id: t.project_id,
      target_branch: d.task.target_branch,
      binding_version: d.projectReview.binding_version,
      config_version: d.projectReview.config_version,
      ...extra,
    },
  });
}
async function propose(
  text: string,
  branch?: Partial<BranchDecision>,
  mode: "query" | "change" = "query",
  repoEvidence = false,
) {
  const id = randomUUID();
  await new Line(db).ingest({
    events: [
      {
        webhookEventId: randomUUID(),
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { type: "text", id, text },
      },
    ],
  });
  const d: TriageDecision = {
    kind: "request",
    projectId: project.id,
    taskType: mode,
    title: "確認欄位用途",
    summary: text,
    acceptance: ["解釋欄位用途及資料來源"],
    sourceIds: [id],
    risks: [],
    missing: [],
    suggestions: [],
    relatedTaskId: null,
    routing: {
      status: "clear",
      basis: repoEvidence ? "repository" : "explicit",
      reason: "本次唯一專案依據",
      evidence: [
        repoEvidence
          ? {
              kind: "repo",
              sourceId: "repo-evidence",
              quote: "機台代碼用於讀取設備並對應生產機台編號",
            }
          : { kind: "message", sourceId: id, quote: text },
      ],
    },
    ...(branch
      ? {
          targetBranch: {
            name: "develop",
            basis: "explicit",
            reason: "需求指名 develop",
            evidence: [{ sourceId: id, quote: text }],
            ...branch,
          },
        }
      : {}),
  };
  await new Triage(
    db,
    { classify: async () => [] },
    new GitHub(),
    new Line(db),
    new Budget(db),
  ).apply(
    await db.one<Group>("SELECT * FROM groups WHERE id='group-a'"),
    [project],
    await db.query<Message>("SELECT * FROM messages WHERE id=$1", [id]),
    [d],
    randomUUID(),
    [],
    undefined,
    [],
    undefined,
    repoEvidence
      ? [
          {
            id: "repo-evidence",
            projectId: project.id,
            sha: "default-sha",
            path: "src/machine.cs",
            text: "機台代碼用於讀取設備並對應生產機台編號",
          },
        ]
      : [],
    { [project.id]: catalog },
  );
  return db.one<Task>("SELECT * FROM tasks WHERE $1=ANY(source_ids)", [id]);
}

it("分支清單需登入並包含 GitHub 與專案各自的預設分支", async () => {
  const t = await task();
  expect(
    (await app.inject({ url: `/api/tasks/${t.id}/branches` })).statusCode,
  ).toBe(401);
  const response = await app.inject({
    url: `/api/tasks/${t.id}/branches`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toMatchObject({
    configuredBranch: "main",
    defaultBranch: "develop",
    version: 1,
    names: catalog.names,
  });
});
it("同專案兩筆任務可分別確認 develop 與 release，不改動專案預設", async () => {
  const a = await task(),
    b = await task();
  const first = await action(a, "target", { target_branch: "develop" });
  const second = await action(b, "target", { target_branch: "release/2026" });
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(first.json()).toMatchObject({
    target_branch: "develop",
    version: 2,
    status: "awaiting_approval",
    approved_version: null,
  });
  expect((await action(first.json(), "approve")).statusCode).toBe(200);
  expect((await action(second.json(), "approve")).statusCode).toBe(200);
  expect((await detail(a.id)).projectReview.confirmation.target_branch).toBe(
    "develop",
  );
  expect((await detail(b.id)).projectReview.confirmation.target_branch).toBe(
    "release/2026",
  );
  expect(
    (await db.one<Project>("SELECT * FROM projects WHERE id=$1", [project.id]))
      .base_branch,
  ).toBe("main");
});
it("換分支作廢核准與舊工作資訊，舊頁面及未重新確認的重試不能派工", async () => {
  const t = await task();
  expect((await action(t, "approve")).statusCode).toBe(200);
  await db.query(
    "UPDATE tasks SET base_sha='old',branch='old-work',approved_paths='{src/a.ts}' WHERE id=$1",
    [t.id],
  );
  const changed = (
    await action(t, "target", { target_branch: "develop" })
  ).json() as Task;
  expect(changed).toMatchObject({
    base_sha: null,
    branch: null,
    approved_version: null,
    approved_paths: [],
    version: 2,
  });
  expect(
    (await action(t, "approve", { target_branch: "main" })).statusCode,
  ).toBe(409);
  expect(
    (await action(changed, "approve", { target_branch: "main" })).statusCode,
  ).toBe(409);
  await db.query("UPDATE tasks SET status='failed' WHERE id=$1", [t.id]);
  expect((await action(changed, "retry")).statusCode).toBe(409);
});
it.each(["missing", "../main", "main~1", "main.lock", "refs/tags/v1", ""])(
  "拒絕不存在或無效分支 %s，保留目前任務",
  async (name) => {
    const t = await task();
    const r = await action(t, "target", { target_branch: name });
    expect(r.statusCode).toBe(409);
    expect((await detail(t.id)).task).toMatchObject({
      version: 1,
      target_branch: "main",
    });
  },
);
it("清理中的工作不能更換分支，改選已移除綁定的專案也不提供分支清單", async () => {
  const t = await task();
  await db.query(
    "INSERT INTO runs(task_id,version,model,deadline) VALUES($1,1,'測試模型',now()+interval '10 minutes')",
    [t.id],
  );
  expect(
    (await action(t, "target", { target_branch: "develop" })).statusCode,
  ).toBe(409);
  await db.query("DELETE FROM group_projects WHERE group_id='group-a'");
  expect(
    (await app.inject({ url: `/api/tasks/${t.id}/branches`, headers }))
      .statusCode,
  ).toBe(409);
});
it("明確指名專案與存在的分支可自動查詢，同樣的修改仍待人工確認", async () => {
  const q = await propose("請查 test/repo 的develop分支，確認機台欄位用途", {});
  expect(q).toMatchObject({ target_branch: "develop", status: "queued" });
  expect((await detail(q.id)).projectReview.confirmation).toMatchObject({
    target_branch: "develop",
    kind: "evidence",
  });
  const c = await propose(
    "請修改 test/repo 的 develop 分支機台提示",
    {},
    "change",
  );
  expect(c).toMatchObject({
    target_branch: "develop",
    status: "awaiting_approval",
  });
});
it.each([
  ["請查 test/repo 的主線", { name: "main", basis: "default" }],
  ["請查 test/repo 的 develop 和 release/2026 分支", {}],
  ["請查 test/repo 的 missing 分支", { name: "missing" }],
  [
    "請查 test/repo 的 develop 分支",
    { evidence: [{ sourceId: "不存在", quote: "develop" }] },
  ],
  ["請查 test/repo 的 develop 分支", { name: "main", basis: "default" }],
] as const)("分支有疑點不會自動派工：%s", async (text, branch) => {
  const t = await propose(text, branch as Partial<BranchDecision>);
  expect(t.status).toBe("awaiting_approval");
});
it("預設分支檔案證據不能自動延伸到另一分支", async () => {
  const t = await propose("請查 develop 分支的機台代碼用途", {}, "query", true);
  expect(t.status).toBe("awaiting_approval");
  expect(t.branch_selection?.reason).toContain("候選程式證據");
});
it("專案預設不是 main 時新任務使用實際設定，未指定分支的查詢也不硬選 main", async () => {
  await db.query(
    "UPDATE projects SET base_branch='develop',config_version=config_version+1 WHERE id=$1",
    [project.id],
  );
  project = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [
    project.id,
  ]);
  const t = await propose("請查 test/repo 的機台欄位用途", {
    name: "develop",
    basis: "default",
    evidence: [],
  });
  expect(t).toMatchObject({ target_branch: "develop", status: "queued" });
});
it("分支升級不沿用舊確認，歷史已完成任務保持原樣且可重複遷移", async () => {
  const t = await task();
  expect((await action(t, "approve")).statusCode).toBe(200);
  await db.query(
    "UPDATE task_project_confirmations SET target_branch=NULL WHERE task_id=$1",
    [t.id],
  );
  const done = await task();
  await db.query(
    "UPDATE tasks SET status='answered',answer='歷史回答',target_branch=NULL WHERE id=$1",
    [done.id],
  );
  await db.query(
    "DELETE FROM rag_migrations WHERE name='task_target_branch_v1'",
  );
  await db.migrate();
  expect((await detail(t.id)).task).toMatchObject({
    status: "awaiting_approval",
    version: 2,
    approved_version: null,
    target_branch: "main",
  });
  expect((await detail(done.id)).task).toMatchObject({
    status: "answered",
    version: 1,
    answer: "歷史回答",
    target_branch: null,
  });
  await db.migrate();
  expect((await detail(t.id)).task.version).toBe(2);
});
it("向 GitHub 確認分支時不握著任務的鎖", async () => {
  const t = await task();
  let free = false;
  vi.spyOn(GitHub.prototype, "base").mockImplementation(async () => {
    // 交易若已鎖住任務，這裡會立刻失敗。
    await db.query("SELECT 1 FROM tasks WHERE id=$1 FOR UPDATE NOWAIT", [t.id]);
    free = true;
    return "a".repeat(40);
  });
  const r = await action(t, "target", { target_branch: "develop" });
  expect(r.statusCode).toBe(200);
  expect(free).toBe(true);
  expect(r.json()).toMatchObject({ target_branch: "develop", version: 2 });
});
it("確認分支後專案換了儲存庫，不採用先前的確認", async () => {
  const t = await task();
  vi.spyOn(GitHub.prototype, "base").mockImplementation(async () => {
    await db.query("UPDATE projects SET repo='test/moved' WHERE id=$1", [
      project.id,
    ]);
    return "a".repeat(40);
  });
  const r = await action(t, "target", { target_branch: "develop" });
  expect(r.statusCode).toBe(409);
  expect((await detail(t.id)).task).toMatchObject({
    version: 1,
    target_branch: "main",
  });
});
