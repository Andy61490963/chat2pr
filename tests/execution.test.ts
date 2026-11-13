import { beforeEach, afterAll, it, expect, vi } from "vitest";
import { reviewVerdict } from "../server/pr-body.js";
import { transientFailure } from "../server/execution.js";
import { db, reset, fixture, confirmTask } from "./helpers.js";
import {
  Execution,
  type Runner,
  type PhaseResult,
} from "../server/execution.js";
import { GitHub, BranchUnavailable } from "../server/github.js";
import { Line } from "../server/line.js";
import { Budget } from "../server/budget.js";
import { Tasks } from "../server/tasks.js";
import { recoverInterrupted } from "../server/jobs.js";
import { syncProjectRepos } from "../server/repo-missing.js";
import type { Project, Task } from "../shared/types.js";
import sharp from "sharp";
import { saveTaskImageRefs, imageHash } from "../server/image-context.js";
import { recordContextEvidence } from "../server/task-context.js";
import { subscriptionGateName } from "../server/subscription-gate.js";
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
    collectCalls = 0;
  let failTests = false,
    mutateCandidate = false,
    cancelDuringPublish = false,
    sensitive = false;
  github.base = async () => "base-sha";
  github.archive = async () => new Blob(["archive"]).stream();
  github.ensureIssue = async () => ({
    number: 1,
    url: "https://github.com/test/repo/issues/1",
  });
  github.findPr = async () => undefined!;
  github.publish = async (_p, _t, _files, _report, guard) => {
    await guard?.();
    published++;
    if (cancelDuringPublish)
      await new Tasks(db).action(task.id, "cancel", 1, "管理者");
    return {
      number: 2,
      html_url: "https://github.com/test/repo/pull/2",
    } as Awaited<ReturnType<GitHub["publish"]>>;
  };
  const runner: Runner = {
    async upload() {},
    async call<T>(path: string, raw: unknown): Promise<T> {
      const body = raw as { phase: string };
      let result: PhaseResult = { exitCode: 0, stdout: "", stderr: "" };
      if (path === "phase") {
        if (body.phase === "test") {
          testCalls++;
          if (failTests) result.exitCode = 1;
        }
        if (body.phase === "code") codeCalls++;
        if (body.phase === "collect") {
          collectCalls++;
          result.stdout = JSON.stringify({
            files: [
              {
                path: sensitive ? "server/auth.ts" : "src/button.ts",
                content: mutateCandidate && collectCalls > 1 ? "Yg==" : "YQ==",
                mode: "100644",
              },
            ],
          });
        }
        if (body.phase === "review")
          result.stdout = JSON.stringify({
            final: JSON.stringify({ passed: true, findings: [] }),
          });
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
    }) => {
      failTests = !!o.failTests;
      mutateCandidate = !!o.mutateCandidate;
      cancelDuringPublish = !!o.cancelDuringPublish;
      sensitive = !!o.sensitive;
    },
    counts: () => ({ published, testCalls, codeCalls }),
  };
}
it("只發布通過測試與獨立審查的同一份候選內容", async () => {
  const s = await scenario();
  await s.execution.execute(s.task.id);
  expect(s.counts()).toEqual({ published: 1, testCalls: 1, codeCalls: 1 });
  expect((await db.one<Task>("SELECT * FROM tasks")).status).toBe("ready");
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
          final: "進站會更新 WIP_LOT 與 WIP_HISTORY。",
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
    `查詢專案：測試專案（test/repo）\n基底分支：main；查詢版本：${task.base_sha}\n\n進站會更新 WIP_LOT 與 WIP_HISTORY。`,
  );
  expect(phases).not.toContain("collect");
  expect(phases).not.toContain("test");
  expect(phases).not.toContain("review");
  expect(s.counts().published).toBe(0);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("WIP_LOT");
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

it("暫時性錯誤自動重新排隊兩次、不通知；第三次才轉為失敗並通知", async () => {
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
    db.one<{ status: string }>("SELECT status FROM tasks WHERE id=$1", [
      s.task.id,
    ]);
  const failures = () =>
    db.query("SELECT 1 FROM notifications WHERE kind='failed'");
  for (const attempt of [1, 2]) {
    await s.execution.execute(s.task.id);
    expect((await state())?.status).toBe("queued");
    expect(
      await db.query("SELECT detail FROM audit WHERE kind='auto_retry'"),
    ).toHaveLength(attempt);
    expect(await failures()).toHaveLength(0);
  }
  await s.execution.execute(s.task.id);
  expect((await state())?.status).toBe("failed");
  expect(await failures()).toHaveLength(1);
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
  expect(task.answer).toContain("一併查詢：設備同步（test/MachineSync");
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
  expect(task.last_error).toContain("安裝失敗");
  expect(s.counts().codeCalls).toBe(0);
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
  expect(task.answer).toContain("延續：〈查詢 ch3 欄位〉");
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
