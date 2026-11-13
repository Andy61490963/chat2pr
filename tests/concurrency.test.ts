import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { db, reset, fixture, confirmTask, session } from "./helpers.js";
import { Execution, type Runner } from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { recoverInterrupted } from "../server/jobs.js";
import {
  checkHostResources,
  hostHealthName,
  suggestedMaxRuns,
} from "../server/capacity.js";
import { subscriptionGateName } from "../server/subscription-gate.js";
import type { Capacity } from "../shared/capacity.js";
import type { Task, TaskMode } from "../shared/types.js";

beforeEach(reset);
// 失敗時也要放行停住的執行，避免拖住後面的測試與關閉連線。
let releaseAll = () => {};
afterEach(() => releaseAll());
afterAll(() => db.close());

let projects = 0;
/** 再建一個已驗證、綁定測試群組的虛構專案。 */
async function project() {
  const p = await db.one<{ id: string }>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES($1,$2,true,now()) RETURNING id",
    [`虛構專案 ${++projects}`, `example-org/demo-${projects}`],
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('group-a',$1)",
    [p.id],
  );
  return p.id;
}
let tasks = 0;
async function task(projectId: string, mode: TaskMode = "change") {
  const t = await db.one<Task>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key,mode) VALUES($1,'group-a',$2,'虛構需求','[\"完成\"]','queued',1,$3,$4) RETURNING *",
    [projectId, `任務 ${++tasks}`, `concurrency-${tasks}`, mode],
  );
  await confirmTask(t.id);
  return t;
}
const status = async (id: string) =>
  (await db.one<Task>("SELECT status FROM tasks WHERE id=$1", [id])).status;
const activeRuns = async () =>
  db.query<{ task_id: string }>(
    "SELECT task_id FROM runs WHERE completed_at IS NULL ORDER BY started_at",
  );
async function until(check: () => Promise<boolean> | boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("等待逾時");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * 可控的執行器：開發階段停住，直到測試放行，模擬「一張任務正在跑」。
 * 修改走完測試、收集、審查；查詢回傳答案。
 * 專案要在建立任務前全部綁好：綁定改變會讓已確認的任務失效。
 */
async function harness(count = 1) {
  const ids = [await fixture()];
  while (ids.length < count) ids.push(await project());
  const github = new GitHub();
  github.base = async () => "base-sha";
  github.archive = async () => new Blob(["archive"]).stream();
  github.ensureIssue = async () => ({
    number: 1,
    url: "https://github.com/example-org/demo/issues/1",
  });
  github.findPr = async () => undefined!;
  github.commentIssue = async () => undefined!;
  github.publish = async (_p, _t, _files, _report, guard) => {
    await guard?.();
    return {
      number: 2,
      html_url: "https://github.com/example-org/demo/pull/2",
    } as Awaited<ReturnType<GitHub["publish"]>>;
  };
  const started: string[] = [];
  const waiting = new Map<string, () => void>();
  let hold = true;
  const runner: Runner = {
    async upload() {},
    account: async () =>
      ({
        allowed: true,
        checkedAt: new Date().toISOString(),
      }) as Awaited<ReturnType<NonNullable<Runner["account"]>>>,
    async call<T>(path: string, raw: unknown): Promise<T> {
      const body = raw as {
        phase?: string;
        runId?: string;
        job?: { query?: boolean };
      };
      if (path !== "phase") return { exitCode: 0, stdout: "", stderr: "" } as T;
      if (body.phase === "code") {
        started.push(body.runId!);
        if (hold) await new Promise<void>((r) => waiting.set(body.runId!, r));
        if (body.job?.query)
          return {
            exitCode: 0,
            stdout: JSON.stringify({ final: "虛構查詢的答案。" }),
            stderr: "",
          } as T;
      }
      if (body.phase === "collect")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            files: [{ path: "src/demo.ts", content: "YQ==", mode: "100644" }],
          }),
          stderr: "",
        } as T;
      if (body.phase === "review")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            final: JSON.stringify({ passed: true, findings: [] }),
          }),
          stderr: "",
        } as T;
      return { exitCode: 0, stdout: "", stderr: "" } as T;
    },
  };
  const budget = new Budget(db),
    line = new Line(db);
  const release = () => {
    hold = false;
    for (const r of waiting.values()) r();
    waiting.clear();
  };
  releaseAll = release;
  return {
    projects: ids,
    runner,
    budget,
    line,
    execution: new Execution(db, github, line, budget, runner),
    started,
    /** 放行所有停住的開發階段，之後的執行不再停。 */
    release,
  };
}

it("上限 2：一張修改與另一個專案的查詢同時執行", async () => {
  const h = await harness(2);
  const change = await task(h.projects[0]);
  const query = await task(h.projects[1], "query");
  const runs = [h.execution.execute(change.id), h.execution.execute(query.id)];
  await until(() => h.started.length === 2);
  expect((await activeRuns()).map((r) => r.task_id).sort()).toEqual(
    [change.id, query.id].sort(),
  );
  h.release();
  await Promise.all(runs);
  expect(await status(change.id)).toBe("ready");
  expect(await status(query.id)).toBe("answered");
  expect(await activeRuns()).toHaveLength(0);
});

it("同一專案兩張修改不同時執行，第二張等第一張結束；同專案的查詢可以並行", async () => {
  const h = await harness(1);
  const p = h.projects[0];
  const first = await task(p),
    second = await task(p),
    query = await task(p, "query");
  const running = h.execution.execute(first.id);
  await until(() => h.started.length === 1);
  await h.execution.execute(second.id);
  expect(await status(second.id)).toBe("queued");
  const asking = h.execution.execute(query.id);
  await until(() => h.started.length === 2);
  expect((await activeRuns()).map((r) => r.task_id)).toEqual([
    first.id,
    query.id,
  ]);
  h.release();
  await Promise.all([running, asking]);
  expect(await status(first.id)).toBe("ready");
  await h.execution.execute(second.id);
  expect(await status(second.id)).toBe("ready");
  // 排隊期間沒有任何錯誤紀錄或失敗通知。
  expect(
    await db.query(
      "SELECT kind FROM audit WHERE task_id=$1 AND kind IN ('error','auto_retry')",
      [second.id],
    ),
  ).toHaveLength(0);
});

it("達到上限時新任務排隊，不產生錯誤；排隊超過一分鐘告訴群組排第幾", async () => {
  const h = await harness(3);
  const a = await task(h.projects[0]),
    b = await task(h.projects[1]),
    c = await task(h.projects[2], "query");
  const runs = [h.execution.execute(a.id), h.execution.execute(b.id)];
  await until(() => h.started.length === 2);
  for (let i = 0; i < 3; i++) await h.execution.execute(c.id);
  expect(await status(c.id)).toBe("queued");
  expect(await activeRuns()).toHaveLength(2);
  expect(
    await db.query(
      "SELECT 1 FROM audit WHERE task_id=$1 AND kind='error' UNION ALL SELECT 1 FROM notifications WHERE task_id=$1",
      [c.id],
    ),
  ).toHaveLength(0);
  // 剛排入時不打擾群組；等超過一分鐘才說明位置。
  await db.query(
    "UPDATE tasks SET updated_at=now()-interval '2 minutes' WHERE id=$1",
    [c.id],
  );
  await h.execution.execute(c.id);
  const [told] = await db.query<{ text: string }>(
    "SELECT text FROM notifications WHERE kind='group_waiting'",
  );
  expect(told.text).toBe(
    "目前有 2 件工作在處理，這件事排在第 1 位，輪到時會自動開始，不用重新提出。",
  );
  // 調高上限後立即可以開始。
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{max_runs}','3') WHERE id=1",
  );
  const third = h.execution.execute(c.id);
  await until(() => h.started.length === 3);
  h.release();
  await Promise.all([...runs, third]);
  expect(await status(c.id)).toBe("answered");
});

it("API 模式並行預留：四張任務同時開始，每日額度只夠兩張", async () => {
  const h = await harness(4);
  await db.query(
    `UPDATE settings SET value=value||'{"max_runs":8,"daily_budget":6,"task_budget":3}'::jsonb WHERE id=1`,
  );
  const list = [
    await task(h.projects[0]),
    await task(h.projects[1]),
    await task(h.projects[2], "query"),
    await task(h.projects[3], "query"),
  ];
  const runs = list.map((t) => h.execution.execute(t.id));
  await until(
    async () =>
      h.started.length === 2 &&
      (await db.query("SELECT 1 FROM tasks WHERE status='budget_wait'"))
        .length === 2,
  );
  const reserved = await db.one<{ total: string; n: number }>(
    "SELECT sum(amount)::text AS total,count(*)::int AS n FROM reservations WHERE NOT released",
  );
  expect(reserved).toEqual({ total: "6.000000", n: 2 });
  h.release();
  await Promise.all(runs);
  expect(
    (await db.query<{ status: string }>("SELECT status FROM tasks"))
      .map((t) => t.status)
      .filter((s) => s === "budget_wait"),
  ).toHaveLength(2);
});

it("訂閱模式並行：每日執行次數 2 時，四張同時開始只執行兩張", async () => {
  const h = await harness(4);
  await db.query(
    `UPDATE settings SET value=value||'{"max_runs":8,"ai_mode":"subscription","daily_runs":2}'::jsonb WHERE id=1`,
  );
  await db.query("DELETE FROM service_health WHERE name=$1", [
    subscriptionGateName,
  ]);
  const list = [
    await task(h.projects[0]),
    await task(h.projects[1]),
    await task(h.projects[2], "query"),
    await task(h.projects[3], "query"),
  ];
  const runs = list.map((t) => h.execution.execute(t.id));
  await until(
    async () =>
      h.started.length === 2 &&
      (await db.query("SELECT 1 FROM tasks WHERE status='budget_wait'"))
        .length === 2,
  );
  h.release();
  await Promise.all(runs);
  expect(
    (await db.one<{ n: number }>("SELECT count(*)::int AS n FROM runs")).n,
  ).toBe(2);
  expect(
    await db.query(
      "SELECT 1 FROM tasks WHERE status='budget_wait' AND last_error LIKE '%今日執行次數%'",
    ),
  ).toHaveLength(2);
});

it("回收中斷執行只處理沒有程序持有的紀錄，執行中的任務不受影響", async () => {
  const h = await harness(2);
  const live = await task(h.projects[0]);
  const orphan = await task(h.projects[1]);
  const running = h.execution.execute(live.id);
  await until(() => h.started.length === 1);
  await db.query("UPDATE tasks SET status='running' WHERE id=$1", [orphan.id]);
  await db.query(
    "INSERT INTO runs(task_id,version,model,deadline) VALUES($1,1,'gpt-6.1-sol',now()+interval '30 minutes')",
    [orphan.id],
  );
  await recoverInterrupted(db, h.runner, h.budget, h.line);
  expect(await status(orphan.id)).toBe("failed");
  expect(await status(live.id)).toBe("running");
  expect((await activeRuns()).map((r) => r.task_id)).toEqual([live.id]);
  h.release();
  await running;
  expect(await status(live.id)).toBe("ready");
});

it("主機可用記憶體不足時暫停派新工作，恢復後照常派工", async () => {
  const h = await harness(1);
  const t = await task(h.projects[0], "query");
  const low = await checkHostResources(db, async () => ({
    cpus: 8,
    memTotalMb: 16384,
    memFreeMb: 1024,
  }));
  expect(low).toContain("暫停派新工作");
  await h.execution.execute(t.id);
  expect(await status(t.id)).toBe("queued");
  expect(await activeRuns()).toHaveLength(0);
  // 讀不到資源不擋派工（每個容器仍有自己的上限）。
  expect(
    await checkHostResources(db, async () => {
      throw new Error("執行器暫時無回應");
    }),
  ).toBeNull();
  expect(
    await checkHostResources(db, async () => ({
      cpus: 8,
      memTotalMb: 16384,
      memFreeMb: 8192,
    })),
  ).toBeNull();
  expect(
    (
      await db.one<{ ok: boolean }>(
        "SELECT ok FROM service_health WHERE name=$1",
        [hostHealthName],
      )
    ).ok,
  ).toBe(true);
  h.release();
  await h.execution.execute(t.id);
  expect(await status(t.id)).toBe("answered");
});

it("依主機 CPU 與記憶體建議同時執行數", () => {
  expect(suggestedMaxRuns({ cpus: 8, memTotalMb: 16384, memFreeMb: 0 })).toBe(
    4,
  );
  // Docker 可用的資源（例如 WSL2 上限）優先。
  expect(
    suggestedMaxRuns({
      cpus: 16,
      memTotalMb: 65536,
      memFreeMb: 0,
      dockerCpus: 4,
      dockerMemMb: 8192,
    }),
  ).toBe(1);
  expect(suggestedMaxRuns({ cpus: 64, memTotalMb: 262144, memFreeMb: 0 })).toBe(
    8,
  );
});

it("看板顯示執行中與排隊順序，管理者可調整同時執行數", async () => {
  const h = await harness(2);
  const p = h.projects[0];
  const first = await task(p),
    second = await task(p),
    other = await task(h.projects[1], "query");
  const running = h.execution.execute(first.id);
  await until(() => h.started.length === 1);
  const { buildApp } = await import("../server/app.js");
  const app = await buildApp(db, undefined, undefined, undefined, {
    call: async <T>(path: string) =>
      (path === "resources"
        ? { cpus: 8, memTotalMb: 16384, memFreeMb: 8192 }
        : {}) as T,
  });
  try {
    const headers = await session();
    const view = (
      await app.inject({ url: "/api/capacity", headers })
    ).json<Capacity>();
    expect(view).toMatchObject({ maxRuns: 2, suggested: 4, hold: null });
    expect(view.running.map((r) => r.id)).toEqual([first.id]);
    expect(view.queued.map((q) => [q.id, q.reason])).toEqual([
      [second.id, "同專案的修改進行中"],
      [other.id, "即將開始"],
    ]);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/capacity",
          headers,
          payload: { max_runs: 0 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/capacity",
          headers,
          payload: { max_runs: 3 },
        })
      ).statusCode,
    ).toBe(200);
    expect((await db.settings()).max_runs).toBe(3);
    expect(
      (await app.inject({ method: "PUT", url: "/api/capacity" })).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    h.release();
    await running;
  }
});
