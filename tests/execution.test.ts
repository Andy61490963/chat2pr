import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { reviewVerdict } from "../server/pr-body.js";
import { phaseEndEvents } from "../server/test-failures.js";
import { transientFailure, claimAutoResume } from "../server/execution.js";
import { codexSdkCrash } from "./failure-samples.js";
import {
  db,
  reset,
  fixture,
  confirmTask,
  dashboardAction,
  session,
} from "./helpers.js";
import {
  phaseDurations,
  repairPhaseDetail,
  type RunView,
} from "../shared/observation.js";
import {
  Execution,
  noConnectionHint,
  type Runner,
  type PhaseResult,
} from "../server/execution.js";
import { GitHub, BranchUnavailable } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { Tasks } from "../server/tasks.js";
import { recoverInterrupted, startJobs } from "../server/jobs.js";
import { AppError } from "../server/policy.js";
import { syncProjectRepos } from "../server/repo-missing.js";
import type { Project, Task } from "../shared/types.js";
import sharp from "sharp";
import { saveTaskImageRefs, imageHash } from "../server/image-context.js";
import { recordContextEvidence } from "../server/task-context.js";
import { subscriptionGateName } from "../server/subscription-gate.js";
import { parseFailure, primaryFix } from "../shared/failure-text.js";
beforeEach(reset);
afterAll(() => db.close());
async function scenario() {
  const projectId = await fixture();
  const task = await db.one<Task>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key) VALUES($1,'group-a','修正按鈕','按鈕顯示綠色','[\"顯示綠色\"]','queued',1,'one') RETURNING *",
    [projectId],
  );
  const github = new GitHub();
  await confirmTask(task.id);
  let published = 0,
    testCalls = 0,
    codeCalls = 0,
    collectCalls = 0,
    reviewCalls = 0,
    failReviews = 0;
  const applied: unknown[] = [];
  const publishedFiles: unknown[] = [];
  let failTests = false,
    mutateCandidate = false,
    cancelDuringPublish = false,
    sensitive = false,
    emptyResult: string | undefined;
  github.base = async () => "base-sha";
  github.archive = async () => new Blob(["archive"]).stream();
  github.ensureIssue = async () => ({
    number: 1,
    url: "https://github.com/test/repo/issues/1",
  });
  github.findPr = async () => undefined!;
  github.publish = async (_p, _t, files, _report, guard) => {
    await guard?.();
    published++;
    publishedFiles.push(files);
    if (cancelDuringPublish)
      await new Tasks(db).action(task.id, "cancel", 1, "管理者");
    return {
      number: 2,
      html_url: "https://github.com/test/repo/pull/2",
    } as Awaited<ReturnType<GitHub["publish"]>>;
  };
  const runner: Runner = {
    async upload() {},
    async applyCandidate(_runId, _image, files) {
      applied.push(files);
    },
    async call<T>(path: string, raw: unknown): Promise<T> {
      const body = raw as { phase: string };
      let result: PhaseResult = { exitCode: 0, stdout: "", stderr: "" };
      if (path === "phase") {
        if (body.phase === "test") {
          testCalls++;
          if (failTests) result.exitCode = 1;
        }
        if (body.phase === "code") {
          codeCalls++;
          if (emptyResult !== undefined)
            result.stdout = JSON.stringify({ final: emptyResult });
        }
        if (body.phase === "collect") {
          collectCalls++;
          result.stdout = JSON.stringify({
            files:
              emptyResult !== undefined
                ? []
                : [
                    {
                      path: sensitive ? "server/auth.ts" : "src/button.ts",
                      content:
                        mutateCandidate && collectCalls > 1 ? "Yg==" : "YQ==",
                      mode: "100644",
                    },
                  ],
          });
        }
        if (body.phase === "review") {
          const passed = ++reviewCalls > failReviews;
          result.stdout = JSON.stringify({
            final: JSON.stringify(
              passed
                ? { passed: true, findings: [] }
                : { passed: false, findings: ["範例按鈕在深色主題仍是灰色"] },
            ),
          });
        }
      }
      return result as T;
    },
  };
  const budget = new Budget(db),
    line = new Line(db);
  return {
    task,
    github,
    runner,
    budget,
    line,
    execution: new Execution(db, github, line, budget, runner),
    change: (o: {
      failTests?: boolean;
      mutateCandidate?: boolean;
      cancelDuringPublish?: boolean;
      sensitive?: boolean;
      emptyResult?: string;
      failReviews?: number;
    }) => {
      failReviews = o.failReviews ?? 0;
      failTests = !!o.failTests;
      mutateCandidate = !!o.mutateCandidate;
      cancelDuringPublish = !!o.cancelDuringPublish;
      sensitive = !!o.sensitive;
      emptyResult = o.emptyResult;
    },
    counts: () => ({ published, testCalls, codeCalls }),
    reviews: () => reviewCalls,
    applied,
    publishedFiles,
  };
}
it("派工只把這筆任務採用的文件文字交給開發執行器", async () => {
  const s = await scenario();
  await db.query(`INSERT INTO messages(id,group_id,type,document_name,text) VALUES
    ('doc-used','group-a','document','規格.txt','出貨報表排除作廢單'),
    ('doc-other','group-a','document','草案.txt','未採用的內容')`);
  await db.query("UPDATE tasks SET source_ids=ARRAY['doc-used'] WHERE id=$1", [s.task.id]);
  let documents: unknown;
  const original = s.runner.call;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string; job?: { prompt: string } };
    if (path === "phase" && body.phase === "code") {
      documents = JSON.parse(body.job!.prompt).documents;
    }
    return original<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  expect(documents).toEqual([{ name: "規格.txt", text: "出貨報表排除作廢單" }]);
});
it.each([
  [86, "環境問題"],
  [1, "專案問題"],
] as const)("SQL 複驗退出碼 %i 以可信來源分類，長日誌中的 429 不會耗盡模型額度", async (exitCode, expected) => {
  const s = await scenario();
  await db.query(`UPDATE settings SET value=value||'{"ai_mode":"subscription"}'::jsonb WHERE id=1`);
  s.runner.account = async () => ({ allowed: true, checkedAt: new Date().toISOString() });
  const original = s.runner.call;
  s.runner.call = async <T>(path: string, body: unknown): Promise<T> =>
    path === "phase" && (body as { phase?: string }).phase === "review"
      ? { sqlReviewFailure: true, exitCode, stdout: "", stderr: "明細\n".repeat(1600) + "HTTP 429 Too Many Requests" } as T
      : original<T>(path, body);
  await new Execution(db, s.github, s.line, s.budget, s.runner).execute(s.task.id);
  const result = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [s.task.id]);
  expect(result.status).toBe("failed");
  expect(result.last_error).toContain(expected);
  expect(result.last_error).not.toContain("AI 額度不足");
  expect((await db.one<{ ok: boolean }>("SELECT ok FROM service_health WHERE name=$1", [subscriptionGateName])).ok).toBe(true);
  expect(s.counts()).toMatchObject({ published: 0, codeCalls: 1 });
});
it("只發布通過測試與獨立審查的同一份候選內容", async () => {
  const s = await scenario();
  await s.execution.execute(s.task.id);
  expect(s.counts()).toEqual({ published: 1, testCalls: 1, codeCalls: 1 });
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
});
it("需求已符合時結束空變更任務，並以同一句話通知群組與管理者", async () => {
  const s = await scenario();
  const explanation = "範例按鈕已是綠色，且有現成的測試覆蓋。";
  s.change({ emptyResult: `${explanation}\nAGENTFLOW_ALREADY_SATISFIED` });
  await s.execution.execute(s.task.id);

  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  const result = "已經符合需求，沒有需要修改的地方。";
  expect(task).toMatchObject({
    status: "answered",
    answer: `${result}\n\n${explanation}`,
    last_error: null,
    pr_number: null,
  });
  expect(s.counts()).toEqual({ published: 0, testCalls: 0, codeCalls: 1 });
  expect(
    await db.query(
      "SELECT kind,text FROM notifications WHERE task_id=$1 AND kind IN ('no_changes','group_no_changes','failed','group_failed') ORDER BY kind",
      [s.task.id],
    ),
  ).toEqual([
    { kind: "group_no_changes", text: `「${s.task.title}」${result}` },
    { kind: "no_changes", text: `「${s.task.title}」${result}` },
  ]);
});
it("Codex 做不到時，空變更仍是失敗並保留說明", async () => {
  const s = await scenario();
  const explanation = "無法完成修改，範例元件缺少可驗證的樣式規格。";
  s.change({ emptyResult: explanation });
  await s.execution.execute(s.task.id);

  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(task).toMatchObject({
    status: "failed",
    answer: null,
    pr_number: null,
  });
  expect(task?.last_error).toContain(explanation);
  expect(s.counts()).toEqual({ published: 0, testCalls: 0, codeCalls: 1 });
  expect(
    await db.query(
      "SELECT kind FROM notifications WHERE task_id=$1 AND kind IN ('no_changes','group_no_changes','failed','group_failed') ORDER BY kind",
      [s.task.id],
    ),
  ).toEqual([{ kind: "failed" }, { kind: "group_failed" }]);
});
it.each([false, true])(
  "自動設定派工使用任務分支，先驗證新基底（基底失敗：%s）",
  async (failBaseline) => {
    const s = await scenario();
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{ai_mode}','\"subscription\"')",
    );
    await db.query("DELETE FROM service_health WHERE name=$1", [
      subscriptionGateName,
    ]);
    await db.query(
      "UPDATE projects SET setup_mode='auto',validated_at=NULL,enabled=false,install_command='',test_command=''",
    );
    const sources: string[] = [],
      commands: string[] = [];
    let plans = 0,
      coded = false;
    s.github.setupContext = async (p) => {
      sources.push(p.base_branch);
      return {
        files: { "package.json": '{"scripts":{"test":"vitest run"}}' },
        locks: [],
      };
    };
    s.runner.account = async () => ({
      allowed: true,
      checkedAt: new Date().toISOString(),
    });
    const original = s.runner.call;
    s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
      const body = raw as { phase?: string; command?: string };
      if (path === "ai") {
        plans++;
        return {
          exitCode: 0,
          stderr: "",
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
      }
      if (body.phase === "code") coded = true;
      if (body.command) commands.push(body.command);
      if (body.phase === "collect" && !coded)
        return { exitCode: 0, stdout: '{"files":[]}', stderr: "" } as T;
      return original<T>(path, raw);
    };
    const execution = new Execution(db, s.github, s.line, s.budget, s.runner);
    await execution.validate(await db.one<Project>("SELECT * FROM projects"));
    await db.query("UPDATE tasks SET target_branch='develop' WHERE id=$1", [
      s.task.id,
    ]);
    await confirmTask(s.task.id);
    s.change({ failTests: failBaseline });
    await execution.execute(s.task.id);
    expect(sources).toEqual(["main", "develop"]);
    expect(plans).toBe(2);
    expect(commands.slice(0, 4)).toEqual([
      "npm ci",
      "npm test",
      "npm ci",
      "npm test",
    ]);
    expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe(
      failBaseline ? "failed" : "ready",
    );
    expect(s.counts().codeCalls).toBe(failBaseline ? 0 : 1);
    expect(s.counts().published).toBe(failBaseline ? 0 : 1);
  },
);

it.each(["develop", "release/2026"])(
  "任務使用自己的 %s 分支讀取來源、提示模型與建立 PR",
  async (branch) => {
    const s = await scenario();
    await db.query("UPDATE tasks SET target_branch=$2 WHERE id=$1", [
      s.task.id,
      branch,
    ]);
    await confirmTask(s.task.id);
    const seen: string[] = [];
    s.github.base = async (p) => {
      seen.push(p.base_branch);
      return "branch-commit";
    };
    s.github.archive = async (p, sha) => {
      expect(p.base_branch).toBe(branch);
      expect(sha).toBe("branch-commit");
      return new Blob(["此分支的內容"]).stream();
    };
    const publish = s.github.publish.bind(s.github);
    s.github.publish = async (p, t, ...args) => {
      expect(p.base_branch).toBe(branch);
      expect(t.target_branch).toBe(branch);
      expect(t.base_sha).toBe("branch-commit");
      return publish(p, t, ...args);
    };
    const call = s.runner.call.bind(s.runner);
    s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
      const body = raw as { phase?: string; job?: { prompt: string } };
      if (path === "phase" && body.phase === "code")
        expect(JSON.parse(body.job!.prompt).sourceVersion).toMatchObject({
          baseBranch: branch,
          baseCommit: "branch-commit",
        });
      return call<T>(path, raw);
    };
    await s.execution.execute(s.task.id);
    expect(
      (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [s.task.id]))
        .status,
    ).toBe("ready");
    expect(seen.every((n) => n === branch)).toBe(true);
    expect(s.counts().published).toBe(1);
  },
);

it.each([false, true])(
  "目標分支刪除就交回確認且不發布（執行中刪除=%s）",
  async (during) => {
    const s = await scenario();
    let reads = 0;
    s.github.base = async () => {
      if (!during || reads++ > 0) throw new BranchUnavailable("main");
      return "base-sha";
    };
    const issue = vi.spyOn(s.github, "ensureIssue");
    await s.execution.execute(s.task.id);
    const t = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      s.task.id,
    ]);
    expect(t).toMatchObject({
      status: "awaiting_approval",
      target_branch: null,
      approved_version: null,
      version: 2,
    });
    expect(t.last_error).toContain("不存在");
    expect(s.counts().published).toBe(0);
    if (!during) expect(issue).not.toHaveBeenCalled();
    expect(
      await db.query("SELECT id FROM runs WHERE completed_at IS NULL"),
    ).toHaveLength(0);
  },
);

it("只有舊核准欄位而沒有專案確認時，不得呼叫執行器或建立 Issue", async () => {
  const s = await scenario();
  await db.query("DELETE FROM task_project_confirmations");
  const issue = vi.spyOn(s.github, "ensureIssue");
  const call = vi.spyOn(s.runner, "call");
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe(
    "awaiting_approval",
  );
  expect(issue).not.toHaveBeenCalled();
  expect(call).not.toHaveBeenCalled();
});
it.each(["綁定", "設定"])(
  "執行途中變更%s時不發布舊結果並完成資源清理",
  async (change) => {
    const s = await scenario();
    const call = s.runner.call.bind(s.runner);
    const paths: string[] = [];
    s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
      paths.push(path);
      if (path === "phase" && (raw as { phase?: string }).phase === "code") {
        if (change === "綁定") await db.query("DELETE FROM group_projects");
        else
          await db.query("UPDATE projects SET config_version=config_version+1");
      }
      return call<T>(path, raw);
    };
    await s.execution.execute(s.task.id);
    expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe(
      "awaiting_approval",
    );
    expect(s.counts().published).toBe(0);
    expect(paths).toContain("cancel");
    expect(
      await db.query("SELECT id FROM runs WHERE completed_at IS NULL"),
    ).toHaveLength(0);
  },
);

it.each(["code", "review"])(
  "API 模式的 %s 收到上游 429 不得誤判成 ChatGPT 訂閱額度",
  async (phase) => {
    const s = await scenario(),
      original = s.runner.call.bind(s.runner);
    s.runner.call = async <T>(path: string, body: unknown): Promise<T> => {
      if (path === "phase" && (body as { phase: string }).phase === phase)
        return { exitCode: 1, stdout: "", stderr: "本機代理回應 429" } as T;
      return original<T>(path, body);
    };
    await s.execution.execute(s.task.id);
    const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      s.task.id,
    ]);
    expect(task.status).toBe("failed");
    expect(task.last_error).toContain("本機代理回應 429");
    expect(task.last_error).not.toContain("訂閱額度");
    expect(s.counts().published).toBe(0);
  },
);

it.each(["code", "review"])(
  "訂閱模式的 %s 確認額度用完仍保留 budget_wait",
  async (phase) => {
    const s = await scenario(),
      original = s.runner.call.bind(s.runner);
    await db.query("DELETE FROM service_health WHERE name=$1", [
      subscriptionGateName,
    ]);
    let reached = false;
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{ai_mode}','\"subscription\"')",
    );
    s.runner.account = async () => ({
      allowed: true,
      checkedAt: new Date().toISOString(),
    });
    s.runner.call = async <T>(path: string, body: unknown): Promise<T> => {
      if (path === "phase" && (body as { phase: string }).phase === phase) {
        reached = true;
        return { exitCode: 1, stdout: "", stderr: "usage limit reached" } as T;
      }
      return original<T>(path, body);
    };
    await new Execution(db, s.github, s.line, s.budget, s.runner).execute(
      s.task.id,
    );
    const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      s.task.id,
    ]);
    expect(task.status).toBe("budget_wait");
    expect(reached).toBe(true);
    expect(task.last_error).toContain("訂閱額度");
    expect(s.counts().published).toBe(0);
  },
);

it("訂閱修改失敗後，執行紀錄、看板與群組保留代理原因", async () => {
  const sample = await scenario();
  const original = sample.runner.call.bind(sample.runner);
  await db.query("DELETE FROM service_health WHERE name=$1", [subscriptionGateName]);
  await db.query(`UPDATE settings SET value=jsonb_set(value,'{ai_mode}','"subscription"')`);
  sample.runner.account = async () => ({ allowed: true, checkedAt: new Date().toISOString() });
  sample.runner.call = async <T>(path: string, body: unknown): Promise<T> => {
    if (path !== "phase" || (body as {phase?: string}).phase !== "code") return original<T>(path, body);
    const result = { exitCode: 1, stdout: "", stderr: "訂閱轉送失敗，未使用其他計費方式", upstreamFailure: { kind: "upstream_http", status: 500 } } as const;
    const observations = phaseEndEvents("code", result).map((event) => ({ ...event, seq: 1, phase: "code", at: new Date().toISOString() }));
    return { ...result, observations } as T;
  };
  const execution = new Execution(db, sample.github, sample.line, sample.budget, sample.runner);
  await execution.execute(sample.task.id);
  expect(await db.one("SELECT status FROM tasks WHERE id=$1", [sample.task.id])).toEqual({ status: "queued" });
  const event = await db.one<{ detail: string }>("SELECT detail FROM run_events WHERE source='runner' AND phase='code' AND kind='phase_end'");
  expect(event.detail).toMatch(/upstream_http.*500/);
  const detail = await new Tasks(db).detail(sample.task.id);
  expect(detail.runs[0]).toMatchObject({ upstream_failure: { kind: "upstream_http", status: 500 } });
  await db.query("UPDATE tasks SET retry_at=now()-interval '1 second' WHERE id=$1", [sample.task.id]);
  await execution.execute(sample.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [sample.task.id]);
  expect(task.status).toBe("failed");
  const reason = parseFailure(task.last_error!)!.plain.replace(/（已自動重試一次，仍然失敗）$/, "");
  expect(reason).toMatch(/訂閱上游回應失敗.*500/);
  const group = await db.one<{ text: string }>("SELECT text FROM notifications WHERE task_id=$1 AND kind='group_failed'", [sample.task.id]);
  expect(group.text).toContain(reason);
});

it("phase 的容器與 HTTP 使用相同剩餘期限，結束清理另有短期限", async () => {
  const s = await scenario(),
    original = s.runner.call.bind(s.runner);
  const phases: Array<{
    phase: string;
    bodyTimeout: number;
    httpTimeout: number | undefined;
  }> = [];
  let cancelTimeout: number | undefined;
  s.runner.call = async <T>(
    path: string,
    raw: unknown,
    timeoutMs?: number,
  ): Promise<T> => {
    const body = raw as { phase: string; timeoutMs: number };
    if (path === "phase")
      phases.push({
        phase: body.phase,
        bodyTimeout: body.timeoutMs,
        httpTimeout: timeoutMs,
      });
    if (path === "cancel") cancelTimeout = timeoutMs;
    return original<T>(path, raw, timeoutMs);
  };
  await s.execution.execute(s.task.id);
  expect(phases.length).toBeGreaterThan(0);
  for (const p of phases) {
    expect(p.httpTimeout).toBe(p.bodyTimeout);
    expect(p.httpTimeout).toBeLessThanOrEqual(1800000);
  }
  expect(cancelTimeout).toBe(20000);
});

it("開發、修復與審查取得相同可信來源 SHA，不以容器本機 commit 冒充遠端版本", async () => {
  const s = await scenario();
  const base = "1234567890abcdef1234567890abcdef12345678";
  s.github.base = async () => base;
  const original = s.runner.call.bind(s.runner);
  const versions: unknown[] = [];
  let tests = 0;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string; job?: { prompt?: string } };
    if (["code", "review"].includes(body.phase ?? ""))
      versions.push(JSON.parse(body.job!.prompt!).sourceVersion);
    const result = await original<PhaseResult>(path, raw);
    if (body.phase === "test" && tests++ === 0) result.exitCode = 1;
    return result as T;
  };
  await s.execution.execute(s.task.id);
  const project = await db.one<Project>("SELECT * FROM projects WHERE id=$1", [
    s.task.project_id,
  ]);
  expect(versions).toEqual(
    Array.from({ length: 3 }, () => ({
      repository: project.repo,
      baseBranch: project.base_branch,
      baseCommit: base,
      note: expect.stringContaining(`${project.base_branch} 分支在 ${base}`),
    })),
  );
  expect(
    (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [s.task.id]))
      .base_sha,
  ).toBe(base);
  expect(s.counts().published).toBe(1);
});

async function imageScenario() {
  const s = await scenario();
  const data = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#127c88" },
  })
    .png()
    .toBuffer();
  await db.query(
    "INSERT INTO messages(id,group_id,type,image,image_mime) VALUES('source-image','group-a','image',$1,'image/png')",
    [data],
  );
  await db.query(
    "UPDATE tasks SET source_ids=ARRAY['source-image'] WHERE id=$1",
    [s.task.id],
  );
  const t = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [s.task.id]);
  await saveTaskImageRefs(db.pool, t, await db.query("SELECT * FROM messages"));
  return { ...s, data };
}

async function selectedTextScenario() {
  const s = await scenario(),
    content = "青鳥欄位已確認最小寬度為 397px";
  await db.query(
    "INSERT INTO messages(id,group_id,type,text,received_at,processed) VALUES('selected-text','group-a','text',$1,now()-interval '7 days',true)",
    [content],
  );
  await db.query(
    "UPDATE tasks SET source_ids=ARRAY['selected-text'] WHERE id=$1",
    [s.task.id],
  );
  await recordContextEvidence(db.pool, s.task.id, "triage-selected", [
    {
      mechanism: "vector",
      source_kind: "message",
      source_id: "selected-text",
      source_hash: imageHash(Buffer.from(content, "utf8")),
    },
  ]);
  return s;
}

it("採用的 RAG 文字在審查期間撤回，晚到成功結果不可發布", async () => {
  const s = await selectedTextScenario(),
    original = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if ((raw as { phase?: string }).phase === "review")
      await s.line.ingest({
        events: [
          {
            webhookEventId: "withdraw-selected-text",
            type: "unsend",
            source: { type: "group", groupId: "group-a" },
            unsend: { messageId: "selected-text" },
          },
        ],
      });
    return original<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  expect(s.counts().published).toBe(0);
  expect((await db.one<Task>("SELECT * FROM tasks"))!.status).toBe(
    "awaiting_approval",
  );
});

it.each(["到期", "變更"])(
  "採用的 RAG 文字在發布前%s，最後 guard 阻止遠端寫入",
  async (kind) => {
    const s = await selectedTextScenario();
    let remoteWrites = 0;
    s.github.publish = async (_p, _t, _f, _r, guard) => {
      await db.query(
        kind === "到期"
          ? "UPDATE messages SET received_at=now()-interval '31 days' WHERE id='selected-text'"
          : "UPDATE messages SET text='青鳥欄位改成 800px' WHERE id='selected-text'",
      );
      await guard?.();
      remoteWrites++;
      return {
        number: 2,
        html_url: "https://github.com/test/repo/pull/2",
      } as Awaited<ReturnType<GitHub["publish"]>>;
    };
    await s.execution.execute(s.task.id);
    expect(remoteWrites).toBe(0);
    expect((await db.one<Task>("SELECT * FROM tasks"))!.last_error).toContain(
      kind,
    );
  },
);

it("B02：開發、唯一一次修復及獨立審查取得同一版有效原圖", async () => {
  const s = await imageScenario(),
    original = s.runner.call.bind(s.runner);
  const inputs: unknown[] = [];
  let tests = 0;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase: string; job?: { images: unknown } };
    if (body.phase === "code" || body.phase === "review")
      inputs.push(body.job?.images);
    const result = await original<PhaseResult>(path, raw);
    if (body.phase === "test" && tests++ === 0) result.exitCode = 1;
    return result as T;
  };
  await s.execution.execute(s.task.id);
  expect(s.counts()).toEqual({ published: 1, testCalls: 2, codeCalls: 2 });
  expect(inputs).toHaveLength(3);
  expect(inputs[0]).toEqual(inputs[1]);
  expect(inputs[1]).toEqual(inputs[2]);
  expect(inputs[0]).toEqual([
    expect.objectContaining({
      id: "source-image",
      sha256: imageHash(s.data),
      data: s.data.toString("base64"),
      origin: "direct",
    }),
  ]);
});

it("B09：審查期間原圖撤回，晚到成功結果不能發布", async () => {
  const s = await imageScenario(),
    original = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if ((raw as { phase?: string }).phase === "review")
      await s.line.ingest({
        events: [
          {
            webhookEventId: "withdraw-during-review",
            type: "unsend",
            source: { type: "group", groupId: "group-a" },
            unsend: { messageId: "source-image" },
          },
        ],
      });
    return original<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  expect(s.counts().published).toBe(0);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe(
    "awaiting_approval",
  );
  expect(
    (await db.one("SELECT image FROM messages WHERE id='source-image'")).image,
  ).toBeNull();
});

it("C11：發布前圖片到期，可信發布服務的最後檢查拒絕內容", async () => {
  const s = await imageScenario();
  let remoteWrites = 0;
  s.github.publish = async (_p, _t, _f, _r, guard) => {
    await db.query(
      "UPDATE messages SET received_at=now()-interval '31 days' WHERE id='source-image'",
    );
    await guard?.();
    remoteWrites++;
    return {
      number: 2,
      html_url: "https://github.com/test/repo/pull/2",
    } as Awaited<ReturnType<GitHub["publish"]>>;
  };
  await s.execution.execute(s.task.id);
  expect(remoteWrites).toBe(0);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).not.toBe("ready");
});
it("派工使用記錄的基底與快取介面，不再下載整包封存檔", async () => {
  const s = await scenario();
  const access = {
    repo: "test/repo",
    sha: "base-sha",
    repositoryId: 1,
    installationId: 1,
    token: "假的唯讀憑證",
  };
  s.github.sourceAccess = vi.fn(async (_project, sha) => ({ ...access, sha }));
  s.github.archive = vi.fn(async () => {
    throw new Error("不應重新下載封存檔");
  });
  s.runner.prepareSource = vi.fn(async () => ({
    cache: "hit" as const,
    sha: "base-sha",
    snapshotHit: true,
    fetchMs: 0,
    snapshotMs: 0,
    copyMs: 10,
    totalMs: 10,
    addedObjectBytes: 0,
  }));
  await s.execution.execute(s.task.id);
  expect(s.runner.prepareSource).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    access,
    expect.any(Number),
  );
  expect(s.github.archive).not.toHaveBeenCalled();
  expect(s.counts().published).toBe(1);
});
it("即使有快取，GitHub 存取權失效也不允許執行", async () => {
  const s = await scenario();
  s.github.sourceAccess = async () => {
    throw new Error("儲存庫存取權已撤銷");
  };
  s.runner.prepareSource = vi.fn();
  await s.execution.execute(s.task.id);
  expect(s.runner.prepareSource).not.toHaveBeenCalled();
  expect(s.counts().codeCalls).toBe(0);
  expect((await db.one<Task>("SELECT * FROM tasks")).last_error).toContain(
    "存取權已撤銷",
  );
});
it("取得快取下載授權期間需求版本改變，不建立工作副本", async () => {
  const s = await scenario();
  s.github.sourceAccess = async () => {
    await db.query("UPDATE tasks SET version=version+1 WHERE id=$1", [
      s.task.id,
    ]);
    return {
      repo: "test/repo",
      sha: "base-sha",
      repositoryId: 1,
      installationId: 1,
      token: "假的唯讀憑證",
    };
  };
  s.runner.prepareSource = vi.fn();
  await s.execution.execute(s.task.id);
  expect(s.runner.prepareSource).not.toHaveBeenCalled();
  expect(s.counts().published).toBe(0);
});
it("準備專案失敗保存實際階段與獨立結束結果，不捏造 Codex 對話", async () => {
  const s = await scenario();
  s.github.archive = async () => {
    throw new Error("封存檔下載停滯超過 60 秒");
  };
  await s.execution.execute(s.task.id);
  const detail = await new Tasks(db).detail(s.task.id);
  expect(detail.runs[0]).toMatchObject({
    status: "archive",
    outcome: "failed",
    observed: true,
    threads: [],
  });
  const events = await new Tasks(db).runEvents(
    s.task.id,
    String(detail.runs[0].id),
  );
  expect(events.events).toContainEqual(
    expect.objectContaining({
      phase: "archive",
      kind: "error",
      detail: expect.stringContaining("下載停滯"),
    }),
  );
  expect(s.counts().codeCalls).toBe(0);
});
it("進度連線失敗不阻止開發，恢復後保存事件並去重", async () => {
  const s = await scenario(),
    original = s.runner.call.bind(s.runner);
  let polls = 0;
  const streamed = {
    seq: 1,
    at: new Date().toISOString(),
    phase: "code",
    kind: "thread",
    threadId: "01234567-89ab-4def-8123-456789abcdef",
  };
  s.runner.observations = async () => {
    if (++polls === 1) throw new Error("連線中斷");
    return [streamed];
  };
  s.runner.call = async <T>(path: string, body: unknown): Promise<T> => {
    if (path === "phase" && (body as { phase: string }).phase === "code")
      await new Promise((resolve) => setTimeout(resolve, 4400));
    return original<T>(path, body);
  };
  await s.execution.execute(s.task.id);
  const detail = await new Tasks(db).detail(s.task.id);
  const events = await new Tasks(db).runEvents(
    s.task.id,
    String(detail.runs[0].id),
  );
  expect(detail.runs[0].outcome).toBe("ready");
  expect(
    events.events.filter((e: Record<string, unknown>) => e.kind === "thread"),
  ).toHaveLength(1);
  expect(events.events).toContainEqual(
    expect.objectContaining({ kind: "observer_error" }),
  );
  expect(events.events).toContainEqual(
    expect.objectContaining({ kind: "observer_restored" }),
  );
});
it("測試修改候選內容時不得發布", async () => {
  const s = await scenario();
  s.change({ mutateCandidate: true });
  await s.execution.execute(s.task.id);
  expect(s.counts().published).toBe(0);
  expect((await db.one<Task>("SELECT * FROM tasks")).last_error).toContain(
    "候選檔案",
  );
});
it("驗證失敗只修復一次", async () => {
  const s = await scenario();
  s.change({ failTests: true });
  await s.execution.execute(s.task.id);
  expect(s.counts()).toEqual({ published: 0, testCalls: 2, codeCalls: 2 });
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("failed");
});
it("GitHub 請求進行中取消任務，不會被完成回覆覆蓋，並通知遠端結果", async () => {
  const s = await scenario();
  s.change({ cancelDuringPublish: true });
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("cancelled");
  expect(
    (await db.query("SELECT * FROM notifications WHERE kind='publish_race'"))
      .length,
  ).toBe(1);
});
it("原先有風險理由也不代表核准所有敏感檔案", async () => {
  const s = await scenario();
  s.change({ sensitive: true });
  await db.query("UPDATE tasks SET risk_reasons='[\"需要人工審核\"]'");
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("awaiting_approval");
  expect(task.pending_paths).toEqual(["server/auth.ts"]);
  expect(s.counts().published).toBe(0);
});
it("安裝與基底測試都通過後才自動啟用專案，清除舊錯誤", async () => {
  const s = await scenario();
  await db.query(
    "UPDATE projects SET enabled=false,validated_at=NULL,validation_error='上次驗證失敗'",
  );
  const project = await db.one<Project>("SELECT * FROM projects");
  const call = s.runner.call.bind(s.runner);
  const phases: string[] = [];
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (path === "phase") {
      phases.push((raw as { phase: string }).phase);
      const current = await db.one<Project>("SELECT * FROM projects");
      expect(current.enabled).toBe(false);
      expect(current.validated_at).toBeNull();
    }
    return call<T>(path, raw);
  };
  await s.execution.validate(project);
  expect(phases).toEqual(["install", "test"]);
  const after = await db.one<Project>("SELECT * FROM projects");
  expect(after.enabled).toBe(true);
  expect(after.validated_at).not.toBeNull();
  expect(after.validation_error).toBeNull();
  s.runner.call = call;
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
});
it("專案驗證達到個人保留上限時保留原狀，額度恢復後可繼續驗證", async () => {
  const s = await scenario();
  await db.query(
    `UPDATE settings SET value=value||'{"ai_mode":"subscription","codex_reserve_percent":60}'::jsonb WHERE id=1`,
  );
  await db.query("DELETE FROM service_health WHERE name=$1", [
    subscriptionGateName,
  ]);
  let usedPercent = 40;
  s.runner.account = async () => ({
    allowed: true,
    checkedAt: new Date().toISOString(),
    limits: [{ windows: [{ usedPercent, resetsAt: null }] }],
  });
  const execution = new Execution(db, s.github, s.line, s.budget, s.runner);
  const project = await db.one<Project>("SELECT * FROM projects");
  expect(await execution.validate(project)).toEqual({
    ok: false,
    quota: expect.stringContaining("已用到 chat2pr 可用的上限（保留 60% 給你）"),
  });
  const held = await db.one<Project>("SELECT * FROM projects");
  expect(held.setup_status).toContain(
    "已用到 chat2pr 可用的上限（保留 60% 給你）",
  );
  expect(held.enabled).toBe(project.enabled);
  expect(held.validated_at).toEqual(project.validated_at);
  expect(held.validation_error).toBeNull();
  expect(s.counts().testCalls).toBe(0);

  usedPercent = 39;
  await db.query(
    "UPDATE service_health SET checked_at=now()-interval '2 minutes' WHERE name=$1",
    [subscriptionGateName],
  );
  expect(await execution.validate(held)).toEqual({ ok: true });
  expect(s.counts().testCalls).toBe(1);
});
it.each(["install", "test"])(
  "%s 階段失敗時不會自動啟用，並清理驗證資源",
  async (failedPhase) => {
    const s = await scenario();
    await db.query("UPDATE projects SET enabled=false,validated_at=NULL");
    const project = await db.one<Project>("SELECT * FROM projects");
    const call = s.runner.call.bind(s.runner);
    const paths: string[] = [];
    s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
      paths.push(path);
      if (path === "phase" && (raw as { phase: string }).phase === failedPhase)
        return { exitCode: 1, stdout: "", stderr: "測試用失敗" } as T;
      return call<T>(path, raw);
    };
    await expect(s.execution.validate(project)).rejects.toThrow("失敗");
    const after = await db.one<Project>("SELECT * FROM projects");
    expect(after.enabled).toBe(false);
    expect(after.validated_at).toBeNull();
    expect(after.validation_error).toContain("測試用失敗");
    expect(paths.at(-1)).toBe("dispose");
  },
);
// 專案頁沒有「重試」按鈕也沒有任務的執行紀錄：驗證失敗要用白話分類、錯誤重點與專案頁找得到的建議。
it.each([
  {
    name: "安裝失敗",
    phase: "install",
    output:
      "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/@contoso%2fmissing",
    label: "環境問題（安裝階段）",
    key: "@contoso%2fmissing",
    advice: "進階設定改安裝指令或映像後按「驗證環境」",
  },
  {
    name: "測試失敗",
    phase: "test",
    output:
      "[xUnit.net 00:00:00.58]     Fictional.Tests.OrderTests.KeepsIdentity [FAIL]\nAssert.Equal() Failure\nFailed!  - Failed:     1, Passed:     5",
    label: "專案問題（測試階段）",
    key: "Failed:     1, Passed:     5",
    advice: "修好儲存庫的建置或測試，或在進階設定調整測試指令後重新驗證",
  },
  {
    name: "指令不存在",
    phase: "test",
    output: "sh: 1: dotnet: not found",
    label: "環境問題（測試階段）",
    key: "dotnet: not found",
    advice: "工作容器可能缺少此指令或工具鏈",
  },
])(
  "驗證$name：專案的錯誤說明有分類、錯誤重點與專案頁的建議，不以 Error: 開頭",
  async ({ phase, output, label, key, advice }) => {
    const s = await scenario();
    await db.query("UPDATE projects SET enabled=false,validated_at=NULL");
    const project = await db.one<Project>("SELECT * FROM projects");
    const call = s.runner.call.bind(s.runner);
    s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
      if (path === "phase" && (raw as { phase: string }).phase === phase)
        return { exitCode: 1, stdout: output, stderr: "" } as T;
      return call<T>(path, raw);
    };
    await expect(s.execution.validate(project)).rejects.toThrow("失敗");
    const error = (await db.one<Project>("SELECT * FROM projects"))
      .validation_error!;
    expect(error).not.toMatch(/^Error:/);
    expect(error.startsWith(label)).toBe(true);
    const [summary, digest] = error.split("\n\n--- 原始輸出摘要 ---\n");
    expect(summary).toContain("錯誤重點：");
    expect(summary).toContain(key);
    expect(summary).toContain("建議：");
    expect(summary).toContain(advice);
    // 任務用的建議在專案頁找不到對應按鈕。
    expect(summary).not.toMatch(/按「重試」|到執行紀錄/);
    // 原始輸出摘要仍附在後面，畫面可以收合顯示。
    expect(digest).toContain(output.split("\n")[0]);
  },
);
it("驗證時其他已整理過的錯誤照原文保存，只去掉 Error: 前綴、不再分類", async () => {
  const s = await scenario();
  await db.query("UPDATE projects SET test_command=''");
  await expect(
    s.execution.validate(await db.one<Project>("SELECT * FROM projects")),
  ).rejects.toThrow("尚未設定測試命令");
  const error = (await db.one<Project>("SELECT * FROM projects"))
    .validation_error!;
  expect(error.startsWith("尚未設定測試命令")).toBe(true);
  expect(error).not.toContain("系統發生預期外的錯誤");
});
it("驗證期間管理者停用專案，成功結果保留較新的停用選擇", async () => {
  const s = await scenario();
  const project = await db.one<Project>("SELECT * FROM projects");
  s.github.archive = async () => {
    await db.query("UPDATE projects SET enabled=false");
    return new Blob(["archive"]).stream();
  };
  await s.execution.validate(project);
  const after = await db.one<Project>("SELECT * FROM projects");
  expect(after.enabled).toBe(false);
  expect(after.validated_at).not.toBeNull();
});
it("驗證成功可啟用專案，但全域暫停仍會阻擋派工", async () => {
  const s = await scenario();
  await db.query("UPDATE projects SET enabled=false,validated_at=NULL");
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{paused}','true')",
  );
  await s.execution.validate(await db.one<Project>("SELECT * FROM projects"));
  expect((await db.one<Project>("SELECT * FROM projects")).enabled).toBe(true);
  expect((await db.settings()).paused).toBe(true);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  expect(s.counts().codeCalls).toBe(0);
});
it("專案通過環境驗證後排程該次驗證的基底版本", async () => {
  const s = await scenario(),
    p = await db.one<Project>("SELECT * FROM projects");
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{rag_enabled}','true')",
  );
  await s.execution.validate(p);
  expect(
    await db.one("SELECT project_id,wanted_sha,phase FROM repo_indexes"),
  ).toEqual({ project_id: p.id, wanted_sha: "base-sha", phase: "queued" });
});
it("重新驗證通過時，標成找不到儲存庫的專案接回、重新啟用並綁回群組", async () => {
  const s = await scenario();
  await syncProjectRepos(db, { locateRepo: async () => null });
  const missing = await db.one<Project>("SELECT * FROM projects");
  expect(missing.repo_missing_at).not.toBeNull();
  expect(await db.query("SELECT 1 FROM group_projects")).toHaveLength(0);
  await s.execution.validate(missing);
  const p = await db.one<Project>("SELECT * FROM projects");
  expect(p.repo_missing_at).toBeNull();
  expect(p.repo_missing_state).toBeNull();
  expect(p.validated_at).not.toBeNull();
  expect(p.enabled).toBe(true);
  expect(await db.query("SELECT 1 FROM group_projects")).toHaveLength(1);
  // 任務掛回專案，但仍要管理者重新核准才派工。
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("awaiting_approval");
  expect(task.project_id).toBe(p.id);
  expect(task.approved_version).toBeNull();
});
it("沒有測試命令時驗證失敗、停用專案並依儲存庫建議命令", async () => {
  const s = await scenario();
  await db.query("UPDATE projects SET test_command=''");
  const project = await db.one<Project>("SELECT * FROM projects");
  s.github.context = async () => ({
    branches: { names: ["main"], defaultBranch: "main", truncated: false },
    branchError: null,
    sha: "base-sha",
    paths: ["App.sln", "src/App/App.csproj"],
    files: {},
    truncated: false,
  });
  await expect(s.execution.validate(project)).rejects.toThrow(
    "尚未設定測試命令",
  );
  const after = await db.one<Project>("SELECT * FROM projects");
  expect(after.validated_at).toBeNull();
  expect(after.enabled).toBe(false);
  expect(after.validation_error).toContain("dotnet restore App.sln");
});
it("驗證期間修改專案設定，舊結果不能啟用新環境", async () => {
  const s = await scenario();
  const project = await db.one<Project>("SELECT * FROM projects");
  s.github.archive = async () => {
    await db.query(
      "UPDATE projects SET config_version=config_version+1,validated_at=NULL,enabled=false,validation_error='新版本尚未驗證'",
    );
    return new Blob(["archive"]).stream();
  };
  await expect(s.execution.validate(project)).rejects.toThrow("設定已變更");
  const after = await db.one<Project>("SELECT * FROM projects");
  expect(after.validated_at).toBeNull();
  expect(after.enabled).toBe(false);
  expect(after.validation_error).toBe("新版本尚未驗證");
});
it("快速重新啟動也會回收中斷工作，保留人工重試", async () => {
  const s = await scenario();
  const reservation = await s.budget.reserve(3, s.task.id);
  await db.query("UPDATE tasks SET status='running'");
  await db.query(
    "INSERT INTO runs(task_id,version,reservation_id,model,deadline) VALUES($1,1,$2,'gpt-6.1-sol',now()+interval '30 minutes')",
    [s.task.id, reservation],
  );
  await recoverInterrupted(db, s.runner, s.budget, s.line);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("failed");
  expect(
    (await db.query("SELECT * FROM runs WHERE completed_at IS NULL")).length,
  ).toBe(0);
});
it("中斷回收時執行器連不上：同一輪照樣排通知、更新佇列心跳，執行器恢復後下一輪收尾", async () => {
  const s = await scenario();
  const reservation = await s.budget.reserve(3, s.task.id);
  await db.query("UPDATE tasks SET status='running'");
  await db.query(
    "INSERT INTO runs(task_id,version,reservation_id,model,deadline,token_hash,proxy_active) VALUES($1,1,$2,'gpt-6.1-sol',now()+interval '30 minutes','fictional-hash',true)",
    [s.task.id, reservation],
  );
  await db.query("DELETE FROM service_health WHERE name='queue'");
  await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
  let runnerDown = true;
  const cancels: (number | undefined)[] = [];
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(
    path: string,
    raw: unknown,
    timeoutMs?: number,
  ): Promise<T> => {
    if (path === "cancel") {
      cancels.push(timeoutMs);
      if (runnerDown)
        throw new Error(
          "執行器連線失敗（ECONNREFUSED）；請檢查執行器、網路及逾時紀錄",
        );
    }
    if (path.startsWith("checks/environments")) return { removed: [] } as T;
    return call<T>(path, raw);
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("DATABASE_URL", db.pool.options.connectionString!);
  let jobs: Awaited<ReturnType<typeof startJobs>> | undefined;
  try {
    jobs = await startJobs(db, { runner: s.runner, github: s.github });
    // 取消只等 20 秒，不沿用執行的 30 分鐘期限。
    expect(cancels).toEqual([20000]);
    const queued = await db.query<{ name: string }>(
      "SELECT name FROM pgboss.job",
    );
    expect(queued.some((j) => j.name === "notifications")).toBe(true);
    expect(
      await db.one(
        "SELECT ok,checked_at>now()-interval '1 minute' AS fresh FROM service_health WHERE name='queue'",
      ),
    ).toEqual({ ok: true, fresh: true });
  } finally {
    await jobs?.stop();
    vi.unstubAllEnvs();
    warn.mockRestore();
  }
  // 憑證先收回；取消沒成功就保留未完成紀錄，任務也還沒被判定中斷。
  expect(
    await db.query(
      "SELECT proxy_active,token_hash FROM runs WHERE completed_at IS NULL",
    ),
  ).toEqual([{ proxy_active: false, token_hash: null }]);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("running");
  runnerDown = false;
  await recoverInterrupted(db, s.runner, s.budget, s.line);
  expect(
    await db.query("SELECT 1 FROM runs WHERE completed_at IS NULL"),
  ).toHaveLength(0);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("failed");
  expect(
    await db.query("SELECT 1 FROM notifications WHERE kind='interrupted'"),
  ).toHaveLength(1);
});
it("收尾時取消失敗留下的紀錄：任務已回答就只收尾，不通知「執行曾中斷」", async () => {
  const s = await scenario();
  await db.query("UPDATE tasks SET status='answered'");
  await db.query(
    "INSERT INTO runs(task_id,version,model,deadline,outcome) VALUES($1,1,'gpt-6.1-sol',now()+interval '30 minutes','answered')",
    [s.task.id],
  );
  await recoverInterrupted(db, s.runner, s.budget, s.line);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("answered");
  expect(
    await db.one(
      "SELECT outcome,completed_at IS NOT NULL AS completed FROM runs",
    ),
  ).toEqual({ outcome: "answered", completed: true });
  expect(
    await db.query("SELECT 1 FROM notifications WHERE kind='interrupted'"),
  ).toHaveLength(0);
  expect(
    await db.query("SELECT 1 FROM audit WHERE kind='interrupted'"),
  ).toHaveLength(0);
});
// 管理者按暫停、補登資料庫連線或時間到時，監看計時器會停掉容器，執行器只回「工作已取消」。
const stopDuringCode = (
  s: Awaited<ReturnType<typeof scenario>>,
  before: () => Promise<unknown>,
) => {
  const call = s.runner.call.bind(s.runner);
  let stopped = false;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (
      !stopped &&
      path === "phase" &&
      (raw as { phase?: string }).phase === "code"
    ) {
      stopped = true;
      await before();
      throw new AppError(409, "工作已取消");
    }
    return call<T>(path, raw);
  };
};
it("執行中系統暫停：工作放回排隊、不算失敗也不推失敗通知，恢復後重新派工", async () => {
  const s = await scenario();
  stopDuringCode(s, () =>
    db.query("UPDATE settings SET value=jsonb_set(value,'{paused}','true')"),
  );
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("queued");
  expect(task.last_error).toContain("恢復派工後自動繼續");
  expect(
    await db.query(
      "SELECT 1 FROM notifications WHERE kind IN ('failed','group_failed')",
    ),
  ).toHaveLength(0);
  expect(
    await db.query("SELECT 1 FROM audit WHERE kind='paused_requeue'"),
  ).toHaveLength(1);
  expect(
    await db.query("SELECT 1 FROM audit WHERE kind='auto_retry'"),
  ).toHaveLength(0);
  expect(
    await db.query("SELECT 1 FROM notifications WHERE kind='group_waiting'"),
  ).toHaveLength(1);
  // 執行紀錄仍留著原始訊息與真正的停止原因。
  expect(
    (
      await db.one<{ detail: string }>(
        "SELECT detail FROM run_events WHERE kind='error'",
      )
    ).detail,
  ).toMatch(/工作已取消[\s\S]*停止原因：系統已暫停派工/);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{paused}','false')",
  );
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(await db.query("SELECT 1 FROM runs")).toHaveLength(2);
});
it("執行中群組停用：說明是設定被變更，不是預期外的錯誤", async () => {
  const s = await scenario();
  stopDuringCode(s, () => db.query("UPDATE groups SET enabled=false"));
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("failed");
  expect(task.last_error).toContain("設定問題");
  expect(task.last_error).toContain("設定被變更");
  expect(task.last_error).not.toContain("預期外的錯誤");
  expect(
    (
      await db.one<{ detail: string }>(
        "SELECT detail FROM run_events WHERE kind='error'",
      )
    ).detail,
  ).toContain("停止原因：群組已停用");
});
it("執行中專案設定變更（config_version+1）：任務回到待確認並說明設定已變更，不推失敗", async () => {
  const s = await scenario();
  stopDuringCode(s, () =>
    db.query("UPDATE projects SET config_version=config_version+1"),
  );
  await s.execution.execute(s.task.id);
  // 資料庫觸發器先把任務改回待確認並寫下原因；執行結束時不能再蓋成「預期外的錯誤」或推失敗。
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("awaiting_approval");
  expect(task.last_error).toContain("專案設定已變更");
  expect(task.last_error).not.toContain("預期外的錯誤");
  expect(
    await db.query(
      "SELECT 1 FROM notifications WHERE kind IN ('failed','group_failed')",
    ),
  ).toHaveLength(0);
});
it("逾時訊息寫出設定的單次執行時間", async () => {
  const s = await scenario();
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{task_minutes}','5')",
  );
  const now = Date.now();
  stopDuringCode(s, async () => {
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60000);
  });
  try {
    await s.execution.execute(s.task.id);
  } finally {
    vi.restoreAllMocks();
  }
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("failed");
  expect(task.last_error).toContain("任務超過 5 分鐘限制");
  expect(task.last_error).not.toContain("30 分鐘限制");
  expect(task.last_error).toContain("縮小需求範圍");
  // 還沒收集到修改就逾時：沒有可接續的修改，不自動接續（#256）。
  expect(await autoResumes()).toEqual([]);
  expect(task.last_error).toContain("用掉最多時間的是");
});
/** 第 n 次進入指定階段時先做 before，再讓執行器丟出 error（模擬取消或逾時）。 */
const failPhase = (
  s: Awaited<ReturnType<typeof scenario>>,
  phase: string,
  nth: number,
  error: () => Error,
  before: () => Promise<unknown> = async () => {},
) => {
  const call = s.runner.call.bind(s.runner);
  let seen = 0;
  const jobs: Array<{ feedback?: string }> = [];
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string; job?: { feedback?: string } };
    if (path === "phase" && body.phase === "code") jobs.push(body.job ?? {});
    if (path === "phase" && body.phase === phase && ++seen === nth) {
      await before();
      throw error();
    }
    return call<T>(path, raw);
  };
  return jobs;
};
const timeout = () => new AppError(408, "執行超過時間限制");
/** 可控制的時鐘：把現在撥到這次執行的期限之後，再讓執行器回報逾時。 */
const pastDeadline = async () => {
  const run = await db.one<{ deadline: Date }>(
    "SELECT deadline FROM runs ORDER BY started_at DESC LIMIT 1",
  );
  vi.spyOn(Date, "now").mockReturnValue(run.deadline.getTime() + 1000);
};
const realClock = () => vi.restoreAllMocks();
const autoResumes = async () =>
  (
    await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='auto_resume' ORDER BY id",
    )
  ).map((a) => a.detail);
const failureNotices = () =>
  db.query(
    "SELECT kind FROM notifications WHERE kind IN ('failed','group_failed')",
  );
const attempts = async () =>
  (
    await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='attempt' ORDER BY id",
    )
  ).map((a) => a.detail);
it("獨立審查時系統暫停：恢復後沿用已收集的修改，從測試與審查接續，不重新修改", async () => {
  const s = await scenario();
  failPhase(
    s,
    "review",
    1,
    () => new AppError(409, "工作已取消"),
    () =>
      db.query("UPDATE settings SET value=jsonb_set(value,'{paused}','true')"),
  );
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{paused}','false')",
  );
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.counts()).toEqual({ published: 1, testCalls: 2, codeCalls: 1 });
  expect(s.applied).toEqual([
    [{ path: "src/button.ts", content: "YQ==", mode: "100644" }],
  ]);
  expect(await attempts()).toEqual([
    "開始程式修改",
    "沿用上一次已收集的修改，從測試與獨立審查接續",
  ]);
});
it("修復後的審查逾時：自動接續一次，沿用修復結果接續審查，不再多修一次", async () => {
  const s = await scenario();
  s.change({ failReviews: 1 });
  failPhase(s, "review", 2, timeout);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  expect(await failureNotices()).toEqual([]);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.counts()).toEqual({ published: 1, testCalls: 3, codeCalls: 2 });
  expect(s.applied).toHaveLength(1);
  expect((await attempts()).at(-1)).toBe(
    "沿用上一次已收集的修改，從測試與獨立審查接續",
  );
});
it("接續的修復結果仍未通過審查：不再多修一次，照常失敗", async () => {
  const s = await scenario();
  s.change({ failReviews: 3 });
  failPhase(s, "review", 2, timeout);
  await s.execution.execute(s.task.id);
  expect(await autoResumes()).toHaveLength(1);
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("failed");
  expect(task.last_error).toContain("仍沒有通過");
  expect(s.counts()).toEqual({ published: 0, testCalls: 3, codeCalls: 2 });
});
it("修復中逾時：自動接續時沿用第一次的修改與審查意見直接修復，不重做第一次修改與審查", async () => {
  const s = await scenario();
  s.change({ failReviews: 1 });
  const jobs = failPhase(s, "code", 2, timeout);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  // 群組收到的進度如實說明接下來是修復，而不是「接續測試與審查」。
  const progress = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE kind='group_resumed'",
  );
  expect(progress.text).toContain("修復");
  expect(progress.text).not.toContain("測試與審查");
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.reviews()).toBe(2);
  expect(s.applied).toHaveLength(1);
  expect(jobs).toHaveLength(3);
  expect(jobs[2].feedback).toContain("範例按鈕在深色主題仍是灰色");
  expect((await attempts()).at(-1)).toBe(
    "沿用上一次已收集的修改與審查意見，開始唯一一次自動修復",
  );
});
it("實際修改碰到敏感路徑：核准後沿用同一份修改接續測試與審查，不從基底重新修改", async () => {
  const s = await scenario();
  s.change({ sensitive: true });
  await s.execution.execute(s.task.id);
  const pending = await db.one<Task>("SELECT * FROM tasks");
  expect(pending.status).toBe("awaiting_approval");
  expect(pending.last_error).toContain("沿用這次的修改");
  await dashboardAction(s.task.id, "approve", pending.version);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.counts()).toEqual({ published: 1, testCalls: 1, codeCalls: 1 });
  expect(s.applied).toEqual([
    [{ path: "server/auth.ts", content: "YQ==", mode: "100644" }],
  ]);
  expect(s.publishedFiles).toEqual(s.applied);
});
const startedBases = async () =>
  (
    await db.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE kind='started' ORDER BY id",
    )
  ).map((a) => a.detail.slice(a.detail.lastIndexOf(" ") + 1));
it("安裝失敗後目標分支前進：重試改用目標分支最新的 commit，時間軸寫出新基底", async () => {
  const s = await scenario();
  const call = s.runner.call.bind(s.runner);
  let failInstall = true;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> =>
    path === "phase" && (raw as { phase?: string }).phase === "install" && failInstall
      ? ({ exitCode: 1, stdout: "", stderr: "npm ERR! 找不到虛構套件" } as T)
      : call<T>(path, raw);
  await s.execution.execute(s.task.id);
  const failed = await db.one<Task>("SELECT * FROM tasks");
  expect(failed.status).toBe("failed");
  failInstall = false;
  s.github.base = async () => "fixed-sha";
  await dashboardAction(s.task.id, "retry", failed.version);
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("ready");
  expect(task.base_sha).toBe("fixed-sha");
  expect(await startedBases()).toEqual(["base-sha", "fixed-sh"]);
});
it("有保留的修改時目標分支前進：接續仍用原基底，不換成新 commit", async () => {
  const s = await scenario();
  failPhase(s, "review", 1, timeout);
  await s.execution.execute(s.task.id);
  // 逾時且修改已保留：系統自動接續（#256），任務回到排隊，不用人按重試。
  const resumed = await db.one<Task>("SELECT * FROM tasks");
  expect(resumed.status).toBe("queued");
  s.github.base = async () => "moved-sha";
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("ready");
  expect(task.base_sha).toBe("base-sha");
  expect(s.applied).toHaveLength(1);
  expect(s.counts().codeCalls).toBe(1);
  expect(await startedBases()).toEqual(["base-sha", "base-sha"]);
});
it("敏感路徑送審期間目標分支前進：核准後仍用送審時的基底接續", async () => {
  const s = await scenario();
  s.change({ sensitive: true });
  await s.execution.execute(s.task.id);
  const pending = await db.one<Task>("SELECT * FROM tasks");
  expect(pending.status).toBe("awaiting_approval");
  s.github.base = async () => "moved-sha";
  await dashboardAction(s.task.id, "approve", pending.version);
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("ready");
  expect(task.base_sha).toBe("base-sha");
  expect(s.applied).toHaveLength(1);
  expect(await startedBases()).toEqual(["base-sha", "base-sha"]);
});
it("修復後仍未通過的修改不沿用：重試從目標分支重新修改", async () => {
  const s = await scenario();
  s.change({ failTests: true });
  await s.execution.execute(s.task.id);
  s.change({});
  await dashboardAction(
    s.task.id,
    "retry",
    (await db.one<Task>("SELECT * FROM tasks")).version,
  );
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.counts().codeCalls).toBe(3);
  expect(s.applied).toHaveLength(0);
});
it("需求換版後不沿用舊版收集的修改", async () => {
  const s = await scenario();
  failPhase(
    s,
    "review",
    1,
    () => new AppError(409, "工作已取消"),
    () =>
      db.query("UPDATE settings SET value=jsonb_set(value,'{paused}','true')"),
  );
  await s.execution.execute(s.task.id);
  await db.query(
    "UPDATE settings SET value=jsonb_set(value,'{paused}','false')",
  );
  await db.query(
    "UPDATE tasks SET version=version+1,approved_version=version+1",
  );
  await confirmTask(s.task.id);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.counts().codeCalls).toBe(2);
  expect(s.applied).toHaveLength(0);
});
/** 第一次執行在獨立審查時遇到系統暫停，再恢復派工：留下一份尚未判定的候選。 */
const pauseAtFirstReview = (s: Awaited<ReturnType<typeof scenario>>) =>
  failPhase(
    s,
    "review",
    1,
    () => new AppError(409, "工作已取消"),
    () =>
      db.query("UPDATE settings SET value=jsonb_set(value,'{paused}','true')"),
  );
const unpause = () =>
  db.query("UPDATE settings SET value=jsonb_set(value,'{paused}','false')");
it("寫回上一次的修改失敗：這份修改不再接續，重試從目標分支重新修改", async () => {
  const s = await scenario();
  pauseAtFirstReview(s);
  await s.execution.execute(s.task.id);
  await unpause();
  const apply = s.runner.applyCandidate!;
  let rejected = 0;
  s.runner.applyCandidate = async () => {
    rejected++;
    throw new AppError(400, "候選檔案路徑無效");
  };
  await s.execution.execute(s.task.id);
  const failed = await db.one<Task>("SELECT * FROM tasks");
  expect(failed.status).toBe("failed");
  s.runner.applyCandidate = apply;
  await dashboardAction(s.task.id, "retry", failed.version);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(rejected).toBe(1);
  expect(s.applied).toHaveLength(0);
  expect(s.counts().codeCalls).toBe(2);
});
it("寫回途中系統暫停：放回排隊，恢復後仍沿用同一份修改", async () => {
  const s = await scenario();
  pauseAtFirstReview(s);
  await s.execution.execute(s.task.id);
  await unpause();
  const apply = s.runner.applyCandidate!;
  s.runner.applyCandidate = async () => {
    s.runner.applyCandidate = apply;
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{paused}','true')",
    );
    throw new AppError(409, "工作已取消");
  };
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  await unpause();
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.applied).toHaveLength(1);
  expect(s.counts().codeCalls).toBe(1);
});
it("送審敏感路徑前需求被其他來源改版：舊修改不會被新版本沿用", async () => {
  const s = await scenario();
  s.change({ sensitive: true });
  // 收集結果寫入後、送審之前，來源訊息被編輯（與 message-sources.ts 相同的改版）。
  const query = db.query.bind(db);
  const spy = vi.spyOn(db, "query").mockImplementation((async (
    sql: string,
    params?: unknown[],
  ) => {
    const rows = await query(sql, params);
    if (
      sql.startsWith("UPDATE runs SET result=$2") &&
      String(params?.[1]).includes('"candidate"')
    ) {
      spy.mockRestore();
      await query(
        "UPDATE tasks SET status='awaiting_approval',approved_version=NULL,version=version+1,base_sha=NULL,branch=NULL,approved_paths='{}' WHERE id=$1",
        [s.task.id],
      );
    }
    return rows;
  }) as typeof db.query);
  await s.execution.execute(s.task.id);
  spy.mockRestore();
  const edited = await db.one<Task>("SELECT * FROM tasks");
  expect(edited.version).toBe(2);
  expect(edited.pending_paths).toEqual([]);
  await db.query(
    "UPDATE tasks SET status='queued',approved_version=version,approved_paths='{server/auth.ts}'",
  );
  await confirmTask(s.task.id);
  await s.execution.execute(s.task.id);
  expect(s.applied).toHaveLength(0);
  expect(s.counts().codeCalls).toBe(2);
});
it("寫回上一次的修改後重新安裝依賴，修改新增的套件在測試時可用", async () => {
  const s = await scenario();
  pauseAtFirstReview(s);
  await s.execution.execute(s.task.id);
  await unpause();
  // 上一次的修改新增了套件：寫回後沒有重新安裝，測試就找不到它。
  let missing = false;
  const apply = s.runner.applyCandidate!;
  s.runner.applyCandidate = async (...args) => {
    missing = true;
    return apply(...args);
  };
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string };
    if (path === "phase" && body.phase === "install") missing = false;
    if (path === "phase" && body.phase === "test" && missing)
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Cannot find module '範例套件'",
      } as T;
    return call<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.counts()).toEqual({ published: 1, testCalls: 2, codeCalls: 1 });
});
it("接續的執行在重新收集前逾時：修改仍保留，自動接續一次", async () => {
  const s = await scenario();
  pauseAtFirstReview(s);
  failPhase(s, "install", 2, timeout);
  await s.execution.execute(s.task.id);
  await unpause();
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  expect(await autoResumes()).toHaveLength(1);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.counts().codeCalls).toBe(1);
  expect(s.applied).toHaveLength(1);
});
it("逾時且修改已保留：自動接續一次、不通知失敗，群組與管理者收到進度，時間軸看得到自動接續", async () => {
  const s = await scenario();
  failPhase(s, "review", 1, timeout, pastDeadline);
  try {
    await s.execution.execute(s.task.id);
  } finally {
    realClock();
  }
  const resumed = await db.one<Task & { retry_at: Date | null }>(
    "SELECT * FROM tasks",
  );
  expect(resumed.status).toBe("queued");
  expect(resumed.retry_at).toBeNull();
  expect(await failureNotices()).toEqual([]);
  const progress = await db.query<{ kind: string; text: string }>(
    "SELECT kind,text FROM notifications WHERE kind IN ('group_resumed','auto_resume') ORDER BY kind",
  );
  expect(progress.map((p) => p.kind)).toEqual(["auto_resume", "group_resumed"]);
  expect(progress[1].text).toContain("已保留目前的修改");
  expect(progress[1].text).toContain("自動接續測試與審查");
  const [history] = await autoResumes();
  expect(history).toContain("自動接續");
  expect(history).toContain("需求版本 1，");
  expect(history).toContain("用掉最多時間的是");
  // 程序重啟（新的 Execution）後照資料庫的紀錄接續：不重新修改，測試與獨立審查照常再跑。
  await new Execution(db, s.github, s.line, s.budget, s.runner).execute(
    s.task.id,
  );
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.counts()).toEqual({ published: 1, testCalls: 2, codeCalls: 1 });
  expect(s.reviews()).toBe(1);
  expect(s.applied).toHaveLength(1);
  expect((await attempts()).at(-1)).toBe(
    "沿用上一次已收集的修改，從測試與獨立審查接續",
  );
});
it.each([
  {
    name: "測試與審查",
    setup: (s: Awaited<ReturnType<typeof scenario>>) =>
      failPhase(s, "review", 1, timeout),
    again: (s: Awaited<ReturnType<typeof scenario>>) =>
      failPhase(s, "review", 1, timeout),
    kept: "修改已保留",
    next: "從測試與獨立審查接續",
  },
  {
    name: "自動修復",
    setup: (s: Awaited<ReturnType<typeof scenario>>) => {
      s.change({ failReviews: 1 });
      return failPhase(s, "code", 2, timeout);
    },
    again: (s: Awaited<ReturnType<typeof scenario>>) =>
      failPhase(s, "code", 1, timeout),
    kept: "修改與審查意見已保留",
    next: "自動修復",
  },
])(
  "自動接續$name後又逾時：照 #246 的說明失敗，同一需求版本不再接續，重試仍沿用保留的修改",
  async ({ setup, again, kept, next }) => {
    const s = await scenario();
    setup(s);
    await s.execution.execute(s.task.id);
    expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
    again(s);
    await s.execution.execute(s.task.id);
    const failed = await db.one<Task>("SELECT * FROM tasks");
    expect(failed.status).toBe("failed");
    expect(failed.last_error).toContain(kept);
    expect(failed.last_error).toContain(next);
    expect(failed.last_error).not.toContain("縮小需求範圍");
    expect(primaryFix(parseFailure(failed.last_error))).toEqual({
      kind: "retry",
    });
    expect(
      (await failureNotices()).map((n) => (n as { kind: string }).kind).sort(),
    ).toEqual(["failed", "group_failed"]);
    expect(await autoResumes()).toHaveLength(1);
    await dashboardAction(s.task.id, "retry", failed.version);
    await s.execution.execute(s.task.id);
    expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
    expect(s.applied).toHaveLength(2);
    expect(s.counts().codeCalls).toBe(next === "自動修復" ? 2 : 1);
  },
);
it.each([
  {
    mode: "訂閱模式每日執行次數",
    reason: "今日執行次數已用完",
    prepare: async (s: Awaited<ReturnType<typeof scenario>>) => {
      await db.query(
        `UPDATE settings SET value=value||'{"ai_mode":"subscription","daily_runs":1}'::jsonb WHERE id=1`,
      );
      s.runner.account = async () => ({
        allowed: true,
        checkedAt: new Date().toISOString(),
      });
      return async () => {};
    },
  },
  {
    mode: "API 模式每日預算",
    reason: "今日預估額度不足",
    prepare: async () => () =>
      db.query(
        "INSERT INTO usage(model,input_tokens,cached_tokens,output_tokens,cost) VALUES('gpt-6.1-sol',0,0,0,13)",
      ),
  },
])(
  "$mode用完：不自動接續，照 #246 的說明失敗並寫出原因",
  async ({ prepare, reason }) => {
    const s = await scenario();
    const spend = await prepare(s);
    failPhase(s, "review", 1, timeout, spend);
    await new Execution(db, s.github, s.line, s.budget, s.runner).execute(
      s.task.id,
    );
    const failed = await db.one<Task>("SELECT * FROM tasks");
    expect(failed.status).toBe("failed");
    expect(failed.last_error).toContain("修改已保留");
    expect(failed.last_error).toContain(reason);
    expect(failed.last_error).toContain("沒有自動接續");
    expect(primaryFix(parseFailure(failed.last_error))).toEqual({
      kind: "retry",
    });
    const group = await db.one<{ text: string }>(
      "SELECT text FROM notifications WHERE kind='group_failed'",
    );
    expect(group.text).toContain(reason);
    expect(await autoResumes()).toEqual([]);
  },
);
it("失敗後重試、逾時自動接續、接續後又失敗：群組依序收到失敗、自動接續、新的失敗說明，每次失敗只一則", async () => {
  const s = await scenario();
  const groupMessages = async () =>
    (
      await db.query<{ kind: string; text: string }>(
        "SELECT kind,text FROM notifications WHERE task_id=$1 AND kind IN ('group_failed','group_resumed') ORDER BY created_at,id",
        [s.task.id],
      )
    ).map((n) => n.kind);
  // 1. 逾時時今日預算用完：沒有自動接續，任務失敗，群組收到失敗說明。
  failPhase(s, "review", 1, timeout, () =>
    db.query(
      "INSERT INTO usage(model,input_tokens,cached_tokens,output_tokens,cost) VALUES('gpt-6.1-sol',0,0,0,13)",
    ),
  );
  await s.execution.execute(s.task.id);
  const first = await db.one<Task>("SELECT * FROM tasks");
  expect(first.status).toBe("failed");
  expect(await groupMessages()).toEqual(["group_failed"]);
  // 2. 隔天（預算恢復）管理者重試，又逾時：這個版本還沒接續過，自動接續一次。
  await db.query("DELETE FROM usage");
  await dashboardAction(s.task.id, "retry", first.version);
  failPhase(s, "review", 1, timeout);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  expect(await groupMessages()).toEqual(["group_failed", "group_resumed"]);
  // 3. 接續的執行又逾時：已接續過，照常失敗，群組要收到新的失敗說明，不能停在「系統會自動接續」。
  failPhase(s, "review", 1, timeout);
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("failed");
  expect(await groupMessages()).toEqual([
    "group_failed",
    "group_resumed",
    "group_failed",
  ]);
  // 同一次失敗再處理一次（例如重複派工）不會多發一則。
  await s.execution.execute(s.task.id);
  expect(await groupMessages()).toHaveLength(3);
});
it.each([
  {
    change: "需求版本改變",
    apply: (id: string) =>
      db.query(
        "UPDATE tasks SET status='awaiting_approval',version=version+1,approved_version=NULL WHERE id=$1",
        [id],
      ),
    status: "awaiting_approval",
  },
  {
    change: "任務被取消",
    apply: (id: string) => new Tasks(db).action(id, "cancel", 1, "管理者"),
    status: "cancelled",
  },
])("逾時前$change：不自動接續", async ({ apply, status }) => {
  const s = await scenario();
  failPhase(s, "review", 1, timeout, () => apply(s.task.id));
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe(status);
  expect(await autoResumes()).toEqual([]);
  expect(
    await db.query("SELECT 1 FROM notifications WHERE kind='group_resumed'"),
  ).toHaveLength(0);
});
it("任務詳情的執行紀錄帶各階段的進入時間，分得出修改與自動修復", async () => {
  const s = await scenario();
  s.change({ failReviews: 1 });
  await s.execution.execute(s.task.id);
  const { buildApp } = await import("../server/app.js");
  const app = await buildApp(db);
  try {
    const detail = (
      await app.inject({
        url: `/api/tasks/${s.task.id}`,
        headers: await session(),
      })
    ).json();
    const [run] = detail.runs as RunView[];
    expect(
      phaseDurations(run.phases!, run.completed_at!).map((p) => p.label),
    ).toEqual(["準備", "測試", "修改", "審查", "修復", "建立 PR"]);
    expect(
      run.phases!.filter((p) => p.detail === repairPhaseDetail),
    ).toMatchObject([{ phase: "code" }]);
  } finally {
    await app.close();
  }
});
it("被自動接續的那次執行，執行紀錄的結果是「逾時，已自動接續」而不是排隊中", async () => {
  const s = await scenario();
  failPhase(s, "review", 1, timeout);
  await s.execution.execute(s.task.id);
  await s.execution.execute(s.task.id);
  const { buildApp } = await import("../server/app.js");
  const app = await buildApp(db);
  try {
    const detail = (
      await app.inject({
        url: `/api/tasks/${s.task.id}`,
        headers: await session(),
      })
    ).json();
    const outcomes = (detail.runs as RunView[])
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .map((r) => r.outcome);
    expect(outcomes).toEqual(["auto_resumed", "ready"]);
  } finally {
    await app.close();
  }
});
it("同一次逾時被重複處理：只接續一次", async () => {
  const s = await scenario();
  const run = await db.one<{ id: string }>(
    "INSERT INTO runs(task_id,version,model,deadline) VALUES($1,1,'測試模型',now()) RETURNING id",
    [s.task.id],
  );
  await db.query("UPDATE tasks SET status='reviewing' WHERE id=$1", [
    s.task.id,
  ]);
  const claim = () =>
    claimAutoResume(db, s.task.id, run.id, {
      lastError: "修改已保留，系統已自動接續",
      detail: (v) => `自動接續（需求版本 ${v}，每個版本一次）`,
      shortfall: async () => "",
    });
  const claims = await Promise.all([claim(), claim(), claim()]);
  expect(claims.filter((c) => c.claimed)).toHaveLength(1);
  expect(await autoResumes()).toHaveLength(1);
  // 接續的執行又回到執行中：同一需求版本已接續過，不再排第二次。
  await db.query("UPDATE tasks SET status='reviewing' WHERE id=$1", [
    s.task.id,
  ]);
  expect(await claim()).toEqual({ claimed: false, used: true });
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("reviewing");
});
it("修復後仍未通過、記錄結論前中斷：這份修改不再接續", async () => {
  const s = await scenario();
  s.change({ failTests: true });
  const query = db.query.bind(db);
  let verifies = 0;
  const spy = vi.spyOn(db, "query").mockImplementation((async (
    sql: string,
    params?: unknown[],
  ) => {
    if (
      sql === "UPDATE runs SET status=$2 WHERE id=$1" &&
      params?.[1] === "verify" &&
      ++verifies === 2
    )
      throw new Error("範例：執行紀錄寫入中斷");
    return query(sql, params);
  }) as typeof db.query);
  await s.execution.execute(s.task.id);
  spy.mockRestore();
  s.change({});
  await dashboardAction(
    s.task.id,
    "retry",
    (await db.one<Task>("SELECT * FROM tasks")).version,
  );
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.applied).toHaveLength(0);
  expect(s.counts().codeCalls).toBe(3);
});
it("SQL Server 複驗未通過時剛好暫停：恢復後不沿用沒通過複驗的修改", async () => {
  const s = await scenario();
  const call = s.runner.call.bind(s.runner);
  let reviews = 0;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string };
    if (path === "phase" && body.phase === "review" && ++reviews === 1) {
      await db.query(
        "UPDATE settings SET value=jsonb_set(value,'{paused}','true')",
      );
      return {
        exitCode: 1,
        stdout: "",
        stderr: "範例資料表缺少欄位",
        sqlReviewFailure: true,
      } as T;
    }
    return call<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  await unpause();
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
  expect(s.applied).toHaveLength(0);
  expect(s.counts().codeCalls).toBe(2);
});
it("核對遠端 PR 時取消，不會被舊結果覆蓋", async () => {
  const s = await scenario();
  await db.query("UPDATE tasks SET branch='agentflow/test-v1'");
  s.github.findPr = async () => {
    await new Tasks(db).action(s.task.id, "cancel", 1, "管理者");
    return {
      number: 2,
      html_url: "https://github.com/test/repo/pull/2",
      state: "open",
      merged_at: null,
    } as Awaited<ReturnType<GitHub["findPr"]>>;
  };
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("cancelled");
});
it("撤回換版會清除舊分支，重新審核不能復用舊 PR", async () => {
  const s = await scenario();
  await db.query(
    "UPDATE tasks SET source_ids=ARRAY['withdrawn'],branch='agentflow/test-v1',base_sha='old',status='reviewing'",
  );
  await s.line.ingest({
    events: [
      {
        webhookEventId: "unsend",
        type: "unsend",
        source: { type: "group", groupId: "group-a" },
        unsend: { messageId: "withdrawn" },
      },
    ],
  });
  const t = await db.one<Task>("SELECT * FROM tasks");
  expect(t.version).toBe(2);
  expect(t.branch).toBe(null);
  expect(t.base_sha).toBe(null);
  expect(t.status).toBe("awaiting_approval");
});
it("新版需求同步回同一張 Issue 的摘要與驗收條件", async () => {
  const s = await scenario(),
    github = new GitHub();
  const update = vi.fn(async () => ({
    data: { number: 7, html_url: "https://github.com/test/repo/issues/7" },
  }));
  github.client = () =>
    ({ issues: { update } }) as unknown as ReturnType<GitHub["client"]>;
  await github.ensureIssue(await db.one<Project>("SELECT * FROM projects"), {
    ...s.task,
    issue_number: 7,
    version: 2,
    summary: "新版需求",
    acceptance: ["新的驗收條件"],
  });
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      issue_number: 7,
      body: expect.stringContaining("新版需求"),
    }),
  );
  expect(update.mock.calls[0]).toBeTruthy();
});

it("審查失敗摘要先顯示原因，不被成功建置的長日誌截斷", async () => {
  const s = await scenario();
  const original = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const phase = (raw as { phase?: string }).phase;
    if (phase === "test")
      return {
        exitCode: 0,
        stdout: "建置成功\n".repeat(1500),
        stderr: "",
      } as T;
    if (phase === "review")
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          final: JSON.stringify({
            passed: false,
            findings: ["新增測試未執行，缺少通過證據"],
          }),
        }),
        stderr: "",
      } as T;
    return original<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("failed");
  expect(task.last_error).toContain("新增測試未執行，缺少通過證據");
  expect(s.counts().published).toBe(0);
  expect(s.counts().codeCalls).toBe(2);
});
it("查詢任務只執行調查，存下報告並通知，不收集變更、不測試、不開 PR", async () => {
  const s = await scenario();
  await db.query("UPDATE tasks SET mode='query',issue_number=7");
  await confirmTask(s.task.id);
  const phases: string[] = [];
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string; job?: { query?: boolean } };
    if (path === "phase" && body.phase) phases.push(body.phase);
    if (path === "phase" && body.phase === "code") {
      expect(body.job?.query).toBe(true);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          final: "## 先看重點\n\n進站會更新 WIP_LOT 與 WIP_HISTORY。",
        }),
        stderr: "",
      } as T;
    }
    return call<T>(path, raw);
  };
  const comments: string[] = [];
  s.github.commentIssue = async (_p, issue, body) => {
    comments.push(`#${issue} ${body}`);
  };
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("answered");
  expect(task.answer).toBe(
    "## 先看重點\n\n進站會更新 WIP_LOT 與 WIP_HISTORY。",
  );
  expect(phases).not.toContain("collect");
  expect(phases).not.toContain("test");
  expect(phases).not.toContain("review");
  expect(s.counts().published).toBe(0);
  expect(comments).toHaveLength(1);
  // Issue 編號由測試替身決定，只核對留言直接從「先看重點」開始。
  expect(comments[0]).toMatch(/^#\d+ ## 先看重點/);
  expect(comments[0]).toContain("WIP_LOT");
  expect(comments[0]).not.toContain(task.base_sha!);
  const groupReply = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE kind='group_answered' AND task_id=$1",
    [task.id],
  );
  expect(groupReply.text).toContain("WIP_LOT");
  expect(groupReply.text).not.toContain(task.base_sha!);
  expect(
    (
      await db.one<{ text: string }>(
        "SELECT text FROM notifications WHERE kind='answered'",
      )
    ).text,
  ).toContain("查詢完成");
});
it("查詢任務沒有產生回覆時視為失敗，不會標成已回覆", async () => {
  const s = await scenario();
  await db.query("UPDATE tasks SET mode='query'");
  await confirmTask(s.task.id);
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> =>
    path === "phase" && (raw as { phase?: string }).phase === "code"
      ? ({
          exitCode: 0,
          stdout: JSON.stringify({ final: "  " }),
          stderr: "",
        } as T)
      : call<T>(path, raw);
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("failed");
  expect(task.last_error).toContain("沒有產生調查結果");
});
it.each([false, true])(
  "報告和附件一起發布，重複執行不留重複附件；取消=%s",
  async (cancel) => {
    const s = await scenario();
    await db.query("UPDATE tasks SET mode='query'");
    await confirmTask(s.task.id);
    const data = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const call = s.runner.call.bind(s.runner);
    s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
      if (path === "phase" && (raw as { phase?: string }).phase === "code") {
        if (cancel)
          await new Tasks(db).action(s.task.id, "cancel", 1, "管理者");
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            final:
              "## 先看重點\n機台編號負責對應。\n\n## 詳細資訊\n![圖說](report:img-1)",
            reportImages: [
              {
                key: "img-1",
                kind: "repository",
                source: "docs/result.png",
                caption: "圖說",
                mime: "image/png",
                data: data.toString("base64"),
              },
            ],
          }),
        } as T;
      }
      return call<T>(path, raw);
    };
    await s.execution.execute(s.task.id);
    await s.execution.execute(s.task.id);
    const task = await db.one<Task>("SELECT * FROM tasks");
    expect(task.status).toBe(cancel ? "cancelled" : "answered");
    expect(await db.query("SELECT id FROM query_report_images")).toHaveLength(
      cancel ? 0 : 1,
    );
    if (!cancel) {
      expect(task.answer).toContain("report:img-1");
      expect(
        (
          await db.one<{ text: string }>(
            "SELECT text FROM notifications WHERE kind='answered'",
          )
        ).text,
      ).toContain("機台編號負責對應。");
      expect(
        (
          await db.one<{ text: string }>(
            "SELECT text FROM notifications WHERE kind='answered'",
          )
        ).text,
      ).not.toContain("report:img-1");
    }
  },
);
it("另一個工作仍佔用執行位置時保持排隊，不算失敗也不重複通知", async () => {
  const s = await scenario();
  const other = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key) SELECT project_id,group_id,'舊工作','舊工作','[]','running',1,'old-run' FROM tasks LIMIT 1 RETURNING id",
  );
  await db.query(
    "INSERT INTO runs(task_id,version,model,deadline) VALUES($1,1,'gpt-6.1-sol',now()+interval '30 minutes')",
    [other.id],
  );
  for (let i = 0; i < 3; i++) await s.execution.execute(s.task.id);
  expect(
    (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [s.task.id])).status,
  ).toBe("queued");
  expect(
    await db.query("SELECT * FROM notifications WHERE task_id=$1", [s.task.id]),
  ).toHaveLength(0);
});
it("附件寫入失敗會回復整份報告，經管理 API 重試後只發布完整的一份", async () => {
  const s = await scenario();
  await db.query("UPDATE tasks SET mode='query'");
  await confirmTask(s.task.id);
  const data = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> =>
    path === "phase" && (raw as { phase?: string }).phase === "code"
      ? ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            final:
              "## 先看重點\n查詢完成。\n\n## 詳細資訊\n![圖](report:img-1)",
            reportImages: [
              {
                key: "img-1",
                kind: "repository",
                source: "docs/view.png",
                caption: "圖",
                mime: "image/png",
                data: data.toString("base64"),
              },
            ],
          }),
        } as T)
      : call<T>(path, raw);
  await db.query(
    "CREATE FUNCTION fail_report_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '模擬圖片寫入失敗'; END $$",
  );
  await db.query(
    "CREATE TRIGGER fail_report_fixture BEFORE INSERT ON query_report_images FOR EACH ROW EXECUTE FUNCTION fail_report_fixture()",
  );
  try {
    await s.execution.execute(s.task.id);
    expect((await db.one<Task>("SELECT * FROM tasks")).answer).toBeNull();
    expect(await db.query("SELECT id FROM query_report_images")).toHaveLength(
      0,
    );
    expect(
      await db.query("SELECT 1 FROM notifications WHERE kind='answered'"),
    ).toHaveLength(0);
  } finally {
    await db.query("DROP TRIGGER fail_report_fixture ON query_report_images");
    await db.query("DROP FUNCTION fail_report_fixture()");
  }
  await new Tasks(db).action(s.task.id, "retry", 1, "管理者");
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("answered");
  expect(await db.query("SELECT id FROM query_report_images")).toHaveLength(1);
  expect(
    await db.query("SELECT 1 FROM notifications WHERE kind='answered'"),
  ).toHaveLength(1);
});

it.each(["change", "query"])(
  "%s 缺必要資訊時補問並清理，不發布結果；回答後仍須確認",
  async (mode) => {
    const s = await scenario();
    await db.query("UPDATE tasks SET mode=$2 WHERE id=$1", [s.task.id, mode]);
    await confirmTask(s.task.id);
    // 前置資料只模擬已確認的環境說明，透過執行器輸入觀察實際帶入內容。
    await db.query("UPDATE projects SET project_context=$1", [
      JSON.stringify({ environment: "測試使用隔離資料庫" }),
    ]);
    const original = s.runner.call.bind(s.runner);
    let cleaned = false,
      prompt = "";
    s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
      const body = raw as { phase: string; job?: { prompt: string } };
      if (path === "cancel") cleaned = true;
      if (body.phase === "code") {
        prompt = body.job!.prompt;
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            final:
              'AGENTFLOW_NEEDS_INPUT: {"questions":[{"kind":"information","question":"請提供去識別化測試資料的檔案位置"}]}',
          }),
        } as T;
      }
      return original<T>(path, raw);
    };
    await s.execution.execute(s.task.id);
    const pending = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      s.task.id,
    ]);
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.missing).toEqual(["請提供去識別化測試資料的檔案位置"]);
    expect(pending.approved_version).toBeNull();
    expect(pending.answer).toBeNull();
    expect(s.counts().published).toBe(0);
    expect(cleaned).toBe(true);
    expect(prompt).toContain("測試使用隔離資料庫");
    expect(
      await db.query(
        "SELECT id FROM notifications WHERE kind='input_required'",
      ),
    ).toHaveLength(1);
    expect(
      await db.query("SELECT id FROM runs WHERE completed_at IS NULL"),
    ).toHaveLength(0);
    const detail = await new Tasks(db).detail(s.task.id);
    expect(
      detail.contextEvidence.some(
        (e) => e.source_kind === "project_context" && e.valid,
      ),
    ).toBe(true);
    await expect(
      new Tasks(db).action(
        s.task.id,
        "amend",
        pending.version,
        "管理者",
        { summary: pending.summary, acceptance: pending.acceptance },
        "dashboard",
      ),
    ).rejects.toThrow("補充回答");
  },
);

it("審查員把「未發現缺陷」寫進 findings 也不擋發布；人工驗收提醒寫進 PR 的待人工確認", async () => {
  const s = await scenario();
  let report = "";
  s.github.publish = async (_p, _t, _files, body) => {
    report = body;
    return {
      number: 2,
      html_url: "https://github.com/test/repo/pull/2",
    } as Awaited<ReturnType<GitHub["publish"]>>;
  };
  const original = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const result = await original<T>(path, raw);
    if ((raw as { phase?: string }).phase === "review")
      return {
        ...(result as object),
        stdout: JSON.stringify({
          final: JSON.stringify({
            passed: false,
            findings: [
              "未發現阻擋發布的缺陷。已核對全部 8 檔完整差異；建置與 412 項單元測試通過。",
            ],
            notes: [
              "docs/checkinwip-validation.md 要求的 37 項產線人工驗收需由現場人員完成",
            ],
          }),
        }),
      } as T;
    return result;
  };
  await s.execution.execute(s.task.id);
  const task = await db.one<Task & { review_note: string }>(
    "SELECT * FROM tasks",
  );
  expect(task?.status).toBe("ready");
  expect(task?.review_note).toContain("獨立審查通過；待人工確認");
  expect(s.counts().codeCalls).toBe(1);
  expect(report).toContain("## 待人工確認");
  expect(report).toContain(
    "- [ ] docs/checkinwip-validation.md 要求的 37 項產線人工驗收",
  );
  const notice = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE kind='ready'",
  );
  expect(notice?.text).toContain("https://github.com/test/repo/pull/2");
});

it("審查判定只看阻擋問題", () => {
  expect(reviewVerdict({ passed: true, findings: [], notes: [] })).toEqual({
    passed: true,
    findings: [],
    notes: [],
  });
  expect(
    reviewVerdict({ passed: false, findings: ["沒有發現任何問題"] }),
  ).toMatchObject({ passed: true, findings: [] });
  expect(
    reviewVerdict({
      passed: true,
      findings: ["src/button.ts:12 按鈕仍是藍色，需改成綠色"],
      notes: ["", 3],
    }),
  ).toEqual({
    passed: false,
    findings: ["src/button.ts:12 按鈕仍是藍色，需改成綠色"],
    notes: [],
  });
  expect(reviewVerdict({ passed: true })).toMatchObject({ passed: false });
});

it("暫時性錯誤退避後自動重試一次、不先通知；仍失敗才回報並註明已自動重試", async () => {
  const s = await scenario();
  const original = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if ((raw as { phase?: string }).phase === "code")
      throw new Error(
        "執行器連線失敗（ECONNRESET）；請檢查執行器、網路及逾時紀錄",
      );
    return original<T>(path, raw);
  };
  const state = () =>
    db.one<Task & { waiting: boolean }>(
      "SELECT *,retry_at>now() AS waiting FROM tasks WHERE id=$1",
      [s.task.id],
    );
  const failures = () =>
    db.query(
      "SELECT 1 FROM notifications WHERE kind IN ('failed','group_failed')",
    );
  await s.execution.execute(s.task.id);
  expect(await state()).toMatchObject({ status: "queued", waiting: true });
  expect((await state()).last_error).toContain("30 秒後自動重試一次");
  expect(
    await db.query("SELECT detail FROM audit WHERE kind='auto_retry'"),
  ).toHaveLength(1);
  expect(await failures()).toHaveLength(0);
  // 退避期間不派工，也不另開執行。
  const runs = () => db.query("SELECT 1 FROM runs");
  await s.execution.execute(s.task.id);
  expect(await runs()).toHaveLength(1);
  expect((await state()).status).toBe("queued");

  await db.query("UPDATE tasks SET retry_at=now()-interval '1 second'");
  await s.execution.execute(s.task.id);
  const task = await state();
  expect(task.status).toBe("failed");
  expect(task.last_error).toContain("暫時性問題");
  expect(task.last_error).toContain("已自動重試一次");
  expect(await failures()).toHaveLength(2);
  const group = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE kind='group_failed'",
  );
  expect(group.text).toContain("系統已自動重試一次");
  expect(group.text).toContain("到看板按「重試」");
});

it("暫時性錯誤重試一次後成功時任務正常完成，稽核記下重試", async () => {
  const s = await scenario();
  const original = s.runner.call.bind(s.runner);
  let broken = true;
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if ((raw as { phase?: string }).phase === "code" && broken) {
      broken = false;
      return {
        exitCode: 1,
        stdout: "",
        stderr: codexSdkCrash("stream disconnected before completion"),
      } as T;
    }
    return original<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("queued");
  await db.query("UPDATE tasks SET retry_at=now()-interval '1 second'");
  await s.execution.execute(s.task.id);
  const task = await db.one<Task & { retry_at: Date | null }>(
    "SELECT * FROM tasks",
  );
  expect(task.status).toBe("ready");
  expect(task.retry_at).toBeNull();
  const retry = await db.one<{ detail: string }>(
    "SELECT detail FROM audit WHERE kind='auto_retry'",
  );
  expect(retry.detail).toContain("AI 服務回應中斷或逾時");
  expect(retry.detail).not.toContain("file:///");
  expect(
    await db.query(
      "SELECT 1 FROM notifications WHERE kind IN ('failed','group_failed')",
    ),
  ).toHaveLength(0);
});

it("自動重試仍經過派工檢查：同時執行已滿時保持排隊，不多開執行", async () => {
  const s = await scenario();
  const original = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if ((raw as { phase?: string }).phase === "code")
      throw new Error("執行器連線失敗（UND_ERR_HEADERS_TIMEOUT）");
    return original<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  await db.query(
    "UPDATE tasks SET retry_at=now()-interval '1 second';UPDATE settings SET value=jsonb_set(value,'{max_runs}','1')",
  );
  // 另一張任務佔住唯一的執行位置。
  const other = await db.one<{ id: string }>(
    "INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key) SELECT project_id,group_id,'另一張','另一張','[]','running',1,'other' FROM tasks LIMIT 1 RETURNING id",
  );
  await db.query(
    "INSERT INTO runs(id,task_id,version,model,deadline,workspace) VALUES(gen_random_uuid(),$1,1,'m',now()+interval '1 hour','w')",
    [other.id],
  );
  await s.execution.execute(s.task.id);
  expect(
    (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [s.task.id])).status,
  ).toBe("queued");
  expect(
    await db.query("SELECT 1 FROM runs WHERE task_id=$1", [s.task.id]),
  ).toHaveLength(1);
});

it("需要修正的錯誤不會自動重試", () => {
  expect(transientFailure("執行器連線失敗（UND_ERR_HEADERS_TIMEOUT）")).toBe(
    true,
  );
  expect(
    transientFailure("Codex 執行失敗：stream disconnected before completion"),
  ).toBe(true);
  expect(transientFailure("上游回應 503 Service Unavailable")).toBe(true);
  expect(transientFailure("驗證未通過，請修正：按鈕仍是藍色")).toBe(false);
  expect(transientFailure("建置設定 README.md 過大，請使用進階設定")).toBe(
    false,
  );
  expect(transientFailure("執行超過時間限制")).toBe(false);
});
async function queryScenario(installFailures = 0) {
  const s = await scenario();
  await db.query("UPDATE tasks SET mode='query'");
  await confirmTask(s.task.id);
  const prompts: string[] = [];
  let installs = 0;
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string; job?: { prompt: string } };
    if (path === "phase" && body.phase === "install") {
      installs++;
      if (installs <= installFailures)
        return { exitCode: 1, stdout: "", stderr: "MSB1001 未知參數" } as T;
    }
    if (path === "phase" && body.phase === "code") {
      prompts.push(body.job!.prompt);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ final: "兩邊欄位一致。" }),
        stderr: "",
      } as T;
    }
    return call<T>(path, raw);
  };
  return { ...s, prompts, installs: () => installs };
}
it("跨專案查詢把其他已綁定專案的原始碼唯讀提供，未綁定的不提供", async () => {
  const s = await queryScenario();
  const other = await db.one<Project>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('設備同步','test/MachineSync',true,now()) RETURNING *",
  );
  await db.query("INSERT INTO group_projects VALUES('group-a',$1,now())", [
    other.id,
  ]);
  const unbound = await db.one<Project>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('外部','test/Outside',true,now()) RETURNING *",
  );
  await db.query(
    "UPDATE tasks SET project_routing=project_routing || jsonb_build_object('relatedProjects',$1::jsonb)",
    [
      JSON.stringify([
        { id: other.id, name: other.name, repo: other.repo },
        { id: unbound.id, name: unbound.name, repo: unbound.repo },
      ]),
    ],
  );
  // 新增綁定會作廢舊確認，比照實際流程重新確認後再執行。
  await db.query("UPDATE tasks SET status='queued',approved_version=version");
  await confirmTask(s.task.id);
  const uploads: string[] = [];
  s.runner.uploadEnvironment = async (_run, _image, directory) => {
    uploads.push(directory);
  };
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("answered");
  expect(uploads).toEqual(["projects/MachineSync"]);
  const prompt = JSON.parse(s.prompts[0]);
  expect(prompt.relatedProjects).toEqual([
    expect.objectContaining({
      repo: "test/MachineSync",
      path: "/agentflow/env/projects/MachineSync",
    }),
  ]);
  expect(task.answer).not.toContain("一併查詢：");
  const run = await db.one<{ sources: { repo: string }[] }>(
    "SELECT result->'querySources' AS sources FROM runs WHERE task_id=$1",
    [task.id],
  );
  expect(run.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ repo: "test/MachineSync" }),
    ]),
  );
});
it("手動指定的參考專案在更換分支及核准後仍唯讀提供給查詢", async () => {
  const s = await queryScenario();
  const other = await db.one<Project>(
    "INSERT INTO projects(name,repo,enabled,validated_at) VALUES('示範後端','example/demo-backend',true,now()) RETURNING *",
  );
  await db.query(
    "INSERT INTO group_projects(group_id,project_id) VALUES('group-a',$1)",
    [other.id],
  );
  const pending = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  const assigned = await dashboardAction(
    pending.id,
    "assign",
    pending.version,
    {
      project_id: pending.project_id,
      related_project_ids: [other.id],
    },
  );
  const base = vi.spyOn(GitHub.prototype, "base").mockResolvedValue("demo-sha");
  try {
    const target = await dashboardAction(
      assigned.id,
      "target",
      assigned.version,
      {
        target_branch: "develop",
      },
    );
    const approved = await dashboardAction(
      target.id,
      "approve",
      target.version,
    );
    expect(approved).toMatchObject({
      status: "queued",
      target_branch: "develop",
    });
  } finally {
    base.mockRestore();
  }
  const uploaded: string[] = [];
  s.runner.uploadEnvironment = async (_run, _image, directory) => {
    uploaded.push(directory);
  };
  await s.execution.execute(pending.id);
  expect(
    (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [pending.id]))
      .status,
  ).toBe("answered");
  expect(uploaded).toEqual(["projects/demo-backend"]);
  expect(JSON.parse(s.prompts[0]).relatedProjects).toEqual([
    expect.objectContaining({
      name: other.name,
      repo: other.repo,
      path: "/agentflow/env/projects/demo-backend",
    }),
  ]);
});

it("交給 Codex 的版本資訊說明本機 master 只是紀錄，不要再連 GitHub 核對", async () => {
  const s = await queryScenario();
  await s.execution.execute(s.task.id);
  const prompt = JSON.parse(s.prompts[0]);
  expect(prompt.sourceVersion.note).toContain("不需要、也不要連線 GitHub");
  expect(prompt.interaction).toContain("不得貼出密碼");
});
it("安裝失敗自動重試一次；查詢重試仍失敗時改以閱讀程式回答", async () => {
  const once = await queryScenario(1);
  await once.execution.execute(once.task.id);
  expect(once.installs()).toBe(2);
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("answered");
  expect(JSON.parse(once.prompts[0]).installStatus).toBeUndefined();

  await reset();
  const twice = await queryScenario(2);
  await twice.execution.execute(twice.task.id);
  expect(twice.installs()).toBe(2);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("answered");
  expect(JSON.parse(twice.prompts[0]).installStatus).toContain(
    "以閱讀程式碼為主",
  );
});
it("修改任務安裝重試仍失敗就停止", async () => {
  const s = await scenario();
  let installs = 0;
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (path === "phase" && (raw as { phase?: string }).phase === "install") {
      installs++;
      return { exitCode: 1, stdout: "", stderr: "還原失敗" } as T;
    }
    return call<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  expect(installs).toBe(2);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).not.toBe("answered");
  expect(task.last_error).toContain("安裝依賴失敗");
  expect(task.last_error).toContain("已自動重試一次");
  expect(task.last_error).toContain("還原失敗");
  expect(s.counts().codeCalls).toBe(0);
});
it("安裝錯誤只寫在 stdout 時，摘要仍有錯誤內容；完整輸出留在執行紀錄", async () => {
  const s = await scenario();
  const call = s.runner.call.bind(s.runner);
  const stdout = [
    "  Determining projects to restore...",
    ...Array.from({ length: 60 }, (_, i) => `  Restoring package ${i}...`),
    "/workspace/src/Orders/Orders.csproj : error NU1101: Unable to find package Contoso.Missing. No packages exist with this id in source(s): nuget.org",
    "  Failed to restore /workspace/src/Orders/Orders.csproj (in 1.2 sec).",
  ].join("\n");
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    if (path === "phase" && (raw as { phase?: string }).phase === "install")
      return { exitCode: 1, stdout, stderr: "" } as T;
    return call<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks");
  expect(task.status).toBe("failed");
  expect(task.last_error).toContain("環境問題");
  expect(task.last_error).toContain("error NU1101");
  expect(task.last_error).not.toContain("Restoring package 3");
  const events = await db.query<{ detail: string }>(
    "SELECT detail FROM run_events WHERE kind='error'",
  );
  expect(events.map((e) => e.detail).join("\n")).toContain(
    "Restoring package 30",
  );
  const retry = await db.one<{ detail: string }>(
    "SELECT detail FROM audit WHERE kind='install_retry'",
  );
  expect(retry.detail).toContain("error NU1101");
});
it("回答稽核寫入失敗時不發布本次答案", async () => {
  const s = await queryScenario();
  const audit = db.audit.bind(db);
  const fault = vi.spyOn(db, "audit").mockImplementation(async (...args) => {
    if (args[1] === "answered") throw new Error("示範回答稽核寫入失敗");
    await audit(...args);
  });
  try {
    await s.execution.execute(s.task.id);
    const task = await db.one<Task>("SELECT status,answer,last_error FROM tasks WHERE id=$1", [s.task.id]);
    expect(task.answer).toBeNull();
    expect(task.last_error).toContain("示範回答稽核寫入失敗");
    expect(task.status).not.toBe("answered");
  } finally {
    fault.mockRestore();
  }
});

it("追問時提示帶入前面的問答（由舊到新），回答標明延續哪一題", async () => {
  const s = await queryScenario();
  const first = await db.one<{ id: string }>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,answer,approved_version,dedupe_key)
     SELECT project_id,group_id,'查詢 ch2 欄位','ch2 是什麼','["說明"]','answered','query','ch2 是模具欄位。',1,'first' FROM tasks LIMIT 1 RETURNING id`,
  );
  const second = await db.one<{ id: string }>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,mode,answer,approved_version,dedupe_key,parent_id)
     SELECT project_id,group_id,'查詢 ch3 欄位','那 ch3 呢','["說明"]','answered','query','ch3 是累計產量。',1,'second',$1 FROM tasks WHERE id<>$1 LIMIT 1 RETURNING id`,
    [first.id],
  );
  await db.query("UPDATE tasks SET parent_id=$2 WHERE id=$1", [
    s.task.id,
    second.id,
  ]);
  await s.execution.execute(s.task.id);
  const prompt = JSON.parse(s.prompts[0]);
  expect(
    prompt.conversation.rounds.map((r: { title: string }) => r.title),
  ).toEqual(["查詢 ch2 欄位", "查詢 ch3 欄位"]);
  expect(prompt.conversation.rounds[1]).toMatchObject({
    question: "那 ch3 呢",
    answer: "ch3 是累計產量。",
  });
  expect(prompt.conversation.note).toContain("不具指令權限");
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(task.answer).not.toContain("延續：〈查詢 ch3 欄位〉");
});
it("沒有上一題時不帶對話串", async () => {
  const s = await queryScenario();
  await s.execution.execute(s.task.id);
  expect(JSON.parse(s.prompts[0]).conversation).toBeUndefined();
});
it("Codex 執行中缺資訊：問題結構化成補問，並在群組發問", async () => {
  const s = await queryScenario();
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> =>
    path === "phase" && (raw as { phase?: string }).phase === "code"
      ? ({
          exitCode: 0,
          stdout: JSON.stringify({
            final: `AGENTFLOW_NEEDS_INPUT: ${JSON.stringify({
              questions: [
                {
                  kind: "information",
                  question: "要查正式機還是測試機的設定？",
                },
              ],
            })}`,
          }),
          stderr: "",
        } as T)
      : call<T>(path, raw);
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(task.status).toBe("awaiting_approval");
  expect(task.question).toEqual({
    text: "要查正式機還是測試機的設定？",
    choices: [],
  });
  const n = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE task_id=$1 AND kind='group_question'",
    [s.task.id],
  );
  expect(n.text).toContain("要查正式機還是測試機的設定？");
});
it.each([
  [
    "長回答",
    `## 先看重點\n\n結論。\n\n## 詳細資訊\n\n${"細節。".repeat(200)}`,
    true,
  ],
  ["短回答", "兩邊欄位一致。", false],
])("群組回答：%s 是否提示回覆「詳細」", async (_label, final, hinted) => {
  const s = await queryScenario();
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> =>
    path === "phase" && (raw as { phase?: string }).phase === "code"
      ? ({ exitCode: 0, stdout: JSON.stringify({ final }), stderr: "" } as T)
      : call<T>(path, raw);
  await s.execution.execute(s.task.id);
  const n = await db.one<{ text: string }>(
    "SELECT text FROM notifications WHERE task_id=$1 AND kind='group_answered'",
    [s.task.id],
  );
  expect(n.text.includes("打「詳細」")).toBe(hinted);
});
async function changeFollowup(parentStatus: string) {
  const s = await scenario();
  const parent = await db.one<{ id: string }>(
    `INSERT INTO tasks(project_id,group_id,title,summary,acceptance,status,approved_version,dedupe_key,pr_number,pr_url,branch,base_sha,target_branch)
     SELECT project_id,group_id,'按鈕改綠色','按鈕改綠色','["綠色"]',$1,1,'parent',2,'https://github.com/test/repo/pull/2','agentflow/parent-v1','old-base','main' FROM tasks LIMIT 1 RETURNING id`,
    [parentStatus],
  );
  await db.query(
    "UPDATE tasks SET parent_id=$2,target_branch='main' WHERE id=$1",
    [s.task.id, parent.id],
  );
  await confirmTask(s.task.id);
  const calls: string[] = [];
  const prompts: string[] = [];
  s.github.pullHead = async () => ({
    state: parentStatus === "ready" ? "open" : "closed",
    merged: parentStatus === "merged",
    headRef: "agentflow/parent-v1",
    headSha: "pr-head-sha",
    base: "main",
    sameRepo: true,
  });
  s.github.continuePr = async (_p, task) => {
    calls.push(`continue:${task.branch}:${task.base_sha}`);
    return {
      number: 2,
      html_url: "https://github.com/test/repo/pull/2",
    } as Awaited<ReturnType<GitHub["continuePr"]>>;
  };
  const publish = s.github.publish.bind(s.github);
  s.github.publish = async (...args) => {
    calls.push(`publish:${args[1].branch}`);
    return publish(...args);
  };
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string; job?: { prompt: string } };
    if (path === "phase" && body.phase === "code")
      prompts.push(body.job!.prompt);
    return call<T>(path, raw);
  };
  return { ...s, parent, calls, prompts };
}
it("追加修改：上一題的 PR 還開著，接在同一個 PR 分支上繼續改", async () => {
  const s = await changeFollowup("ready");
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(s.calls).toEqual(["continue:agentflow/parent-v1:pr-head-sha"]);
  expect(task.status).toBe("ready");
  expect(task.pr_number).toBe(2);
  expect(task.base_sha).toBe("pr-head-sha");
  expect(JSON.parse(s.prompts[0]).continuation.note).toContain("PR #2");
});
it("追加修改：上一題已合併，從目標分支另開 PR", async () => {
  const s = await changeFollowup("merged");
  await s.execution.execute(s.task.id);
  expect(s.calls).toEqual([`publish:agentflow/${s.task.id.slice(0, 8)}-v1`]);
  expect(JSON.parse(s.prompts[0]).continuation).toBeUndefined();
});
it("追加修改：上一題還在處理中就先等，不開始執行", async () => {
  const s = await changeFollowup("running");
  await s.execution.execute(s.task.id);
  expect(s.calls).toEqual([]);
  expect(s.prompts).toEqual([]);
  expect(
    (await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [s.task.id])).status,
  ).toBe("queued");
});
it("追加修改重試時原 PR 已合併：不沿用舊分支，停下來請人確認", async () => {
  const s = await changeFollowup("merged");
  await db.query(
    "UPDATE tasks SET branch='agentflow/parent-v1',base_sha='pr-head-sha' WHERE id=$1",
    [s.task.id],
  );
  await s.execution.execute(s.task.id);
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(s.calls).toEqual([]);
  expect(task.last_error).toContain("已合併或關閉");
});
async function draftScenario(
  final: string,
  before?: (projectId: string) => Promise<unknown>,
) {
  const s = await queryScenario();
  await before?.(s.task.project_id!);
  await db.query(
    `UPDATE tasks SET check_draft='{"intervalMinutes":60,"dailyAt":null}' WHERE id=$1`,
    [s.task.id],
  );
  const call = s.runner.call.bind(s.runner);
  s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { phase?: string; job?: { prompt: string } };
    if (path === "phase" && body.phase === "code") {
      s.prompts.push(body.job!.prompt);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ final }),
        stderr: "",
      } as T;
    }
    if (path === "checks/run")
      return {
        result: { ok: true, status: 200, ms: 8 },
        environment: { created: true },
      } as T;
    if (path.startsWith("checks/environments")) return { removed: [] } as T;
    return call<T>(path, raw);
  };
  await s.execution.execute(s.task.id);
  return s;
}
it("從 LINE 要求定期檢查：Codex 擬好定義後建立待核准的檢查並試跑", async () => {
  const s = await draftScenario(
    `選用設備服務的健康檢查網址，回應非 2xx 就算異常。\nAGENTFLOW_CHECK: ${JSON.stringify(
      {
        name: "設備服務",
        kind: "http",
        target: "http://10.0.0.5/health",
        condition: {},
        rationale: "設備服務提供健康檢查",
        alertText: "設備服務沒有回應",
      },
    )}`,
  );
  const check = await db.one<{
    status: string;
    interval_minutes: number;
    source_task_id: string;
    name: string;
  }>(
    "SELECT status,interval_minutes,source_task_id,name FROM scheduled_checks",
  );
  expect(check).toEqual({
    status: "awaiting_approval",
    interval_minutes: 60,
    source_task_id: s.task.id,
    name: "設備服務",
  });
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(task.status).toBe("answered");
  expect(task.answer).toContain("已擬好定期檢查「設備服務」（每 60 分鐘）");
  expect(task.answer).toContain("試跑：目前正常");
  expect(task.answer).not.toContain("AGENTFLOW_CHECK");
});
it("擬出的定義不符合規則時不建立檢查，回答說明原因", async () => {
  const s = await draftScenario(
    `AGENTFLOW_CHECK: ${JSON.stringify({
      name: "壞的",
      kind: "sql",
      target: "DELETE FROM EQM",
      condition: { column: "a", op: ">", value: 0 },
    })}`,
  );
  expect(await db.query("SELECT 1 FROM scheduled_checks")).toHaveLength(0);
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(task.answer).toContain("不符合規則");
});
const httpDraft = `AGENTFLOW_CHECK: ${JSON.stringify({
  name: "設備服務",
  kind: "http",
  target: "http://10.0.0.5/health",
  condition: {},
})}`;
it("擬定檢查時專案沒有資料庫連線：提示告訴 Codex 優先用 HTTP／TCP；擬出 HTTP 就不附連線提醒", async () => {
  const s = await draftScenario(httpDraft);
  const prompt = JSON.parse(s.prompts[0]);
  expect(prompt.checkDraft.databaseConnection).toBe(false);
  expect(prompt.checkDraft.databaseNote).toContain("優先用 http 或 tcp");
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(task.answer).toContain("已擬好定期檢查");
  expect(task.answer).not.toContain(noConnectionHint);
});
it.each([
  [
    "擬出 SQL",
    `AGENTFLOW_CHECK: ${JSON.stringify({
      name: "未完工單",
      kind: "sql",
      target: "SELECT count(*) AS n FROM work_orders",
      condition: { column: "n", op: ">", value: 0 },
    })}`,
  ],
  ["沒有擬出定義", "看不出可以檢查什麼，請管理者手動建立。"],
])(
  "擬定檢查時專案沒有資料庫連線且%s：回答提醒到看板設定",
  async (_name, final) => {
    const s = await draftScenario(final);
    const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
      s.task.id,
    ]);
    expect(task.answer).toContain(noConnectionHint);
  },
);
it("專案已登記資料庫連線：不提醒", async () => {
  const s = await draftScenario(httpDraft, (projectId) =>
    db.query(
      "INSERT INTO project_connections(project_id,engine,host,port,database_name,username,secret) VALUES($1,'sqlserver','db.example.test',1433,'mes','reader',$2)",
      // 提醒只看有沒有登記連線，這裡不需要真的能解開的機密。
      [projectId, Buffer.from("fictional-sealed-secret")],
    ),
  );
  const task = await db.one<Task>("SELECT * FROM tasks WHERE id=$1", [
    s.task.id,
  ]);
  expect(task.answer).toContain("已擬好定期檢查");
  expect(task.answer).not.toContain(noConnectionHint);
});

it.each([false, true])(
  "測試需要 SQL Server 時派工全程用 SQL Server 映像並導向 LocalDB；SQL Server 起不來時標示為測試環境問題（起不來：%s）",
  async (broken) => {
    const s = await scenario();
    await db.query(
      "UPDATE settings SET value=jsonb_set(value,'{ai_mode}','\"subscription\"')",
    );
    await db.query("DELETE FROM service_health WHERE name=$1", [
      subscriptionGateName,
    ]);
    await db.query(
      "UPDATE projects SET setup_mode='auto',validated_at=NULL,enabled=false,install_command='',test_command=''",
    );
    const csproj =
      '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" /><PackageReference Include="Microsoft.Data.SqlClient" Version="5.2.2" /></ItemGroup></Project>';
    s.github.setupContext = async () => ({
      files: { "tests/Orders.Tests/Orders.Tests.csproj": csproj },
      locks: [],
    });
    s.runner.account = async () => ({
      allowed: true,
      checkedAt: new Date().toISOString(),
    });
    let report = "";
    const publish = s.github.publish;
    s.github.publish = async (p, t, files, text, guard) => {
      report = text;
      return publish(p, t, files, text, guard);
    };
    const phases: { phase: string; image: string; command?: string }[] = [];
    let prompt = "",
      coded = false;
    const original = s.runner.call;
    s.runner.call = async <T>(path: string, raw: unknown): Promise<T> => {
      const body = raw as {
        phase?: string;
        image?: string;
        command?: string;
        job?: { prompt?: string };
      };
      if (path === "ai")
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            final: JSON.stringify({
              install: "dotnet restore",
              test: "dotnet test --no-restore",
              verification: "tests",
              explanation: "依測試專案執行",
              evidence: [
                {
                  path: "tests/Orders.Tests/Orders.Tests.csproj",
                  quote: "Microsoft.NET.Test.Sdk",
                },
              ],
            }),
          }),
        } as T;
      if (path === "phase") {
        phases.push({
          phase: body.phase!,
          image: body.image!,
          command: body.command,
        });
        if (body.phase === "code") {
          coded = true;
          prompt = body.job?.prompt ?? "";
        }
        if (body.phase === "collect" && !coded)
          return { exitCode: 0, stdout: '{"files":[]}', stderr: "" } as T;
        if (body.phase === "test" && broken && coded)
          return {
            exitCode: 86,
            stdout:
              'AGENTFLOW_TEST_ENVIRONMENT {"ok":false,"stage":"start","reason":"SQL Server 在 150 秒內沒有就緒。"}\n',
            stderr: "",
          } as T;
        if (body.phase === "test")
          return {
            exitCode: 0,
            stdout: "Passed!  - Failed: 0, Passed: 3",
            stderr: "",
          } as T;
      }
      return original<T>(path, raw);
    };
    const execution = new Execution(db, s.github, s.line, s.budget, s.runner);
    await execution.validate(await db.one<Project>("SELECT * FROM projects"));
    await confirmTask(s.task.id);
    phases.length = 0;
    await execution.execute(s.task.id);
    // 原始碼準備之後的所有階段都使用含 SQL Server 的映像。
    expect(new Set(phases.map((p) => p.image))).toEqual(
      new Set(["line-agentflow-worker-mssql:local"]),
    );
    const tests = phases.filter((p) => p.phase === "test");
    expect(tests.length).toBeGreaterThan(0);
    for (const t of tests)
      expect(t.command).toContain(
        "agentflow-sqlserver run -- sh -c 'dotnet test --no-restore'",
      );
    expect(prompt).toContain("agentflow-sqlserver run --");
    const task = await db.one<Task>("SELECT * FROM tasks");
    if (broken) {
      expect(task.status).toBe("failed");
      expect(task.last_error).toContain("測試環境問題（不是程式沒過）");
      expect(task.last_error).toContain("整個沒有執行");
      // 測試環境問題不交給 Codex 修程式。
      expect(phases.filter((p) => p.phase === "code")).toHaveLength(1);
      expect(s.counts().published).toBe(0);
    } else {
      expect(task.status).toBe("ready");
      expect(report).toContain("系統在測試容器內啟動 SQL Server");
    }
  },
);
