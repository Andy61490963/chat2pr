import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { basicFixture } from "../scripts/acceptance/flows/basic.js";
import { baselineFailurePlain } from "../shared/failure-text.js";
import {
  checkRecoveryRuns, checkRetrySchedule, recoveryScenarios,
  runRecoveryFlow, type RecoveryFlowContext,
} from "../scripts/acceptance/flows/recovery.js";

// 這些樣本只測劇本會接受或拒絕哪些證據。真實執行與通知由隔離主控驗收。
const version = 3;
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const run = (n: number, outcome: string, phases = ["code", "test", "review", "publish"]) => ({
  id: `26600000-0000-4000-8000-${String(n).padStart(12, "0")}`, version,
  started_at: at(n * 60), completed_at: at(n * 60 + 5), outcome,
  phases: phases.map(phase => ({ phase })),
});

const projectId = "26600000-0000-4000-8000-000000000101";
const original = "26600000-0000-4000-8000-000000000102";
const repair = "26600000-0000-4000-8000-000000000103";
const repository = "lantern-example/lantern-tickets";
const channel = "discord:" + basicFixture.discord.channelId;
const testName = "合計各批燈會票數，而非批數";
const broken = "a".repeat(40), merged = "b".repeat(40);
const failure = `專案問題：${baselineFailurePlain}。\n錯誤重點：失敗的測試：${testName}\n建議：請修復基底。`;

function dashboard(id: string, status: string, sequence: ReturnType<typeof run>[], kinds: string[]) {
  const isRepair = id === repair;
  const published = status === "ready" || status === "merged";
  const confirmed = status !== "awaiting_approval";
  const task = {
    id, status, title: isRepair ? "修復目標分支 main" : "省略批次時回傳零",
    summary: isRepair ? testName : basicFixture.discord.text, project_id: projectId, group_id: channel, mode: "change",
    source_ids: isRepair ? [] : ["discord:" + basicFixture.discord.interactionId], version,
    target_branch: "main", approved_version: confirmed ? version : null,
    last_error: status === "failed" ? failure : null, retry_at: null, updated_at: at(65),
    base_sha: confirmed ? (!isRepair && published ? merged : broken) : null, baseline_repair: isRepair,
    pr_number: published ? (isRepair ? 12 : 14) : null,
    pr_url: published ? `https://github.example.invalid/${repository}/pull/${isRepair ? 12 : 14}` : null,
    branch: published ? "work/" + id : null, issue_number: published ? (isRepair ? 11 : 13) : null,
  };
  return {
    task, runs: sequence, history: kinds.map(kind => ({ kind })),
    projectReview: { repo: repository, config_version: 8, binding_version: 6, confirmed, confirmation: confirmed ? { kind: "manual" } : null },
  };
}

function replay(views: ReturnType<typeof dashboard>[], receipts: readonly string[], alerts: { task_id: string; kind: string; text: string }[]) {
  const pending = dashboard(original, "awaiting_approval", [], ["triage"]);
  let delivered = false;
  const ctx: RecoveryFlowContext = {
    projectId, repository, githubWebhookSecret: "example-merge-proof", lineSecret: "example-line-proof",
    async groupMessages() { return delivered ? receipts : []; },
    async gateway(packet) {
      expect(packet.d.data.options[0].value).toBe(basicFixture.discord.text);
      delivered = true;
    },
    db: { async one(sql) {
      expect(sql.trim()).toMatch(/^SELECT /);
      return delivered ? { id: original } : undefined;
    } },
    async admin(method, path, body) {
      if (method === "GET" && path === "/api/state") return { alerts };
      if (method === "GET") {
        const view = views.shift();
        expect(path).toBe("/api/tasks/" + view?.task.id);
        return view;
      }
      if (path === `/api/tasks/${original}/baseline-repair`) return dashboard(repair, "awaiting_approval", [], []).task;
      const id = path.includes(repair) ? repair : original;
      expect(path).toBe(`/api/tasks/${id}/actions`);
      if (body?.action === "retry") expect(body).toEqual({ action: "retry", version });
      else expect(body).toEqual({ action: "approve", version, project_id: projectId, target_branch: "main", config_version: 8, binding_version: 6 });
      return { ...pending.task, id, status: "queued", approved_version: version };
    },
    async poll(label, probe) {
      const result = await probe();
      if (result === undefined) throw new Error("缺少觀測：" + label);
      return result;
    },
    async readPr(number) {
      const isRepair = number === 12;
      const id = isRepair ? repair : original;
      const files: Record<string, string> = { "tickets.mjs": "function countTickets(batches = []) { return batches.reduce((total, tickets) => total + tickets, 0); }" };
      if (!isRepair) files["tickets.test.mjs"] = "assert.equal(countTickets(), 0)";
      return { number, head: "work/" + id, headSha: "c".repeat(40), base: "main", files,
        body: `Closes #${isRepair ? 11 : 13}\n測試：通過\n獨立審查：通過` };
    },
    async webhook(request) {
      expect(request.url).toBe("/webhooks/github");
      expect(request.headers["x-hub-signature-256"]).toBe("sha256=" + createHmac("sha256", ctx.githubWebhookSecret).update(request.payload).digest("hex"));
      expect(JSON.parse(request.payload).pull_request).toMatchObject({ number: 12, merged: true });
      return { statusCode: 200 };
    },
    setModelSteps: vi.fn(async () => {}), setModelFault: vi.fn(async () => {}), modelFaultHits: async () => 1,
    async commitFixture(files) {
      expect(files["tickets.mjs"]).toContain("total - tickets");
      expect(Object.keys(files).sort()).toEqual(["README.md", "tickets.mjs"]);
      return broken;
    },
    async mergeFixturePr(pr) { expect(pr).toBe(12); return merged; },
  };
  return ctx;
}

function baselineReplay() {
  const red = run(1, "failed", ["test"]);
  const repairRun = run(2, "ready", ["test", "code", "test", "review", "publish"]);
  const failed = dashboard(original, "failed", [red], ["triage", "approve", "started", "error"]);
  const readyRepair = dashboard(repair, "ready", [repairRun], ["baseline_repair", "approve", "started", "baseline_known_failures", "ready"]);
  const ready = dashboard(original, "ready", [run(3, "ready", ["test", "code", "test", "review", "publish"]), red], ["triage", "approve", "started", "error", "retry", "started", "ready"]);
  const views = [
    dashboard(original, "awaiting_approval", [], ["triage"]), failed,
    dashboard(repair, "awaiting_approval", [], ["baseline_repair"]), readyRepair,
    dashboard(repair, "merged", [repairRun], ["ready", "merged"]), ready,
  ];
  const ctx = replay(views, [testName, readyRepair.task.title + readyRepair.task.pr_url, readyRepair.task.title + "修改已合併", ready.task.title + ready.task.pr_url], [
    { task_id: original, kind: "approval", text: repository }, { task_id: repair, kind: "approval", text: repository },
    { task_id: original, kind: "failed", text: failure }, { task_id: repair, kind: "ready", text: readyRepair.task.pr_url! },
    { task_id: original, kind: "ready", text: ready.task.pr_url! },
  ]);
  return { ctx, ready, failed };
}

it("修復任務另外核准，確認實際 PR 與簽章合併後才重試原任務", async () => {
  const { ctx } = baselineReplay();
  const checkpoints: string[] = [];
  const result = await runRecoveryFlow(10, ctx, async item => { checkpoints.push(item.taskId); });
  expect(result).toMatchObject({ taskId: original, runId: run(3, "ready").id, pr: 14 });
  expect(checkpoints).toEqual([repair, original]);
});

it("修復已合併但原任務仍使用舊 SHA，或基底說明漏列測試，皆拒絕結案", async () => {
  const stale = baselineReplay();
  stale.ready.task.base_sha = broken;
  await expect(runRecoveryFlow(10, stale.ctx)).rejects.toThrow("未使用已合併的基底");
  const unnamed = baselineReplay();
  unnamed.failed.task.last_error = failure.replace(testName, "不明測試");
  await expect(runRecoveryFlow(10, unnamed.ctx)).rejects.toThrow("看板缺少本次失敗原因");
});

function quotaReplay() {
  const waiting = run(1, "budget_wait", ["code"]);
  const hold = dashboard(original, "budget_wait", [waiting], ["approve", "started", "quota"]);
  hold.task.last_error = "訂閱額度已達上限";
  const end = dashboard(original, "ready", [run(2, "ready"), waiting], ["approve", "started", "quota", "started", "ready"]);
  return replay([dashboard(original, "awaiting_approval", [], ["triage"]), hold, end],
    ["額度恢復後會自動繼續", end.task.title + end.task.pr_url], [
      { task_id: original, kind: "approval", text: repository }, { task_id: original, kind: "budget", text: "額度已達上限" },
      { task_id: original, kind: "ready", text: end.task.pr_url! },
    ]);
}

it("額度耗盡與恢復經模型邊界切換，只有收到等待說明與後續 PR 才結案", async () => {
  const ctx = quotaReplay();
  await expect(runRecoveryFlow(14, ctx)).resolves.toMatchObject({ taskId: original, pr: 14 });
  expect(ctx.setModelFault).toHaveBeenCalledWith([], { kind: "error", status: 429 });
  const noHit = quotaReplay();
  noHit.modelFaultHits = async () => 0;
  await expect(runRecoveryFlow(14, noHit)).rejects.toThrow("429");
  const noReceipt = quotaReplay();
  noReceipt.groupMessages = async () => [];
  await expect(runRecoveryFlow(14, noReceipt)).rejects.toThrow("原頻道收到額度");
});

describe("失敗與恢復劇本的結案證據", () => {
  it("五個情境涵蓋兩種逾時結局及兩種永久錯誤", () => {
    expect(recoveryScenarios).toEqual({
      10: ["baseline"], 11: ["resume", "timeout-again"],
      12: ["backoff"], 13: ["model-unavailable", "request-rejected"], 14: ["quota"],
    });
  });

  it("接續必須沿用同版候選，第二次仍要完成測試與審查", () => {
    const first = run(1, "auto_resumed", ["code", "test", "review"]);
    const second = run(2, "ready", ["test", "review", "publish"]);
    const verify = (runs: typeof first[]) => checkRecoveryRuns("resume", version, runs);
    expect(() => verify([second, first])).not.toThrow();
    for (const broken of [
      [second], [run(3, "ready"), second, first], [{ ...second, version: 4 }, first],
      [run(2, "ready", ["review", "publish"]), first], [run(2, "ready"), first],
    ]) expect(() => verify(broken)).toThrow();
    expect(() => checkRecoveryRuns("timeout-again", version, [second, first])).toThrow();
    expect(() => checkRecoveryRuns("timeout-again", version, [run(2, "failed", ["test", "review"]), first])).not.toThrow();
  });

  it.each(["model-unavailable", "request-rejected"] as const)("%s 須在第一次執行即失敗", variant => {
    expect(() => checkRecoveryRuns(variant, version, [run(1, "failed", ["code"])])).not.toThrow();
    expect(() => checkRecoveryRuns(variant, version, [run(2, "failed"), run(1, "queued")])).toThrow();
    expect(() => checkRecoveryRuns(variant, version, [run(1, "failed", ["install"])])).toThrow();
  });

  it("額度恢復須留下等待與重新派工的兩次執行", () => {
    expect(() => checkRecoveryRuns("quota", version, [run(2, "ready"), run(1, "budget_wait", ["code"])])).not.toThrow();
    expect(() => checkRecoveryRuns("quota", version, [run(1, "ready")])).toThrow();
  });

  it("兩次退避逐次拉長，下一個執行須在排定時刻以後", () => {
    const runs = [run(3, "ready"), run(2, "queued"), run(1, "queued")];
    const schedule = [{ failedAt: at(65), due: at(75) }, { failedAt: at(125), due: at(165) }];
    expect(() => checkRetrySchedule(runs, schedule)).not.toThrow();
    expect(() => checkRetrySchedule(runs, [schedule[0], { ...schedule[1], due: at(130) }])).toThrow();
    expect(() => checkRetrySchedule(runs, [schedule[0], { ...schedule[1], due: at(181) }])).toThrow();
  });

  it("基底失敗須來自修改前的測試，恢復後要在新基底實際執行原需求", () => {
    const failed = run(1, "failed", ["install", "test"]);
    const completed = run(2, "ready", ["test", "code", "test", "review", "publish"]);
    expect(() => checkRecoveryRuns("baseline", version, [completed, failed])).not.toThrow();
    expect(() => checkRecoveryRuns("baseline", version, [completed, run(1, "failed", ["install"])])).toThrow();
    expect(() => checkRecoveryRuns("baseline", version, [run(2, "ready", ["test", "review", "publish"]), failed])).toThrow();
  });
});

it("短期限與短退避只在對應的隔離劇本生效，正式、真訂閱與外部資料庫拒絕載入", async () => {
  const { recoveryTimings } = await import("../server/execution.js");
  const normal = recoveryTimings({});
  expect(normal.maxTaskMinutes).toBe(Infinity);
  expect(normal.retrySeconds).toBe(30);
  const env = {
    ACCEPTANCE_RECOVERY_TIMING: "11", AGENTFLOW_INSTANCE: "verify-266-demo-11",
    ACCEPTANCE_FLOW_REAL: "0", ACCEPTANCE_MODEL_ORIGIN: "http://127.0.0.1:20125",
    DATABASE_URL: "postgres://127.0.0.1:20126/lantern_test",
  };
  expect(recoveryTimings(env)).toEqual({ maxTaskMinutes: 1, retrySeconds: 30 });
  expect(recoveryTimings({ ...env, ACCEPTANCE_RECOVERY_TIMING: "12", AGENTFLOW_INSTANCE: "verify-266-demo-12" }))
    .toEqual({ maxTaskMinutes: Infinity, retrySeconds: 10 });
  for (const overrides of [
    { NODE_ENV: "production" }, { AGENTFLOW_INSTANCE: "production" }, { AGENTFLOW_INSTANCE: undefined },
    { ACCEPTANCE_FLOW_REAL: "1" }, { ACCEPTANCE_MODEL_ORIGIN: undefined }, { ACCEPTANCE_MODEL_ORIGIN: "http://127.0.0.1:4313" },
    { ACCEPTANCE_RECOVERY_TIMING: "12" }, { ACCEPTANCE_RECOVERY_TIMING: "0" },
    { DATABASE_URL: "postgres://127.0.0.1:20126/lantern" }, { DATABASE_URL: "postgres://example.invalid:20126/lantern_test" },
    { DATABASE_URL: "postgres://127.0.0.1:5439/lantern_test" },
  ]) expect(() => recoveryTimings({ ...env, ...overrides })).toThrow();
});
