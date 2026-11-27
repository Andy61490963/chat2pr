import { expect, it, vi } from "vitest";
import { reviewVerdict } from "../server/pr-body.js";
import { Decisions } from "../server/triage.js";
import {
  basicFixture,
  discordChangeSteps,
  lineQuerySteps,
  runDiscordChange,
  runLineQuery,
  type BasicFlowContext,
  type BasicPullRequest,
} from "../scripts/acceptance/flows/basic.js";
import type { ModelStep } from "../scripts/acceptance/flows/model-upstream.js";

const projectId = "26600000-0000-4000-8000-000000000001";
const taskId = "26600000-0000-4000-8000-000000000002";
const runId = "26600000-0000-4000-8000-000000000003";
const repository = "lantern-example/lantern-tickets";
const url =
  "https://github.example.invalid/lantern-example/lantern-tickets/pull/12";
const branch = "agentflow/26600000-v3";
const { line, discord } = basicFixture;
const channel = `discord:${discord.channelId}`;
const queryTitle = "燈會有幾張票";
const changeTitle = "未提供批次時回傳零";
const answer = `「${queryTitle}」的查詢結果：兩批合計 5 張。`;
const published = `「${changeTitle}」已修改完成，等管理者檢視後合併：\n${url}`;
const merged = `「${changeTitle}」的修改已合併。`;

function modelText(step: ModelStep | undefined) {
  if (step?.kind !== "text") throw new Error("此步應輸出模型文字");
  return step.text;
}

it.each([
  {
    mode: "query",
    steps: lineQuerySteps,
    sourceId: line.messageId,
    text: line.text,
    basis: "default",
  },
  {
    mode: "change",
    steps: discordChangeSteps,
    sourceId: `discord:${discord.interactionId}`,
    text: discord.text,
    basis: "explicit",
  },
])(
  "判讀腳本符合正式結構，$mode 的專案與分支證據可回查本則訊息",
  ({ mode, steps, sourceId, text, basis }) => {
    const { decisions } = Decisions.parse(
      JSON.parse(modelText(steps(projectId)[0])),
    );
    expect(decisions).toHaveLength(1);
    const [decision] = decisions;
    expect(decision).toMatchObject({
      kind: "request",
      taskType: mode,
      projectId,
      sourceIds: [sourceId],
      routing: {
        status: "clear",
        basis: "explicit",
        evidence: [{ kind: "message", sourceId, quote: text }],
      },
      targetBranch: {
        name: "main",
        basis,
        evidence: mode === "query" ? [] : [{ sourceId, quote: text }],
      },
      risks: [],
      missing: [],
      question: null,
    });
  },
);

it("查詢腳本讀取示範程式，修改腳本交付程式與測試，審查腳本讀取可信差異", () => {
  const [, read, report] = lineQuerySteps(projectId);
  expect(read).toMatchObject({
    kind: "tool",
    name: "exec_command",
    arguments: { cmd: expect.stringContaining("tickets.mjs") },
  });
  expect(modelText(report)).toContain("5 張");
  const [, edit, summary, inspect, verdict] = discordChangeSteps(projectId);
  expect(edit).toMatchObject({
    kind: "tool",
    name: "exec_command",
    arguments: {
      workdir: "/workspace",
      cmd: expect.stringContaining("assert.equal(countTickets(), 0)"),
    },
  });
  expect(modelText(summary)).toContain("countTickets()");
  expect(inspect).toMatchObject({
    kind: "tool",
    arguments: { cmd: expect.stringContaining(".patch") },
  });
  const result = JSON.parse(modelText(verdict));
  expect(result).toEqual({ passed: true, findings: [], notes: [] });
  expect(reviewVerdict(result)).toEqual(result);
});

function dashboard(
  status: "answered" | "awaiting_approval" | "ready" | "merged",
) {
  const query = status === "answered";
  const pending = status === "awaiting_approval";
  const hasPr = status === "ready" || status === "merged";
  const history = query
    ? ["triage", "started", "answered"]
    : pending
      ? ["triage"]
      : ["triage", "approve", "started", "ready"];
  if (status === "merged") history.push("merged");
  return {
    task: {
      id: taskId,
      title: query ? queryTitle : changeTitle,
      mode: query ? "query" : "change",
      group_id: query ? line.groupId : channel,
      project_id: projectId,
      source_ids: [query ? line.messageId : `discord:${discord.interactionId}`],
      status,
      version: 3,
      approved_version: pending ? null : 3,
      target_branch: "main",
      branch: pending ? null : branch,
      issue_number: pending ? null : 11,
      pr_number: hasPr ? 12 : null,
      pr_url: hasPr ? url : null,
      answer: query ? "共 5 張，計算位於 tickets.mjs:2。" : null,
      review_note: hasPr ? "獨立審查通過" : null,
    },
    projectReview: {
      repo: repository,
      binding_version: 7,
      config_version: 9,
      confirmed: !pending,
      confirmation: pending ? null : { kind: query ? "evidence" : "manual" },
    },
    history: history.map((kind) => ({ kind })),
    runs: pending
      ? []
      : [
          {
            id: runId,
            version: 3,
            outcome: query ? "answered" : "ready",
            completed_at: "2026-01-01T03:00:00.000Z",
            phases: (query
              ? ["code"]
              : ["code", "test", "review", "publish"]
            ).map((phase) => ({ phase })),
          },
        ],
  };
}

function context(mode: "query" | "change") {
  const one = vi
    .fn<BasicFlowContext["db"]["one"]>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({
      id: taskId,
      trigger_mode: mode === "query" ? "auto" : "command",
    });
  const messages = mode === "query" ? [answer] : [published];
  const group = mode === "query" ? line.groupId : channel;
  const ctx = {
    db: { one },
    projectId,
    repository,
    lineSecret: "驗收用 LINE 字串",
    githubWebhookSecret: "驗收用 GitHub 字串",
    admin: vi.fn<BasicFlowContext["admin"]>(),
    webhook: vi
      .fn<BasicFlowContext["webhook"]>()
      .mockResolvedValue({ statusCode: 200 }),
    gateway: vi.fn<BasicFlowContext["gateway"]>().mockResolvedValue(undefined),
    groupMessages: vi
      .fn<BasicFlowContext["groupMessages"]>()
      .mockResolvedValueOnce([])
      .mockImplementation(async (id) => (id === group ? messages : [])),
    readPr: vi.fn<BasicFlowContext["readPr"]>(),
    async poll<T>(label: string, probe: () => Promise<T | undefined>) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const value = await probe();
        if (value !== undefined) return value;
      }
      throw new Error(`未觀察到：${label}`);
    },
  } satisfies BasicFlowContext;
  return { ctx, messages };
}

const notices = {
  alerts: [
    {
      task_id: taskId,
      kind: "answered",
      text: `查詢完成：${queryTitle}，共 5 張。`,
    },
    {
      task_id: taskId,
      kind: "approval",
      text: `請確認 ${repository} 與 main 分支。`,
    },
    { task_id: taskId, kind: "ready", text: `請檢視後合併：${url}` },
  ],
};

function lineCase() {
  const f = context("query");
  const view = dashboard("answered");
  f.ctx.admin.mockImplementation(async (method, path) => {
    expect(method).toBe("GET");
    if (path === "/api/state") return notices;
    expect(path).toBe("/api/tasks/" + taskId);
    return view;
  });
  return { ...f, view };
}

function discordCase() {
  const f = context("change");
  const pending = dashboard("awaiting_approval"),
    ready = dashboard("ready");
  let approved = false,
    delivered = false;
  f.ctx.admin.mockImplementation(async (method, path, body) => {
    if (method === "POST") {
      expect(path).toBe("/api/tasks/" + taskId + "/actions");
      expect(body).toEqual({
        action: "approve",
        version: 3,
        project_id: projectId,
        target_branch: "main",
        binding_version: 7,
        config_version: 9,
      });
      approved = true;
      return { ...pending.task, approved_version: 3, status: "queued" };
    }
    if (path === "/api/state") return notices;
    expect(path).toBe("/api/tasks/" + taskId);
    return delivered ? dashboard("merged") : approved ? ready : pending;
  });
  f.ctx.webhook.mockImplementation(async (request) => {
    expect(approved).toBe(true);
    expect(request.url).toBe("/webhooks/github");
    expect(JSON.parse(request.payload)).toMatchObject({
      action: "closed",
      repository: { full_name: repository },
      pull_request: { number: 12, merged: true },
    });
    delivered = true;
    f.messages.push(merged);
    return { statusCode: 200 };
  });
  const pr: BasicPullRequest = {
    number: 12,
    head: branch,
    headSha: "a".repeat(40),
    base: "main",
    body: "測試：通過\n獨立審查：通過\nCloses #11",
    files: {
      "tickets.mjs":
        "export function countTickets(batches = []) { return batches.reduce((a,b) => a+b, 0); }",
      "tickets.test.mjs": "assert.equal(countTickets(), 0);",
    },
  };
  f.ctx.readPr.mockResolvedValue(pr);
  return { ...f, pending, ready, pr };
}

it("LINE 自動查詢以判讀證據派工，回傳原群組的實收回答與執行編號", async () => {
  const { ctx } = lineCase();
  expect(await runLineQuery(ctx)).toEqual({
    taskId,
    runId,
    groupMessages: [answer],
  });
  const [request] = ctx.webhook.mock.calls[0];
  expect(JSON.parse(request.payload).events[0]).toMatchObject({
    source: { groupId: line.groupId },
    message: { id: line.messageId, text: line.text },
  });
  expect(ctx.readPr).not.toHaveBeenCalled();
});

it("群組只收到先前的正確答案或本題錯誤票數時，不能通過 LINE 驗收", async () => {
  const { ctx } = lineCase();
  ctx.groupMessages
    .mockReset()
    .mockResolvedValueOnce([answer])
    .mockResolvedValue([answer, answer.replace("5 張", "15 張")]);
  await expect(runLineQuery(ctx)).rejects.toThrow("LINE 群組收到本題票數回答");
});

it("Discord 先核對看板版本才核准，已測試與審查的 PR 合併後原頻道收到通知", async () => {
  const { ctx } = discordCase();
  const result = await runDiscordChange(ctx);
  expect(result).toEqual({
    taskId,
    runId,
    issue: 11,
    pr: 12,
    headSha: "a".repeat(40),
    groupMessages: [published, merged],
  });
  expect(ctx.gateway.mock.calls[0][0].d).toMatchObject({
    channel_id: discord.channelId,
    data: { name: "任務", options: [{ name: "需求", value: discord.text }] },
  });
  expect(ctx.readPr).toHaveBeenCalledExactlyOnceWith(12);
});

it("修改在人工確認前就已核准時，劇本停在核准入口之前", async () => {
  const { ctx, pending } = discordCase();
  pending.task.approved_version = 3;
  await expect(runDiscordChange(ctx)).rejects.toThrow("人工確認前已被核准");
  expect(ctx.admin.mock.calls.some(([method]) => method === "POST")).toBe(
    false,
  );
  expect(ctx.webhook).not.toHaveBeenCalled();
});

it("看板顯示待合併但假 GitHub 找不到對應 PR 時，不投遞合併事件", async () => {
  const { ctx } = discordCase();
  ctx.readPr.mockResolvedValue(null);
  await expect(runDiscordChange(ctx)).rejects.toThrow("找不到看板的 PR #12");
  expect(ctx.webhook).not.toHaveBeenCalled();
});

it("基底測試無法代替修改後測試，缺少修改後驗證即停止合併", async () => {
  const { ctx, ready } = discordCase();
  ready.runs[0].phases = ["test", "code", "review", "publish"].map((phase) => ({
    phase,
  }));
  await expect(runDiscordChange(ctx)).rejects.toThrow(
    "修改執行缺少步驟或順序錯誤：test",
  );
  expect(ctx.webhook).not.toHaveBeenCalled();
});

it("PR 即使含有原函式名稱也必須實際帶有核准的變更", async () => {
  const { ctx, pr } = discordCase();
  ctx.readPr.mockResolvedValue({
    ...pr,
    files: {
      ...pr.files,
      "tickets.mjs": "export function countTickets(batches) { return 99; }",
    },
  });
  await expect(runDiscordChange(ctx)).rejects.toThrow(
    "PR 缺少空批次的預設參數",
  );
  expect(ctx.webhook).not.toHaveBeenCalled();
});

it("收到合併 webhook 前就宣告合併的訊息不能當成驗收證據", async () => {
  const { ctx, messages } = discordCase();
  messages.push(merged);
  await expect(runDiscordChange(ctx)).rejects.toThrow(
    "在合併 webhook 前就已通知合併",
  );
  expect(ctx.webhook).not.toHaveBeenCalled();
});

it("看板已合併仍須等到原頻道實際收到通知", async () => {
  const { ctx } = discordCase();
  ctx.groupMessages.mockResolvedValue([published]);
  await expect(runDiscordChange(ctx)).rejects.toThrow(
    "Discord 原頻道收到本題合併通知",
  );
});
