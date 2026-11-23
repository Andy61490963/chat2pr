import { afterAll, beforeEach, expect, it } from "vitest";
import { db, reset, fixture, confirmTask } from "./helpers.js";
import { Execution, type PhaseResult, type Runner } from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { subscriptionGateName } from "../server/subscription-gate.js";
import type { Project, Task } from "../shared/types.js";
import { parseFailure } from "../shared/failure-text.js";

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
  stderr: "    at command (file:///workspace/scripts/test.mjs:31:34)\n\nNode.js v24.0.0",
};

/** 自動設定的專案：驗證通過後派一筆修改；每次測試階段依序取 tests 的結果，用完後一律通過。 */
async function autoScenario(tests: PhaseResult[]) {
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
    prompt = "";
  const runner: Runner = {
    async upload() {},
    account: async () => ({ allowed: true, checkedAt: new Date().toISOString() }),
    async call<T>(path: string, raw: unknown): Promise<T> {
      const body = raw as { phase?: string; job?: { prompt?: string } };
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
              evidence: [{ path: "package.json", quote: '"test":"vitest run"' }],
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
      }
      if (body.phase === "collect")
        return {
          ...ok,
          stdout: JSON.stringify({
            files: coded
              ? [{ path: "src/stock.ts", content: "YQ==", mode: "100644" }]
              : [],
          }),
        } as T;
      if (body.phase === "review")
        return {
          ...ok,
          stdout: JSON.stringify({
            final: JSON.stringify({ passed: true, findings: [] }),
          }),
        } as T;
      return ok as T;
    },
  };
  const execution = new Execution(db, github, new Line(db), new Budget(db), runner);
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
    counts: () => ({ coded, testCalls, published, prompt }),
    reload: (id = task.id) =>
      db.one<Task>("SELECT * FROM tasks WHERE id=$1", [id]),
  };
}

it("基底驗證失敗：看板與群組列出失敗的測試名稱與錯誤訊息，不再只有統計數字", async () => {
  // 第一次是專案驗證（通過），第二次是派工的基底驗證（失敗）。
  const s = await autoScenario([{ exitCode: 0, stdout: "", stderr: "" }, redBaseline]);
  await s.execution.execute(s.task.id);
  const task = await s.reload();
  expect(task.status).toBe("failed");
  expect(s.counts().coded).toBe(0);
  const parsed = parseFailure(task.last_error)!;
  expect(parsed.plain).toBe("還沒修改前，目標分支本身就建置或測試失敗");
  expect(parsed.detail.split("\n").slice(0, 3)).toEqual([
    "失敗的測試（共 2 個）：",
    "・Demo.Shop.Tests.StockTests.Reserve_ShouldLock(rush: True)：Assert.Equal() Failure: Values differ",
    "・Demo.Shop.Tests.StockTests.Release_ShouldUnlock：System.InvalidOperationException : 找不到虛構庫存 B-002",
  ]);
  expect(parsed.detail).not.toContain("file:///");
  const group = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE task_id=$1 AND kind='group_failed'",
    [s.task.id],
  );
  expect(group!.text).toContain("Demo.Shop.Tests.StockTests.Release_ShouldUnlock");
  expect(group!.text).toContain("請 AI 修好目標分支");
});

it("有上次通過的紀錄：說明上次通過的短 SHA、之後的新 commit 數與比較連結", async () => {
  const s = await autoScenario([{ exitCode: 0, stdout: "", stderr: "" }, redBaseline]);
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
  expect(group!.text).toContain("上次通過是 1111111，之後目標分支有 3 個新 commit");
});

it("GitHub 比較失敗時仍說明上次通過的 commit 並附比較連結，只是不寫數量", async () => {
  const s = await autoScenario([{ exitCode: 0, stdout: "", stderr: "" }, redBaseline]);
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
  const s = await autoScenario([{ exitCode: 0, stdout: "", stderr: "" }, redBaseline]);
  await s.execution.execute(s.task.id);
  expect(parseFailure((await s.reload()).last_error)!.detail).toContain(
    "上次在同一個 commit（1111111）通過",
  );
});

it("沒有上次通過的紀錄就不顯示這一段", async () => {
  const s = await autoScenario([{ exitCode: 0, stdout: "", stderr: "" }, redBaseline]);
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
  expect(
    await db.query("SELECT branch,sha FROM baseline_passes"),
  ).toEqual([{ branch: "main", sha: "2222222bbbbbbbbb" }]);
});
