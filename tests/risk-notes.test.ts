import { expect, it } from "vitest";
import { classifyRisk } from "../server/policy.js";
import { riskNotes } from "../shared/risk-notes.js";

it("以分號與句號拆分風險提醒，保留原順序並移除空白及完全相同的句子", () => {
  expect(
    riskNotes([
      " 共用設備帳密需要人工審核。；設備主檔寫入需要人工審核； ",
      "共用設備帳密需要人工審核",
      "設備主檔讀取需要人工審核。",
      "檢查 config.json 的 1.2 版. 確認存取權限;",
    ]),
  ).toEqual([
    "共用設備帳密需要人工審核",
    "設備主檔寫入需要人工審核",
    "設備主檔讀取需要人工審核",
    "檢查 config.json 的 1.2 版",
    "確認存取權限",
  ]);
});

it("新產生的風險原因沒有相鄰標點，只有標點的內容仍須審核", () => {
  expect(
    classifyRisk("調整範例報表", ["共用設備帳密。", "設備主檔寫入。"]),
  ).toBe("共用設備帳密；設備主檔寫入");
  expect(classifyRisk("調整範例報表", ["。；"])).toBe(
    "涉及敏感功能，必須人工審核",
  );
});
