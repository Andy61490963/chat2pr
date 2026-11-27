import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { discordId } from "../../../server/chat-platform.js";
import type { Database } from "../../../server/db.js";
import type { Decisions } from "../../../server/triage.js";
import type { ModelStep } from "./model-upstream.js";
import {
  discordTaskInteraction,
  signedGitHubPrMerged,
  signedLineMessage,
  type SignedWebhookRequest,
} from "./signed-events.js";

export const basicFixture = {
  project: "lantern-tickets",
  branch: "main",
  line: {
    groupId: `C${"1".repeat(32)}`,
    userId: `U${"2".repeat(32)}`,
    eventId: "lantern-line-query-1",
    messageId: "2661001",
    text: "lantern-tickets 的兩批燈會票各有 2 張與 3 張，總票數是多少？請引用計算票數的程式。",
  },
  discord: {
    applicationId: "100000000000000003",
    guildId: "100000000000000001",
    channelId: "100000000000000002",
    userId: "100000000000000004",
    interactionId: "100000000000000005",
    sequence: 1,
    text: "請修改 lantern-tickets 的 main 分支。讓 tickets.mjs 的 countTickets 批次參數預設為空陣列，省略時回傳 0。保留原有加總行為，並在 tickets.test.mjs 補上無參數呼叫的測試。",
  },
} as const;

export interface BasicPullRequest {
  number: number;
  base: string;
  head: string;
  headSha?: string;
  body: string;
  /** 假 GitHub 收到的變更檔，以儲存庫相對路徑索引解碼後的內容。 */
  files: Readonly<Record<string, string>>;
  deletedFiles?: readonly string[];
}

/** 主控提供已綁定的隔離專案、登入工作階段與實際投遞入口。 */
export interface BasicFlowContext {
  db: { one(...args: Parameters<Database["one"]>): Promise<unknown> };
  projectId: string;
  repository: string;
  lineSecret: string;
  githubWebhookSecret: string;
  /** 回傳已解析的 JSON，非成功狀態應直接拋出錯誤。 */
  admin(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown>;
  webhook(request: SignedWebhookRequest): Promise<{ statusCode: number }>;
  gateway(packet: ReturnType<typeof discordTaskInteraction>): Promise<void>;
  /** 依投遞順序讀取外部收件紀錄，Discord 群組使用 discord: 前綴。 */
  groupMessages(groupId: string): Promise<readonly string[]>;
  readPr(number: number): Promise<BasicPullRequest | null>;
  /** undefined 表示仍在等待；逾時時保留目前步驟名稱。 */
  poll<T>(label: string, probe: () => Promise<T | undefined>): Promise<T>;
}

const line = basicFixture.line;
const discord = basicFixture.discord;
const discordSource = discordId(discord.interactionId);
const discordGroup = discordId(discord.channelId);
const total = /(?<![\d十百千萬])(?:5|五)\s*張/u;

function classify(projectId: string, mode: "query" | "change"): ModelStep {
  const query = mode === "query";
  const sourceId = query ? line.messageId : discordSource;
  const summary = query ? line.text : discord.text;
  const quote = { sourceId, quote: summary };
  const response = {
    decisions: [
      {
        kind: "request",
        taskType: mode,
        projectId,
        title: query ? "查詢燈會總票數" : "省略燈會票批次時回傳零",
        summary,
        acceptance: query
          ? ["回答兩批票的合計張數並引用程式位置"]
          : ["省略批次時回傳 0", "既有票數加總仍正確，並有省略參數的測試"],
        sourceIds: [sourceId],
        relatedTaskId: null,
        relatedListItemId: null,
        noTaskReason: null,
        schedule: null,
        risks: [],
        missing: [],
        question: null,
        assumptions: [],
        suggestions: [],
        contextSourceIds: [],
        routing: {
          status: "clear",
          basis: "explicit",
          reason: "成員在本則訊息中指名 lantern-tickets。",
          evidence: [{ kind: "message", ...quote }],
        },
        targetBranch: {
          name: basicFixture.branch,
          basis: query ? "default" : "explicit",
          reason: query ? "沿用專案預設分支。" : "成員指定 main 分支。",
          evidence: query ? [] : [quote],
        },
      },
    ],
  } satisfies z.output<typeof Decisions>;
  return { kind: "text", text: JSON.stringify(response) };
}

function command(cmd: string): ModelStep {
  return {
    kind: "tool",
    name: "exec_command",
    arguments: { cmd, workdir: "/workspace" },
  };
}

export function lineQuerySteps(projectId: string): ModelStep[] {
  return [
    classify(projectId, "query"),
    command("cat -n tickets.mjs tickets.test.mjs"),
    {
      kind: "text",
      text: "## 先看重點\n兩批燈會票合計 5 張。\n\n## 程式依據\n`tickets.mjs:2` 從 0 開始累加每批票數，因此 2 加 3 等於 5。",
    },
  ];
}

export function discordChangeSteps(projectId: string): ModelStep[] {
  return [
    classify(projectId, "change"),
    command(
      [
        "sed -i 's/function countTickets(batches)/function countTickets(batches = [])/' tickets.mjs && cat >> tickets.test.mjs <<'EOF'",
        "",
        'test("省略批次時總票數為零", () => {',
        "  assert.equal(countTickets(), 0);",
        "});",
        "EOF",
      ].join("\n"),
    ),
    {
      kind: "text",
      text: "countTickets() 現在將省略的批次視為空清單，總票數為 0。已補上無參數呼叫的測試。",
    },
    command(
      "cat /tmp/agentflow-review-*/manifest.json /tmp/agentflow-review-*/*.patch",
    ),
    {
      kind: "text",
      text: JSON.stringify({ passed: true, findings: [], notes: [] }),
    },
  ];
}

const Task = z.object({
  id: z.uuid(),
  group_id: z.string(),
  project_id: z.uuid().nullable(),
  mode: z.enum(["change", "query"]),
  status: z.string(),
  version: z.number().int().positive(),
  approved_version: z.number().nullable(),
  title: z.string().min(1),
  source_ids: z.array(z.string()),
  target_branch: z.string().nullable(),
  branch: z.string().nullable(),
  answer: z.string().nullable(),
  issue_number: z.number().int().positive().nullable(),
  pr_number: z.number().int().positive().nullable(),
  pr_url: z.string().nullable(),
  review_note: z.string().nullable(),
});
const Detail = z.object({
  task: Task,
  projectReview: z.object({
    repo: z.string().nullable(),
    config_version: z.number().int().positive().nullable(),
    binding_version: z.number().int().positive(),
    confirmed: z.boolean(),
    confirmation: z.object({ kind: z.enum(["manual", "evidence"]) }).nullable(),
  }),
  history: z.array(z.object({ kind: z.string() })),
  runs: z.array(
    z.object({
      id: z.uuid(),
      version: z.number(),
      outcome: z.string().nullable(),
      completed_at: z.string().nullable(),
      phases: z.array(z.object({ phase: z.string() })),
    }),
  ),
});
const Alerts = z.object({
  alerts: z.array(
    z.object({
      task_id: z.string().nullable(),
      kind: z.string(),
      text: z.string(),
    }),
  ),
});

async function deliver(ctx: BasicFlowContext, request: SignedWebhookRequest) {
  const { statusCode } = await ctx.webhook(request);
  assert.equal(
    statusCode,
    200,
    `${request.url} 投遞失敗（HTTP ${statusCode}）`,
  );
}

async function startTask(
  ctx: BasicFlowContext,
  group: string,
  source: string,
  send: () => Promise<void>,
) {
  assert.equal(
    ctx.repository.split("/").at(-1),
    basicFixture.project,
    "驗收專案須為 lantern-tickets",
  );
  const existing = await ctx.db.one(
    "SELECT id FROM messages WHERE group_id=$1 AND id=$2",
    [group, source],
  );
  assert(!existing, "驗收來源訊息已存在，重播會讀到前一次的結果");
  await send();
  return ctx.poll("從本次來源訊息找到判讀建立的任務", async () => {
    const row = await ctx.db.one(
      `SELECT t.id,m.trigger_mode FROM tasks t JOIN messages m ON m.group_id=t.group_id
       WHERE m.group_id=$1 AND m.id=$2 AND m.id=ANY(t.source_ids)`,
      [group, source],
    );
    if (!row) return undefined;
    const origin = z.object({ id: z.uuid(), trigger_mode: z.string() }).parse(row);
    assert.equal(
      origin.trigger_mode,
      group === discordGroup ? "command" : "auto",
      "來源訊息的觸發方式錯誤",
    );
    return origin.id;
  });
}

async function detailAt(
  ctx: BasicFlowContext,
  id: string,
  status: string,
  active: string[],
) {
  return ctx.poll(`看板任務進入 ${status}`, async () => {
    const view = Detail.parse(await ctx.admin("GET", `/api/tasks/${id}`));
    assert.equal(view.task.id, id, "看板回傳其他任務");
    if (view.task.status !== status) {
      assert(
        active.includes(view.task.status),
        `預期 ${status}，任務停在 ${view.task.status}`,
      );
      return undefined;
    }
    if (
      status !== "awaiting_approval" &&
      view.runs.some((r) => !r.completed_at)
    )
      return undefined;
    return view;
  });
}

function checkSource(
  view: z.output<typeof Detail>,
  ctx: BasicFlowContext,
  mode: "change" | "query",
) {
  const { task, projectReview } = view;
  assert.equal(task.mode, mode, "任務種類錯誤");
  assert.equal(
    task.group_id,
    mode === "query" ? line.groupId : discordGroup,
    "任務群組錯誤",
  );
  assert.deepEqual(
    task.source_ids,
    [mode === "query" ? line.messageId : discordSource],
    "任務未對應本次訊息",
  );
  assert.equal(task.project_id, ctx.projectId, "任務專案錯誤");
  assert.equal(projectReview.repo, ctx.repository, "看板儲存庫錯誤");
  assert.equal(task.target_branch, basicFixture.branch, "看板目標分支錯誤");
}

function ordered(actual: string[], expected: string[], label: string) {
  let index = -1;
  for (const step of expected) {
    index = actual.indexOf(step, index + 1);
    assert(index >= 0, `${label}缺少步驟或順序錯誤：${step}`);
  }
}

function completedRun(view: z.output<typeof Detail>, outcome: string) {
  const [run] = view.runs;
  assert.equal(view.runs.length, 1, "基本情境應只有一次執行");
  assert(run?.completed_at, "執行尚未清理完成");
  assert.equal(run.version, view.task.version, "執行版本錯誤");
  assert.equal(run.outcome, outcome, "執行結束狀態錯誤");
  return run;
}

async function adminNotice(
  ctx: BasicFlowContext,
  id: string,
  kind: string,
  content: string,
) {
  return ctx.poll(`看板管理者通知 ${kind}`, async () => {
    const { alerts } = Alerts.parse(await ctx.admin("GET", "/api/state"));
    const notice = alerts.find((a) => a.task_id === id && a.kind === kind);
    if (!notice) return undefined;
    assert(notice.text.includes(content), `管理者通知 ${kind} 內容錯誤`);
    return notice.text;
  });
}

async function received(
  ctx: BasicFlowContext,
  group: string,
  from: number,
  label: string,
  matches: (s: string) => boolean,
) {
  return ctx.poll(label, async () => {
    const messages = await ctx.groupMessages(group);
    return messages.find((text, i) => i >= from && matches(text));
  });
}

export async function runLineQuery(ctx: BasicFlowContext) {
  const from = (await ctx.groupMessages(line.groupId)).length;
  const taskId = await startTask(ctx, line.groupId, line.messageId, () =>
    deliver(
      ctx,
      signedLineMessage({
        ...line,
        secret: ctx.lineSecret,
        timestamp: Date.now(),
      }),
    ),
  );
  const view = await detailAt(ctx, taskId, "answered", ["queued", "running"]);
  checkSource(view, ctx, "query");
  assert(
    view.projectReview.confirmed &&
      view.projectReview.confirmation?.kind === "evidence",
    "LINE 查詢應由來源證據自動確認",
  );
  assert.equal(
    view.task.approved_version,
    view.task.version,
    "查詢版本未獲自動派工",
  );
  assert.equal(view.task.pr_number, null, "查詢產生了 PR");
  assert(
    view.task.answer &&
      total.test(view.task.answer) &&
      view.task.answer.includes("tickets.mjs"),
    "看板回答缺少正確總票數或程式依據",
  );
  const history = view.history.map((h) => h.kind);
  ordered(history, ["triage", "started", "answered"], "查詢稽核");
  assert(!history.includes("approve"), "自動查詢出現了人工核准");
  const run = completedRun(view, "answered");
  const notice = await adminNotice(ctx, taskId, "answered", view.task.title);
  assert(total.test(notice), "管理者查詢通知缺少正確總票數");
  const answer = await received(
    ctx,
    line.groupId,
    from,
    "LINE 群組收到本題票數回答",
    (text) => text.includes(view.task.title) && total.test(text),
  );
  return { taskId, runId: run.id, groupMessages: [answer] };
}

export async function runDiscordChange(ctx: BasicFlowContext) {
  const from = (await ctx.groupMessages(discordGroup)).length;
  const taskId = await startTask(ctx, discordGroup, discordSource, () =>
    ctx.gateway(discordTaskInteraction(discord)),
  );
  const pending = await detailAt(ctx, taskId, "awaiting_approval", []);
  checkSource(pending, ctx, "change");
  const { task, projectReview } = pending;
  assert.equal(task.approved_version, null, "修改需求在人工確認前已被核准");
  assert.equal(
    projectReview.confirmed,
    false,
    "修改需求在人工確認前已有有效確認",
  );
  assert.equal(pending.runs.length, 0, "修改需求在核准前已開始執行");
  assert.equal(task.pr_number, null, "修改需求在核准前已建立 PR");
  await adminNotice(ctx, taskId, "approval", ctx.repository);
  assert(projectReview.config_version !== null, "待確認專案缺少設定版本");
  const approved = Task.parse(
    await ctx.admin("POST", `/api/tasks/${taskId}/actions`, {
      action: "approve",
      version: task.version,
      project_id: task.project_id,
      target_branch: task.target_branch,
      config_version: projectReview.config_version,
      binding_version: projectReview.binding_version,
    }),
  );
  assert.equal(approved.id, taskId, "核准了其他任務");
  assert.equal(
    approved.approved_version,
    task.version,
    "核准回應的需求版本錯誤",
  );
  assert.equal(approved.status, "queued", "核准後未排隊");

  const ready = await detailAt(ctx, taskId, "ready", [
    "queued",
    "running",
    "reviewing",
  ]);
  checkSource(ready, ctx, "change");
  assert(
    ready.projectReview.confirmed &&
      ready.projectReview.confirmation?.kind === "manual",
    "修改缺少本版人工確認",
  );
  assert.equal(ready.task.version, task.version, "發布的需求版本與核准不符");
  const run = completedRun(ready, "ready");
  ordered(
    run.phases.map((p) => p.phase),
    ["code", "test", "review", "publish"],
    "修改執行",
  );
  assert(
    ready.task.review_note?.includes("獨立審查通過"),
    "看板缺少審查通過紀錄",
  );
  const {
    pr_number: number,
    pr_url: url,
    issue_number: issue,
    branch,
  } = ready.task;
  assert(number && url && issue && branch, "看板缺少 Issue、PR 或工作分支");
  const pr = await ctx.readPr(number);
  assert(pr, `假 GitHub 找不到看板的 PR #${number}`);
  assert.equal(pr.number, number, "假 GitHub 的 PR 編號不符");
  assert.equal(pr.base, basicFixture.branch, "PR 目標分支與核准不符");
  assert.equal(pr.head, branch, "PR 來源與本次工作分支不符");
  assert.notEqual(pr.head, pr.base, "PR 應使用獨立工作分支");
  assert(
    pr.body.split(/\r?\n/).includes(`Closes #${issue}`),
    "PR 未關聯本次 Issue",
  );
  assert(
    pr.body.includes("測試：通過") && pr.body.includes("獨立審查：通過"),
    "PR 缺少測試或審查結果",
  );
  assert.deepEqual(
    Object.keys(pr.files).sort(),
    ["tickets.mjs", "tickets.test.mjs"],
    "PR 變更檔案與核准範圍不符",
  );
  assert.equal(pr.deletedFiles?.length ?? 0, 0, "PR 刪除了核准範圍外的檔案");
  assert(
    /\bcountTickets\s*(?:=\s*)?\(\s*\w+\s*=\s*\[\s*\]\s*\)/.test(
      pr.files["tickets.mjs"],
    ),
    "PR 缺少空批次的預設參數",
  );
  assert(
    /countTickets\(\s*\)/.test(pr.files["tickets.test.mjs"]),
    "PR 缺少無參數呼叫的測試",
  );
  await adminNotice(ctx, taskId, "ready", url);
  const published = await received(
    ctx,
    discordGroup,
    from,
    "Discord 原頻道收到待合併 PR",
    (text) => text.includes(task.title) && text.includes(url),
  );

  const isMergeNotice = (text: string) =>
    text.includes(task.title) && text.includes("修改已合併");
  const beforeMerge = await ctx.groupMessages(discordGroup);
  const mergeOffset = beforeMerge.length;
  assert(
    !beforeMerge.slice(from).some(isMergeNotice),
    "Discord 在合併 webhook 前就已通知合併",
  );
  await deliver(
    ctx,
    signedGitHubPrMerged({
      secret: ctx.githubWebhookSecret,
      deliveryId: randomUUID(),
      repository: ctx.repository,
      prNumber: number,
    }),
  );
  const merged = await detailAt(ctx, taskId, "merged", ["ready"]);
  assert.equal(merged.task.pr_number, number, "合併的 PR 編號錯誤");
  ordered(
    merged.history.map((h) => h.kind),
    ["triage", "approve", "started", "ready", "merged"],
    "修改稽核",
  );
  const delivery = await received(
    ctx,
    discordGroup,
    mergeOffset,
    "Discord 原頻道收到本題合併通知",
    isMergeNotice,
  );
  return {
    taskId,
    runId: run.id,
    issue,
    pr: number,
    headSha: pr.headSha,
    groupMessages: [published, delivery],
  };
}
