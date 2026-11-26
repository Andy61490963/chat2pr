import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { Budget } from "../server/budget.js";
import { taskQueue } from "../server/capacity.js";
import { Execution, type Runner } from "../server/execution.js";
import { GitHub } from "../server/github.js";
import { progressSummary, progressTasks } from "../server/group-replies.js";
import { Line } from "../server/line.js";
import { expireStaleNotifications } from "../server/line-quota.js";
import { claimUpstreamRetry } from "../server/upstream-retry.js";
import { confirmTask, dashboardAction, db, fixture, reset } from "./helpers.js";

beforeEach(async () => {
  await reset();
  await db.query(
    "DELETE FROM service_health WHERE name IN ('codex_upstream','codex_subscription_gate')",
  );
  await db.query(
    `UPDATE settings SET value=value||'{"ai_mode":"subscription"}' WHERE id=1`,
  );
});
afterAll(() => db.close());

const files = [{ path: "src/button.ts", content: "YQ==", mode: "100644" }];
const upstream = {
  kind: "server_error",
  status: 503,
  message: "不該留下的上游內文",
};
const broken = (upstreamFailure: unknown) => ({
  upstreamFailure,
  exitCode: 1,
  stdout: "",
  stderr: "不該留下的標準錯誤輸出",
});
async function scenario(result: (phase: string) => unknown) {
  const project = await fixture();
  const { id } = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,status,approved_version,dedupe_key) VALUES($1,'group-a','示範按鈕','顯示按鈕','queued',1,'button') RETURNING id",
    [project],
  );
  await confirmTask(id);
  const github = new GitHub();
  github.base = async () => "base";
  github.archive = async () => new Blob(["archive"]).stream();
  github.ensureIssue = async () => ({
    number: 1,
    url: "https://example.test/issues/1",
  });
  github.findPr = async () => undefined!;
  github.publish = async () =>
    ({ number: 2, html_url: "https://example.test/pull/2" }) as Awaited<
      ReturnType<GitHub["publish"]>
    >;
  const applyCandidate = vi.fn<NonNullable<Runner["applyCandidate"]>>(
    async () => {},
  );
  const phases: string[] = [];
  const runner: Runner = {
    account: async () => ({
      allowed: true,
      checkedAt: new Date().toISOString(),
    }),
    upload: async () => {},
    applyCandidate,
    async call<T>(path: string, raw: unknown) {
      const phase = (raw as { phase: string }).phase;
      if (path === "phase") phases.push(phase);
      const override = path === "phase" && result(phase);
      const stdout =
        phase === "collect"
          ? JSON.stringify({ files })
          : phase === "review"
            ? JSON.stringify({
                final: JSON.stringify({ passed: true, findings: [] }),
              })
            : "";
      return (override || { exitCode: 0, stdout, stderr: "" }) as T;
    },
  };
  return {
    id,
    phases,
    applyCandidate,
    dispatch: () =>
      new Execution(db, github, new Line(db), new Budget(db), runner).execute(
        id,
      ),
    due: () =>
      db.query(
        "UPDATE tasks SET retry_at=now()-interval '1 second' WHERE id=$1",
        [id],
      ),
    state: () =>
      db.one<{ status: string; last_error: string; delay: number | null }>(
        "SELECT status,last_error,extract(epoch FROM retry_at-updated_at)::int AS delay FROM tasks WHERE id=$1",
        [id],
      ),
  };
}

it("同一需求版本依序等待 30 秒、3 分鐘、10 分鐘，重啟或並行派工不提早也不多試", async () => {
  const work = await scenario((phase) => phase === "code" && broken(upstream));
  for (const [index, delay] of [30, 180, 600].entries()) {
    await Promise.all([work.dispatch(), work.dispatch()]);
    expect(await work.state()).toMatchObject({
      status: "queued",
      delay,
      last_error: expect.stringContaining("等待 AI 服務恢復"),
    });
    expect((await work.state()).last_error).toContain("從頭開始");
    await work.dispatch();
    expect(work.phases.filter((phase) => phase === "code")).toHaveLength(
      index + 1,
    );
    const progress = await progressTasks(db.pool, "group-a");
    expect(progressSummary(progress.tasks, progress.total, 0)).toContain(
      "示範按鈕：等待 AI 服務恢復",
    );
    expect((await taskQueue(db, work.id))?.text).toContain("等待 AI 服務恢復");
    await db.transaction(expireStaleNotifications);
    const notices = await db.query(
      "SELECT text FROM notifications WHERE group_id='group-a' AND sent_at IS NULL",
    );
    expect(notices).toEqual([{ text: (await work.state()).last_error }]);
    await work.due();
  }
  await work.dispatch();
  expect(await work.state()).toMatchObject({ status: "failed", delay: null });
  const failed = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE kind='group_failed'",
  );
  expect(failed.text).toMatch(/3 次|三次/);
  expect((await work.state()).last_error).toMatch(/3 次|三次/);
  expect(work.phases.filter((phase) => phase === "code")).toHaveLength(4);
});

it.each([
  ["rejected", 400],
  ["model_unavailable", 404],
  ["auth", 401],
  ["context_too_long", 400],
] as const)(
  "不可重試的上游分類 %s 不排隊，執行事件與健康項目只保存白名單資訊",
  async (kind, status) => {
    const work = await scenario(
      (phase) => phase === "code" && broken({ ...upstream, kind, status }),
    );
    await work.dispatch();
    expect(await work.state()).toMatchObject({ status: "failed", delay: null });
    const health = await db.one(
      "SELECT ok,detail,checked_at FROM service_health WHERE name='codex_upstream'",
    );
    expect(health).toMatchObject({
      ok: false,
      detail: expect.stringContaining(String(status)),
      checked_at: expect.any(Date),
    });
    const events = await db.query(
      "SELECT detail FROM run_events WHERE kind='error'",
    );
    expect(events).toContainEqual({
      detail: expect.stringContaining(String(status)),
    });
    const notices = await db.query("SELECT text FROM notifications");
    expect(
      JSON.stringify([health, events, notices, await work.state()]),
    ).not.toContain("不該留下");
  },
);

it("已收集的修改在審查遇到上游故障後接續，不重新修改；只有推論成功才清除健康故障", async () => {
  let failing = true;
  const work = await scenario(
    (phase) =>
      phase === "review" &&
      (failing
        ? broken(upstream)
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              final: JSON.stringify({ passed: true, findings: [] }),
            }),
            stderr: "",
            upstreamSucceeded: true,
          }),
  );
  await work.dispatch();
  expect((await work.state()).last_error).toMatch(/保留.*測試.*審查/);
  failing = false;
  await work.due();
  await work.dispatch();
  expect((await work.state()).status).toBe("ready");
  expect(work.applyCandidate.mock.calls.map((args) => args[2])).toEqual([
    files,
  ]);
  expect(work.phases.filter((phase) => phase === "code")).toHaveLength(1);
  expect(
    await db.one(
      "SELECT ok,detail FROM service_health WHERE name='codex_upstream'",
    ),
  ).toMatchObject({ ok: true, detail: expect.not.stringContaining("503") });
});

it("退出碼成功或輸出聲稱推論成功，都不能清除最近一次已知上游失敗", async () => {
  await db.query(
    "INSERT INTO service_health(name,ok,detail) VALUES('codex_upstream',false,'上游伺服器錯誤（HTTP 503）')",
  );
  const work = await scenario(
    (phase) =>
      phase === "code" && {
        exitCode: 0,
        stdout: JSON.stringify({ upstreamSucceeded: true }),
        stderr: "",
      },
  );
  await work.dispatch();
  expect((await work.state()).status).toBe("ready");
  expect(
    await db.one("SELECT ok FROM service_health WHERE name='codex_upstream'"),
  ).toEqual({ ok: false });
});

it("可信的額度限制仍等額度而非自動重試", async () => {
  const work = await scenario(
    (phase) => phase === "code" && broken({ kind: "quota", status: 429 }),
  );
  await work.dispatch();
  expect(await work.state()).toMatchObject({
    status: "budget_wait",
    delay: null,
  });
  expect(
    await db.one(
      "SELECT ok FROM service_health WHERE name='codex_subscription_gate'",
    ),
  ).toEqual({ ok: false });
  expect(
    await db.one(
      "SELECT detail FROM service_health WHERE name='codex_upstream'",
    ),
  ).toMatchObject({ detail: expect.stringContaining("429") });
});

it.each(["cancel", "amend"] as const)(
  "退避中執行 %s 後不再派舊版，也不補送待恢復通知",
  async (action) => {
    const work = await scenario(
      (phase) => phase === "code" && broken(upstream),
    );
    await work.dispatch();
    await dashboardAction(
      work.id,
      action,
      1,
      action === "amend"
        ? {
            summary: "改成顯示兩顆示範按鈕",
            acceptance: ["顯示兩顆按鈕"],
          }
        : {},
    );
    await work.dispatch();
    expect(work.phases.filter((phase) => phase === "code")).toHaveLength(1);
    await db.transaction(expireStaleNotifications);
    expect(
      await db.query(
        "SELECT id FROM notifications WHERE kind='group_waiting' AND sent_at IS NULL",
      ),
    ).toHaveLength(0);
    if (action === "amend") {
      await dashboardAction(work.id, "approve", 2);
      await work.dispatch();
      expect(work.phases.filter((phase) => phase === "code")).toHaveLength(2);
      expect(await work.state()).toMatchObject({ status: "queued", delay: 30 });
    }
  },
);

it("上游明確回絕時，容器輸出中的額度字樣不能耗盡訂閱額度", async () => {
  const work = await scenario(
    (phase) =>
      phase === "code" && {
        ...broken({ kind: "rejected", status: 400 }),
        stderr: "HTTP 429 Too Many Requests",
      },
  );
  await work.dispatch();
  expect((await work.state()).status).toBe("failed");
  expect(
    await db.one(
      "SELECT ok FROM service_health WHERE name='codex_subscription_gate'",
    ),
  ).toEqual({ ok: true });
});

it("上游故障時今日執行次數已用完，不承諾會自動再試", async () => {
  await db.query(
    `UPDATE settings SET value=value||'{"daily_runs":1}' WHERE id=1`,
  );
  const work = await scenario((phase) => phase === "code" && broken(upstream));
  await work.dispatch();
  expect(await work.state()).toMatchObject({
    status: "failed",
    delay: null,
    last_error: expect.stringContaining("今日執行次數已用完"),
  });
  expect(
    await db.query("SELECT id FROM notifications WHERE kind='group_waiting'"),
  ).toHaveLength(0);
});

it("重試交易中斷不消耗次數，同一執行重送只新增一次通知與稽核", async () => {
  const work = await scenario(() => undefined);
  await db.query("UPDATE tasks SET status='reviewing' WHERE id=$1", [work.id]);
  const run = await db.one<{ id: string }>(
    "INSERT INTO runs(task_id,version,model,deadline) VALUES($1,1,'示範模型',now()) RETURNING id",
    [work.id],
  );
  const claim = () =>
    claimUpstreamRetry(
      db,
      work.id,
      run.id,
      { kind: "connection" },
      "verify",
      async () => "",
    );
  const audit = vi
    .spyOn(db, "audit")
    .mockRejectedValueOnce(new Error("示範稽核中斷"));
  try {
    await expect(claim()).rejects.toThrow("示範稽核中斷");
  } finally {
    audit.mockRestore();
  }
  expect(await work.state()).toMatchObject({
    status: "reviewing",
    delay: null,
  });
  const results = await Promise.all([claim(), claim(), claim()]);
  expect(results.map((result) => result.kind).sort()).toEqual([
    "scheduled",
    "stale",
    "stale",
  ]);
  expect(await work.state()).toMatchObject({ status: "queued", delay: 30 });
  expect(
    await db.query("SELECT 1 FROM audit WHERE kind='auto_retry'"),
  ).toHaveLength(1);
  expect(
    await db.query("SELECT 1 FROM notifications WHERE kind='group_waiting'"),
  ).toHaveLength(1);
});
