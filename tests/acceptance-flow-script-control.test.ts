import { describe, expect, it } from "vitest";
import { installModelSteps, expiredCase } from "../scripts/acceptance/flows/script-control.js";

it("整案超時先取得案例診斷，再停止本次程序；程序無回應仍保留最後步驟", async () => {
  for (const detail of ["步驟：等待發布\n任務：queued", null]) {
    const order: string[] = [];
    const result = await expiredCase("等待發布", async () => {
      order.push("查詢"); return detail ?? new Promise<string>(() => {});
    }, () => { order.push("停止"); }, 20);
    expect(result).toContain("步驟：等待發布");
    expect(result).toContain(detail ? "任務：queued" : "未能取得診斷");
    expect(order).toEqual(["查詢", "停止"]);
  }
});

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
