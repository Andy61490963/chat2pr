import { expect, it } from "vitest";
import { classifyFlowFailure } from "../scripts/acceptance/flows/known-failures.js";

const signatures = [{ number: 2, step: "步驟：等待合併：逾時", cause: "最近稽核：合併事件未投遞", issue: 266 }];
const detail = "步驟：等待合併：逾時\n最近稽核：合併事件未投遞";

it("只有同一情境、步驟與原因符合才辨識為已知失敗", () => {
  expect(classifyFlowFailure(2, detail, signatures)).toBe(266);
  expect(classifyFlowFailure(1, detail, signatures)).toBeUndefined();
  expect(classifyFlowFailure(2, detail.replace("等待合併", "等待建單"), signatures)).toBeUndefined();
  expect(classifyFlowFailure(2, detail.replace("未投遞", "已投遞"), signatures)).toBeUndefined();
});

it("已知缺陷同時出現另一個不變式失敗時仍屬新故障", () => {
  expect(classifyFlowFailure(2, `${detail}\n輸出含虛構憑證`, signatures)).toBeUndefined();
});
