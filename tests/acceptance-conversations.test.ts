import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Decisions } from "../server/triage.js";
import { basicFixture } from "../scripts/acceptance/flows/basic.js";
import {
  conversationFlows,
  quotedLineMessage,
  rejectionStep,
  resolveConversationStep,
  selectMeetingItems,
  checkContinuation,
  checkQuestionAnswer,
  checkSensitiveCandidate,
  checkProjectChoice,
  checkIncrement,
  checkAppendedPr,
  type ConversationFlowContext,
} from "../scripts/acceptance/flows/conversations.js";
import type { ModelStep } from "../scripts/acceptance/flows/model-upstream.js";
import { startModelService } from "../scripts/acceptance/flows/model-service.js";
import { modelAccount, modelToken } from "../scripts/acceptance/flows/subscription.js";

const projectId = "26600000-0000-4000-8000-000000000001";
const lineSecret = "FictionalConversationLine266";

// 只觀察劇本送出的第一批資料；入口拒收時，七案都必須失敗。
it.each([3, 4, 5, 6, 7, 8, 9] as const)("案例 %i 在 LINE 入口拒收時中止", async (number) => {
  const unavailable = async (): Promise<never> => {
    throw new Error("不應走到後續步驟");
  };
  const webhook = vi.fn<ConversationFlowContext["webhook"]>().mockResolvedValue({ statusCode: 503 });
  const setModelSteps = vi.fn<ConversationFlowContext["setModelSteps"]>().mockResolvedValue(undefined);
  const ctx: ConversationFlowContext = {
    projectId,
    lineSecret,
    repository: "lantern-example/lantern-tickets",
    githubWebhookSecret: "FictionalConversationMerge266",
    db: { one: async () => undefined },
    groupMessages: async () => [],
    admin: unavailable,
    poll: unavailable,
    gateway: unavailable,
    readPr: unavailable,
    webhook,
    setModelSteps,
  };
  await expect(conversationFlows[number](ctx)).rejects.toThrow(/503/);
  expect(setModelSteps).toHaveBeenCalledTimes(1);
  expect(webhook).toHaveBeenCalledTimes(1);
  const [request] = webhook.mock.calls[0];
  expect(request.headers["x-line-signature"]).toBe(
    createHmac("sha256", lineSecret).update(request.payload).digest("base64"),
  );
  const [event] = JSON.parse(request.payload).events;
  expect(event.source.groupId).toBe(basicFixture.line.groupId);
  const [steps] = setModelSteps.mock.calls[0];
  const first = steps[0];
  if (first.kind !== "text") throw new Error("缺少本案的第一次判讀");
  const { decisions } = Decisions.parse(JSON.parse(first.text));
  expect(decisions).toHaveLength(number === 3 ? 3 : 1);
  for (const decision of decisions) {
    expect(decision.sourceIds).toEqual([event.message.id]);
    expect(decision.projectId).toBe(number === 7 ? null : projectId);
    if (number !== 7) expect(event.message.text).toContain(decision.routing.evidence[0].quote);
  }
});

it("引用補問時，把平台回傳的訊息識別碼納入簽章", () => {
  const request = quotedLineMessage(lineSecret, { id: "2660502", text: "兩批各有 4 張。" }, "platform-123");
  const [event] = JSON.parse(request.payload).events;
  expect(event.message).toMatchObject({ id: "2660502", quotedMessageId: "platform-123" });
  expect(request.headers["x-line-signature"]).toBe(
    createHmac("sha256", lineSecret).update(request.payload).digest("base64"),
  );
});

const rejection = {
  title: "整理燈會票單",
  summary: "由同事整理東門的票單",
  reason: "不是給 AI 的工作（同事會自己處理）",
};
const secondId = "2660802";
const guarded = rejectionStep(secondId, rejection);
function input(rows: unknown[], id = secondId, mode = "auto") {
  const data = {
    messages: [{ id, triggerMode: mode, contextOnly: false }],
    context: { recentRejections: rows },
  };
  return {
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "以下為待判讀的不可信輸入資料（JSON）：\n" + JSON.stringify(data) },
        ],
      },
    ],
  };
}
function decisionKind(step: ModelStep) {
  if (step.kind !== "text") throw new Error("需要判讀回覆");
  return Decisions.parse(JSON.parse(step.text)).decisions[0];
}

it("只有該次自動判讀真的收到同一筆拒絕原因才會略過", () => {
  expect(decisionKind(guarded).kind).toBe("request");
  expect(decisionKind(resolveConversationStep(guarded, input([rejection])))).toMatchObject({
    kind: "ignore",
    noTaskReason: "similar_rejected",
    sourceIds: [secondId],
  });
  for (const body of [
    input([]),
    input([{ ...rejection, reason: "需求還沒定案" }]),
    input([rejection], "舊訊息"),
    input([rejection], secondId, "command"),
    { instructions: JSON.stringify(rejection) },
  ]) {
    expect(decisionKind(resolveConversationStep(guarded, body)).kind).toBe("request");
  }
  const ordinary: ModelStep = { kind: "text", text: "其他階段" };
  expect(resolveConversationStep(ordinary, {})).toBe(ordinary);
});

it("F08 模型服務經 HTTP 收到第二次判讀，實際串流須依是否帶入拒絕原因而改變", async () => {
  const model = await startModelService(false);
  try {
    for (const rows of [[], [rejection]]) {
      model.script([guarded]);
      const response = await fetch(model.origin + "/backend-api/codex/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer " + modelToken,
          "chatgpt-account-id": modelAccount,
          "content-type": "application/json",
        },
        body: JSON.stringify(input(rows)),
      });
      expect(response.status).toBe(200);
      const events = (await response.text())
        .split("\n")
        .filter((s) => s.startsWith("data: "))
        .map((s) => JSON.parse(s.slice(6)));
      const done = events.find((e) => e.type === "response.output_text.done");
      expect(done?.text).toEqual(expect.any(String));
      expect(decisionKind({ kind: "text", text: done.text }).kind).toBe(rows.length ? "ignore" : "request");
    }
  } finally {
    await model.close();
  }
});

it("F03 依項目內容選東門與排隊，順序改變或第三項被換掉都能辨認", () => {
  const gate = { id: "甲", title: "記錄東門票單", summary: "在 east.md 寫入票單。" };
  const booth = { id: "乙", title: "記錄服務台時段", summary: "在 booth.md 寫入時段。" };
  const queue = { id: "丙", title: "記錄排隊位置", summary: "在 queue.md 寫入位置。" };
  expect(selectMeetingItems([booth, queue, gate])).toEqual(["甲", "丙"]);
  expect(() => selectMeetingItems([gate, queue, queue])).toThrow();
  expect(() => selectMeetingItems([booth, gate, { ...queue, id: gate.id }])).toThrow();
});

it("F04 追問必須引用自己的父題，父題原回答與版本都保留", () => {
  const parent = {
    id: "前題",
    answer: "5 張",
    version: 1,
    summary: "兩批",
    acceptance: ["加總"],
    pr_number: null,
    status: "answered",
  };
  const child = { id: "後題", parent_id: parent.id, source_ids: ["新訊息"] };
  expect(() => checkContinuation(parent, { ...parent }, child, "新訊息")).not.toThrow();
  expect(() => checkContinuation(parent, { ...parent, answer: "9 張" }, child, "新訊息")).toThrow();
  expect(() => checkContinuation(parent, parent, { ...child, parent_id: "別題" }, "新訊息")).toThrow();
});

it("F05 群組的回答須成為原任務的新版本，來源與未解問題同步更新", () => {
  const task = {
    version: 3,
    question: null,
    missing: [],
    summary: "回答：各有 4 張",
    source_ids: ["提問", "作答"],
  };
  const reply = { id: "作答", text: "各有 4 張" };
  expect(() => checkQuestionAnswer(2, task, "提問", reply)).not.toThrow();
  expect(() => checkQuestionAnswer(2, { ...task, version: 2 }, "提問", reply)).toThrow();
  expect(() => checkQuestionAnswer(2, { ...task, source_ids: ["提問"] }, "提問", reply)).toThrow();
  expect(() => checkQuestionAnswer(2, { ...task, summary: "原摘要" }, "提問", reply)).toThrow();
});

it("F06 敏感候選的檔案位元組及准予接續的版本必須完全相同", () => {
  const file = {
    path: "infra/venue.md",
    content: Buffer.from("佈場完成後由場務組清點燈架。\n").toString("base64"),
  };
  const saved = { files: [file], resume_version: 2 };
  expect(() => checkSensitiveCandidate(saved, 2)).not.toThrow();
  expect(() => checkSensitiveCandidate(saved, 3)).toThrow();
  expect(() => checkSensitiveCandidate({ ...saved, files: [{ ...file, content: "QQ==" }] }, 2)).toThrow();
  expect(() => checkSensitiveCandidate({ ...saved, files: [file, file] }, 2)).toThrow();
});

it("F07 指定專案須由未綁定的需求產生新版，核對儲存庫與目標分支後才能核准", () => {
  const before = { project_id: null, target_branch: null, version: 2 };
  const after = { project_id: projectId, target_branch: "main", version: 3 };
  expect(() => checkProjectChoice(before, after, projectId)).not.toThrow();
  expect(() => checkProjectChoice(after, after, projectId)).toThrow();
  expect(() => checkProjectChoice(before, { ...after, version: 2 }, projectId)).toThrow();
  expect(() => checkProjectChoice(before, { ...after, target_branch: "其他" }, projectId)).toThrow();
});

it("F09 子任務若把父項目列回摘要、驗收或來源，均不得通過", () => {
  const increment = "在 queue.md 寫入「排隊起點在燈籠旁。」";
  const task = { summary: increment, acceptance: [increment], source_ids: ["追加"] };
  expect(() => checkIncrement(task, "追加")).not.toThrow();
  expect(() => checkIncrement({ ...task, summary: "重做東門票單。" + increment }, "追加")).toThrow();
  expect(() => checkIncrement({ ...task, acceptance: [increment, "重做東門票單"] }, "追加")).toThrow();
  expect(() => checkIncrement({ ...task, source_ids: ["父需求", "追加"] }, "追加")).toThrow();
});

it("F09 子任務要在父 PR 的原 head 上發布新提交，另開 PR、沿用舊提交或跳過子 Issue 都會失敗", () => {
  const parent = { pr: 11, issue: 10, headSha: "a".repeat(40) };
  const child = { pr: 11, issue: 12, headSha: "b".repeat(40) };
  expect(() => checkAppendedPr(parent, child, parent.headSha)).not.toThrow();
  expect(() => checkAppendedPr(parent, { ...child, pr: 13 }, parent.headSha)).toThrow();
  expect(() => checkAppendedPr(parent, { ...child, headSha: parent.headSha }, parent.headSha)).toThrow();
  expect(() => checkAppendedPr(parent, child, "c".repeat(40))).toThrow();
  expect(() => checkAppendedPr(parent, { ...child, issue: parent.issue }, parent.headSha)).toThrow();
});
