import { expect, it } from "vitest";
import { noChangeInstruction, noChangeResult } from "../server/change-result.js";
import { classifyFailure } from "../server/failure.js";

const mark = "AGENTFLOW_ALREADY_SATISFIED";
const title = "修正範例按鈕";
const explanation = "範例按鈕已使用綠色，現有測試也覆蓋此條件。";
const notice = "已經符合需求，沒有需要修改的地方。";

it("空變更且 Codex 以最後一行確認時，保留看板說明與通知文字", () => {
  expect(noChangeInstruction).toContain(mark);
  expect(noChangeResult(0, `${explanation}\r\n${mark}\r\n`, title)).toEqual({
    answer: `${notice}\n\n${explanation}`,
    notice: `「${title}」${notice}`,
  });
});

it.each([
  "無法確認範例按鈕的顏色，缺少樣式規格。",
  `無法確認，即使提示提到 ${mark}。`,
  `${mark}\n無法確認範例按鈕的顏色。`,
  mark,
  "",
])("空變更且沒有明確確認與依據時，保留失敗原因（%s）", (summary) => {
  expect(() => noChangeResult(0, summary, title)).toThrow(
    "Codex 未確認需求已符合",
  );
  try {
    noChangeResult(0, summary, title);
  } catch (error) {
    const failure = classifyFailure((error as Error).message);
    expect(failure.category).toBe("project");
    expect(failure.detail).toContain(summary || "未提供說明");
  }
});

it("收集到變更時，照常交給測試、獨立審查與 PR 流程", () => {
  expect(noChangeResult(1, `${explanation}\n${mark}`, title)).toBeNull();
});
