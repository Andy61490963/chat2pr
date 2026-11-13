import { describe, it, expect } from "vitest";
import {
  verifySignature,
  batchDue,
  taipeiDay,
  classifyRisk,
  assertTransition,
} from "../server/policy.js";
import { createHmac } from "node:crypto";

describe("事件與派工規則", () => {
  it("簽章以原始位元組驗證，拒絕內容變動與缺少簽章", () => {
    const raw = Buffer.from('{"events":[]}');
    const signature = createHmac("sha256", "test-secret")
      .update(raw)
      .digest("base64");
    expect(verifySignature(raw, signature, "test-secret", "base64")).toBe(true);
    expect(
      verifySignature(Buffer.from("{}"), signature, "test-secret", "base64"),
    ).toBe(false);
    expect(verifySignature(raw, "", "test-secret", "base64")).toBe(false);
  });
  it("安靜一分鐘或連續聊天五分鐘時才彙整", () => {
    expect(batchDue(0, 25000, 84000)).toBe(false);
    expect(batchDue(0, 25000, 85000)).toBe(true);
    expect(batchDue(0, 299000, 300000)).toBe(true);
  });
  it("預算日期使用臺北午夜", () => {
    expect(taipeiDay(new Date("2026-11-04T15:59:59Z"))).toBe("2026-11-04");
    expect(taipeiDay(new Date("2026-11-04T16:00:00Z"))).toBe("2026-11-05");
  });
  it("敏感需求不能因 AI 宣稱低風險而自動派工", () => {
    expect(classifyRisk("移除登入權限驗證", [], [])).toContain("敏感");
    expect(
      classifyRisk("修正按鈕顏色", [], [".github/workflows/deploy.yml"]),
    ).toContain("敏感");
    expect(classifyRisk("修正按鈕顏色", [], ["src/button.css"])).toBeNull();
  });
  it("不允許完成的任務再次核准", () => {
    expect(() => assertTransition("ready", "approve")).toThrow();
    expect(() =>
      assertTransition("awaiting_approval", "approve"),
    ).not.toThrow();
  });
});
