import { describe, expect, it } from "vitest";
import { commonFailure } from "../server/stuck-failures.js";

describe("連續失敗只顯示三次紀錄都能證實的原因", () => {
  it("不同上游狀態碼只顯示共同類別，不把其中一次的狀態碼套給整組", () => {
    expect(commonFailure([
      { detail: "upstream_http（HTTP 502）", category: null },
      { detail: "upstream_http（HTTP 503）", category: null },
      { detail: "upstream_http", category: null },
    ])?.reason).toBe("訂閱上游回應失敗");
  });

  it("非訂閱失敗沿用結束稽核的分類，不轉述錯誤輸出", () => {
    const evidence = { detail: null, category: "環境問題" };
    expect(commonFailure([evidence, evidence, evidence])?.reason).toBe("環境問題");
    expect(commonFailure([evidence, evidence, { detail: null, category: "專案問題" }])).toBeNull();
    expect(commonFailure([evidence, evidence, { detail: null, category: "不在分類中的文字" }])).toBeNull();
  });

  it("三次都有任意標準錯誤輸出時仍採用相同的可信稽核分類，不從輸出猜測類別", () => {
    const records = [
      { detail: "環境問題：示範依賴未啟動", category: "專案問題" },
      { detail: "upstream_http（HTTP 502）：示範工具輸出", category: "專案問題" },
      { detail: "unknown_kind", category: "專案問題" },
    ];
    expect(commonFailure(records)).toEqual({ key: "專案問題", reason: "專案問題" });
    expect(commonFailure(records.map((row) => ({ ...row, category: null })))).toBeNull();
    expect(commonFailure([records[0], records[1], { ...records[2], category: "環境問題" }])).toBeNull();
  });

  it("即使稽核大類相同也不能把不同訂閱類別算成同一種，不能從任意錯誤文字推測", () => {
    const evidence = { detail: "connection", category: "暫時性問題" };
    expect(commonFailure([evidence, evidence, { ...evidence, detail: "stream_error" }])).toBeNull();
    expect(commonFailure([evidence, evidence, { ...evidence, detail: "轉送 HTTP 502" }])).toBeNull();
    expect(commonFailure([evidence, evidence])).toBeNull();
  });
});
