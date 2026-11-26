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

it.each([
  [10, "failed：看板缺少本次失敗原因", "專案問題（執行測試階段）：還沒修改前，目標分支本身就建置或測試失敗。", 266],
  [12, "queued：預期 queued，任務已成為 failed", "暫時性問題（Codex 修改程式階段）：AI 服務回應中斷或逾時（已自動重試一次，仍然失敗）。", 264],
  [13, "failed：永久錯誤仍被重試", "暫時性問題（Codex 修改程式階段）：AI 服務回應中斷或逾時（已自動重試一次，仍然失敗）。", 264],
] as const)("情境 %i 只辨識實跑確認的診斷，有額外異常仍須阻擋", (number, state, cause, issue) => {
  const receipt = `步驟：任務 00000000-0000-4000-8000-000000000001 進入 ${state}\n最近稽核：error ${cause}\n錯誤重點：虛構案例`;
  expect(classifyFlowFailure(number, receipt)).toBe(issue);
  expect(classifyFlowFailure(number, receipt.replace(cause, "其他原因"))).toBeUndefined();
  expect(classifyFlowFailure(number, `${receipt}\n有 1 則過期通知仍可補送`)).toBeUndefined();
});
