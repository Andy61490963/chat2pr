import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { discordId } from "../../../server/chat-platform.js";
import type { Decisions } from "../../../server/triage.js";
import { baselineFailurePlain, parseFailure } from "../../../shared/failure-text.js";
import { basicFixture, discordChangeSteps, type BasicFlowContext } from "./basic.js";
import type { ModelFault } from "./model-service.js";
import type { ModelStep } from "./model-upstream.js";
import { discordTaskInteraction, signedGitHubPrMerged } from "./signed-events.js";

export const recoveryScenarios = {
  10: ["baseline"], 11: ["resume", "timeout-again"], 12: ["backoff"],
  13: ["model-unavailable", "request-rejected"], 14: ["quota"],
} as const;
export type RecoveryNumber = keyof typeof recoveryScenarios;
type Variant = (typeof recoveryScenarios)[RecoveryNumber][number];
type Result = { taskId: string; runId: string; pr?: number; issue?: number; headSha?: string; groupMessages: string[] };
type Checkpoint = (result: Result) => Promise<void>;

export interface RecoveryFlowContext extends BasicFlowContext {
  /** 安裝完成才回覆。重設後的新請求讀新劇本，已掛起的舊請求仍等原客戶端取消。 */
  setModelSteps(steps: readonly ModelStep[]): Promise<void>;
  /** prefix 用完後持續注入同一故障；命中 429 時同步耗盡 /account 配額，換回正常劇本才恢復。 */
  setModelFault(prefix: readonly ModelStep[], fault: ModelFault): Promise<void>;
  /** 只計本次設定後，已通過訂閱驗證且實際進入故障分支的 Responses 請求。 */
  modelFaultHits(): Promise<number>;
  /** 在虛構儲存庫 main 現有版本上提交指定檔案，回傳新的 commit SHA。 */
  commitFixture(files: Readonly<Record<string, string>>): Promise<string>;
  /** 合併已發布的 PR 並推進替身的 main，回傳實際合併 SHA；簽章事件由劇本投遞。 */
  mergeFixturePr(pr: number): Promise<string>;
}

/** F10 建立專案時就選自動設定，先用此回答通過綠色基底的專案驗證。 */
export const recoverySetupStep: ModelStep = {
  kind: "text",
  text: JSON.stringify({
    install: "npm ci --offline --ignore-scripts --no-audit --no-fund", test: "npm test",
    verification: "tests", explanation: "依據專案腳本執行全部票務測試。",
    evidence: [{ path: "package.json", quote: "node --test" }],
  }),
};

const { discord, branch } = basicFixture;
const group = discordId(discord.channelId);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const uuid = z.uuid();
const taskSchema = z.object({
  id: uuid, title: z.string().min(1), summary: z.string(), project_id: uuid, group_id: z.string(),
  mode: z.literal("change"), source_ids: z.array(z.string()), version: z.int().positive(),
  target_branch: z.string(), approved_version: z.int().nullable(), status: z.string(),
  last_error: z.string().nullable(), retry_at: z.string().nullable(), updated_at: z.string(), base_sha: sha.nullable(),
  baseline_repair: z.boolean(), pr_number: z.int().positive().nullable(), pr_url: z.string().nullable(),
  issue_number: z.int().positive().nullable(), branch: z.string().nullable(),
});
const runSchema = z.object({
  id: uuid, version: z.int(), outcome: z.string().nullable(), started_at: z.string(),
  completed_at: z.string().nullable(), phases: z.array(z.object({ phase: z.string() })),
});
const detailSchema = z.object({
  task: taskSchema, runs: z.array(runSchema),
  history: z.array(z.object({ kind: z.string() })),
  projectReview: z.object({
    repo: z.string(), confirmed: z.boolean(), config_version: z.int().positive(), binding_version: z.int().positive(),
    confirmation: z.object({ kind: z.string() }).nullable(),
  }),
});
type Detail = z.infer<typeof detailSchema>;
type Run = z.infer<typeof runSchema>;
const alerts = z.object({ alerts: z.array(z.object({ task_id: z.string().nullable(), kind: z.string(), text: z.string() })) });
const failures = new Set(["failed", "cancelled", "rejected", "closed", "interrupted", "ready", "merged", "answered"]);
const orderedRuns = (runs: readonly Run[]) => [...runs].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));

function ordered(actual: readonly string[], expected: readonly string[]) {
  let position = -1;
  for (const step of expected) {
    position = actual.indexOf(step, position + 1);
    assert(position >= 0, `執行或稽核順序缺少 ${step}`);
  }
}

const outcomes: Record<Variant, readonly string[]> = {
  baseline: ["failed", "ready"], resume: ["auto_resumed", "ready"],
  "timeout-again": ["auto_resumed", "failed"], backoff: ["queued", "queued", "ready"],
  "model-unavailable": ["failed"], "request-rejected": ["failed"], quota: ["budget_wait", "ready"],
};

/** 看板依最新執行優先回傳；所有分支都核對同一核准版本的完整執行序列。 */
export function checkRecoveryRuns(variant: Variant, version: number, rows: readonly Run[]) {
  const runs = orderedRuns(rows);
  assert.deepEqual(runs.map(r => r.outcome), outcomes[variant], "執行次數或結局不符");
  assert.equal(new Set(runs.map(r => r.id)).size, runs.length, "執行識別碼重複");
  for (const r of runs) assert(r.completed_at && r.version === version, "執行未清理或版本不符");
  const last = runs[runs.length - 1];
  const phases = last.phases.map(p => p.phase);
  if (variant === "baseline") {
    const first = runs[0].phases.map(p => p.phase);
    ordered(first, ["test"]);
    assert(!first.includes("code"), "基底失敗後仍修改程式");
    ordered(phases, ["test", "code", "test", "review", "publish"]);
  } else if (variant === "resume" || variant === "timeout-again") {
    ordered(runs[0].phases.map(p => p.phase), ["code", "test", "review"]);
    assert(!phases.includes("code"), "接續時重新呼叫模型修改");
    ordered(phases, ["test", "review"]);
  } else {
    for (const r of runs) ordered(r.phases.map(p => p.phase), ["code"]);
  }
  if (last.outcome === "ready") ordered(phases, ["test", "review", "publish"]);
  else assert(!phases.includes("publish"), "失敗的任務進入發布");
  return last;
}

type Retry = { failedAt: string; due: string };
export function checkRetrySchedule(rows: readonly Run[], schedule: readonly Retry[]) {
  const runs = orderedRuns(rows);
  assert.equal(schedule.length, 2, "需要兩次排定的退避");
  assert.equal(runs.length, 3, "需要兩次重試的實際開始時間");
  let previous = 0;
  for (const [i, retry] of schedule.entries()) {
    const due = Date.parse(retry.due);
    const interval = due - Date.parse(retry.failedAt);
    assert(interval > previous, "自動重試的退避時間沒有逐次拉長");
    assert(Date.parse(runs[i + 1].started_at) >= due, "排程在退避到期前重開執行");
    previous = interval;
  }
}

async function observe(ctx: RecoveryFlowContext, id: string, status: string, visit = 0) {
  return ctx.poll(`任務 ${id} 進入 ${status}`, async () => {
    const view = detailSchema.parse(await ctx.admin("GET", `/api/tasks/${id}`));
    assert.equal(view.task.id, id, "看板回傳其他任務");
    assert.equal(view.task.group_id, group, "任務群組錯誤");
    assert.equal(view.task.project_id, ctx.projectId, "任務專案錯誤");
    assert.equal(view.projectReview.repo, ctx.repository, "看板儲存庫錯誤");
    assert.equal(view.task.target_branch, branch, "任務目標分支錯誤");
    if (view.task.status !== status) {
      assert(!failures.has(view.task.status), `預期 ${status}，任務已成為 ${view.task.status}`);
      return undefined;
    }
    if (visit && (view.runs.length !== visit || !view.task.retry_at)) return undefined;
    if (view.runs.some(r => !r.completed_at)) return undefined;
    if (status !== "awaiting_approval") {
      assert.equal(view.task.approved_version, view.task.version, "未核准此版需求");
      assert(view.projectReview.confirmed && view.projectReview.confirmation?.kind === "manual", "缺少本版人工確認");
    }
    return view;
  });
}

async function notice(ctx: RecoveryFlowContext, id: string, kind: string, pattern: RegExp | string) {
  return ctx.poll(`看板顯示 ${kind} 通知`, async () => {
    const state = alerts.parse(await ctx.admin("GET", "/api/state"));
    return state.alerts.find(a => a.task_id === id && a.kind === kind &&
      (typeof pattern === "string" ? a.text.includes(pattern) : pattern.test(a.text)))?.text;
  });
}

function receiver(ctx: RecoveryFlowContext, offset: number) {
  const messages: string[] = [];
  return {
    messages,
    async next(label: string, matches: (text: string) => boolean) {
      const receipt = await ctx.poll(label, async () => {
        const rows = await ctx.groupMessages(group);
        const index = rows.findIndex((text, i) => i >= offset && matches(text));
        return index < 0 ? undefined : { index, text: rows[index] };
      });
      offset = receipt.index + 1;
      messages.push(receipt.text);
    },
  };
}
type Receiver = ReturnType<typeof receiver>;

function request(projectId: string, second: boolean) {
  const [classify, edit, summary, ...review] = discordChangeSteps(projectId);
  if (!second) return { packet: discord, classify, code: [edit, summary], review };
  const text = "請修改 lantern-tickets 的 main，讓 countTickets(null) 回傳 0，並加入對應的測試。";
  const packet = { ...discord, interactionId: "100000000000000006", sequence: 2, text };
  const sourceId = discordId(packet.interactionId);
  const quote = { sourceId, quote: text };
  const response = { decisions: [{
    kind: "request", taskType: "change", projectId, title: "未提供有效票批時回傳零", summary: text,
    acceptance: ["傳入 null 時回傳 0 並有測試"], sourceIds: [sourceId],
    relatedTaskId: null, relatedListItemId: null, noTaskReason: null, schedule: null, risks: [],
    missing: [], question: null, assumptions: [], suggestions: [], contextSourceIds: [],
    routing: { status: "clear", basis: "explicit", reason: "來源指定燈會專案。", evidence: [{ kind: "message", ...quote }] },
    targetBranch: { name: branch, basis: "explicit", reason: "來源指定 main。", evidence: [quote] },
  }] } satisfies z.output<typeof Decisions>;
  return { packet, classify: { kind: "text", text: JSON.stringify(response) } satisfies ModelStep, review,
    code: [command("sed -i 's/return batches.reduce/return (batches ?? []).reduce/' tickets.mjs && echo 'test(\"票批為空值\", () => assert.equal(countTickets(null), 0));' >> tickets.test.mjs"),
      { kind: "text", text: "已處理空值票批並補上對應測試。" } satisfies ModelStep] };
}

function command(cmd: string): ModelStep {
  return { kind: "tool", name: "exec_command", arguments: { cmd, workdir: "/workspace" } };
}

async function submit(ctx: RecoveryFlowContext, work: ReturnType<typeof request>) {
  const source = discordId(work.packet.interactionId);
  assert(!await ctx.db.one("SELECT id FROM messages WHERE id=$1 AND group_id=$2", [source, group]), "來源訊息已投遞");
  await ctx.setModelSteps([work.classify]);
  await ctx.gateway(discordTaskInteraction(work.packet));
  const id = await ctx.poll("從本次 Discord 指令找到修改任務", async () => {
    const row = await ctx.db.one(
      `SELECT t.id FROM tasks t JOIN messages m ON m.group_id=t.group_id AND m.id=ANY(t.source_ids)
       WHERE m.id=$1 AND m.group_id=$2 AND m.trigger_mode='command'`, [source, group]);
    return row ? z.object({ id: uuid }).parse(row).id : undefined;
  });
  const pending = await observe(ctx, id, "awaiting_approval");
  assert.deepEqual(pending.task.source_ids, [source], "任務來源不符");
  return pending;
}

async function approve(ctx: RecoveryFlowContext, pending: Detail) {
  const { task, projectReview } = pending;
  assert.equal(task.status, "awaiting_approval");
  assert(!projectReview.confirmed && task.approved_version === null && !pending.runs.length && !task.pr_number, "人工核准前已派工");
  await notice(ctx, task.id, "approval", ctx.repository);
  const approved = taskSchema.parse(await ctx.admin("POST", `/api/tasks/${task.id}/actions`, {
    action: "approve", version: task.version, project_id: task.project_id, target_branch: task.target_branch,
    config_version: projectReview.config_version, binding_version: projectReview.binding_version,
  }));
  assert.equal(approved.id, task.id);
  assert.equal(approved.status, "queued");
  assert.equal(approved.approved_version, task.version);
}

async function published(ctx: RecoveryFlowContext, view: Detail, inbox: Receiver, repair = false) {
  const { task } = view;
  assert(task.pr_number && task.pr_url && task.issue_number && task.branch, "看板缺少發布結果");
  const pr = await ctx.readPr(task.pr_number);
  assert(pr && pr.number === task.pr_number && pr.base === branch && pr.head === task.branch && pr.head !== pr.base, "GitHub PR 與核准分支不符");
  sha.parse(pr.headSha);
  assert(pr.body.split(/\r?\n/).includes(`Closes #${task.issue_number}`));
  assert(pr.body.includes("測試：通過") && pr.body.includes("獨立審查：通過"), "PR 缺少驗證結果");
  assert.deepEqual(Object.keys(pr.files).sort(), repair ? ["tickets.mjs"] : ["tickets.mjs", "tickets.test.mjs"], "PR 變更範圍不符");
  assert.equal(pr.deletedFiles?.length ?? 0, 0);
  assert(pr.files["tickets.mjs"].includes("total + tickets"), "票數加總未保留");
  if (!repair) {
    assert.match(pr.files["tickets.mjs"], /countTickets\(batches = \[\]\)/);
    assert.match(pr.files["tickets.test.mjs"], /assert\.equal\(countTickets\(\), 0\)/);
  }
  await notice(ctx, task.id, "ready", task.pr_url);
  const url = task.pr_url;
  await inbox.next("原頻道收到本題 PR", text => text.includes(task.title) && text.includes(url));
  return { issue: task.issue_number, pr: pr.number, headSha: sha.parse(pr.headSha) };
}

async function failed(ctx: RecoveryFlowContext, view: Detail, inbox: Receiver, reason: RegExp) {
  assert.equal(view.task.pr_number, null, "失敗時已發布 PR");
  assert.equal(view.task.retry_at, null, "終態仍排定重試");
  assert.match(view.task.last_error ?? "", reason, "看板缺少本次失敗原因");
  await notice(ctx, view.task.id, "failed", reason);
  await inbox.next("原頻道收到本次失敗原因", text => reason.test(text));
}

const brokenTest = "合計各批燈會票數，而非批數";
async function baseline(ctx: RecoveryFlowContext, pending: Detail, work: ReturnType<typeof request>, inbox: Receiver, checkpoint?: Checkpoint) {
  // 專案已在綠色版本完成自動驗證。README 變動使正式設定指紋失效，測試本身保持原樣。
  const brokenSha = sha.parse(await ctx.commitFixture({
    "README.md": "燈會票務使用 npm test 執行完整測試。",
    "tickets.mjs": "export function countTickets(batches) {\n  return batches.reduce((total, tickets) => total - tickets, 0);\n}\n",
  }));
  await ctx.setModelSteps([recoverySetupStep]);
  await approve(ctx, pending);
  const id = pending.task.id;
  const red = await observe(ctx, id, "failed");
  assert.equal(red.task.base_sha, brokenSha, "失敗的基底不符");
  assert.equal(parseFailure(red.task.last_error)?.plain, baselineFailurePlain);
  assert.equal(red.runs.length, 1);
  assert(!red.runs[0].phases.some(p => p.phase === "code"), "在基底失敗後仍執行修改");
  await failed(ctx, red, inbox, new RegExp(brokenTest));

  const repair = taskSchema.parse(await ctx.admin("POST", `/api/tasks/${id}/baseline-repair`, {}));
  assert(repair.baseline_repair && repair.id !== id && repair.summary.includes(brokenTest), "修復任務缺少原任務的失敗清單");
  const repairPending = await observe(ctx, repair.id, "awaiting_approval");
  await ctx.setModelSteps([recoverySetupStep, command("sed -i 's/total - tickets/total + tickets/' tickets.mjs"),
    { kind: "text", text: "已恢復票數加總。" }, ...work.review]);
  await approve(ctx, repairPending);
  const ready = await observe(ctx, repair.id, "ready");
  assert.equal(ready.task.base_sha, brokenSha);
  assert.equal(ready.runs.length, 1);
  assert.equal(ready.runs[0].outcome, "ready");
  ordered(ready.runs[0].phases.map(p => p.phase), ["test", "code", "test", "review", "publish"]);
  ordered(ready.history.map(h => h.kind), ["baseline_repair", "approve", "baseline_known_failures", "ready"]);
  const pr = await published(ctx, ready, inbox, true);
  const mergedSha = sha.parse(await ctx.mergeFixturePr(pr.pr));
  assert.notEqual(mergedSha, brokenSha, "合併未推進基底");
  const delivered = await ctx.webhook(signedGitHubPrMerged({ secret: ctx.githubWebhookSecret, deliveryId: randomUUID(),
    repository: ctx.repository, prNumber: pr.pr }));
  assert.equal(delivered.statusCode, 200, "修復 PR 合併事件投遞失敗");
  const merged = await observe(ctx, repair.id, "merged");
  assert.equal(merged.task.pr_number, pr.pr);
  ordered(merged.history.map(h => h.kind), ["ready", "merged"]);
  await inbox.next("原頻道收到修復合併通知", text => text.includes(repair.title) && text.includes("修改已合併"));
  await checkpoint?.({ taskId: repair.id, runId: ready.runs[0].id, ...pr, groupMessages: [...inbox.messages] });

  await ctx.setModelSteps([recoverySetupStep, ...work.code, ...work.review]);
  const retry = taskSchema.parse(await ctx.admin("POST", `/api/tasks/${id}/actions`, { action: "retry", version: red.task.version }));
  assert(retry.id === id && retry.status === "queued" && retry.version === pending.task.version);
  const result = await observe(ctx, id, "ready");
  assert.equal(result.task.base_sha, mergedSha, "原任務重試未使用已合併的基底");
  ordered(result.history.map(h => h.kind), ["approve", "error", "retry", "started", "ready"]);
  return result;
}

async function hit(ctx: RecoveryFlowContext, label: string) {
  await ctx.poll(label, async () => (await ctx.modelFaultHits()) > 0 ? true : undefined);
}

async function timeout(ctx: RecoveryFlowContext, variant: "resume" | "timeout-again",
  pending: Detail, work: ReturnType<typeof request>, inbox: Receiver) {
  await ctx.setModelFault(work.code, { kind: "stall" });
  await approve(ctx, pending);
  await hit(ctx, "獨立審查的訂閱請求已抵達掛起的上游");
  // 第一個審查請求仍在等待自己的期限；只有新的請求會使用重新設定的回覆。
  if (variant === "resume") await ctx.setModelSteps(work.review);
  const id = pending.task.id;
  await notice(ctx, id, "auto_resume", /逾時.*接續/);
  await inbox.next("原頻道收到候選保留與自動接續通知", t => /保留.*修改/.test(t) && t.includes("自動接續"));
  const view = await observe(ctx, id, variant === "resume" ? "ready" : "failed");
  const first = orderedRuns(view.runs)[0];
  assert(first, "未建立逾時執行");
  // 只讀接續證據，既不傳回原始內容也不改寫候選。
  const saved = await ctx.db.one(
    `SELECT result->'candidate'->>'baseSha' AS base,
       EXISTS(SELECT 1 FROM jsonb_array_elements(result->'files') f
              WHERE f->>'path'='tickets.mjs' AND length(f->>'content')>0) AS has_file
     FROM runs WHERE id=$1 AND task_id=$2 AND version=$3`, [first.id, id, pending.task.version]);
  const candidate = z.object({ base: sha, has_file: z.literal(true) }).parse(saved);
  assert.equal(candidate.base, view.task.base_sha, "接續候選的基底改變");
  const audit = view.history.map(h => h.kind);
  assert.equal(audit.filter(kind => kind === "auto_resume").length, 1, "每版只能自動接續一次");
  assert(!audit.includes("retry") && !audit.includes("auto_retry"), "逾時後走了其他重試路徑");
  ordered(audit, ["approve", "started", "auto_resume", "started", variant === "resume" ? "ready" : "error"]);
  if (variant === "timeout-again") {
    assert((await ctx.modelFaultHits()) >= 2, "第二次執行未抵達故障上游");
    await failed(ctx, view, inbox, /(?:接續|重試).*一次.*(?:失敗|未成功)/);
    assert.match(view.task.last_error ?? "", /時間|逾時/);
    assert.match(view.task.last_error ?? "", /保留/);
  }
  return view;
}

async function backoff(ctx: RecoveryFlowContext, pending: Detail, work: ReturnType<typeof request>) {
  const schedule: Retry[] = [];
  const faults = [{ kind: "error", status: 502 }, { kind: "disconnect" }] as const;
  for (const [index, fault] of faults.entries()) {
    await ctx.setModelFault([], fault);
    if (!index) await approve(ctx, pending);
    await hit(ctx, index ? "重試遭遇未完成的 Responses 串流" : "首次修改遭遇上游 502");
    const wait = await observe(ctx, pending.task.id, "queued", index + 1);
    const retries = wait.history.filter(h => h.kind === "auto_retry");
    assert.equal(retries.length, index + 1, "沒有本次故障的自動重試稽核");
    assert.match(wait.task.last_error ?? "", /等待|稍後|重試|再試/, "看板缺少等待說明");
    const due = wait.task.retry_at;
    assert(due && Date.parse(due) > Date.now(), "未觀察到仍有效的退避期限");
    // retry_at 與 updated_at 由同一筆狀態轉移寫入，稽核稍後才另行寫入。
    schedule.push({ failedAt: wait.task.updated_at, due });
  }
  // 不呼叫 retry，不修改 retry_at。下一輪由正式排程派工。
  await ctx.setModelSteps([...work.code, ...work.review]);
  const result = await observe(ctx, pending.task.id, "ready");
  checkRetrySchedule(result.runs, schedule);
  ordered(result.history.map(h => h.kind), ["approve", "started", "auto_retry", "started", "auto_retry", "started", "ready"]);
  return result;
}

const permanent = {
  "model-unavailable": { fault: { kind: "error", status: 404, message: "model_not_found" },
    reason: /模型.{0,18}(?:不可用|無法使用|不存在|不支援|找不到)|找不到.{0,8}模型/ },
  "request-rejected": { fault: { kind: "error", status: 400, message: "invalid_request_error" },
    reason: /(?:請求|要求).{0,18}(?:被拒|拒絕|無效|不接受)|拒絕.{0,8}(?:請求|要求)/ },
} as const;

async function reject(ctx: RecoveryFlowContext, variant: keyof typeof permanent, pending: Detail, inbox: Receiver) {
  const { fault, reason } = permanent[variant];
  await ctx.setModelFault([], fault);
  await approve(ctx, pending);
  await hit(ctx, `訂閱上游回應 ${fault.status}`);
  const view = await observe(ctx, pending.task.id, "failed");
  assert(!view.history.some(h => ["retry", "auto_retry", "auto_resume"].includes(h.kind)), "永久錯誤仍被重試");
  ordered(view.history.map(h => h.kind), ["approve", "started", "error"]);
  await failed(ctx, view, inbox, reason);
  return view;
}

async function quota(ctx: RecoveryFlowContext, pending: Detail, work: ReturnType<typeof request>, inbox: Receiver) {
  await ctx.setModelFault([], { kind: "error", status: 429 });
  await approve(ctx, pending);
  await hit(ctx, "訂閱上游回應 429 並耗盡時段額度");
  const wait = await observe(ctx, pending.task.id, "budget_wait");
  assert.equal(wait.task.pr_number, null);
  assert.match(wait.task.last_error ?? "", /額度/);
  assert(wait.history.some(h => h.kind === "quota"), "缺少本次執行用完額度的稽核");
  await notice(ctx, pending.task.id, "budget", /額度/);
  await inbox.next("原頻道收到額度恢復後將自動繼續的通知", t => /額度.*恢復.*自動繼續/.test(t));
  await ctx.setModelSteps([...work.code, ...work.review]);
  const result = await observe(ctx, pending.task.id, "ready");
  ordered(result.history.map(h => h.kind), ["approve", "started", "quota", "started", "ready"]);
  assert(!result.history.some(h => ["retry", "auto_retry"].includes(h.kind)), "額度恢復時走了其他重試路徑");
  return result;
}

/** 每個編號各用一個新隔離實例。主控在此函式回傳後照常核對結案不變式、清理與帳本。 */
export async function runRecoveryFlow(number: RecoveryNumber, ctx: RecoveryFlowContext,
  checkpoint?: Checkpoint): Promise<Result> {
  const messages: string[] = [];
  let last: Result | undefined;
  for (const [index, variant] of recoveryScenarios[number].entries()) {
    const work = request(ctx.projectId, index > 0);
    const inbox = receiver(ctx, (await ctx.groupMessages(group)).length);
    const pending = await submit(ctx, work);
    let result: Detail;
    switch (variant) {
      case "baseline": result = await baseline(ctx, pending, work, inbox, checkpoint); break;
      case "resume":
      case "timeout-again": result = await timeout(ctx, variant, pending, work, inbox); break;
      case "backoff": result = await backoff(ctx, pending, work); break;
      case "model-unavailable":
      case "request-rejected": result = await reject(ctx, variant, pending, inbox); break;
      case "quota": result = await quota(ctx, pending, work, inbox); break;
    }
    assert.equal(result.task.version, pending.task.version, "完成版本與核准不符");
    const run = checkRecoveryRuns(variant, pending.task.version, result.runs);
    const pr = result.task.status === "ready" ? await published(ctx, result, inbox) : {};
    last = { taskId: pending.task.id, runId: run.id, ...pr, groupMessages: inbox.messages };
    await checkpoint?.(last);
    messages.push(...inbox.messages);
  }
  assert(last, "查無失敗與恢復劇本");
  return { ...last, groupMessages: messages };
}
