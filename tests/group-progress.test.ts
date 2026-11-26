import { describe, expect, it } from "vitest";
import { isProgressCommand, isTaskCommand } from "../shared/chat.js";
import {
  answerPostback,
  answerPostbackData,
  questionButtons,
} from "../server/answers.js";
import type { Task } from "../shared/types.js";
import {
  ackFor,
  aiQuotaAck,
  commandAck,
  followupAck,
  noProjectAck,
  pausedAck,
  progressMoreNote,
  progressSummary,
  replyRejected,
  triageStoppedAck,
} from "../server/group-replies.js";

describe("/進度 補送失敗是不是內容被拒收", () => {
  it("LINE 明確拒收的 4xx 才算，計入 reply_failures", () => {
    for (const status of [400, 404, 413, 422])
      expect(replyRejected(status, "The request body has 1 error(s)")).toBe(
        true,
      );
    expect(replyRejected(400, undefined)).toBe(true);
  });
  it("限流、權杖、reply token 失效、5xx、逾時與沒有權杖都不算", () => {
    expect(replyRejected(429, "Too many requests")).toBe(false);
    expect(replyRejected(401, "Authentication failed")).toBe(false);
    expect(replyRejected(403, "Not authorized")).toBe(false);
    expect(replyRejected(400, "Invalid reply token")).toBe(false);
    for (const status of [500, 502, 503])
      expect(replyRejected(status)).toBe(false);
    // 逾時、連不上或沒有權杖時 reply 回傳 status=null。
    expect(replyRejected(null)).toBe(false);
  });
});

describe("「/進度」指令的辨識", () => {
  it("必須在開頭，後接空白、換行、冒號或直接結束", () => {
    for (const text of [
      "/進度",
      "/進度 ",
      "/進度\n",
      "/進度：",
      "/進度:看一下",
    ])
      expect(isProgressCommand(text)).toBe(true);
    for (const text of [
      "/進度表",
      "有人說 /進度",
      " /進度",
      "進度",
      "/任務 進度",
      undefined,
      null,
    ])
      expect(isProgressCommand(text)).toBe(false);
  });
  it("不會被當成 /任務，/任務 也不會被當成 /進度", () => {
    expect(isTaskCommand("/進度")).toBe(false);
    expect(isTaskCommand("/進度 /任務")).toBe(false);
    expect(isProgressCommand("/任務 /進度")).toBe(false);
  });
});

describe("「收到」依狀態選文字", () => {
  const normal = {
    base: commandAck,
    paused: false,
    triageStopped: false,
    noProject: false,
    aiQuotaOut: false,
  };
  it("正常狀態維持原本的 commandAck／followupAck", () => {
    expect(ackFor(normal)).toBe(commandAck);
    expect(ackFor({ ...normal, base: followupAck })).toBe(followupAck);
  });
  it("優先序：暫停 → 判讀停止 → 沒有可用專案 → AI 額度", () => {
    const all = {
      ...normal,
      paused: true,
      triageStopped: true,
      noProject: true,
      aiQuotaOut: true,
    };
    expect(ackFor(all)).toBe(pausedAck);
    expect(ackFor({ ...all, paused: false })).toBe(triageStoppedAck);
    expect(ackFor({ ...normal, noProject: true, aiQuotaOut: true })).toBe(
      noProjectAck,
    );
    expect(ackFor({ ...normal, aiQuotaOut: true })).toBe(aiQuotaAck);
    expect(ackFor({ ...normal, triageStopped: true, base: followupAck })).toBe(
      triageStoppedAck,
    );
    expect(triageStoppedAck).toBe(
      "收到，但這個群組的需求判讀目前因連續錯誤暫停，訊息已保留；管理者排除問題後會接著整理，不用重新提出。",
    );
    // 暫停、判讀停止或額度用完時不再承諾「處理完會在這裡回報」。
    for (const text of [
      pausedAck,
      triageStoppedAck,
      noProjectAck,
      aiQuotaAck,
    ]) {
      expect(text).not.toContain("處理完會在這裡回報");
      expect(text).toContain("不用重新提出");
    }
  });
});

describe("補問的常見答案按鈕（純函式）", () => {
  const task = (choices: string[]) =>
    ({
      id: "00000000-0000-4000-8000-000000000001",
      version: 3,
      question: { text: "要匯出哪一種格式？", choices },
    }) as unknown as Task;
  it("標籤截到 20 字、顯示文字保留完整選項、data 綁定任務與版本", () => {
    const long = "一二三四五六七八九十".repeat(3);
    expect(questionButtons(task(["CSV", long]))).toEqual([
      {
        label: "CSV",
        data: "answer:00000000-0000-4000-8000-000000000001:3:0",
        displayText: "CSV",
      },
      {
        label: long.slice(0, 20),
        data: "answer:00000000-0000-4000-8000-000000000001:3:1",
        displayText: long,
      },
    ]);
  });
  it("沒有常見答案、空白或含憑證格式的選項不給按鈕，索引仍對應原本位置", () => {
    expect(questionButtons(task([]))).toEqual([]);
    expect(
      questionButtons(
        task(["  ", "ghp_abcdefghijklmnopqrstuvwxyz123456", "Excel"]),
      ).map((b) => b.data),
    ).toEqual(["answer:00000000-0000-4000-8000-000000000001:3:2"]);
  });
  it("ingest 的比對規則認得 askInGroup 產生的 data，其他格式一律不認", () => {
    const data = answerPostbackData(task([]), 2);
    expect(answerPostback.exec(data)?.slice(1)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "3",
      "2",
    ]);
    for (const bad of [
      "adopt:00000000-0000-4000-8000-000000000001:3:0",
      "answer:------------------------------------:3:0",
      "answer:00000000-0000-4000-8000-000000000001:3:10",
      "answer:00000000-0000-4000-8000-000000000001:x:0",
    ])
      expect(answerPostback.test(bad)).toBe(false);
  });
});

describe("/進度 的需求摘要", () => {
  it("列出標題與白話狀態，標出等群組回答的問題", () => {
    const text = progressSummary(
      [
        { title: "調整按鈕顏色", status: "awaiting_approval", asking: false },
        { title: "匯出問題", status: "awaiting_approval", asking: true },
        { title: "查訂單欄位", status: "answered", asking: false },
      ],
      3,
      2,
    );
    expect(text).toContain("- 調整按鈕顏色：等管理者確認");
    expect(text).toContain("- 匯出問題：等你們回答一個問題");
    expect(text).toContain("- 查訂單欄位：已回答");
    expect(text).toContain("下面是先前沒送到的回覆。");
    expect(text).not.toContain("另外還有");
  });
  it("列不完時寫出剩幾件；沒有待取回的就明說", () => {
    const text = progressSummary(
      [{ title: "調整按鈕顏色", status: "queued", asking: false }],
      4,
      0,
    );
    expect(text).toContain("…另外還有 3 件");
    expect(text).toContain("目前沒有待取回的結果。");
    expect(progressSummary([], 0, 0)).toBe(
      "這個群組最近 7 天沒有需求。\n\n目前沒有待取回的結果。",
    );
    expect(progressMoreNote(3)).toBe("還有 3 則，再輸入 /進度。");
  });
});
