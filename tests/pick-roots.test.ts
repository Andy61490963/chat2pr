import { describe, expect, it } from "vitest";
import { pickRoots } from "../server/pick-lists.js";
import type { Message, TriageDecision } from "../shared/types.js";

const messages = [
  { id: "meeting", type: "text" },
  { id: "reply-a", type: "text", quoted_id: "meeting" },
  { id: "reply-b", type: "text", quoted_id: "meeting" },
  { id: "other", type: "text" },
  { id: "history", type: "text", contextOnly: true },
] as Message[];

const change = (i: number, ...sourceIds: string[]): TriageDecision => ({
  kind: "request",
  title: `調整範例欄位 ${i}`,
  summary: `更新範例欄位 ${i}。`,
  sourceIds,
  projectId: null,
  acceptance: [],
  risks: [],
  missing: [],
  relatedTaskId: null,
  suggestions: [],
});

describe("從同一則根訊息收成待挑選清單", () => {
  it("六項修改共用一個根訊息", () => {
    const items = Array.from({ length: 6 }, (_, i) => change(i, "meeting"));
    const result = pickRoots("auto", messages, items);
    expect([...result.keys()]).toEqual(items);
    expect(new Set(result.values())).toEqual(new Set(["meeting"]));
  });

  it("同一段回覆可以共用根訊息，獨立的需求仍照原流程", () => {
    const list = [
      change(1, "meeting"),
      change(2, "reply-a"),
      change(3, "reply-b"),
    ];
    const result = pickRoots("auto", messages, [...list, change(4, "other")]);
    expect([...result.keys()]).toEqual(list);
    expect(new Set(result.values())).toEqual(new Set(["meeting"]));
  });

  it.each([1, 2])("只有 %i 項修改時照舊", (count) => {
    const items = Array.from({ length: count }, (_, i) => change(i, "meeting"));
    expect(pickRoots("auto", messages, items).size).toBe(0);
  });

  it("查詢、補充、重複結果、歷史來源與指令模式都不補足門檻", () => {
    const first = change(1, "meeting");
    const second = change(2, "meeting");
    expect(
      pickRoots("auto", messages, [
        first,
        second,
        { ...first },
        { ...change(3, "meeting"), taskType: "query" },
        { ...change(4, "meeting"), relatedListItemId: "existing-item" },
        { ...change(5, "meeting"), relatedTaskId: "existing-task" },
        ...[1, 2, 3].map((i) => change(i, "history")),
      ]).size,
    ).toBe(0);
    expect(
      pickRoots("command", messages, [first, second, change(3, "meeting")])
        .size,
    ).toBe(0);
  });
});
