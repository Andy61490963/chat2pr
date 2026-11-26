import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { installMarker, missingImage, operationsInstance, type WorkerFault } from "./operations-worker.js";
import { MEMORY_FLOOR_MB, MEMORY_STEADY_MS } from "../../../server/capacity.js";
import { discordId } from "../../../server/chat-platform.js";
import type { DiscordMessageEvent } from "../../../server/discord.js";
import type { Decisions } from "../../../server/triage.js";
import { LINE_QUOTA, quotaBellNotice } from "../../../shared/line-quota.js";
import { basicFixture, lineQuerySteps, type BasicFlowContext } from "./basic.js";
import type { ModelStep } from "./model-upstream.js";
import { signedLineMessage, type SignedWebhookRequest } from "./signed-events.js";

/**
 * 主控以同一個驗收實例的 app、jobs、runner、聊天替身組裝控制項。
 * discordEvent 接 startDiscord 註冊的 callbacks.event；putSettings 經登入的 PUT /api/settings。
 * restartRunner 只重啟持有的子程序，先核對實例、等舊程序退出，等新程序通過同實例的 health 再回傳 PID。
 * setMemoryCeiling 只將 resources 的真實 memFreeMb 取較小值，null 恢復實測；app 和 jobs 共用此 runner。
 * setWorkerFault 透過 operationsPhaseInput 標記安裝請求；runner 送 Docker 建立請求前套用 operationsCreateInput。
 * LINE 替身耗盡時回報相符的月用量並對 push 回 monthly limit 的 429，保留免費 reply。
 * webhook 遇到 unsend 無 replyToken 時照常投遞原始簽章本文。每案結束仍由主控等資源釋放並檢查共用不變式。
 */
export interface OperationsControls {
  setModelSteps(steps: readonly ModelStep[]): Promise<void>;
  discordEvent(event: DiscordMessageEvent): Promise<void>;
  restartRunner(runId: string): Promise<{ instance: string; previousPid: number; pid: number }>;
  setMemoryCeiling(mb: number | null): Promise<void>;
  putSettings(body: Record<string, unknown>): Promise<unknown>;
  setWorkerFault(fault: WorkerFault): Promise<void>;
  setLineQuotaExhausted(exhausted: boolean): Promise<void>;
}

const { discord, line } = basicFixture;
const parent = discordId(discord.channelId);
const threadId = "100000000000000099";
const sourceRow = z.object({ id: z.uuid(), source_ids: z.array(z.string()), group_id: z.string() });
const detailSchema = z.object({
  task: sourceRow.extend({
    title: z.string(),
    mode: z.string(),
    status: z.string(),
    project_id: z.uuid(),
    target_branch: z.string(),
    discord_thread_id: z.string().nullable(),
    version: z.int().positive(),
    approved_version: z.number().nullable(),
    pr_number: z.number().nullable(),
    answer: z.string().nullable(),
    last_error: z.string().nullable(),
  }),
  projectReview: z.object({
    config_version: z.int().positive(),
    binding_version: z.int().positive(),
    confirmed: z.boolean(),
  }),
  sources: z.array(z.object({ id: z.string(), availability: z.string(), text: z.string().nullable() })),
  runs: z.array(
    z.object({
      id: z.uuid(),
      version: z.int(),
      outcome: z.string().nullable(),
      status: z.string(),
      started_at: z.string(),
      completed_at: z.string().nullable(),
      phases: z.array(z.object({ phase: z.string() })),
    }),
  ),
  history: z.array(z.object({ kind: z.string(), detail: z.string() })),
  groupDeliveries: z.array(
    z.object({
      kind: z.string(),
      text: z.string().nullable(),
      delivery: z.object({ status: z.string(), reason: z.string().nullable() }),
    }),
  ),
});
type View = z.infer<typeof detailSchema>;
type Run = View["runs"][number];
type Mode = "query" | "change";
type Channel = "line" | "discord" | "thread";
type Context = { ctx: BasicFlowContext; controls: OperationsControls };
const correctTotal = /(?:^|[^\d])5\s*張/u;

async function deliver(ctx: BasicFlowContext, request: SignedWebhookRequest) {
  const { statusCode } = await ctx.webhook(request);
  assert.equal(statusCode, 200, "LINE 事件投遞失敗，HTTP " + statusCode);
}

async function start(
  { ctx, controls }: Context,
  index: number,
  title: string,
  channel: Channel = "line",
  mode: Mode = "query",
  hold = false,
) {
  const messageId = String(100000000000000000n + BigInt(index));
  const source = channel === "line" ? messageId : discordId(messageId);
  const group = channel === "line" ? line.groupId : parent;
  const destination = channel === "thread" ? discordId(threadId) : group;
  const text = "/任務 " + title + "。" + (mode === "query" ? line.text : discord.text);
  const quote = { sourceId: source, quote: mode === "query" ? line.text : discord.text };
  const response = {
    decisions: [
      {
        kind: "request",
        taskType: mode,
        projectId: ctx.projectId,
        title,
        summary: text,
        acceptance: [mode === "query" ? "回答票數並引用程式" : "無參數時總票數為零"],
        sourceIds: [source],
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
          reason: "需求指名燈會專案",
          evidence: [{ kind: "message", ...quote }],
        },
        targetBranch: {
          name: "main",
          basis: mode === "change" ? "explicit" : "default",
          reason: "使用燈會專案的 main 分支",
          evidence: mode === "change" ? [quote] : [],
        },
      },
    ],
  } satisfies z.output<typeof Decisions>;
  const matching = async () =>
    z
      .object({ tasks: z.array(sourceRow) })
      .parse(await ctx.admin("GET", "/api/state"))
      .tasks.filter((t) => t.group_id === group && t.source_ids.includes(source));
  assert.equal((await matching()).length, 0, "來源已用於其他任務");
  const offset = (await ctx.groupMessages(destination)).length;
  const steps: ModelStep[] = [{ kind: "text", text: JSON.stringify(response) }];
  if (hold)
    steps.push({
      kind: "tool",
      name: "exec_command",
      arguments: {
        cmd: "sleep 60 && cat -n tickets.mjs",
        workdir: "/workspace",
        yield_time_ms: 60000,
      },
    });
  if (mode === "query") steps.push(...lineQuerySteps(ctx.projectId).slice(1));
  await controls.setModelSteps(steps);
  if (channel === "line") {
    await deliver(
      ctx,
      signedLineMessage({
        ...line,
        messageId,
        text,
        timestamp: Date.now(),
        eventId: randomUUID(),
        secret: ctx.lineSecret,
      }),
    );
  } else {
    await controls.discordEvent({
      type: "create",
      id: messageId,
      channel: channel === "thread" ? threadId : discord.channelId,
      ...(channel === "thread" ? { parentChannel: discord.channelId } : {}),
      author: { id: discord.userId, name: "驗收志工" },
      name: "燈會／票務",
      botId: discord.applicationId,
      text,
      images: [],
    });
  }
  const taskId = await ctx.poll("從看板找到「" + title + "」的唯一來源任務", async () => {
    const rows = await matching();
    assert(rows.length <= 1, "同一來源重複建立任務");
    return rows[0]?.id;
  });
  const view = async () => {
    const v = detailSchema.parse(await ctx.admin("GET", "/api/tasks/" + taskId));
    assert.equal(v.task.id, taskId, "看板回傳了其他任務");
    assert.deepEqual(v.task.source_ids, [source], "任務混入其他來源");
    assert.equal(v.task.group_id, group, "任務未沿用來源群組");
    assert.equal(v.task.discord_thread_id, channel === "thread" ? destination : null, "討論串綁定錯誤");
    assert.equal(v.task.project_id, ctx.projectId, "任務專案錯誤");
    assert.equal(v.task.mode, mode, "任務種類錯誤");
    assert.equal(v.task.target_branch, "main", "任務目標分支錯誤");
    assert.equal(v.task.pr_number, null, "這條維運路徑不應產生 PR");
    return v;
  };
  const messages = async () => (await ctx.groupMessages(destination)).slice(offset);
  const until = (label: string, predicate: (v: View) => boolean) =>
    ctx.poll(title + "：" + label, async () => {
      const v = await view();
      return predicate(v) ? v : undefined;
    });
  const received = (label: string, match: (s: string) => boolean) =>
    ctx.poll(title + "：" + label, async () => (await messages()).find(match));
  return { taskId, source, messageId, view, until, messages, received };
}
type Started = Awaited<ReturnType<typeof start>>;

function audited(v: View, ...kinds: string[]) {
  let index = -1;
  for (const kind of kinds) {
    index = v.history.findIndex((h, i) => i > index && h.kind === kind);
    assert(index >= 0, "缺少依序發生的稽核 " + kind);
  }
}

async function bell(
  ctx: BasicFlowContext,
  taskId: string | null,
  kind: string,
  match: (s: string) => boolean,
) {
  return ctx.poll("看板鈴鐺 " + kind, async () => {
    const { alerts } = z
      .object({
        alerts: z.array(z.object({ task_id: z.string().nullable(), kind: z.string(), text: z.string() })),
      })
      .parse(await ctx.admin("GET", "/api/state"));
    return alerts.find((a) => a.task_id === taskId && a.kind === kind && match(a.text))?.text;
  });
}

function finished(v: View, outcome: string) {
  const run = v.runs[0];
  assert(run?.completed_at && v.runs.every((r) => r.completed_at), "仍有執行尚未回收");
  assert.equal(run.version, v.task.version, "已結束的執行版本不符");
  assert.equal(run.outcome, outcome, "執行結果不符");
  return run;
}

async function answered(ctx: BasicFlowContext, task: Started) {
  const v = await task.until(
    "查詢已回答並完成清理",
    (v) => v.task.status === "answered" && !!v.runs[0]?.completed_at,
  );
  const run = finished(v, "answered");
  assert.equal(v.task.approved_version, v.task.version, "回答的版本尚未核准");
  assert(
    v.task.answer?.includes("tickets.mjs") && correctTotal.test(v.task.answer),
    "看板回答缺少票數或依據",
  );
  audited(v, "triage", "started", "answered");
  await bell(ctx, task.taskId, "answered", (s) => s.includes(v.task.title) && correctTotal.test(s));
  return { v, run, isAnswer: (s: string) => s.includes(v.task.title) && correctTotal.test(s) };
}

async function receivedAnswer(ctx: BasicFlowContext, task: Started) {
  const { run, isAnswer } = await answered(ctx, task);
  const message = await task.received("原群組收到本題回答", isAnswer);
  return { taskId: task.taskId, runId: run.id, groupMessages: [message] };
}

async function events(ctx: BasicFlowContext, task: Started, run: Run) {
  return z
    .object({
      events: z.array(
        z.object({
          phase: z.string(),
          kind: z.string(),
          detail: z.string().nullable(),
          containerId: z.string().nullable().optional(),
          exitCode: z.number().nullable().optional(),
        }),
      ),
    })
    .parse(await ctx.admin("GET", "/api/tasks/" + task.taskId + "/runs/" + run.id + "/events")).events;
}

async function activeCode(ctx: BasicFlowContext, task: Started) {
  return ctx.poll("確認執行中的工作容器與等待命令", async () => {
    const v = await task.view(),
      run = v.runs[0];
    if (!run) return undefined;
    assert(!run.completed_at, "注入前執行已結束");
    if (v.task.status !== "running" || run.status !== "code") return undefined;
    const seen = (await events(ctx, task, run)).filter((e) => e.phase === "code");
    if (
      !seen.some((e) => e.kind === "container" && e.containerId) ||
      !seen.some((e) => e.kind === "command_start" && e.detail?.includes("sleep 60"))
    )
      return undefined;
    assert.equal(run.version, v.task.approved_version, "執行中的版本未核准");
    return run;
  });
}

async function interrupt(c: Context, action: "cancel" | "message_edit" | "unsend", index: number) {
  const { ctx, controls } = c;
  const edit = action === "message_edit";
  const title = { cancel: "取消票數調查", message_edit: "編輯票數需求", unsend: "撤回票數來源" }[action];
  const task = await start(c, index, title, edit ? "discord" : "line", "query", true);
  const run = await activeCode(ctx, task);
  // 成員把原指令改成一般文字。指令頻道仍會使舊來源失效，且不另開第二輪判讀。
  const edited = "請改查 lantern-tickets 只有一批四張的情況。";
  if (action === "cancel") {
    const result = z.object({
      id: z.literal(task.taskId),
      status: z.literal("cancelled"),
      version: z.literal(run.version),
    });
    result.parse(
      await ctx.admin("POST", "/api/tasks/" + task.taskId + "/actions", { action, version: run.version }),
    );
  } else if (edit) {
    await controls.discordEvent({
      type: "update",
      channel: discord.channelId,
      id: task.messageId,
      botId: discord.applicationId,
      editedAt: new Date().toISOString(),
      text: edited,
    });
  } else {
    const payload = JSON.stringify({
      events: [
        {
          type: "unsend",
          webhookEventId: randomUUID(),
          timestamp: Date.now(),
          source: { type: "group", groupId: line.groupId, userId: line.userId },
          unsend: { messageId: task.messageId },
        },
      ],
    });
    await deliver(ctx, {
      method: "POST",
      url: "/webhooks/line",
      payload,
      headers: {
        "content-type": "application/json",
        "x-line-signature": createHmac("sha256", ctx.lineSecret).update(payload).digest("base64"),
      },
    });
  }
  const expected = action === "cancel" ? "cancelled" : "awaiting_approval";
  const v = await task.until(
    "原執行已停止並清理",
    (v) => v.task.status === expected && !!v.runs[0]?.completed_at,
  );
  assert.equal(v.runs.length, 1, "中止後另開了執行");
  assert.equal(v.runs[0].id, run.id, "清理了其他執行");
  assert.equal(v.runs[0].outcome, expected, "原執行結果未反映中止");
  assert.equal(v.task.answer, null, "中止後仍發布舊答案");
  audited(v, "triage", "started", action);
  let receipts: readonly string[];
  if (action === "cancel") {
    assert.equal(v.task.version, run.version, "取消的需求版本錯誤");
    const closed = (s: string) => s.includes(v.task.title) && s.includes("取消");
    await bell(ctx, task.taskId, "group_closed", closed);
    receipts = [await task.received("群組收到取消通知", closed)];
  } else {
    assert.equal(v.task.version, run.version + 1, "來源變動後需求未升版");
    assert.equal(v.task.approved_version, null, "新需求沿用了舊核准");
    assert.equal(v.projectReview.confirmed, false, "新需求沿用了舊專案確認");
    const src = v.sources.find((s) => s.id === task.source);
    assert.equal(src?.availability, edit ? "readable" : "revoked", "來源可讀狀態不符");
    assert.equal(src?.text, edit ? edited : null, "看板保留了錯誤的來源內容");
    await bell(ctx, task.taskId, action, (s) => s.includes(edit ? "編輯" : "撤回"));
    receipts = await task.messages();
  }
  assert(
    !(await task.messages()).some((s) => s.includes(v.task.title) && correctTotal.test(s)),
    "群組收到了中止前的舊答案",
  );
  return { taskId: task.taskId, runId: run.id, groupMessages: [...receipts] };
}

async function restart(c: Context) {
  const task = await start(c, 161, "重啟期間的票數調查", "line", "query", true);
  const old = await activeCode(c.ctx, task);
  // 重啟若觸發暫時性錯誤，排程可使用同一需求版本真正重新查詢。
  await c.controls.setModelSteps(lineQuerySteps(c.ctx.projectId).slice(1));
  const receipt = await c.controls.restartRunner(old.id);
  z.object({
    instance: z.literal(operationsInstance()),
    previousPid: z.int().positive(),
    pid: z.int().positive(),
  }).parse(receipt);
  assert.notEqual(receipt.previousPid, receipt.pid, "重啟前後為同一個 runner 程序");
  const v = await task.until(
    "回收重啟前的執行並結案",
    (v) => ["failed", "answered"].includes(v.task.status) && v.runs.every((r) => r.completed_at),
  );
  const recovered = v.runs.find((r) => r.id === old.id);
  assert(recovered?.completed_at && recovered.version === old.version, "重啟前的執行尚未回收");
  if (v.task.status === "answered") {
    assert.equal(v.runs.length, 2, "重啟後應有一次新的執行");
    assert.equal(recovered.outcome, "queued", "中斷的執行沒有排定重試");
    assert.notEqual(v.runs[0].id, old.id, "舊執行冒充重試");
    audited(v, "started", "auto_retry", "started", "answered");
    assert(
      v.history.some((h) => h.kind === "auto_retry" && /執行器|連線中斷/.test(h.detail)),
      "重試原因與執行器中斷不符",
    );
    return receivedAnswer(c.ctx, task);
  }
  const interrupted = recovered.outcome === "interrupted";
  assert(interrupted || recovered.outcome === "failed", "中斷執行的結案原因不符");
  assert.equal(v.runs.length, 1, "重啟後另一次無關錯誤遮蔽了原始中斷");
  assert.match(v.task.last_error ?? "", /中斷|執行器.*連線/, "看板缺少執行中斷原因");
  audited(v, "started", interrupted ? "interrupted" : "error");
  await bell(c.ctx, task.taskId, interrupted ? "interrupted" : "failed", (s) => /中斷|連線/.test(s));
  const msg = interrupted
    ? await task.received("群組已收到需求", (s) => s.includes("收到"))
    : await task.received("群組收到執行失敗通知", (s) => /中斷|連線/.test(s));
  assert.equal(v.task.answer, null, "中斷執行仍產生答案");
  return { taskId: task.taskId, runId: old.id, groupMessages: [msg] };
}

async function memory(c: Context) {
  const { ctx, controls } = c;
  const capacity = async () =>
    z
      .object({
        holdKind: z.string().nullable(),
        hold: z.string().nullable(),
        host: z.object({ memFreeMb: z.number() }),
        queued: z.array(z.object({ id: z.string(), code: z.string() })),
      })
      .parse(await ctx.admin("GET", "/api/capacity"));
  await controls.setMemoryCeiling(MEMORY_FLOOR_MB - 1);
  let restored = false;
  try {
    const task = await start(c, 171, "記憶體回升後的票數調查");
    await ctx.poll("主機記憶體不足，保留同一件排隊任務", async () => {
      const cap = await capacity(),
        v = await task.view();
      assert.equal(v.runs.length, 0, "低記憶體期間已派工");
      if (cap.holdKind !== "memory" || !cap.queued.some((q) => q.id === task.taskId && q.code === "memory"))
        return undefined;
      assert.equal(v.task.status, "queued", "暫停期間任務未在排隊");
      assert(cap.host.memFreeMb < MEMORY_FLOOR_MB, "容量頁未讀到低記憶體");
      return true;
    });
    const releasedAt = Date.now();
    await controls.setMemoryCeiling(null);
    restored = true;
    const since = await ctx.poll("記憶體已回升，穩定期間仍保留排隊", async () => {
      const v = await task.view();
      assert(v.task.status === "queued" && !v.runs.length, "回升後跳過穩定期");
      const { health } = z
        .object({
          health: z.array(
            z.object({ name: z.string(), ok: z.boolean(), recovering_since: z.string().nullable() }),
          ),
        })
        .parse(await ctx.admin("GET", "/api/state"));
      const h = health.find((row) => row.name === "host_resources");
      if (!h?.recovering_since || h.ok) return undefined;
      const time = Date.parse(h.recovering_since);
      assert(time >= releasedAt, "看板回報的回升起點早於解除低讀數");
      return time;
    });
    // 每個觀察窗最多三分鐘，依產品的回升起點核對整段穩定期。
    await ctx.poll("前半段穩定期仍在等待派工", async () => {
      const v = await task.view();
      const elapsed = Date.now() - since;
      if (elapsed < MEMORY_STEADY_MS) assert(!v.runs.length, "尚未穩定五分鐘就已派工");
      return elapsed >= MEMORY_STEADY_MS / 2 ? true : undefined;
    });
    await ctx.poll("穩定期結束並解除暫停", async () =>
      (await capacity()).holdKind === null ? true : undefined,
    );
    const result = await receivedAnswer(ctx, task);
    const v = await task.view();
    assert.equal(v.runs.length, 1, "恢復派工次數錯誤");
    assert(Date.parse(v.runs[0].started_at) >= since + MEMORY_STEADY_MS, "尚未穩定五分鐘就已派工");
    assert.equal((await capacity()).holdKind, null, "完成後容量頁仍顯示暫停");
    return result;
  } finally {
    if (!restored) await controls.setMemoryCeiling(null);
  }
}

async function daily(c: Context) {
  const first = await start(c, 181, "第一批票數核算");
  const used = await receivedAnswer(c.ctx, first);
  const state = z
    .object({
      settings: z.looseObject({ daily_runs: z.int().positive(), ai_mode: z.literal("subscription") }),
      usage: z.object({ runs_today: z.int().positive() }),
    })
    .parse(await c.ctx.admin("GET", "/api/state"));
  assert.equal(state.usage.runs_today, 1, "本案須由一筆真正完成的執行用完當日次數");
  await c.controls.putSettings({ ...state.settings, daily_runs: 1 });
  // 提高上限會提前解除等待；這個設定隨案例專屬實例清理。
  const task = await start(c, 182, "第二批票數核算");
  const v = await task.until("每日次數用完，工作已保留", (v) => v.task.status === "budget_wait");
  assert.match(v.task.last_error ?? "", /今日執行次數.*上限/, "等候原因不是每日次數上限");
  assert.equal(v.runs.length, 0, "超額工作已建立執行");
  assert.equal(v.task.answer, null, "超額工作仍產生回答");
  audited(v, "triage");
  await bell(c.ctx, task.taskId, "budget", (s) => s.includes(v.task.title) && s.includes("保留"));
  const wait = await task.received(
    "群組收到次數用盡與恢復時間",
    (s) => /今天.*次數.*用完/.test(s) && s.includes("明天"),
  );
  const held = await task.view();
  assert(held.task.status === "budget_wait" && !held.runs.length, "送達等待說明後超額任務竟已派工");
  assert(
    held.groupDeliveries.some((d) => d.kind === "group_waiting" && d.text === wait),
    "群組等待說明不是本題通知",
  );
  return { taskId: task.taskId, groupMessages: [...used.groupMessages, wait] };
}

async function workerFailure(c: Context, fault: Exclude<WorkerFault, null>) {
  const install = fault === "install",
    { ctx, controls } = c;
  const task = await start(
    c,
    install ? 191 : 192,
    install ? "安裝失敗的票務修改" : "無法建立票務工作容器",
    "line",
    "change",
  );
  const before = await task.until("等待人工核准", (v) => v.task.status === "awaiting_approval");
  assert(
    !before.runs.length && before.task.approved_version === null && !before.projectReview.confirmed,
    "修改未等候本版人工核准",
  );
  await controls.setWorkerFault(fault);
  try {
    z.object({
      id: z.literal(task.taskId),
      approved_version: z.literal(before.task.version),
      status: z.literal("queued"),
    }).parse(
      await ctx.admin("POST", "/api/tasks/" + task.taskId + "/actions", {
        action: "approve",
        version: before.task.version,
        project_id: before.task.project_id,
        config_version: before.projectReview.config_version,
        binding_version: before.projectReview.binding_version,
        target_branch: before.task.target_branch,
      }),
    );
    const v = await task.until(
      "工作失敗並清理執行",
      (v) => v.task.status === "failed" && !!v.runs[0]?.completed_at,
    );
    const run = finished(v, "failed");
    assert.equal(v.runs.length, 1, "故障不應另行派工");
    audited(v, "triage", "approve", "started", ...(install ? ["install_retry"] : []), "error");
    const seen = (await events(ctx, task, run)).filter((e) => e.phase === "install");
    const marker = install ? installMarker : missingImage;
    assert(
      seen.some((e) => e.kind === "error" && e.detail?.includes(marker)),
      "執行錯誤缺少本次故障標記 " + marker,
    );
    if (install) {
      assert(
        v.history.some((h) => h.kind === "install_retry" && h.detail.includes(marker)),
        "安裝重試未對應注入的安裝錯誤",
      );
      assert.equal(
        new Set(seen.filter((e) => e.kind === "container" && e.containerId).map((e) => e.containerId)).size,
        2,
        "安裝失敗應在兩個工作容器各執行一次",
      );
      assert.equal(
        seen.filter((e) => e.kind === "phase_end" && e.exitCode === 19 && e.detail?.includes(marker)).length,
        2,
        "缺少兩次安裝指令退出的證據",
      );
    } else {
      assert(!seen.some((e) => e.kind === "container"), "應在建立工作容器時失敗");
      assert(!v.history.some((h) => h.kind === "install_retry"), "建立容器錯誤被當成安裝指令失敗");
      assert(
        seen.some((e) => e.kind === "error" && /No such image/i.test(e.detail ?? "")),
        "Docker 未回報指定映像建立失敗",
      );
    }
    assert(!run.phases.some((p) => ["code", "publish"].includes(p.phase)), "故障後仍開發或發布");
    const reason = install ? /安裝依賴失敗/ : /工作容器.*映像/;
    assert.match(v.task.last_error ?? "", reason, "看板未說明正確的故障原因");
    await bell(ctx, task.taskId, "failed", (s) => reason.test(s));
    const msg = await task.received("群組收到故障原因", (s) => reason.test(s));
    assert(
      v.groupDeliveries.some((d) => d.kind === "group_failed" && d.text === msg),
      "群組錯誤通知與本題不符",
    );
    return { taskId: task.taskId, runId: run.id, groupMessages: [msg] };
  } finally {
    await controls.setWorkerFault(null);
  }
}

async function channels(c: Context) {
  const { ctx, controls } = c;
  const offset = (await ctx.groupMessages(parent)).length;
  const thread = await start(c, 201, "志工討論串票數", "thread");
  const result = await receivedAnswer(ctx, thread);
  const title = (await thread.view()).task.title;
  const checkParent = async () =>
    assert(
      !(await ctx.groupMessages(parent)).slice(offset).some((s) => s.includes(title) || correctTotal.test(s)),
      "討論串的回答送到了父頻道",
    );
  await checkParent();
  await controls.setLineQuotaExhausted(true);
  try {
    const task = await start(c, 202, "LINE 推播暫停時的票數");
    const { run, isAnswer } = await answered(ctx, task);
    await bell(ctx, null, LINE_QUOTA, (s) => s === quotaBellNotice);
    const v = await task.until("本題群組回答因月額度不足留在看板", (v) =>
      v.groupDeliveries.some(
        (d) =>
          d.kind === "group_answered" &&
          d.delivery.status === "pending" &&
          d.delivery.reason === "quota" &&
          isAnswer(d.text ?? ""),
      ),
    );
    const ack = await task.received("LINE 免費回覆仍送達", (s) => s.includes("收到"));
    assert(
      !(await task.messages()).some((s) => isAnswer(s) || correctTotal.test(s)),
      "額度用盡仍送出了本題回答",
    );
    assert.equal(v.runs.length, 1, "LINE 推播失敗不應重跑查詢");
    await checkParent();
    return { taskId: task.taskId, runId: run.id, groupMessages: [...result.groupMessages, ack] };
  } finally {
    await controls.setLineQuotaExhausted(false);
  }
}

export async function runOperationsFlow(
  number: number,
  ctx: BasicFlowContext,
  controls: OperationsControls,
): Promise<{ taskId: string; runId?: string; groupMessages: string[] }> {
  operationsInstance();
  const c = { ctx, controls };
  switch (number) {
    case 15: {
      const cancelled = await interrupt(c, "cancel", 151);
      const edited = await interrupt(c, "message_edit", 152);
      const revoked = await interrupt(c, "unsend", 153);
      return {
        ...revoked,
        groupMessages: [...cancelled.groupMessages, ...edited.groupMessages, ...revoked.groupMessages],
      };
    }
    case 16:
      return restart(c);
    case 17:
      return memory(c);
    case 18:
      return daily(c);
    case 19: {
      const install = await workerFailure(c, "install");
      const create = await workerFailure(c, "create");
      return { ...create, groupMessages: [...install.groupMessages, ...create.groupMessages] };
    }
    case 20:
      return channels(c);
    default:
      throw new Error("維運劇本編號限 15 到 20");
  }
}
