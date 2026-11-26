import { expect, it } from "vitest";
import { checkFlowEvidence, formatFlowFailure } from "../scripts/acceptance/flows/evidence.js";

const clean = { stranded: 0, stale: 0, leaks: 0, resources: [] as string[], states: ["answered"], audit: ["已回答"], events: ["驗證完成"], messages: ["共五張票"] };
const canary = "ExampleKey266";

it("四個結案條件任一不符都阻擋通過", () => {
  expect(checkFlowEvidence(clean, [canary])).toEqual([]);
  for (const change of [{ stranded: 1 }, { stale: 1 }, { resources: ["工作卷"] }, { leaks: 1 }, { messages: [`回答${canary}`] }]) {
    expect(checkFlowEvidence({ ...clean, ...change }, [canary])).toHaveLength(1);
  }
});

it("失敗摘要指出步驟並保留四種線索，不會因截短而露出虛構金鑰前綴", () => {
  const message = "群組已收到" + "票".repeat(65) + canary;
  const detail = formatFlowFailure("等待合併通知", { ...clean, messages: [message], events: [canary] }, [canary]);
  for (const expected of ["等待合併通知", "answered", "已回答", "群組已收到", "[已遮蔽]"]) expect(detail).toContain(expected);
  expect(detail).not.toContain("ExampleKey");
});
