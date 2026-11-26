import { describe, expect, it } from "vitest";
import { installModelSteps } from "../scripts/acceptance/flows/script-control.js";

describe("逐階段設定驗收模型", () => {
  it("回覆後才投遞下一步，確保工作程序不會先讀到舊劇本", async () => {
    let acknowledged = false;
    await installModelSteps([{ kind: "text", text: "繼續" }], async steps => {
      expect(steps).toEqual([{ kind: "text", text: "繼續" }]);
      await Promise.resolve(); acknowledged = true; return { event: "script-ready" };
    });
    expect(acknowledged).toBe(true);
  });
  it("主控未確認設定時不投遞新事件", async () => {
    await expect(installModelSteps([], async () => ({ event: "other" }))).rejects.toThrow("未確認");
  });
});
