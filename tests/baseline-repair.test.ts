import { afterAll, beforeEach, expect, it } from "vitest";
import { db, reset, fixture, confirmTask } from "./helpers.js";
import {
  Execution,
  type PhaseResult,
  type Runner,
} from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { subscriptionGateName } from "../server/subscription-gate.js";
import type { Project, Task } from "../shared/types.js";
import { parseFailure } from "../shared/failure-text.js";
import { createBaselineRepair } from "../server/baseline.js";
import { buildApp } from "../server/app.js";
import { dashboardAction, session } from "./helpers.js";

beforeEach(reset);
afterAll(() => db.close());

// 虛構專案的 xUnit 測試輸出：兩個測試在修改前就失敗。
export const redBaseline: PhaseResult = {
  exitCode: 1,
  stdout: [
    "隔離測試服務已備妥；開始完整測試。",
    "[xUnit.net 00:00:02.10]     Demo.Shop.Tests.StockTests.Reserve_ShouldLock(rush: True) [FAIL]",
    "[xUnit.net 00:00:02.10]       Assert.Equal() Failure: Values differ",
    "[xUnit.net 00:00:02.10]       Stack Trace:",
    "[xUnit.net 00:00:02.20]     Demo.Shop.Tests.StockTests.Release_ShouldUnlock [FAIL]",
    "[xUnit.net 00:00:02.20]       System.InvalidOperationException : 找不到虛構庫存 B-002",
    "Failed!  - Failed:     2, Passed:    40, Skipped:     0, Total:    42",
  ].join("\n"),
  stderr:
    "    at command (file:///workspace/scripts/test.mjs:31:34)\n\nNode.js v24.0.0",
};

/** 自動設定的專案：驗證通過後派一筆修改；每次測試階段依序取 tests 的結果，用完後一律通過。 */
async function autoScenario(
  tests: PhaseResult[],
  opts: {
    path?: string;
    review?: { passed: boolean; findings: string[] };
  } = {},
) {
  const projectId = await fixture();
  const task = await db.one<Task>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key,target_branch) VALUES($1,'group-a','修正按鈕','按鈕顯示綠色','[\"顯示綠色\"]','queued',1,'one','main') RETURNING *",
    [projectId],
  );
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{ai_mode}','\"subscription\"')",
  );
  await db.query("DELETE FROM service_health WHERE name=$1", [
    subscriptionGateName,
  ]);
  await db.query(
    "UPDATE projects SET setup_mode='auto',validated_at=NULL,enabled=false,install_command='',test_command=''",
  );
  const github = new GitHub();
  let sha = "1111111aaaaaaaaa";
  github.base = async () => sha;
  github.archive = async () => new Blob(["archive"]).stream();
  github.ensureIssue = async () => ({
    number: 1,
    url: "https://github.com/test/repo/issues/1",
  });
  github.findPr = async () => undefined!;
  let published = 0;
  github.publish = async (_p, _t, _files, _report, guard) => {
    await guard?.();
    published++;
    return {
      number: 2,
      html_url: "https://github.com/test/repo/pull/2",
    } as Awaited<ReturnType<GitHub["publish"]>>;
  };
  github.setupContext = async () => ({
    files: { "package.json": '{"scripts":{"test":"vitest run"}}' },
    locks: [],
  });
  const queue = [...tests];
  let coded = 0,
    testCalls = 0,
    prompt = "",
    feedback = "";
  const runner: Runner = {
    async upload() {},
    account: async () => ({
      allowed: true,
      checkedAt: new Date().toISOString(),
    }),
    async call<T>(path: string, raw: unknown): Promise<T> {
      const body = raw as {
        phase?: string;
        job?: { prompt?: string; feedback?: string };
      };
      const ok: PhaseResult = { exitCode: 0, stdout: "", stderr: "" };
      if (path === "ai")
        return {
          ...ok,
          stdout: JSON.stringify({
            final: JSON.stringify({
              install: "npm ci",
              test: "npm test",
              verification: "tests",
              explanation: "依實際套件設定執行測試",
              evidence: [
                { path: "package.json", quote: '"test":"vitest run"' },
              ],
            }),
          }),
        } as T;
      if (path !== "phase") return ok as T;
      if (body.phase === "test") {
        testCalls++;
        return (queue.shift() ?? ok) as T;
      }
      if (body.phase === "code") {
        coded++;
        prompt = body.job?.prompt ?? "";
        feedback = body.job?.feedback ?? "";
      }
      if (body.phase === "collect")
        return {
          ...ok,
          stdout: JSON.stringify({
            files: coded
              ? [
                  {
                    path: opts.path ?? "src/stock.ts",
                    content: "YQ==",
                    mode: "100644",
                  },
                ]
              : [],
          }),
        } as T;
      if (body.phase === "review")
        return {
          ...ok,
          stdout: JSON.stringify({
            final: JSON.stringify(
              opts.review ?? { passed: true, findings: [] },
            ),
          }),
        } as T;
      return ok as T;
    },
  };
  const execution = new Execution(
    db,
    github,
    new Line(db),
    new Budget(db),
    runner,
  );
  await execution.validate(await db.one<Project>("SELECT * FROM projects"));
  // 驗證之後換了建置設定：派工不能沿用驗證結果，要先驗證新基底。
  github.setupContext = async () => ({
    files: {
      "package.json": '{"scripts":{"test":"vitest run"}}',
      "vitest.config.ts": "export default {};",
    },
    locks: [],
  });
  await confirmTask(task.id);
  return {
    task,
    github,
    execution,
    setSha: (next: string) => (sha = next),
    counts: () => ({ coded, testCalls, published, prompt, feedback }),
    reload: (id = task.id) =>
      db.one<Task>("SELECT * FROM tasks WHERE id=$1", [id]),
  };
}

it("基底驗證失敗：看板與群組列出失敗的測試名稱與錯誤訊息，不再只有統計數字", async () => {
  // 第一次是專案驗證（通過），第二次是派工的基底驗證（失敗）。
  const s = await autoScenario([
    { exitCode: 0, stdout: "", stderr: "" },
    redBaseline,
  ]);
  await s.execution.execute(s.task.id);
  const task = await s.reload();
  expect(task.status).toBe("failed");
  expect(s.counts().coded).toBe(0);
  const parsed = parseFailure(task.last_error)!;
  expect(parsed.plain).toBe("還沒修改前，目標分支本身就建置或測試失敗");
  expect(parsed.detail.split("\n").slice(0, 3)).toEqual([
    "失敗的測試（共 2 個）：",
    "1. Demo.Shop.Tests.StockTests.Reserve_ShouldLock(rush: True)：Assert.Equal() Failure: Values differ",
    "2. Demo.Shop.Tests.StockTests.Release_ShouldUnlock：System.InvalidOperationException : 找不到虛構庫存 B-002",
  ]);
  expect(parsed.detail).not.toContain("file:///");
  const group = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE task_id=$1 AND kind='group_failed'",
    [s.task.id],
  );
  expect(group!.text).toContain(
    "Demo.Shop.Tests.StockTests.Release_ShouldUnlock",
  );
  expect(group!.text).toContain("請 AI 修好目標分支");
});

it("Node 基底失敗時，看板、群組與待核准的修復任務沿用同一份測試清單", async () => {
  const s = await autoScenario([ok, {
    exitCode: 1, stdout: "TAP version 13\nnot ok 1 - 計算示範票數\n  ---\n  error: '票數應為五張'\n  ...\n1..1", stderr: "",
  }]);
  await s.execution.execute(s.task.id);
  const detail = parseFailure((await s.reload()).last_error)!.detail;
  expect(detail.split("\n").slice(0, 2)).toEqual(["失敗的測試（共 1 個）：", "1. 計算示範票數：票數應為五張"]);
  const group = await db.one<{ text: string }>("SELECT text FROM notifications WHERE task_id=$1 AND kind='group_failed'", [s.task.id]);
  expect(group.text).toContain(detail);
  const repair = await createBaselineRepair(db, s.task.id, "示範管理者");
  expect(repair.status).toBe("awaiting_approval");
  expect(repair.summary).toContain(detail);
});

it("有上次通過的紀錄：說明上次通過的短 SHA、之後的新 commit 數與比較連結", async () => {
  const s = await autoScenario([
    { exitCode: 0, stdout: "", stderr: "" },
    redBaseline,
  ]);
  s.setSha("2222222bbbbbbbbb");
  const compared: string[] = [];
  s.github.compareCommits = async (_p, base, head) => {
    compared.push(`${base}...${head}`);
    return {
      aheadBy: 3,
      url: "https://github.com/test/repo/compare/1111111aaaaaaaaa...2222222bbbbbbbbb",
    };
  };
  await s.execution.execute(s.task.id);
  expect(compared).toEqual(["1111111aaaaaaaaa...2222222bbbbbbbbb"]);
  const detail = parseFailure((await s.reload()).last_error)!.detail;
  expect(detail.split("\n").at(-1)).toBe(
    "上次通過是 1111111，之後目標分支有 3 個新 commit：https://github.com/test/repo/compare/1111111aaaaaaaaa...2222222bbbbbbbbb",
  );
  const group = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE task_id=$1 AND kind='group_failed'",
    [s.task.id],
  );
  expect(group!.text).toContain(
    "上次通過是 1111111，之後目標分支有 3 個新 commit",
  );
});

it("GitHub 比較失敗時仍說明上次通過的 commit 並附比較連結，只是不寫數量", async () => {
  const s = await autoScenario([
    { exitCode: 0, stdout: "", stderr: "" },
    redBaseline,
  ]);
  s.setSha("2222222bbbbbbbbb");
  s.github.compareCommits = async () => {
    throw new Error("HttpError: Not Found");
  };
  await s.execution.execute(s.task.id);
  const detail = parseFailure((await s.reload()).last_error)!.detail;
  expect(detail).toContain(
    "上次通過是 1111111，之後目標分支有新 commit：https://github.com/test/repo/compare/1111111aaaaaaaaa...2222222bbbbbbbbb",
  );
});

it("在同一個 commit 上次通過、這次失敗：提示可能是測試不穩定", async () => {
  const s = await autoScenario([
    { exitCode: 0, stdout: "", stderr: "" },
    redBaseline,
  ]);
  await s.execution.execute(s.task.id);
  expect(parseFailure((await s.reload()).last_error)!.detail).toContain(
    "上次在同一個 commit（1111111）通過",
  );
});

it("沒有上次通過的紀錄就不顯示這一段", async () => {
  const s = await autoScenario([
    { exitCode: 0, stdout: "", stderr: "" },
    redBaseline,
  ]);
  await db.query("DELETE FROM baseline_passes");
  await db.query(
    "UPDATE projects SET setup_plan=jsonb_set(setup_plan,'{branch}','\"release\"')",
  );
  s.setSha("2222222bbbbbbbbb");
  await s.execution.execute(s.task.id);
  const detail = parseFailure((await s.reload()).last_error)!.detail;
  expect(detail).toContain("失敗的測試（共 2 個）");
  expect(detail).not.toContain("上次");
});

it("派工前的基底驗證通過時記下這個 commit，之後的失敗以它為起點", async () => {
  const s = await autoScenario([]);
  s.setSha("2222222bbbbbbbbb");
  await s.execution.execute(s.task.id);
  expect((await s.reload()).status).toBe("ready");
  expect(await db.query("SELECT branch,sha FROM baseline_passes")).toEqual([
    { branch: "main", sha: "2222222bbbbbbbbb" },
  ]);
});

const ok: PhaseResult = { exitCode: 0, stdout: "", stderr: "" };
const redAfter: PhaseResult = {
  exitCode: 1,
  stdout:
    "[xUnit.net 00:00:02.10]     Demo.Shop.Tests.StockTests.Release_ShouldUnlock [FAIL]\n[xUnit.net 00:00:02.10]       仍找不到虛構庫存 B-002",
  stderr: "",
};

/** 一般任務先在紅基底失敗，再從它建立並核准修復任務；回傳修復任務。 */
async function repairFrom(s: Awaited<ReturnType<typeof autoScenario>>) {
  await s.execution.execute(s.task.id);
  expect((await s.reload()).status).toBe("failed");
  const repair = await createBaselineRepair(db, s.task.id, "小林");
  await dashboardAction(repair.id, "approve", repair.version);
  return repair;
}

it("一般任務在紅基底照舊被擋：不開發、不發布", async () => {
  const s = await autoScenario([ok, redBaseline]);
  await s.execution.execute(s.task.id);
  expect((await s.reload()).status).toBe("failed");
  expect(s.counts()).toMatchObject({ coded: 0, published: 0, testCalls: 2 });
});

it("目標分支修好後重試：改用最新的 commit 重新驗證基底，通過後照常開發與發布（#261）", async () => {
  const s = await autoScenario([ok, redBaseline]);
  await s.execution.execute(s.task.id);
  const failed = await s.reload();
  expect(failed.status).toBe("failed");
  expect(failed.last_error).toContain("目標分支本身就建置或測試失敗");
  // 修復 PR 合併後目標分支前進到新 commit，基底測試通過。
  s.setSha("3333333ccccccccc");
  await dashboardAction(s.task.id, "retry", failed.version);
  await s.execution.execute(s.task.id);
  const task = await s.reload();
  expect(task.status).toBe("ready");
  expect(task.base_sha).toBe("3333333ccccccccc");
  expect(s.counts()).toMatchObject({ coded: 1, published: 1, testCalls: 4 });
  const started = await db.query<{ detail: string }>(
    "SELECT detail FROM audit WHERE task_id=$1 AND kind='started' ORDER BY id",
    [s.task.id],
  );
  expect(started.map((a) => a.detail.slice(-8))).toEqual(["1111111a", "3333333c"]);
  expect(await db.query("SELECT branch,sha FROM baseline_passes")).toEqual([
    { branch: "main", sha: "3333333ccccccccc" },
  ]);
});

it("從基底失敗的任務建立修復任務：帶入失敗的測試，等人工核准，重複按只會有一筆", async () => {
  const s = await autoScenario([ok, redBaseline]);
  await s.execution.execute(s.task.id);
  const app = await buildApp(db);
  try {
    const headers = await session();
    const created = await app.inject({
      method: "POST",
      url: `/api/tasks/${s.task.id}/baseline-repair`,
      headers,
    });
    expect(created.statusCode).toBe(200);
    const repair = created.json() as Task;
    expect(repair).toMatchObject({
      status: "awaiting_approval",
      mode: "change",
      baseline_repair: true,
      target_branch: "main",
      approved_version: null,
      title: "修復目標分支 main",
    });
    expect(repair.summary).toContain(
      "Demo.Shop.Tests.StockTests.Release_ShouldUnlock",
    );
    expect(repair.acceptance[0]).toBe(
      "完整測試全部通過，包含修改前就失敗的測試",
    );
    const again = await app.inject({
      method: "POST",
      url: `/api/tasks/${s.task.id}/baseline-repair`,
      headers,
    });
    expect(again.json().id).toBe(repair.id);
    expect(
      await db.query(
        "SELECT kind FROM notifications WHERE task_id=$1 AND kind='approval'",
        [repair.id],
      ),
    ).toHaveLength(1);
    // 未核准前執行不會開始。
    await s.execution.execute(repair.id);
    expect(s.counts().coded).toBe(0);
  } finally {
    await app.close();
  }
});

it("不是基底驗證失敗的任務不能建立修復任務", async () => {
  const s = await autoScenario([ok, redBaseline]);
  await db.query("UPDATE tasks SET status='failed',last_error=$2 WHERE id=$1", [
    s.task.id,
    "專案問題：建置或測試失敗。\n建議：到執行紀錄查看測試輸出，修好專案的建置或測試後重試。",
  ]);
  await expect(createBaselineRepair(db, s.task.id, "小林")).rejects.toThrow(
    "只有因目標分支基底驗證失敗而停下的修改",
  );
});

it("修復任務可在紅基底開始，記下已知失敗清單；完整測試全過才進審查並開 PR", async () => {
  const s = await autoScenario([ok, redBaseline, redBaseline, ok]);
  const repair = await repairFrom(s);
  await s.execution.execute(repair.id);
  const done = await s.reload(repair.id);
  expect(done.status).toBe("ready");
  expect(s.counts()).toMatchObject({ coded: 1, published: 1 });
  const prompt = JSON.parse(s.counts().prompt);
  expect(prompt.baselineRepair.knownFailures).toContain(
    "Demo.Shop.Tests.StockTests.Release_ShouldUnlock",
  );
  expect(prompt.baselineRepair.rule).toContain(
    "不可刪除、略過、停用或放寬測試",
  );
  const known = await db.one<{ detail: string }>(
    "SELECT detail FROM audit WHERE task_id=$1 AND kind='baseline_known_failures'",
    [repair.id],
  );
  expect(known!.detail).toContain("已記下已知失敗清單");
});

it("修復任務結束時仍有測試失敗（包含原本就失敗的）：自動修復一次後仍失敗，不發布", async () => {
  const s = await autoScenario([
    ok,
    redBaseline,
    redBaseline,
    redAfter,
    redAfter,
  ]);
  const repair = await repairFrom(s);
  await s.execution.execute(repair.id);
  const done = await s.reload(repair.id);
  expect(done.status).toBe("failed");
  expect(parseFailure(done.last_error)!.plain).toBe(
    "AI 修改後，測試或獨立審查仍沒有通過",
  );
  expect(s.counts()).toMatchObject({ coded: 2, published: 0 });
});

it("修復任務的獨立審查照常：審查不通過就不發布", async () => {
  const s = await autoScenario([ok, redBaseline, redBaseline], {
    review: { passed: false, findings: ["刪除了失敗的測試，不是修好"] },
  });
  const repair = await repairFrom(s);
  await s.execution.execute(repair.id);
  const done = await s.reload(repair.id);
  expect(done.status).toBe("failed");
  expect(parseFailure(done.last_error)!.plain).toBe(
    "AI 修改後，測試或獨立審查仍沒有通過",
  );
  expect(s.counts()).toMatchObject({ coded: 2, published: 0 });
});

it("修復任務改到敏感路徑照常要人工核准", async () => {
  const s = await autoScenario([ok, redBaseline, redBaseline], {
    path: "server/auth.ts",
  });
  const repair = await repairFrom(s);
  await s.execution.execute(repair.id);
  const t = await s.reload(repair.id);
  expect(t.status).toBe("awaiting_approval");
  expect(t.pending_paths).toEqual(["server/auth.ts"]);
  expect(s.counts().published).toBe(0);
});

it("修復任務照常受每日執行次數限制", async () => {
  const s = await autoScenario([ok, redBaseline, redBaseline]);
  const repair = await repairFrom(s);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{daily_runs}',to_jsonb((SELECT count(*) FROM runs)::int))",
  );
  await s.execution.execute(repair.id);
  expect((await s.reload(repair.id)).status).toBe("budget_wait");
  expect(s.counts().coded).toBe(0);
});

// 虛構帳密，只用英數字。
const leakedPass = "demoPass123";
const leakyBaseline: PhaseResult = {
  exitCode: 1,
  stdout: [
    "[xUnit.net 00:00:02.10]     Demo.Shop.Tests.OrderTests.Save_ShouldPersist [FAIL]",
    `[xUnit.net 00:00:02.10]       Npgsql.NpgsqlException : 無法連線 Host=db.demo.test;Database=demo_shop;Username=demoUser;Password=${leakedPass}`,
    "[xUnit.net 00:00:02.10]       Stack Trace:",
    "Failed!  - Failed:     1, Passed:    40, Skipped:     0, Total:    41",
  ].join("\n"),
  stderr: `Error: connect ECONNREFUSED postgres://demoUser:${leakedPass}@db.demo.test:5432/demo_shop`,
};

/** 看板、群組通知、執行紀錄、稽核與執行結果裡都不能出現密碼。 */
async function expectNoLeak(taskId: string) {
  const app = await buildApp(db);
  try {
    const headers = await session();
    const detail = await app.inject({ url: `/api/tasks/${taskId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(leakedPass);
    const list = await app.inject({ url: "/api/tasks", headers });
    expect(list.body).not.toContain(leakedPass);
  } finally {
    await app.close();
  }
  const rows = await db.query<{ text: string }>(
    `SELECT text FROM notifications
     UNION ALL SELECT detail FROM audit
     UNION ALL SELECT detail FROM run_events
     UNION ALL SELECT result::text FROM runs
     UNION ALL SELECT concat_ws(' ',last_error,summary,review_note,answer) FROM tasks`,
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.text ?? "").not.toContain(leakedPass);
}

it("測試失敗訊息含連線字串：看板、群組、執行紀錄、稽核、修復任務需求與提示都不含密碼，主機與資料庫仍看得到", async () => {
  const s = await autoScenario([ok, leakyBaseline, leakyBaseline, ok]);
  await s.execution.execute(s.task.id);
  const task = await s.reload();
  expect(task.status).toBe("failed");
  const detail = parseFailure(task.last_error)!.detail;
  expect(detail).toContain("Demo.Shop.Tests.OrderTests.Save_ShouldPersist");
  expect(detail).toContain("Host=db.demo.test;Database=demo_shop");
  const group = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE task_id=$1 AND kind='group_failed'",
    [s.task.id],
  );
  expect(group!.text).toContain("db.demo.test");
  await expectNoLeak(s.task.id);

  const repair = await createBaselineRepair(db, s.task.id, "小林");
  expect(repair.summary).toContain("Host=db.demo.test;Database=demo_shop");
  expect(repair.summary).not.toContain(leakedPass);
  await dashboardAction(repair.id, "approve", repair.version);
  await s.execution.execute(repair.id);
  expect(s.counts().coded).toBe(1);
  expect(s.counts().prompt).not.toContain(leakedPass);
  await expectNoLeak(repair.id);
});

it("舊版保存、未遮蔽的基底失敗說明，建立修復任務時一樣遮蔽", async () => {
  const s = await autoScenario([ok, redBaseline]);
  await s.execution.execute(s.task.id);
  const raw = (await s.reload()).last_error!.replace(
    "Demo.Shop.Tests.StockTests.Release_ShouldUnlock",
    `Demo.Shop.Tests.StockTests.Release_ShouldUnlock postgres://demoUser:${leakedPass}@db.demo.test/demo_shop`,
  );
  await db.query("UPDATE tasks SET last_error=$2 WHERE id=$1", [s.task.id, raw]);
  const repair = await createBaselineRepair(db, s.task.id, "小林");
  expect(repair.summary).toContain("postgres://demoUser:[已遮蔽]@db.demo.test/demo_shop");
  expect(repair.summary).not.toContain(leakedPass);
});

it("獨立審查意見引述連線字串：修復提示、候選的審查意見、稽核與失敗說明都不含密碼", async () => {
  const s = await autoScenario([], {
    review: {
      passed: false,
      findings: [`測試設定寫死了 postgres://demoUser:${leakedPass}@db.demo.test/demo_shop`],
    },
  });
  await s.execution.execute(s.task.id);
  expect((await s.reload()).status).toBe("failed");
  expect(s.counts().coded).toBe(2);
  expect(s.counts().feedback).toContain("postgres://demoUser:[已遮蔽]@db.demo.test/demo_shop");
  expect(s.counts().feedback).not.toContain(leakedPass);
  expect(s.counts().prompt).not.toContain(leakedPass);
  await expectNoLeak(s.task.id);
});
