import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Decisions } from "../../../server/triage.js";
import { endReasonLabels, triageNoTaskLabels } from "../../../shared/status-glossary.js";
import type { RecordInput } from "../ledger.js";
import { basicFixture, type BasicFlowContext } from "./basic.js";
import type { ModelStep } from "./model-upstream.js";
import { signedGitHubPrMerged, signedLineMessage } from "./signed-events.js";

export type ConversationFlowContext = BasicFlowContext & {
  setModelSteps(steps: readonly ModelStep[]): Promise<void>;
};
type Result = NonNullable<RecordInput["references"]> & { groupMessages: string[] };
export type ConversationNumber = 3 | 4 | 5 | 6 | 7 | 8 | 9;
type Decision = z.output<typeof Decisions>["decisions"][number];
type Message = { id: string; text: string };
const { line, branch, project } = basicFixture;

function decision(
  message: Message,
  projectId: string | null,
  title: string,
  mode: Decision["taskType"],
  summary = message.text,
): Decision {
  const explicit = projectId !== null && message.text.includes(project);
  return {
    kind: "request",
    taskType: mode,
    projectId,
    title,
    summary,
    acceptance: [summary],
    sourceIds: [message.id],
    risks: [],
    missing: [],
    suggestions: [],
    assumptions: [],
    contextSourceIds: [],
    relatedTaskId: null,
    relatedListItemId: null,
    noTaskReason: null,
    schedule: null,
    question: null,
    targetBranch: {
      name: projectId ? branch : null,
      basis: projectId ? "default" : "uncertain",
      reason: projectId ? "沿用專案預設分支。" : "須先指定專案。",
      evidence: [],
    },
    routing: explicit
      ? {
          status: "clear",
          basis: "explicit",
          reason: "成員指名此專案。",
          evidence: [{ kind: "message", sourceId: message.id, quote: message.text }],
        }
      : { status: "uncertain", basis: "none", reason: "訊息未指定專案。", evidence: [] },
  };
}
function classification(...decisions: Decision[]): Extract<ModelStep, { kind: "text" }> {
  return { kind: "text", text: JSON.stringify({ decisions }) };
}
function command(cmd: string): ModelStep {
  return { kind: "tool", name: "exec_command", arguments: { cmd, workdir: "/workspace" } };
}
function answerSteps(result: string): ModelStep[] {
  return [
    command("cat -n tickets.mjs"),
    { kind: "text", text: `## 先看重點\n${result}\n\n## 程式依據\ntickets.mjs:2 從零開始累加每批張數。` },
  ];
}
const reviewSteps: ModelStep[] = [
  command("cat /tmp/agentflow-review-*/manifest.json /tmp/agentflow-review-*/*.patch"),
  { kind: "text", text: JSON.stringify({ passed: true, findings: [], notes: [] }) },
];

export function quotedLineMessage(secret: string, message: Message, quotedId?: string) {
  const request = signedLineMessage({
    ...line,
    text: message.text,
    secret,
    timestamp: Date.now(),
    messageId: message.id,
    eventId: "lantern-conversation-" + message.id,
  });
  if (!quotedId) return request;
  const body = JSON.parse(request.payload);
  body.events[0].message.quotedMessageId = quotedId;
  const payload = JSON.stringify(body);
  return {
    ...request,
    payload,
    headers: {
      ...request.headers,
      "x-line-signature": createHmac("sha256", secret).update(payload).digest("base64"),
    },
  };
}

const Detail = z.object({
  task: z.object({
    id: z.uuid(),
    title: z.string(),
    summary: z.string(),
    acceptance: z.array(z.string()),
    source_ids: z.array(z.string()),
    parent_id: z.uuid().nullable(),
    group_id: z.string(),
    mode: z.enum(["change", "query"]),
    version: z.number().int(),
    status: z.string(),
    approved_version: z.number().nullable(),
    project_id: z.uuid().nullable(),
    target_branch: z.string().nullable(),
    branch: z.string().nullable(),
    base_sha: z.string().nullable(),
    answer: z.string().nullable(),
    issue_number: z.number().nullable(),
    pr_number: z.number().nullable(),
    pr_url: z.string().nullable(),
    pending_paths: z.array(z.string()),
    approved_paths: z.array(z.string()),
    end_reason: z.string().nullable(),
    missing: z.array(z.string()),
    question: z.object({ text: z.string() }).nullable(),
  }),
  history: z.array(z.object({ kind: z.string(), detail: z.string() })),
  projectReview: z.object({
    binding_version: z.number().int(),
    config_version: z.number().nullable(),
    repo: z.string().nullable(),
    confirmed: z.boolean(),
    confirmation: z.object({ kind: z.string() }).nullable(),
  }),
  runs: z.array(
    z.object({
      id: z.uuid(),
      version: z.number().int(),
      outcome: z.string().nullable(),
      completed_at: z.string().nullable(),
      phases: z.array(z.object({ phase: z.string() })),
    }),
  ),
});
type View = z.output<typeof Detail>;
type Task = View["task"];
const Alerts = z.object({
  alerts: z.array(z.object({ task_id: z.string().nullable(), kind: z.string(), text: z.string() })),
});

async function send(ctx: ConversationFlowContext, message: Message, steps: ModelStep[], quote?: string) {
  const old = await ctx.db.one("SELECT id FROM messages WHERE id=$1", [message.id]);
  assert(!old, "本次來源已存在，請使用全新驗收實例");
  await ctx.setModelSteps(steps);
  const response = await ctx.webhook(quotedLineMessage(ctx.lineSecret, message, quote));
  assert.equal(response.statusCode, 200, `LINE 投遞失敗（HTTP ${response.statusCode}）`);
}
async function idsFor(ctx: ConversationFlowContext, message: Message) {
  const row = await ctx.db.one(
    "SELECT ARRAY(SELECT id FROM tasks WHERE group_id=$1 AND $2=ANY(source_ids) ORDER BY id) AS ids",
    [line.groupId, message.id],
  );
  return z.object({ ids: z.array(z.uuid()) }).parse(row).ids;
}
async function taskFor(ctx: ConversationFlowContext, message: Message) {
  return ctx.poll("等待本則 LINE 訊息建立唯一任務 " + message.id, async () => {
    const ids = await idsFor(ctx, message);
    if (!ids.length) return undefined;
    assert.equal(ids.length, 1, "同一個需求產生多張任務");
    return ids[0];
  });
}
async function read(ctx: ConversationFlowContext, id: string) {
  const view = Detail.parse(await ctx.admin("GET", "/api/tasks/" + id));
  assert.equal(view.task.id, id);
  assert.equal(view.task.group_id, line.groupId);
  return view;
}
async function at(ctx: ConversationFlowContext, id: string, status: string, active: string[] = []) {
  return ctx.poll(`等待 ${id} 進入 ${status} 並完成本次執行清理`, async () => {
    const view = await read(ctx, id);
    if (view.task.status === status)
      return view.runs.every((r) => r.completed_at !== null) ? view : undefined;
    assert(active.includes(view.task.status), `預期 ${status}，實際為 ${view.task.status}`);
    return undefined;
  });
}
async function alert(ctx: ConversationFlowContext, id: string, kind: string, fragment: string) {
  return ctx.poll("管理者看板收到 " + kind, async () => {
    const { alerts } = Alerts.parse(await ctx.admin("GET", "/api/state"));
    return alerts.find((a) => a.task_id === id && a.kind === kind && a.text.includes(fragment))?.text;
  });
}
async function received(ctx: ConversationFlowContext, offset: number, ...parts: string[]) {
  return ctx.poll("LINE 原群組收到「" + parts.join("／") + "」", async () =>
    (await ctx.groupMessages(line.groupId)).slice(offset).find((s) => parts.every((p) => s.includes(p))),
  );
}
async function sentId(ctx: ConversationFlowContext, id: string, kind: string) {
  return ctx.poll("取得本次已送達的 LINE 訊息識別碼 " + kind, async () => {
    const row = await ctx.db.one(
      "SELECT sent_message_id FROM notifications WHERE task_id=$1 AND group_id=$2 AND kind=$3 AND sent_at IS NOT NULL AND sent_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [id, line.groupId, kind],
    );
    return row ? z.object({ sent_message_id: z.string().min(1) }).parse(row).sent_message_id : undefined;
  });
}
function ordered(actual: string[], expected: string[]) {
  let last = -1;
  for (const step of expected) {
    last = actual.indexOf(step, last + 1);
    assert(last >= 0, "缺少有序步驟 " + step);
  }
}
function audit(view: View, ...events: string[]) {
  ordered(
    view.history.map((h) => h.kind),
    events,
  );
}
function pending(view: View, mode: "change" | "query") {
  assert.equal(view.task.status, "awaiting_approval");
  assert.equal(view.task.mode, mode);
  assert.equal(view.task.approved_version, null);
  assert.equal(view.projectReview.confirmed, false);
  assert.equal(view.task.pr_number, null);
  assert.equal(view.runs.length, 0, "首次人工決定前已有執行");
  audit(view, "triage");
}
async function approve(ctx: ConversationFlowContext, view: View, steps: ModelStep[]) {
  const { task, projectReview } = view;
  assert.equal(task.status, "awaiting_approval");
  assert.equal(task.approved_version, null);
  assert.equal(task.project_id, ctx.projectId);
  assert.equal(task.target_branch, branch);
  assert.equal(projectReview.repo, ctx.repository);
  assert(projectReview.config_version !== null);
  await ctx.setModelSteps(steps);
  const result = await ctx.admin("POST", `/api/tasks/${task.id}/actions`, {
    action: "approve",
    version: task.version,
    project_id: task.project_id,
    target_branch: task.target_branch,
    binding_version: projectReview.binding_version,
    config_version: projectReview.config_version,
  });
  z.object({
    id: z.literal(task.id),
    approved_version: z.literal(task.version),
    status: z.literal("queued"),
  }).parse(result);
}
function finalRun(ctx: ConversationFlowContext, view: View, status: "ready" | "answered") {
  const { task } = view;
  assert.equal(task.status, status);
  assert.equal(task.mode, status === "ready" ? "change" : "query");
  assert.equal(task.project_id, ctx.projectId);
  assert.equal(task.target_branch, branch);
  assert.equal(view.projectReview.repo, ctx.repository);
  assert.equal(view.projectReview.confirmed, true);
  assert.equal(task.approved_version, task.version);
  const [run] = view.runs;
  assert(
    run?.completed_at && run.version === task.version && run.outcome === status,
    "缺少本版成功結束的執行",
  );
  return run;
}
async function answered(ctx: ConversationFlowContext, id: string, offset: number, expected: string) {
  const view = await at(ctx, id, "answered", ["queued", "running"]);
  const run = finalRun(ctx, view, "answered");
  ordered(
    run.phases.map((p) => p.phase),
    ["code"],
  );
  audit(view, "triage", "started", "answered");
  assert(
    view.task.answer?.includes(expected) && view.task.answer.includes("tickets.mjs"),
    "查詢結果或程式依據錯誤",
  );
  assert.equal(view.task.pr_number, null);
  await alert(ctx, id, "answered", expected);
  const message = await received(ctx, offset, view.task.title, expected);
  return { view, runId: run.id, message };
}
type DocumentChange = { title: string; path: string; content: string };
const gate: DocumentChange = { title: "記錄東門票單", path: "east.md", content: "東門票單按批次加總。" };
const booth: DocumentChange = {
  title: "記錄服務台時段",
  path: "booth.md",
  content: "服務台於下午三點開放。",
};
const queue: DocumentChange = { title: "記錄排隊位置", path: "queue.md", content: "排隊起點在燈籠旁。" };
const sensitive: DocumentChange = {
  title: "補上場地清點說明",
  path: "infra/venue.md",
  content: "佈場完成後由場務組清點燈架。",
};

const requirement = (change: DocumentChange) => `在 ${change.path} 寫入「${change.content}」`;
function editSteps(change: DocumentChange): ModelStep[] {
  // 檔名與內容均為本檔的固定驗收素材。
  return [
    command(
      `mkdir -p "$(dirname '${change.path}')" && printf '%s\\n' '${change.content}' > '${change.path}'`,
    ),
    { kind: "text", text: requirement(change) },
  ];
}
async function published(
  ctx: ConversationFlowContext,
  id: string,
  offset: number,
  ...changes: DocumentChange[]
) {
  const view = await at(ctx, id, "ready", ["queued", "running", "reviewing"]);
  const run = finalRun(ctx, view, "ready");
  assert.equal(view.projectReview.confirmation?.kind, "manual");
  ordered(
    run.phases.map((p) => p.phase),
    ["test", "review", "publish"],
  );
  audit(view, "triage", "approve", "started", "ready");
  const { pr_number: pr, pr_url: url, issue_number: issue, branch: head } = view.task;
  assert(pr && url && issue && head && head !== branch, "看板缺少本案的 PR、Issue 或工作分支");
  const remote = await ctx.readPr(pr);
  assert(remote, "GitHub 找不到看板上的 PR");
  assert.equal(remote.number, pr);
  assert.equal(remote.head, head);
  assert.equal(remote.base, branch);
  assert(remote.body.split(/\r?\n/).includes("Closes #" + issue));
  assert.deepEqual(
    remote.files,
    Object.fromEntries(changes.map((c) => [c.path, c.content + "\n"])),
    "PR 內容與核准範圍不同",
  );
  assert(remote.headSha && /^[a-f0-9]{40}$/.test(remote.headSha), "GitHub PR 缺少目前提交的 SHA");
  assert.equal(remote.deletedFiles?.length ?? 0, 0);
  await alert(ctx, id, "ready", url);
  const message = await received(ctx, offset, view.task.title, url);
  return {
    view,
    message,
    body: remote.body,
    refs: { taskId: id, runId: run.id, issue, pr, headSha: remote.headSha },
  };
}

const offsetOf = async (ctx: ConversationFlowContext) => (await ctx.groupMessages(line.groupId)).length;
async function beginChange(ctx: ConversationFlowContext, msg: Message, change: DocumentChange) {
  await send(ctx, msg, [
    classification(decision(msg, ctx.projectId, change.title, "change", requirement(change))),
  ]);
  const id = await taskFor(ctx, msg);
  const view = await at(ctx, id, "awaiting_approval");
  pending(view, "change");
  assert.deepEqual(view.task.source_ids, [msg.id]);
  await alert(ctx, id, "approval", ctx.repository);
  return view;
}

const selectedChanges = [gate, queue];
export function selectMeetingItems(items: readonly { id: string; title: string; summary: string }[]) {
  assert.deepEqual(
    items.map((i) => i.title).sort(),
    [gate.title, booth.title, queue.title].sort(),
    "清單項目與會議紀錄不符",
  );
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, "清單項目識別碼重複");
  return selectedChanges.map((change) => {
    const item = items.find((i) => i.title === change.title);
    assert(item && item.summary.includes(change.path), "待挑選項目內容與會議紀錄不符");
    return item.id;
  });
}

async function pickTwo(ctx: ConversationFlowContext): Promise<Result> {
  const offset = await offsetOf(ctx);
  const choices = [gate, booth, queue];
  const minutes = { id: "2660301", text: `${project} 會議紀錄：${choices.map(requirement).join("；")}。` };
  await send(ctx, minutes, [
    classification(
      ...choices.map((change) =>
        decision(minutes, ctx.projectId, change.title, "change", requirement(change)),
      ),
    ),
  ]);
  const lists = z.object({
    pickLists: z.array(
      z.object({
        id: z.uuid(),
        version: z.number().int(),
        groupId: z.string(),
        items: z.array(z.object({ id: z.uuid(), title: z.string(), summary: z.string() })),
      }),
    ),
  });
  const list = await ctx.poll("看板列出會議待辦", async () => {
    const { pickLists } = lists.parse(await ctx.admin("GET", "/api/state"));
    return pickLists.find((l) => l.groupId === line.groupId && l.items.some((i) => i.title === gate.title));
  });
  const itemIds = selectMeetingItems(list.items);
  assert.deepEqual(await idsFor(ctx, minutes), [], "挑選前不應有任務");
  const groupMessages = [await received(ctx, offset, "收到 3 項待辦", "挑選")];
  const resolved = await ctx.admin("POST", `/api/pick-lists/${list.id}/resolve`, {
    version: list.version,
    itemIds,
  });
  z.object({ created: z.literal(2) }).parse(resolved);
  const after = lists.parse(await ctx.admin("GET", "/api/state"));
  assert(!after.pickLists.some((l) => l.id === list.id), "已挑選的清單仍可重複操作");
  const ids = await idsFor(ctx, minutes);
  assert.equal(ids.length, 2, "挑選兩項應只建立兩張任務");
  const views = await Promise.all(ids.map((id) => at(ctx, id, "awaiting_approval")));
  const completed = [];
  for (const change of selectedChanges) {
    const view = views.find((v) => v.task.title === change.title);
    assert(view, "找不到已勾選的任務 " + change.title);
    pending(view, "change");
    assert.deepEqual(view.task.source_ids, [minutes.id]);
    await alert(ctx, view.task.id, "approval", ctx.repository);
    await approve(ctx, view, [...editSteps(change), ...reviewSteps]);
    const ready = await published(ctx, view.task.id, offset, change);
    assert.equal(ready.view.runs.length, 1);
    completed.push(ready.refs);
    groupMessages.push(ready.message);
  }
  assert.notEqual(completed[0].pr, completed[1].pr, "兩個獨立項目共用了 PR");
  assert.deepEqual(await idsFor(ctx, minutes), ids, "未選的項目也建立了任務");
  return { ...completed[1], groupMessages };
}

type Parent = Pick<Task, "id" | "answer" | "version" | "summary" | "acceptance" | "pr_number" | "status">;
export function checkContinuation(
  before: Parent,
  after: Parent,
  child: Pick<Task, "id" | "parent_id" | "source_ids">,
  source: string,
) {
  assert.notEqual(child.id, before.id, "接續需求覆寫了父任務");
  assert.equal(child.parent_id, before.id, "接續需求連到其他父任務");
  assert.deepEqual(child.source_ids, [source], "接續需求未以本則訊息為唯一來源");
  assert.deepEqual(after, before, "接續需求改變了父任務");
}

async function followup(ctx: ConversationFlowContext): Promise<Result> {
  const offset = await offsetOf(ctx);
  const first = { id: "2660401", text: `${project} 的 2 張與 3 張票合計多少？` };
  const second = { id: "2660402", text: "那再加一批 4 張呢？" };
  await send(ctx, first, [
    classification(decision(first, ctx.projectId, "清點兩批票", "query")),
    ...answerSteps("合計 5 張。"),
  ]);
  const parentId = await taskFor(ctx, first);
  const parent = await answered(ctx, parentId, offset, "合計 5 張");
  const quote = await sentId(ctx, parentId, "group_answered");
  const next = await offsetOf(ctx);
  await send(
    ctx,
    second,
    [classification(decision(second, null, "追加一批後的票數", "query")), ...answerSteps("合計 9 張。")],
    quote,
  );
  const childId = await taskFor(ctx, second);
  assert.notEqual(childId, parentId, "追問覆寫了上一題");
  const child = await answered(ctx, childId, next, "合計 9 張");
  assert.equal(child.view.projectReview.confirmation?.kind, "evidence");
  const original = await read(ctx, parentId);
  checkContinuation(parent.view.task, original.task, child.view.task, second.id);
  return { taskId: childId, runId: child.runId, groupMessages: [parent.message, child.message] };
}

export function checkQuestionAnswer(
  version: number,
  task: Pick<Task, "version" | "question" | "missing" | "summary" | "source_ids">,
  source: string,
  reply: Message,
) {
  assert.equal(task.version, version + 1, "回答補問未成為下一個需求版本");
  assert.equal(task.question, null);
  assert.deepEqual(task.missing, []);
  assert(task.summary.includes(reply.text), "新版需求摘要缺少群組的回答");
  assert.deepEqual([...task.source_ids].sort(), [source, reply.id].sort());
}

async function answerQuestion(ctx: ConversationFlowContext): Promise<Result> {
  const offset = await offsetOf(ctx);
  const first = { id: "2660501", text: `請用 ${project} 的計算方式加總這次交來的兩批紙本票。` };
  const question = "這次交來的兩批紙本票各有幾張？";
  const reply = { id: "2660502", text: "兩批各有 4 張。" };
  await send(ctx, first, [
    classification(decision(first, ctx.projectId, "清點紙本票", "query")),
    {
      kind: "text",
      text: "AGENTFLOW_NEEDS_INPUT: " + JSON.stringify({ questions: [{ kind: "information", question }] }),
    },
  ]);
  const id = await taskFor(ctx, first);
  const waiting = await at(ctx, id, "awaiting_approval", ["queued", "running"]);
  assert.equal(waiting.task.question?.text, question);
  assert(waiting.task.missing.includes(question));
  assert.equal(waiting.task.approved_version, null);
  assert.equal(waiting.task.answer, null);
  assert.equal(waiting.runs.length, 1, "必須由執行中的 AI 提問");
  assert.equal(waiting.runs[0].outcome, "awaiting_approval");
  audit(waiting, "started", "input_required");
  await alert(ctx, id, "input_required", question);
  const asked = await received(ctx, offset, question, "回覆");
  const quote = await sentId(ctx, id, "group_question");
  const next = await offsetOf(ctx);
  await send(ctx, reply, answerSteps("合計 8 張。"), quote);
  const result = await answered(ctx, id, next, "合計 8 張");
  const { task, runs } = result.view;
  audit(result.view, "input_required", "question_answered", "started", "answered");
  assert.equal(runs.length, 2);
  checkQuestionAnswer(waiting.task.version, task, first.id, reply);
  assert.deepEqual(await idsFor(ctx, reply), [id], "補問的回答意外建立新任務");
  return { taskId: id, runId: result.runId, groupMessages: [asked, result.message] };
}

export function checkSensitiveCandidate(row: unknown, version: number) {
  const saved = z
    .object({
      files: z.array(z.object({ path: z.string(), content: z.string() })),
      resume_version: z.number(),
    })
    .parse(row);
  assert.equal(saved.resume_version, version, "候選修改不屬於待核准的版本");
  assert.deepEqual(
    saved.files,
    [{ path: sensitive.path, content: Buffer.from(sensitive.content + "\n").toString("base64") }],
    "送審候選檔案與預期位元組不同",
  );
}

async function sensitiveApproval(ctx: ConversationFlowContext): Promise<Result> {
  const offset = await offsetOf(ctx);
  const msg = { id: "2660601", text: `請在 ${project} ${requirement(sensitive)}。` };
  const initial = await beginChange(ctx, msg, sensitive);
  const id = initial.task.id;
  await approve(ctx, initial, editSteps(sensitive));
  const held = await at(ctx, id, "awaiting_approval", ["queued", "running", "reviewing"]);
  assert.equal(held.task.version, initial.task.version + 1);
  assert.equal(held.task.approved_version, null);
  assert.equal(held.task.pr_number, null);
  assert.deepEqual(held.task.pending_paths, [sensitive.path]);
  assert.deepEqual(held.task.approved_paths, []);
  assert.equal(held.runs.length, 1);
  assert.equal(held.runs[0].outcome, "awaiting_approval");
  await alert(ctx, id, "risk", held.task.title);
  const saved = await ctx.db.one(
    "SELECT result->'files' AS files,(result#>>'{candidate,resumeVersion}')::int AS resume_version FROM runs WHERE id=$1 AND task_id=$2",
    [held.runs[0].id, id],
  );
  checkSensitiveCandidate(saved, held.task.version);
  await approve(ctx, held, reviewSteps);
  const ready = await published(ctx, id, offset, sensitive);
  assert.equal(ready.view.runs.length, 2);
  assert.deepEqual(ready.view.task.approved_paths, [sensitive.path]);
  const [resumed] = ready.view.runs;
  assert.equal(resumed.version, held.task.version);
  assert(!resumed.phases.some((p) => p.phase === "code"), "再次核准後重新產生了修改");
  assert(
    ready.view.history.some((h) => h.kind === "attempt" && h.detail.includes("沿用上一次已收集的修改")),
    "沒有沿用候選修改的稽核",
  );
  return { ...ready.refs, groupMessages: [ready.message] };
}

type ProjectChoice = Pick<Task, "version" | "target_branch" | "project_id">;
export function checkProjectChoice(before: ProjectChoice, after: ProjectChoice, projectId: string) {
  assert.equal(before.project_id, null);
  assert.equal(before.target_branch, null);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.project_id, projectId);
  assert.equal(after.target_branch, branch);
}

async function chooseProject(ctx: ConversationFlowContext): Promise<Result> {
  const offset = await offsetOf(ctx);
  const msg = { id: "2660701", text: "兩批各有 1 張與 6 張，這套系統怎麼算合計？" };
  await send(ctx, msg, [classification(decision(msg, null, "查詢批次計算", "query"))]);
  const id = await taskFor(ctx, msg);
  const initial = await at(ctx, id, "awaiting_approval");
  pending(initial, "query");
  assert.equal(initial.task.project_id, null);
  assert.equal(initial.task.target_branch, null);
  await alert(ctx, id, "approval", "尚未指定");
  const waiting = await received(ctx, offset, initial.task.title, "等管理者確認");
  await ctx.admin("POST", `/api/tasks/${id}/actions`, {
    action: "assign",
    version: initial.task.version,
    project_id: ctx.projectId,
  });
  const assigned = await at(ctx, id, "awaiting_approval");
  checkProjectChoice(initial.task, assigned.task, ctx.projectId);
  pending(assigned, "query");
  await approve(ctx, assigned, answerSteps("合計 7 張。"));
  const result = await answered(ctx, id, offset, "合計 7 張");
  assert.equal(result.view.projectReview.confirmation?.kind, "manual");
  audit(result.view, "triage", "assign", "approve", "started", "answered");
  return { taskId: id, runId: result.runId, groupMessages: [waiting, result.message] };
}

const Rejection = z.object({ title: z.string(), summary: z.string(), reason: z.string() });
const Guard = z.object({ sourceId: z.string(), rejected: Rejection });
type Guarded = Extract<ModelStep, { kind: "text" }> & { recentRejection: z.output<typeof Guard> };
export function rejectionStep(sourceId: string, rejected: z.output<typeof Rejection>): Guarded {
  // 未安裝本文檢查，或本次判讀沒有拒絕案例時，替身會要求建立新任務，使驗收失敗。
  return {
    ...classification(decision({ id: sourceId, text: rejected.summary }, null, rejected.title, "change")),
    recentRejection: { sourceId, rejected },
  };
}
const Input = z.object({ input: z.array(z.unknown()) });
const UserInput = z.object({ role: z.literal("user"), content: z.array(z.unknown()) });
const TextPart = z.object({ type: z.literal("input_text"), text: z.string() });
const TriageInput = z.object({
  messages: z.array(z.object({ id: z.string(), triggerMode: z.string(), contextOnly: z.boolean() })),
  context: z.object({ recentRejections: z.array(Rejection) }),
});
/** 上游收到 Responses 請求時解析此步驟。只檢查使用者輸入內結構化的判讀資料。 */
export function resolveConversationStep(step: ModelStep, body: unknown): ModelStep {
  if (step.kind !== "text" || !("recentRejection" in step)) return step;
  const { sourceId, rejected } = Guard.parse(step.recentRejection);
  const input = Input.safeParse(body);
  if (!input.success) return step;
  const marker = "以下為待判讀的不可信輸入資料（JSON）：\n";
  for (const item of input.data.input) {
    const user = UserInput.safeParse(item);
    if (!user.success) continue;
    for (const part of user.data.content) {
      const text = TextPart.safeParse(part);
      if (!text.success) continue;
      const pos = text.data.text.indexOf(marker);
      if (pos < 0) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(text.data.text.slice(pos + marker.length));
      } catch {
        continue;
      }
      const data = TriageInput.safeParse(payload);
      if (!data.success) continue;
      const { messages, context } = data.data;
      if (
        messages.some((m) => m.id === sourceId && m.triggerMode === "auto" && !m.contextOnly) &&
        context.recentRejections.some(
          (r) => r.title === rejected.title && r.summary === rejected.summary && r.reason === rejected.reason,
        )
      ) {
        const ignored = decision({ id: sourceId, text: "" }, null, "", "change");
        return classification({
          ...ignored,
          kind: "ignore",
          noTaskReason: "similar_rejected",
          acceptance: [],
        });
      }
    }
  }
  return step;
}

async function rejectSimilar(ctx: ConversationFlowContext): Promise<Result> {
  const offset = await offsetOf(ctx);
  const first = { id: "2660801", text: `請在 ${project} ${requirement(gate)}。` };
  const second = { id: "2660802", text: `請幫 ${project} 整理一份東門的批次票單說明。` };
  const initial = await beginChange(ctx, first, gate);
  const id = initial.task.id;
  await ctx.admin("POST", `/api/tasks/${id}/actions`, {
    action: "reject",
    version: initial.task.version,
    end_reason: "not_for_ai",
  });
  const rejected = await at(ctx, id, "rejected");
  assert.equal(rejected.task.end_reason, "not_for_ai");
  const reason = endReasonLabels.not_for_ai;
  assert(rejected.history.some((h) => h.kind === "reject" && h.detail.includes(reason)));
  const message = await received(ctx, offset, rejected.task.title, "管理者決定不處理");
  await send(ctx, second, [
    rejectionStep(second.id, { title: rejected.task.title, summary: rejected.task.summary, reason }),
  ]);
  await ctx.poll("等待相似訊息完成自動判讀", async () => {
    const row = await ctx.db.one(
      "SELECT processed,batch_id,trigger_mode FROM messages WHERE group_id=$1 AND id=$2",
      [line.groupId, second.id],
    );
    if (!row) return undefined;
    const m = z
      .object({ processed: z.boolean(), batch_id: z.uuid().nullable(), trigger_mode: z.string() })
      .parse(row);
    assert.equal(m.trigger_mode, "auto");
    return m.processed && m.batch_id ? true : undefined;
  });
  assert.deepEqual(await idsFor(ctx, second), [], "相似訊息仍建了任務，請核對上游是否收到拒絕原因並解析劇本");
  const state = z
    .object({
      totals: z.object({ tasks: z.number() }),
      activity: z.array(z.object({ kind: z.string(), detail: z.string() })),
    })
    .parse(await ctx.admin("GET", "/api/state"));
  assert.equal(state.totals.tasks, 1, "隔離案例應只留下原本被拒絕的任務");
  assert(
    state.activity.some(
      (a) => a.kind === "triage_skipped" && a.detail.includes(triageNoTaskLabels.similar_rejected),
    ),
    "缺少略過相似需求的稽核",
  );
  const final = await read(ctx, id);
  assert.equal(final.task.status, "rejected");
  assert.equal(final.runs.length, 0);
  return { taskId: id, groupMessages: [message] };
}

export function checkIncrement(task: Pick<Task, "summary" | "acceptance" | "source_ids">, source: string) {
  assert.deepEqual(task.source_ids, [source]);
  assert.equal(task.summary, requirement(queue), "子任務摘要跨出新增範圍");
  assert.deepEqual(task.acceptance, [requirement(queue)], "子任務的驗收條件跨出新增範圍");
}

type PublishedPr = { pr: number; issue: number; headSha: string };
export function checkAppendedPr(parent: PublishedPr, child: PublishedPr, childBase: string | null) {
  assert.equal(child.pr, parent.pr, "追加修改另開了 PR");
  assert.notEqual(child.issue, parent.issue, "追加修改缺少自己的 Issue");
  assert.equal(childBase, parent.headSha, "子任務未使用父 PR 的最新提交為基底");
  assert.notEqual(child.headSha, parent.headSha, "子任務沒有發布新提交");
}

async function incrementalChild(ctx: ConversationFlowContext): Promise<Result> {
  const offset = await offsetOf(ctx);
  const first = { id: "2660901", text: `請在 ${project} ${requirement(gate)}。` };
  const second = { id: "2660902", text: `另外追加一項：${requirement(queue)}。` };
  const initial = await beginChange(ctx, first, gate);
  const id = initial.task.id;
  await approve(ctx, initial, [...editSteps(gate), ...reviewSteps]);
  const parent = await published(ctx, id, offset, gate);
  const next = await offsetOf(ctx);
  const quote = await sentId(ctx, id, "group_ready");
  await send(
    ctx,
    second,
    [classification(decision(second, null, queue.title, "change", requirement(queue)))],
    quote,
  );
  const childId = await taskFor(ctx, second);
  assert.notEqual(childId, id, "追加需求覆寫已核准的父任務");
  const child = await at(ctx, childId, "awaiting_approval");
  pending(child, "change");
  assert.equal(child.task.project_id, ctx.projectId);
  assert.equal(child.task.target_branch, branch);
  checkIncrement(child.task, second.id);
  await alert(ctx, childId, "approval", ctx.repository);
  const waiting = await received(ctx, next, child.task.title, "等管理者確認");
  const original = await read(ctx, id);
  checkContinuation(parent.view.task, original.task, child.task, second.id);
  await approve(ctx, child, [...editSteps(queue), ...reviewSteps]);
  const ready = await published(ctx, childId, next, gate, queue);
  assert.equal(ready.view.runs.length, 1);
  assert.equal(ready.view.task.version, child.task.version);
  assert.equal(ready.view.task.branch, parent.view.task.branch);
  ordered(
    ready.view.runs[0].phases.map((p) => p.phase),
    ["code", "test", "review", "publish"],
  );
  checkIncrement(ready.view.task, second.id);
  checkAppendedPr(parent.refs, ready.refs, ready.view.task.base_sha);
  assert(ready.body.split(/\r?\n/).includes("Closes #" + parent.refs.issue), "追加後 PR 遺失父任務的 Issue");
  checkContinuation(parent.view.task, (await read(ctx, id)).task, ready.view.task, second.id);
  assert(ready.message.includes("追加到同一個 PR"), "群組通知未說明子任務追加到原 PR");
  const beforeMerge = await offsetOf(ctx);
  const merged = await ctx.webhook(
    signedGitHubPrMerged({
      secret: ctx.githubWebhookSecret,
      deliveryId: randomUUID(),
      repository: ctx.repository,
      prNumber: ready.refs.pr,
    }),
  );
  assert.equal(merged.statusCode, 200, "GitHub 合併事件投遞失敗");
  const groupMessages = [parent.message, waiting, ready.message];
  for (const view of [parent.view, ready.view]) {
    const closed = await at(ctx, view.task.id, "merged", ["ready"]);
    assert.equal(closed.task.pr_number, ready.refs.pr);
    audit(closed, "approve", "ready", "merged");
    groupMessages.push(await received(ctx, beforeMerge, view.task.title, "修改已合併"));
  }
  return { ...ready.refs, groupMessages };
}

/** 每案使用全新的隔離實例；模型階段由各案在對應的外部操作前安裝。 */
export const conversationFlows = {
  3: pickTwo,
  4: followup,
  5: answerQuestion,
  6: sensitiveApproval,
  7: chooseProject,
  8: rejectSimilar,
  9: incrementalChild,
} satisfies Record<ConversationNumber, (ctx: ConversationFlowContext) => Promise<Result>>;
