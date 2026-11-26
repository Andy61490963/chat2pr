import { createHmac, randomUUID } from "node:crypto";
import { expect, it, vi, afterEach, beforeEach } from "vitest";
import { Decisions } from "../server/triage.js";
import { basicFixture, type BasicFlowContext } from "../scripts/acceptance/flows/basic.js";
import { runOperationsFlow, type OperationsControls } from "../scripts/acceptance/flows/operations.js";
import { archiveRunner, operationsRunner, prepareProject } from "../scripts/acceptance/flows/application.js";
import {
  operationsCreateInput,
  operationsPhaseInput,
  installMarker,
  missingImage,
} from "../scripts/acceptance/flows/operations-worker.js";
import { MEMORY_STEADY_MS } from "../server/capacity.js";
import { HttpRunner } from "../server/execution.js";
import type { RunnerTransport } from "../server/runner-http.js";

const instance = "verify-266-lantern-operations";
const project = randomUUID();
const lineSecret = "ExampleLine266";
const { line, discord } = basicFixture;
const parent = "discord:" + discord.channelId;
beforeEach(() => {
  vi.stubEnv("AGENTFLOW_INSTANCE", instance);
  vi.stubEnv("ACCEPTANCE_FLOW_REAL", "0");
});
afterEach(() => vi.unstubAllEnvs());

// 只供輕量紅綠測試使用。看板快照與外部收件匣分開保存，可單獨破壞其中一項證據。
function fixture(entry: "normal" | "active" | "approval" | "memory" = "normal") {
  let decision: ReturnType<typeof Decisions.parse>["decisions"][number] | undefined;
  let daily = 5,
    exhausted = false;
  const tasks: { id: string; group_id: string; source_ids: string[] }[] = [];
  const inbox = new Map<string, string[]>();
  const alerts: { task_id: string | null; kind: string; text: string }[] = [];
  const details = new Map<string, ReturnType<typeof snapshot>>();
  const settingsWrites: number[] = [];
  function receive(group: string, text: string) {
    const messages = inbox.get(group) ?? [];
    messages.push(text);
    inbox.set(group, messages);
  }
  function snapshot(group: string, source: string, thread: string | null, text: string) {
    if (!decision) throw new Error("尚未提供判讀劇本");
    expect(decision.sourceIds).toEqual([source]);
    expect(decision.projectId).toBe(project);
    expect(text).toContain(decision.routing.evidence[0].quote);
    const id = randomUUID(),
      title = decision.title;
    const held = tasks.length >= daily;
    const answer = held ? null : "兩批合計 5 張，依據 tickets.mjs:2。";
    const status = held ? "budget_wait" : "answered";
    const body = held
      ? "今天的執行次數用完了，這件事已經保留，明天凌晨會自動繼續處理，不用重新提出。"
      : "「" + title + "」的查詢結果：兩批合計 5 張。";
    if (group === line.groupId)
      receive(group, "收到，我會把這則需求整理好交給管理者確認，處理完會在這裡回報。");
    if (entry === "normal") {
      if (!exhausted || group !== line.groupId) receive(thread ?? group, body);
      alerts.push({
        task_id: id,
        kind: held ? "budget" : "answered",
        text: held ? "額度不足，工作已保留：" + title : title + "：兩批合計 5 張。",
      });
    }
    const task = {
      id,
      title,
      group_id: group,
      discord_thread_id: thread,
      source_ids: [source],
      project_id: project,
      mode: decision.taskType,
      target_branch: "main",
      status,
      version: 1,
      approved_version: 1,
      answer,
      pr_number: null,
      last_error: held ? "今日執行次數已達上限，工作已保留" : null,
    };
    tasks.push(task);
    return {
      task,
      sources: [{ id: source, availability: "readable", text }],
      projectReview: { binding_version: 1, config_version: 1, confirmed: true },
      history: (held ? ["triage"] : ["triage", "started", "answered"]).map((kind) => ({ kind, detail: "" })),
      runs: held
        ? []
        : [
            {
              id: randomUUID(),
              status: "code",
              version: 1,
              outcome: "answered",
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              phases: [{ phase: "code" }],
            },
          ],
      groupDeliveries: [
        {
          kind: held ? "group_waiting" : "group_answered",
          text: body,
          delivery: { status: exhausted ? "pending" : "sent", reason: exhausted ? "quota" : null },
        },
      ],
    };
  }
  function save(group: string, source: string, thread: string | null, text: string) {
    const view = snapshot(group, source, thread, text);
    if (entry !== "normal") {
      Object.assign(view.task, {
        answer: null,
        status: entry === "active" ? "running" : entry === "approval" ? "awaiting_approval" : "queued",
      });
      view.groupDeliveries.length = 0;
      view.history = [{ kind: "triage", detail: "" }];
      if (entry !== "active") view.runs.length = 0;
      else {
        Object.assign(view.runs[0], { completed_at: null, outcome: null });
        view.history.push({ kind: "started", detail: "" });
      }
      if (entry === "approval") {
        Object.assign(view.task, { approved_version: null });
        view.projectReview.confirmed = false;
      }
    }
    details.set(view.task.id, view);
  }
  const ctx = {
    projectId: project,
    repository: "lantern-example/lantern-tickets",
    lineSecret,
    githubWebhookSecret: "ExampleGitHub266",
    gateway: vi.fn(),
    readPr: vi.fn(),
    db: {
      one: vi.fn(() => {
        throw new Error("不應存取資料庫");
      }),
    },
    webhook: vi.fn<BasicFlowContext["webhook"]>(async (req) => {
      expect(req.url).toBe("/webhooks/line");
      expect(req.headers["x-line-signature"]).toBe(
        createHmac("sha256", lineSecret).update(req.payload).digest("base64"),
      );
      const [event] = JSON.parse(req.payload).events;
      save(event.source.groupId, event.message.id, null, event.message.text);
      return { statusCode: 200 };
    }),
    groupMessages: vi.fn(async (id: string) => [...(inbox.get(id) ?? [])]),
    admin: vi.fn<BasicFlowContext["admin"]>(async (method, path) => {
      expect(method).toBe("GET");
      if (path === "/api/state")
        return {
          tasks,
          alerts,
          settings: { ai_mode: "subscription", daily_runs: daily },
          usage: { runs_today: [...details.values()].reduce((sum, v) => sum + v.runs.length, 0) },
        };
      const view = details.get(path.replace("/api/tasks/", ""));
      if (!view) throw new Error("未知的看板路徑 " + path);
      return view;
    }),
    async poll<T>(label: string, probe: () => Promise<T | undefined>) {
      const result = await probe();
      if (result === undefined) throw new Error("未觀察到：" + label);
      return result;
    },
  } satisfies BasicFlowContext;
  const controls = {
    setModelSteps: vi.fn<OperationsControls["setModelSteps"]>(async (steps) => {
      const first = steps[0];
      if (first?.kind === "text") decision = Decisions.parse(JSON.parse(first.text)).decisions[0];
    }),
    discordEvent: vi.fn<OperationsControls["discordEvent"]>(async (event) => {
      if (event.type !== "create") throw new Error("非建立訊息");
      save(
        "discord:" + (event.parentChannel ?? event.channel),
        "discord:" + event.id,
        event.parentChannel ? "discord:" + event.channel : null,
        event.text,
      );
    }),
    restartRunner: vi.fn<OperationsControls["restartRunner"]>(),
    setMemoryCeiling: vi.fn<OperationsControls["setMemoryCeiling"]>(),
    setWorkerFault: vi.fn<OperationsControls["setWorkerFault"]>(),
    putSettings: vi.fn<OperationsControls["putSettings"]>(async (body) => {
      daily = Number(body.daily_runs);
      settingsWrites.push(daily);
      return { ok: true };
    }),
    setLineQuotaExhausted: vi.fn(async (value: boolean) => {
      exhausted = value;
      if (value)
        alerts.push({
          task_id: null,
          kind: "line_quota",
          text: "LINE 推播額度用完，群組回覆與私訊暫停，看板通知照常",
        });
    }),
  } satisfies OperationsControls;
  return { ctx, controls, tasks, settingsWrites, inbox, details, alerts, receive };
}

it("F18 用已完成的執行耗盡次數，看板、鈴鐺及群組都說明第二題等待", async () => {
  const f = fixture();
  await runOperationsFlow(18, f.ctx, f.controls);
  expect(f.tasks).toHaveLength(2);
  expect(f.settingsWrites).toContain(1);
  expect(f.ctx.groupMessages).toHaveBeenCalledWith(line.groupId);
});

it("F20 依父頻道綁定建立任務，討論串收到回答，LINE 額度用完仍在鈴鐺保留回答", async () => {
  const f = fixture();
  await runOperationsFlow(20, f.ctx, f.controls);
  expect(f.controls.discordEvent).toHaveBeenCalledOnce();
  expect(f.ctx.webhook).toHaveBeenCalledOnce();
  expect(f.controls.setLineQuotaExhausted.mock.calls.map(([value]) => value)).toEqual([true, false]);
});

it("F20 同一個回答也送到父頻道就失敗", async () => {
  const f = fixture();
  f.ctx.groupMessages.mockImplementation(async (id) =>
    id === parent
      ? [...f.inbox.entries()].filter(([key]) => key.startsWith("discord:")).flatMap(([, texts]) => texts)
      : (f.inbox.get(id) ?? []),
  );
  await expect(runOperationsFlow(20, f.ctx, f.controls)).rejects.toThrow(/父頻道/);
});

it("F20 鈴鐺有月額度提示，仍必須有本題的回答", async () => {
  const f = fixture();
  const send = f.ctx.webhook.getMockImplementation()!;
  f.ctx.webhook.mockImplementation(async (req) => {
    const res = await send(req);
    f.alerts.splice(
      f.alerts.findIndex((a) => a.task_id === f.tasks.at(-1)?.id),
      1,
    );
    return res;
  });
  await expect(runOperationsFlow(20, f.ctx, f.controls)).rejects.toThrow(/answered|回答/);
  expect(f.controls.setLineQuotaExhausted).toHaveBeenLastCalledWith(false);
});

type Fixture = ReturnType<typeof fixture>;
function current(f: Fixture) {
  const view = [...f.details.values()].at(-1);
  if (!view) throw new Error("測試缺少任務快照");
  return view;
}

const activeEvents = [
  { kind: "container", phase: "code", containerId: "a".repeat(64), detail: null },
];

function interruptedFixture(keepApproval = false) {
  const f = fixture("active");
  function stop(kind: string, text?: string) {
    const v = current(f),
      cancelled = kind === "cancel";
    const status = cancelled ? "cancelled" : "awaiting_approval";
    v.task.status = status;
    Object.assign(v.runs[0], { completed_at: new Date().toISOString(), outcome: status });
    v.history.push({ kind, detail: "" });
    if (!cancelled) {
      Object.assign(v.task, { version: 2, approved_version: keepApproval ? 1 : null });
      v.projectReview.confirmed = false;
      Object.assign(v.sources[0], { text: text ?? null, availability: text ? "readable" : "revoked" });
    }
    const msg = cancelled
      ? "「" + v.task.title + "」已由管理者取消。"
      : "需求來源已" + (text ? "編輯" : "撤回");
    f.alerts.push({ task_id: v.task.id, kind: cancelled ? "group_closed" : kind, text: msg });
    if (cancelled) f.receive(line.groupId, msg);
    return v.task;
  }
  const read = f.ctx.admin.getMockImplementation()!;
  f.ctx.admin.mockImplementation(async (method, path, body) => {
    if (path.endsWith("/events")) return { events: activeEvents };
    if (method === "POST") {
      expect(body).toMatchObject({ action: "cancel", version: current(f).runs[0].version });
      return stop("cancel");
    }
    return read(method, path, body);
  });
  const post = f.ctx.webhook.getMockImplementation()!;
  f.ctx.webhook.mockImplementation(async (req) => {
    const [event] = JSON.parse(req.payload).events;
    if (event.type !== "unsend") return post(req);
    expect(req.headers["x-line-signature"]).toBe(
      createHmac("sha256", f.ctx.lineSecret).update(req.payload).digest("base64"),
    );
    expect(event.unsend.messageId).toBe(current(f).sources[0].id);
    expect(event).not.toHaveProperty("replyToken");
    stop("unsend");
    return { statusCode: 200 };
  });
  const dispatch = f.controls.discordEvent.getMockImplementation()!;
  f.controls.discordEvent.mockImplementation(async (event) => {
    if (event.type !== "update") return dispatch(event);
    expect("discord:" + event.id).toBe(current(f).sources[0].id);
    stop("message_edit", event.text);
  });
  return f;
}

it("F15 在執行容器出現後分別取消、編輯來源及簽章撤回，核對三筆舊執行", async () => {
  const f = interruptedFixture();
  await runOperationsFlow(15, f.ctx, f.controls);
  expect(f.tasks).toHaveLength(3);
  expect([...f.details.values()].map((v) => v.history.at(-1)?.kind)).toEqual([
    "cancel",
    "message_edit",
    "unsend",
  ]);
});

it("F15 來源已升版但仍沿用舊核准會失敗", async () => {
  const f = interruptedFixture(true);
  await expect(runOperationsFlow(15, f.ctx, f.controls)).rejects.toThrow("舊核准");
});

it.each([true, false])("F16 只接受新程序且舊執行已回收（PID 有更換 %s）", async (replace) => {
  const f = fixture("active");
  const read = f.ctx.admin.getMockImplementation()!;
  f.ctx.admin.mockImplementation(async (m, p, b) =>
    p.endsWith("/events") ? { events: activeEvents } : read(m, p, b),
  );
  f.controls.restartRunner.mockImplementation(async (runId) => {
    const v = current(f);
    expect(v.runs[0].id).toBe(runId);
    Object.assign(v.runs[0], { outcome: "interrupted", completed_at: new Date().toISOString() });
    Object.assign(v.task, { status: "failed", last_error: "服務曾中斷；重試前會先核對 GitHub PR" });
    v.history.push({ kind: "interrupted", detail: "" });
    f.alerts.push({ task_id: v.task.id, kind: "interrupted", text: "執行曾中斷，請檢視並重試" });
    return { instance, previousPid: 101, pid: replace ? 102 : 101 };
  });
  const attempt = runOperationsFlow(16, f.ctx, f.controls);
  if (replace) expect((await attempt).runId).toBe(current(f).runs[0].id);
  else await expect(attempt).rejects.toThrow("同一個 runner");
});

it.each([true, false])("F17 低讀數不派工、通過穩定期才接受有回答的執行（足時 %s）", async (steady) => {
  const f = fixture("memory");
  let now = Date.parse("2026-08-01T12:00:00Z"),
    since = 0;
  const date = vi.spyOn(Date, "now").mockImplementation(() => now);
  f.controls.setMemoryCeiling.mockImplementation(async (mb) => {
    if (mb === null) since = now;
  });
  const read = f.ctx.admin.getMockImplementation()!;
  f.ctx.admin.mockImplementation(async (m, p, b) => {
    if (p === "/api/state" && since)
      return Object.assign({}, await read(m, p, b), {
        health: [{ name: "host_resources", ok: false, recovering_since: new Date(since).toISOString() }],
      });
    if (p === "/api/capacity")
      return {
        holdKind: since ? null : "memory",
        hold: since ? null : "主機記憶體不足",
        host: { memFreeMb: since ? 4096 : 2047 },
        queued: [{ id: current(f).task.id, code: "memory" }],
      };
    return read(m, p, b);
  });
  const poll = f.ctx.poll;
  f.ctx.poll = async (label, probe) => {
    if (label.includes("前半段")) now = since + MEMORY_STEADY_MS / 2;
    if (label.includes("解除暫停")) {
      now = since + MEMORY_STEADY_MS;
      const v = current(f);
      const body = "「" + v.task.title + "」兩批合計 5 張。";
      Object.assign(v.task, { answer: "兩批合計 5 張，依據 tickets.mjs:2。", status: "answered" });
      v.runs.push({
        id: randomUUID(),
        version: 1,
        status: "code",
        outcome: "answered",
        started_at: new Date(steady ? now : now - 1).toISOString(),
        completed_at: new Date(now).toISOString(),
        phases: [{ phase: "code" }],
      });
      v.history.push({ kind: "started", detail: "" }, { kind: "answered", detail: "" });
      f.alerts.push({ task_id: v.task.id, kind: "answered", text: body });
      f.receive(line.groupId, body);
    }
    return poll(label, probe);
  };
  try {
    const attempt = runOperationsFlow(17, f.ctx, f.controls);
    if (steady) await attempt;
    else await expect(attempt).rejects.toThrow("尚未穩定五分鐘");
    expect(f.controls.setMemoryCeiling.mock.calls).toEqual([[2047], [null]]);
  } finally {
    date.mockRestore();
  }
});

it.each([true, false])("F19 核准後核對安裝重試與 Docker 建立錯誤（錯誤來自本次映像 %s）", async (inject) => {
  const f = fixture("approval");
  let fault: "install" | "create" | null = null;
  f.controls.setWorkerFault.mockImplementation(async (value) => {
    fault = value;
  });
  const read = f.ctx.admin.getMockImplementation()!;
  f.ctx.admin.mockImplementation(async (method, path, b) => {
    if (path.endsWith("/events")) {
      const event = (kind: string, detail: string) => ({ phase: "install", kind, detail });
      return {
        events:
          fault === "install"
            ? [
                ...["a", "b"].flatMap((id) => [
                  { ...event("container", ""), containerId: id.repeat(64) },
                  { ...event("phase_end", installMarker), exitCode: 19 },
                ]),
                event("error", installMarker),
              ]
            : [event("error", "No such image: " + (inject ? missingImage : "另一個映像"))],
      };
    }
    if (method !== "POST") return read(method, path, b);
    const v = current(f);
    expect(b).toEqual({
      action: "approve",
      version: 1,
      project_id: project,
      config_version: 1,
      binding_version: 1,
      target_branch: "main",
    });
    const why = fault === "install" ? "安裝依賴失敗" : "工作容器缺少需要的指令、工具或映像";
    Object.assign(v.task, { status: "failed", approved_version: 1, last_error: why });
    v.runs.push({
      id: randomUUID(),
      version: 1,
      status: "install",
      outcome: "failed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      phases: [{ phase: "install" }],
    });
    v.history.push({ kind: "approve", detail: "" }, { kind: "started", detail: "" });
    if (fault === "install") v.history.push({ kind: "install_retry", detail: installMarker });
    v.history.push({ kind: "error", detail: why });
    f.alerts.push({ task_id: v.task.id, kind: "failed", text: why });
    v.groupDeliveries.push({ kind: "group_failed", text: why, delivery: { status: "sent", reason: null } });
    f.receive(line.groupId, why);
    return { id: v.task.id, approved_version: 1, status: "queued" };
  });
  const attempt = runOperationsFlow(19, f.ctx, f.controls);
  if (inject) await attempt;
  else await expect(attempt).rejects.toThrow("本次故障標記");
  expect(f.controls.setWorkerFault.mock.calls).toEqual([["install"], [null], ["create"], [null]]);
});

it("F18 改為訂閱額度等待，即使鈴鐺有預算通知仍會失敗", async () => {
  const f = fixture(),
    post = f.ctx.webhook.getMockImplementation()!;
  f.ctx.webhook.mockImplementation(async (req) => {
    const result = await post(req);
    if (f.tasks.length === 2) Object.assign(current(f).task, { last_error: "等待訂閱額度恢復" });
    return result;
  });
  await expect(runOperationsFlow(18, f.ctx, f.controls)).rejects.toThrow("每日次數上限");
});

it("控制項只壓低真實讀數，安裝故障沿用原本的 runner，正式及真實訂閱模式拒絕注入", async () => {
  const transport = vi
    .fn<RunnerTransport>()
    .mockResolvedValue({ status: 200, body: JSON.stringify({ memFreeMb: 1500, cpus: 4 }) });
  const controlled = operationsRunner(archiveRunner(new HttpRunner(() => "FixtureRunner", transport)));
  await controlled.setMemoryCeiling(2000);
  expect(await controlled.runner.call("resources", {})).toEqual({ memFreeMb: 1500, cpus: 4 });
  await controlled.setMemoryCeiling(1024);
  expect(await controlled.runner.call("resources", {})).toMatchObject({ memFreeMb: 1024 });
  await controlled.setMemoryCeiling(null);
  expect(await controlled.runner.call("resources", {})).toMatchObject({ memFreeMb: 1500 });
  const job = {
    runId: randomUUID(),
    phase: "install",
    command: "npm ci",
    image: "lantern-worker",
    open: false,
  };
  await controlled.setWorkerFault("install");
  await controlled.runner.call("phase", job, 1000);
  expect(JSON.parse(String(transport.mock.calls.at(-1)?.[1].body))).toEqual({
    ...job,
    command: expect.stringContaining("exit 19"),
  });
  await controlled.setWorkerFault(null);
  await controlled.runner.call("phase", job, 1000);
  expect(JSON.parse(String(transport.mock.calls.at(-1)?.[1].body))).toEqual(job);
  vi.stubEnv("ACCEPTANCE_FLOW_REAL", "1");
  await expect(controlled.setWorkerFault("create")).rejects.toThrow("固定劇本");
  vi.stubEnv("AGENTFLOW_INSTANCE", "production");
  await expect(controlled.setMemoryCeiling(1024)).rejects.toThrow("隔離實例");
});

it("建立容器故障在原本映像完成檢查後才作用，只收本次實例的工作容器", () => {
  const runId = randomUUID();
  const job = { runId, phase: "install", command: "npm ci", image: "原始映像" };
  const marked = operationsPhaseInput("create", "phase", job);
  expect(marked).toMatchObject({ image: job.image, command: expect.any(String) });
  if (!marked || typeof marked !== "object" || !("command" in marked)) throw new Error("缺少標記");
  const options = {
    Image: "通過檢查的映像",
    Entrypoint: ["sh", "-c", String(marked.command)],
    Labels: { "io.agentflow.instance": instance, "io.agentflow.managed": "true", "io.agentflow.run": runId },
    HostConfig: { Memory: 12345 },
  };
  expect(operationsCreateInput(options)).toEqual({ ...options, Image: missingImage });
  expect(() =>
    operationsCreateInput({
      ...options,
      Labels: { ...options.Labels, "io.agentflow.instance": "production" },
    }),
  ).toThrow("其他實例");
  const regular = { ...options, Entrypoint: ["sh", "-c", "npm ci"] };
  expect(operationsCreateInput(regular)).toBe(regular);
});

it.each([true, false])("準備專案時將自動設定選擇送到建立 API，再送出正式驗證（%s）", async (auto) => {
  const db = {
    one: vi.fn().mockResolvedValue({ enabled: true, validated_at: new Date(), validation_error: null }),
    settings: vi.fn().mockResolvedValue({}),
    query: vi.fn(),
  };
  const admin = vi.fn<Parameters<typeof prepareProject>[1]>(async (_method, path) =>
    path === "/api/projects" ? { id: project } : { ok: true },
  );
  expect(await prepareProject(db, admin, "lantern-example/lantern-tickets", "lantern-worker", auto)).toBe(
    project,
  );
  expect(admin).toHaveBeenCalledWith(
    "POST",
    "/api/projects",
    expect.objectContaining({ enabled: false, setup_mode: auto ? "auto" : "manual" }),
  );
  expect(admin).toHaveBeenCalledWith("POST", "/api/projects/" + project + "/validate");
});
