import { describe, expect, it } from "vitest";
import { linePushService } from "../shared/group-delivery.js";
import { quotaExhaustedDetail } from "../shared/line-quota.js";
import {
  workerImageLabels,
  workerImageStatus,
} from "../shared/status-glossary.js";

describe("工作映像狀態", () => {
  it("版本符合時顯示版本，即使沒有專案明確指定這個映像", () => {
    expect(workerImageStatus(true, true)).toBe("current");
    expect(workerImageStatus(true, false)).toBe("current");
    expect(workerImageLabels.current("示範版")).toBe("版本 示範版");
  });

  it("過舊且有專案使用時提醒重新驗證該專案", () => {
    expect(workerImageStatus(false, true)).toBe("outdated");
    expect(workerImageLabels.outdated).toBe("過舊，請重新驗證使用它的專案");
  });

  it("過舊且沒有專案使用時提示可清理", () => {
    expect(workerImageStatus(false, false)).toBe("unused");
    expect(workerImageLabels.unused).toBe("沒有專案使用，可清理");
  });
});

describe("服務連線的 LINE 推播狀態", () => {
  it.each(["Error: LINE 通知失敗（429）", `Error: ${quotaExhaustedDetail}`])(
    "最近一次儲存的是額度錯誤時指向額度列（樣本 %#）",
    (detail) => {
      expect(linePushService({ ok: false, detail }, false)).toEqual({
        quota: true,
        detail: "本月額度用完，見下一列",
      });
    },
  );

  it("額度封鎖時，即使沒有推播紀錄也指向額度列", () => {
    expect(linePushService(undefined, true)).toEqual({
      quota: true,
      detail: "本月額度用完，見下一列",
    });
  });

  it("短時間限流與其他錯誤都顯示原因和處理方式", () => {
    expect(
      linePushService(
        { ok: false, detail: "Error: LINE 推播太頻繁，稍後會再送（429）" },
        false,
      ),
    ).toEqual({
      quota: false,
      detail: "上次推播因短時間內送出太多通知而受限，請稍後再試。",
    });
    expect(
      linePushService(
        { ok: false, detail: "Error: LINE 通知失敗（401）" },
        false,
      ),
    ).toEqual({
      quota: false,
      detail: "上次推播失敗，LINE 未授權推播。請確認 LINE 權杖與權限後再試。",
    });
  });

  it("無法辨認的錯誤只顯示檢查連線的提示", () => {
    expect(
      linePushService(
        { ok: false, detail: "TypeError: unknown example" },
        false,
      ),
    ).toEqual({
      quota: false,
      detail: "上次推播失敗，原因未能確認。請檢查 LINE 連線後再試。",
    });
  });
});
