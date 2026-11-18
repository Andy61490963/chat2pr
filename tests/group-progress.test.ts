import { describe, expect, it } from "vitest";
import { isProgressCommand, isTaskCommand } from "../shared/chat.js";
import {
  ackFor,
  aiQuotaAck,
  commandAck,
  followupAck,
  noProjectAck,
  pausedAck,
  progressMoreNote,
  progressSummary,
} from "../server/group-replies.js";

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
    noProject: false,
    aiQuotaOut: false,
    undelivered: 0,
  };
  it("正常狀態維持原本的 commandAck／followupAck", () => {
    expect(ackFor(normal)).toBe(commandAck);
    expect(ackFor({ ...normal, base: followupAck })).toBe(followupAck);
  });
  it("優先序：暫停 → 沒有可用專案 → AI 額度", () => {
    expect(
      ackFor({ ...normal, paused: true, noProject: true, aiQuotaOut: true }),
    ).toBe(pausedAck);
    expect(ackFor({ ...normal, noProject: true, aiQuotaOut: true })).toBe(
      noProjectAck,
    );
    expect(ackFor({ ...normal, aiQuotaOut: true })).toBe(aiQuotaAck);
    // 暫停或額度用完時不再承諾「處理完會在這裡回報」。
    for (const text of [pausedAck, noProjectAck, aiQuotaAck]) {
      expect(text).not.toContain("處理完會在這裡回報");
      expect(text).toContain("不用重新提出");
    }
  });
  it("有沒送達的回覆時只加一句提示，不附完整內容", () => {
    expect(ackFor({ ...normal, undelivered: 2 })).toBe(
      `${commandAck}\n有 2 則先前沒送達的回覆，打 /進度 取回。`,
    );
    expect(ackFor({ ...normal, paused: true, undelivered: 1 })).toBe(
      `${pausedAck}\n有 1 則先前沒送達的回覆，打 /進度 取回。`,
    );
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
    expect(text).toContain("・調整按鈕顏色：等管理者確認");
    expect(text).toContain("・匯出問題：等你們回答一個問題");
    expect(text).toContain("・查訂單欄位：已回答");
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
