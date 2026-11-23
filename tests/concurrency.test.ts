import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, reset, fixture, confirmTask, session } from "./helpers.js";
import { Execution, type Runner } from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { recoverInterrupted, startJobs } from "../server/jobs.js";
import {
  checkHostResources,
  hostHealthName,
  hostHold,
  memoryHold,
  suggestedMaxRuns,
} from "../server/capacity.js";
import { subscriptionGateName } from "../server/subscription-gate.js";
import type { Capacity, TaskQueue } from "../shared/capacity.js";
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
    github,
    runner,
    budget,
    line,
    execution: new Execution(db, github, line, budget, runner),
    started,
    /** 放行所有停住的開發階段，之後的執行不再停。 */
    release,
  };
}

it("佇列保留待領工作，調高上限時可先處理另一專案，空位釋出後接續派工", async () => {
  const h = await harness(2);
  await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  await db.query(`UPDATE settings SET value=value||'{"max_runs":1,"daily_budget":100}'::jsonb`);
  const first = await task(h.projects[0]);
  const second = await task(h.projects[0]);
  const third = await task(h.projects[0]);
  const other = await task(h.projects[1]);
  const ids = [first.id, second.id, third.id, other.id];
  vi.stubEnv("DATABASE_URL", db.pool.options.connectionString!);
  let jobs: Awaited<ReturnType<typeof startJobs>> | undefined;
  try {
    jobs = await startJobs(db, { github: h.github, runner: h.runner });
    await until(() => h.started.length === 1);
    expect((await activeRuns()).map((r) => r.task_id)).toEqual([first.id]);
    const pending = () => db.query<{ id: string }>(
      "SELECT data->>'taskId' AS id FROM pgboss.job WHERE name='execute' AND state='created'",
    );
    expect((await pending()).map((j) => j.id).sort()).toEqual(ids.slice(1).sort());
    await db.query("UPDATE tasks SET updated_at=now()-interval '2 minutes' WHERE id=$1", [second.id]);
    await db.query(`UPDATE settings SET value=value||'{"max_runs":2}'::jsonb`);
    await until(() => h.started.length === 2);
    expect((await activeRuns()).map((r) => r.task_id).sort()).toEqual([first.id, other.id].sort());
    await until(async () => (await db.query("SELECT 1 FROM notifications WHERE kind='group_waiting' AND task_id=$1", [second.id])).length === 1);
    h.release();
    await until(async () => (await db.query("SELECT 1 FROM tasks WHERE id=ANY($1) AND status='ready'", [ids])).length === 4, 6000);
    expect(await db.query("SELECT 1 FROM runs WHERE task_id=ANY($1)", [ids])).toHaveLength(4);
    expect(await db.query("SELECT 1 FROM pgboss.job WHERE name='execute'")).toHaveLength(4);
  } finally {
    h.release();
    await jobs?.stop();
    vi.unstubAllEnvs();
  }
}, 35000);

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

const hostReading = (memFreeMb: number) =>
  checkHostResources(db, async () => ({
    cpus: 8,
    memTotalMb: 16384,
    memFreeMb,
  }));
const notices = (kind: string) =>
  db.query<{ text: string }>("SELECT text FROM notifications WHERE kind=$1", [
    kind,
  ]);
const clearHostHealth = () =>
  db.query("DELETE FROM service_health WHERE name=$1", [hostHealthName]);

it("記憶體暫停判斷有遲滯：低於 2 GB 才暫停，暫停中要回升到 2.5 GB 以上才恢復", () => {
  const r = (memFreeMb: number) => ({ cpus: 8, memTotalMb: 16384, memFreeMb });
  expect(memoryHold(r(1900))).toBe(
    "Windows 主機可用記憶體只剩 1.9 GB（低於 2 GB），暫停派新工作，回升到 2.5 GB 以上才恢復；執行中的工作不受影響",
  );
  expect(memoryHold(r(2100))).toBeNull();
  expect(memoryHold(r(2100), true)).toBe(
    "Windows 主機可用記憶體 2.1 GB，尚未回升到 2.5 GB，仍暫停派新工作；執行中的工作不受影響",
  );
  expect(memoryHold(r(2559), true)).not.toBeNull();
  expect(memoryHold(r(2560), true)).toBeNull();
});

it("主機記憶體在 2 GB 上下徘徊時只通知一次異常；回升到 2.5 GB 以上連續兩次才通知恢復", async () => {
  const h = await harness(1);
  const t = await task(h.projects[0], "query");
  await clearHostHealth();
  try {
    expect(await hostReading(8192)).toBeNull();
    for (const mb of [1900, 2100, 1900, 2100, 2200])
      expect(await hostReading(mb)).toContain("暫停派新工作");
    const down = await notices("service_down");
    expect(down).toHaveLength(1);
    expect(down[0].text).toContain("主機資源");
    expect(await notices("service_up")).toHaveLength(0);
    // 2.1、2.2 GB 仍在遲滯區間，派工維持暫停。
    expect(await hostHold(db.pool)).toContain("尚未回升到 2.5 GB");
    await h.execution.execute(t.id);
    expect(await status(t.id)).toBe("queued");
    expect(await activeRuns()).toHaveLength(0);
    expect(await hostReading(2600)).toBeNull();
    expect(await hostReading(2600)).toBeNull();
    expect(await notices("service_up")).toHaveLength(1);
    expect(await notices("service_down")).toHaveLength(1);
    h.release();
    await h.execution.execute(t.id);
    expect(await status(t.id)).toBe("answered");
  } finally {
    await clearHostHealth();
  }
});

it("低記憶體時暫時讀不到資源不擋派工，也不算恢復、不通知；之後仍沿用恢復門檻", async () => {
  await clearHostHealth();
  try {
    await hostReading(8192);
    await hostReading(1900);
    await hostReading(1900);
    expect(await notices("service_down")).toHaveLength(1);
    expect(
      await checkHostResources(db, async () => {
        throw new Error("執行器暫時無回應");
      }),
    ).toBeNull();
    expect(await hostHold(db.pool)).toBeNull();
    expect(await hostReading(1900)).toContain("暫停派新工作");
    expect(await hostReading(2100)).toContain("尚未回升到 2.5 GB");
    expect(await notices("service_up")).toHaveLength(0);
    expect(await notices("service_down")).toHaveLength(1);
  } finally {
    await clearHostHealth();
  }
});

// 項目 21：讀不到資源的 silent 會把 ok 寫成正常；連續判斷要比對上一次真實讀數，不能被它湊成第二次。
it("已通知異常後中間讀不到一次，下一次單一的正常讀數不算恢復，再一次才通知", async () => {
  const unreadable = () =>
    checkHostResources(db, async () => {
      throw new Error("執行器暫時無回應");
    });
  await clearHostHealth();
  try {
    await hostReading(8192);
    await hostReading(1900);
    await hostReading(1900);
    expect(await notices("service_down")).toHaveLength(1);
    expect(await unreadable()).toBeNull();
    expect(await hostReading(2600)).toBeNull();
    expect(await notices("service_up")).toHaveLength(0);
    expect(await hostReading(2600)).toBeNull();
    const up = await notices("service_up");
    expect(up).toHaveLength(1);
    expect(up[0].text).toBe("服務已恢復：主機資源");

    // 轉異常同樣要連續兩次真實讀數：單一次低讀數不通知，中間夾一次正常讀數就重新計算。
    expect(await hostReading(1900)).toContain("暫停派新工作");
    expect(await notices("service_down")).toHaveLength(1);
    expect(await hostReading(8192)).toBeNull();
    expect(await hostReading(1900)).toContain("暫停派新工作");
    expect(await notices("service_down")).toHaveLength(1);
    // silent 不算一次正常讀數：前後兩次低讀數仍是連續兩次。
    expect(await unreadable()).toBeNull();
    expect(await notices("service_down")).toHaveLength(1);
    expect(await hostReading(1900)).toContain("暫停派新工作");
    expect(await notices("service_down")).toHaveLength(2);
    expect(await notices("service_up")).toHaveLength(1);
  } finally {
    await clearHostHealth();
  }
});

it("只有真實讀數會更新 reading_ok，silent 只改目前狀態", async () => {
  await clearHostHealth();
  try {
    await hostReading(1900);
    const row = () =>
      db.one<{ ok: boolean; reading_ok: boolean | null }>(
        "SELECT ok,reading_ok FROM service_health WHERE name=$1",
        [hostHealthName],
      );
    expect(await row()).toEqual({ ok: false, reading_ok: false });
    await checkHostResources(db, async () => null);
    expect(await row()).toEqual({ ok: true, reading_ok: false });
  } finally {
    await clearHostHealth();
  }
});

// 欄位新增前的舊列沒有 reading_ok，ok 可能正是 silent 寫的「正常」：部署後第一次正常讀數也不能直接算恢復。
it("沒有 reading_ok 的舊列：已通知異常時，單一次正常讀數不通知，再一次才通知", async () => {
  await clearHostHealth();
  try {
    await db.query(
      "INSERT INTO service_health(name,ok,detail,notified_ok) VALUES($1,true,'暫時讀不到主機資源',false)",
      [hostHealthName],
    );
    expect(await hostReading(2600)).toBeNull();
    expect(await notices("service_up")).toHaveLength(0);
    expect(await hostReading(2600)).toBeNull();
    expect(await notices("service_up")).toHaveLength(1);
  } finally {
    await clearHostHealth();
  }
});

it("主機記憶體不足暫停時，系統頁回傳 holdKind 與排隊原因，任務詳情說明原因", async () => {
  const h = await harness(1);
  const t = await task(h.projects[0], "query");
  await clearHostHealth();
  await hostReading(1500);
  await hostReading(1500);
  const { buildApp } = await import("../server/app.js");
  const app = await buildApp(db, undefined, undefined, undefined, {
    call: async <T>(path: string) =>
      (path === "resources"
        ? {
            cpus: 8,
            memTotalMb: 16384,
            memFreeMb: 1500,
            dockerCpus: 8,
            dockerMemMb: 7990,
          }
        : {}) as T,
  });
  try {
    const headers = await session();
    const view = (
      await app.inject({ url: "/api/capacity", headers })
    ).json<Capacity>();
    expect(view.holdKind).toBe("memory");
    expect(view.hold).toContain("Windows 主機可用記憶體只剩 1.5 GB");
    expect(view.hold).toContain("回升到 2.5 GB 以上才恢復");
    expect(view.queued.map((q) => [q.id, q.code, q.reason])).toEqual([
      [t.id, "memory", "主機記憶體不足，暫停派工中"],
    ]);
    const detail = (
      await app.inject({ url: `/api/tasks/${t.id}`, headers })
    ).json<{ queue: TaskQueue }>();
    expect(detail.queue).toMatchObject({
      code: "memory",
      text: "主機記憶體不足，暫停派工中",
      position: 1,
    });
  } finally {
    await app.close();
    await clearHostHealth();
  }
});

it("專案停用、驗證未通過、群組停用與退避中的任務顯示原因，不佔空位也不標為即將開始", async () => {
  const h = await harness(3);
  const [disabled, unvalidated, retrying] = h.projects;
  // 另一個群組綁定自己的虛構專案，之後由管理者停用群組。
  const other = await db.one<{ id: string }>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('虛構專案 乙群','example-org/demo-group-b',true,now()) RETURNING id",
  );
  await db.query(
    "INSERT INTO groups(id,name,enabled,trigger_mode) VALUES('group-b','虛構群組乙',true,'auto')",
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('group-b',$1)",
    [other.id],
  );
  const a = await task(disabled),
    b = await task(unvalidated);
  const c = await db.one<Task>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key,mode) VALUES($1,'group-b','乙群任務','虛構需求','[\"完成\"]','queued',1,'concurrency-group-b','query') RETURNING *",
    [other.id],
  );
  await confirmTask(c.id);
  const d = await task(retrying, "query"),
    e = await task(retrying, "query");
  const { buildApp } = await import("../server/app.js");
  const app = await buildApp(db, undefined, undefined, undefined, {
    call: async <T>() => ({}) as T,
  });
  try {
    const headers = await session();
    // 管理者在專案頁只取消「啟用」，其他設定不變（不會讓已確認的任務失效）。
    const row = await db.one<Record<string, unknown>>(
      "SELECT name,repo,description,base_branch,image,install_command,test_command,sensitive_paths FROM projects WHERE id=$1",
      [disabled],
    );
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${disabled}`,
      headers,
      payload: { ...row, enabled: false },
    });
    expect(put.statusCode).toBe(200);
    await db.query(
      "UPDATE projects SET validated_at=NULL,validation_error='虛構的驗證錯誤：找不到 package.json' WHERE id=$1",
      [unvalidated],
    );
    const group = await app.inject({
      method: "PUT",
      url: "/api/groups/group-b",
      headers,
      payload: { name: "虛構群組乙", project_ids: [other.id], enabled: false },
    });
    expect(group.statusCode).toBe(200);
    await db.query(
      "UPDATE tasks SET retry_at=now()+interval '10 minutes' WHERE id=$1",
      [d.id],
    );
    // 這些任務仍在排隊，沒有被退回待審核。
    for (const t of [a, b, c, d, e]) expect(await status(t.id)).toBe("queued");
    const view = (
      await app.inject({ url: "/api/capacity", headers })
    ).json<Capacity>();
    expect(view.holdKind).toBeNull();
    const byId = Object.fromEntries(view.queued.map((q) => [q.id, q]));
    expect(byId[a.id]).toMatchObject({
      code: "project",
      reason: "專案已停用",
      hint: "到專案頁重新啟用",
    });
    expect(byId[b.id]).toMatchObject({
      code: "project",
      reason: "專案驗證未通過：虛構的驗證錯誤：找不到 package.json",
      hint: "到專案頁重新驗證",
    });
    expect(byId[c.id]).toMatchObject({
      code: "group",
      reason: "群組已停用",
      hint: "到群組頁重新啟用",
    });
    expect(byId[d.id].code).toBe("retry");
    expect(byId[d.id].reason).toMatch(/^暫時性錯誤，約 \d{2}:\d{2} 自動重試$/);
    // 被擋住的任務不佔空位：只有最後一張沒有阻擋的任務是「即將開始」。
    expect(
      view.queued.filter((q) => q.code === "next").map((q) => q.id),
    ).toEqual([e.id]);
    const queueOf = async (id: string) =>
      (await app.inject({ url: `/api/tasks/${id}`, headers })).json<{
        queue: TaskQueue;
      }>().queue;
    expect((await queueOf(a.id)).code).toBe("project");
    expect((await queueOf(b.id)).code).toBe("project");
    expect((await queueOf(c.id)).code).toBe("group");
    const retry = await queueOf(d.id);
    expect(retry.code).toBe("retry");
    expect(retry.retry_at).not.toBeNull();
    expect(await queueOf(e.id)).toMatchObject({
      code: "next",
      text: "即將開始",
      position: 5,
    });
  } finally {
    await app.close();
  }
});

it("磁碟空間不足的暫停派工（#28）開啟時，並行派工也一起停，看板顯示原因", async () => {
  const h = await harness(2);
  const a = await task(h.projects[0]),
    b = await task(h.projects[1], "query");
  await db.query(
    "UPDATE docker_disk SET settings='{\"pause_enabled\":true}',level='critical',checked_at=now() WHERE id=1",
  );
  try {
    await Promise.all([h.execution.execute(a.id), h.execution.execute(b.id)]);
    expect(await activeRuns()).toHaveLength(0);
    expect([await status(a.id), await status(b.id)]).toEqual([
      "queued",
      "queued",
    ]);
    const { buildApp } = await import("../server/app.js");
    const app = await buildApp(db, undefined, undefined, undefined, {
      call: async <T>() => ({}) as T,
    });
    try {
      const view = (
        await app.inject({ url: "/api/capacity", headers: await session() })
      ).json<Capacity>();
      expect(view.hold).toContain("磁碟空間嚴重不足");
      expect(view.holdKind).toBe("disk");
      expect(view.queued.map((q) => [q.code, q.reason])).toEqual([
        ["disk", "Docker 磁碟不足，暫停派工中"],
        ["disk", "Docker 磁碟不足，暫停派工中"],
      ]);
    } finally {
      await app.close();
    }
  } finally {
    await db.query(
      "UPDATE docker_disk SET settings='{}',level='unknown',checked_at=NULL WHERE id=1",
    );
  }
  h.release();
  await Promise.all([h.execution.execute(a.id), h.execution.execute(b.id)]);
  expect([await status(a.id), await status(b.id)]).toEqual([
    "ready",
    "answered",
  ]);
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
    expect(view).toMatchObject({
      maxRuns: 2,
      suggested: 4,
      hold: null,
      holdKind: null,
      memoryFloorMb: 2048,
      memoryResumeMb: 2560,
    });
    expect(view.running.map((r) => r.id)).toEqual([first.id]);
    expect(view.queued.map((q) => [q.id, q.code, q.reason])).toEqual([
      [second.id, "changing", "同專案的修改進行中"],
      [other.id, "next", "即將開始"],
    ]);
    // 任務詳情回傳同一套排隊原因。
    const detail = (
      await app.inject({ url: `/api/tasks/${second.id}`, headers })
    ).json<{ queue: TaskQueue }>();
    expect(detail.queue).toMatchObject({
      code: "changing",
      text: "同專案的修改進行中",
      position: 1,
      retry_at: null,
    });
    // 不在排隊中的任務沒有排隊資訊。
    expect(
      (await app.inject({ url: `/api/tasks/${first.id}`, headers })).json()
        .queue,
    ).toBeNull();
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
