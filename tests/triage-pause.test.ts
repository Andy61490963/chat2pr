import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({
    openaiKey: "fictional-openai",
    lineToken: "fictional-token",
    lineSecret: "fictional-secret",
    githubAppId: "fictional-app",
    githubPrivateKey: "fictional-private",
  }),
}));
import { db, reset, fixture, session, confirmTask } from "./helpers.js";
import { Database } from "../server/db.js";
import { buildApp } from "../server/app.js";
import { Triage } from "../server/triage.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import {
  Execution,
  type Runner,
  type PhaseResult,
} from "../server/execution.js";
import { Tasks } from "../server/tasks.js";
import { startJobs } from "../server/jobs.js";
import type { Task, TriageDecision } from "../shared/types.js";
beforeEach(reset);
afterAll(() => db.close());
const pause = (triage_paused = true) =>
  db.query("UPDATE settings SET value=value || $1::jsonb", [
    JSON.stringify({ triage_paused }),
  ]);
const settingBody = async () => ({
  ...(await db.settings()),
  paused: true,
  codex_model: null,
  triage_effort: "high",
  coding_effort: "medium",
});
async function incoming(app: Awaited<ReturnType<typeof buildApp>>) {
  const body = JSON.stringify({
    events: [
      {
        webhookEventId: "pause-event",
        type: "message",
        source: { type: "group", groupId: "group-a" },
        message: { id: "pause-source", type: "text", text: "請把按鈕改成綠色" },
      },
    ],
  });
  return app.inject({
    method: "POST",
    url: "/webhooks/line",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-line-signature": createHmac("sha256", "fictional-secret")
        .update(body)
        .digest("base64"),
    },
  });
}
const decision = (
  projectId: string,
  relatedTaskId: string | null = null,
): TriageDecision => ({
  kind: "request",
  projectId,
  title: "按鈕綠色",
  summary: "把按鈕改成綠色",
  acceptance: ["按鈕顯示綠色"],
  sourceIds: ["pause-source"],
  contextSourceIds: [],
  risks: [],
  missing: [],
  relatedTaskId,
  suggestions: [],
});
function triage(
  projectId: string,
  classify = vi.fn(async () => [decision(projectId)]),
) {
  const github = new GitHub();
  github.context = vi.fn(async () => ({
    branches: {names:["main"],defaultBranch:"main",truncated:false}, branchError: null,
    sha: "base",
    paths: [],
    files: {},
    truncated: false,
  }));
  return {
    classify,
    github,
    service: new Triage(db, { classify }, github, new Line(db), new Budget(db)),
  };
}
it("舊設定讀取預設false，兩次升級只補缺值且重開DB保留true", async () => {
  expect((await db.settings()).triage_paused).toBe(false);
  await db.migrate();
  await db.migrate();
  expect(
    (await db.one("SELECT value->'triage_paused' AS paused FROM settings"))
      .paused,
  ).toBe(false);
  await pause();
  await db.migrate();
  const reopened = new Database(db.pool.options.connectionString!);
  try {
    expect((await reopened.settings()).triage_paused).toBe(true);
  } finally {
    await reopened.close();
  }
});
it.each(["未登入", "非管理員"])("%s不能變更判讀暫停", async (kind) => {
  const app = await buildApp(db);
  try {
    const headers = kind === "非管理員" ? await session() : {};
    if (kind === "非管理員")
      await db.query("UPDATE sessions SET user_id='999'");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers,
          payload: { ...(await settingBody()), triage_paused: true },
        })
      ).statusCode,
    ).toBe(401);
    expect((await db.settings()).triage_paused).toBe(false);
  } finally {
    await app.close();
  }
});
it("管理員可開關；舊呼叫端省略欄位保留true", async () => {
  const app = await buildApp(db),
    headers = await session();
  try {
    const original = await settingBody();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers,
          payload: { ...original, triage_paused: true },
        })
      ).statusCode,
    ).toBe(200);
    const { triage_paused: _, ...legacy } = original;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers,
          payload: legacy,
        })
      ).statusCode,
    ).toBe(200);
    expect((await db.settings()).triage_paused).toBe(true);
    expect(
      (await app.inject({ method: "GET", url: "/api/state", headers })).json()
        .settings.triage_paused,
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings",
          headers,
          payload: { ...original, triage_paused: false },
        })
      ).statusCode,
    ).toBe(200);
    expect((await db.settings()).triage_paused).toBe(false);
  } finally {
    await app.close();
  }
});
it("暫停時真Webhook收訊但零判讀；恢復後處理原待判讀訊息", async () => {
  const project = await fixture(),
    app = await buildApp(db),
    s = triage(project);
  try {
    await pause();
    expect((await incoming(app)).statusCode).toBe(200);
    await s.service.process("group-a");
    expect(s.classify).not.toHaveBeenCalled();
    expect(s.github.context).not.toHaveBeenCalled();
    expect(
      await db.one(
        "SELECT text,processed FROM messages WHERE id='pause-source'",
      ),
    ).toEqual({ text: "請把按鈕改成綠色", processed: false });
    expect(await db.query("SELECT * FROM tasks")).toHaveLength(0);
    await pause(false);
    await s.service.process("group-a");
    expect(s.classify).toHaveBeenCalledTimes(1);
    expect((await db.one("SELECT status FROM tasks")).status).toBe("awaiting_approval");
  } finally {
    await app.close();
  }
});
it("等待專案上下文時啟用暫停，尚未開始的classifier不呼叫", async () => {
  const project = await fixture(),
    app = await buildApp(db),
    s = triage(project);
  try {
    await incoming(app);
    s.github.context = async () => {
      await pause();
      return { sha: "base", paths: [], files: {}, truncated: false, branches:{names:["main"],defaultBranch:"main",truncated:false}, branchError:null };
    };
    await expect(s.service.process("group-a")).rejects.toThrow("設定已改變");
    expect(s.classify).not.toHaveBeenCalled();
    expect((await db.one("SELECT processed FROM messages")).processed).toBe(
      false,
    );
  } finally {
    await app.close();
  }
});
it.each(["新需求", "修改既有", "暫停再恢復"])(
  "判讀中%s的晚到結果不建立或修改任務",
  async (kind) => {
    const project = await fixture(),
      app = await buildApp(db);
    try {
      await incoming(app);
      let previous: Task | undefined;
      if (kind === "修改既有")
        previous = await db.one<Task>(
          "INSERT INTO tasks(group_id,project_id,title,summary,dedupe_key) VALUES('group-a',$1,'舊任務','舊摘要','old') RETURNING *",
          [project],
        );
      const classify = vi.fn(async () => {
        await pause();
        if (kind === "暫停再恢復") await pause(false);
        return [decision(project, previous?.id ?? null)];
      });
      await expect(
        triage(project, classify).service.process("group-a"),
      ).rejects.toThrow("設定已改變");
      expect(classify).toHaveBeenCalledTimes(1);
      const tasks = await db.query<Task>("SELECT * FROM tasks");
      expect(tasks).toHaveLength(previous ? 1 : 0);
      if (previous)
        expect(tasks[0]).toMatchObject({
          id: previous.id,
          summary: "舊摘要",
          version: 1,
          status: "awaiting_approval",
          approved_version: null,
        });
      expect((await db.one("SELECT processed FROM messages")).processed).toBe(
        false,
      );
      expect(
        (await db.one("SELECT triage_failures FROM groups")).triage_failures,
      ).toBe(0);
    } finally {
      await app.close();
    }
  },
);
async function approvedExecution() {
  const project = await fixture();
  const task = await db.one<Task>(
    "INSERT INTO tasks(group_id,project_id,title,summary,acceptance,status,approved_version,dedupe_key) VALUES('group-a',$1,'綠色按鈕','把按鈕改為綠色','[\"按鈕綠色\"]','failed',1,'approved') RETURNING *",
    [project],
  );
  const github = new GitHub();
  await confirmTask(task.id);
  github.base = async () => "fixed-base";
  github.archive = async () => new Blob(["fixture"]).stream();
  github.ensureIssue = async () => ({
    number: 1,
    url: "https://example.invalid/issue",
  });
  github.findPr = async () => undefined!;
  const publish = vi.fn(async (_p, _t, _f, _r, guard) => {
    await guard?.();
    return { number: 2, html_url: "https://example.invalid/pr" } as Awaited<
      ReturnType<GitHub["publish"]>
    >;
  });
  github.publish = publish;
  const call = vi.fn(async <T>(path: string, body: unknown): Promise<T> => {
    const b = body as { phase: string };
    const r: PhaseResult = { exitCode: 0, stdout: "", stderr: "" };
    if (path === "phase" && b.phase === "collect")
      r.stdout = JSON.stringify({
        files: [{ path: "src/button.ts", content: "YQ==", mode: "100644" }],
      });
    if (path === "phase" && b.phase === "review")
      r.stdout = JSON.stringify({
        final: JSON.stringify({ passed: true, findings: [] }),
      });
    return r as T;
  });
  const runner: Runner = {
    upload: async () => {},
    call: async <T>(path: string, body: unknown) =>
      (await call(path, body)) as T,
  };
  return {
    task,
    runner,
    github,
    publish,
    call,
    execution: new Execution(db, github, new Line(db), new Budget(db), runner),
  };
}
it("判讀暫停後已核准v1可經管理API重試並完成原Execution守門", async () => {
  const s = await approvedExecution(),
    app = await buildApp(db);
  try {
    await pause();
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${s.task.id}/actions`,
      headers: await session(),
      payload: { action: "retry", version: 1 },
    });
    expect(response.statusCode).toBe(200);
    await s.execution.execute(s.task.id);
    expect(s.publish).toHaveBeenCalledTimes(1);
    expect(
      await db.one("SELECT * FROM tasks WHERE id=$1", [s.task.id]),
    ).toMatchObject({ status: "ready", version: 1, approved_version: 1 });
    const phases = s.call.mock.calls
      .filter(([path]) => path === "phase")
      .map(([, b]) => (b as { phase: string }).phase);
    expect(phases).toContain("code");
    expect(phases).toContain("test");
    expect(phases).toContain("review");
  } finally {
    await app.close();
  }
});
it("判讀暫停不解除原核准版本要求", async () => {
  const s = await approvedExecution();
  await pause();
  await db.query("UPDATE tasks SET approved_version=NULL WHERE id=$1", [
    s.task.id,
  ]);
  await expect(
    new Tasks(db).action(s.task.id, "retry", 1, "管理員"),
  ).rejects.toThrow("尚未核准");
  expect(s.call).not.toHaveBeenCalled();
});
it("全域暫停優先阻擋已核准任務與判讀", async () => {
  const s = await approvedExecution();
  await pause();
  await new Tasks(db).action(s.task.id, "retry", 1, "管理員");
  await db.query("UPDATE settings SET value=value||'{\"paused\":true}'::jsonb");
  await s.execution.execute(s.task.id);
  expect(s.call).not.toHaveBeenCalled();
  expect(s.publish).not.toHaveBeenCalled();
  expect((await db.one("SELECT status FROM tasks")).status).toBe("queued");
});
it("真持久佇列略過判讀但仍排已核准執行與收圖工作", async () => {
  const s = await approvedExecution();
  await pause();
  await new Tasks(db).action(s.task.id, "retry", 1, "管理員");
  await db.query(
    "UPDATE tasks SET issue_number=1,issue_version=version WHERE id=$1",
    [s.task.id],
  );
  await db.query(
    "UPDATE groups SET first_pending_at=now()-interval '6 minutes',last_pending_at=now()-interval '2 minutes'",
  );
  await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  vi.stubEnv("DATABASE_URL", db.pool.options.connectionString!);
  let jobs: Awaited<ReturnType<typeof startJobs>> | undefined;
  try {
    jobs = await startJobs(db, { runner: s.runner, github: s.github });
    const queued = await db.query<{ name: string }>(
      "SELECT name FROM pgboss.job",
    );
    expect(queued.some((j) => j.name === "triage")).toBe(false);
    expect(queued.some((j) => j.name === "execute")).toBe(true);
    expect(queued.some((j) => j.name === "images")).toBe(true);
  } finally {
    await jobs?.stop();
    vi.unstubAllEnvs();
  }
});
