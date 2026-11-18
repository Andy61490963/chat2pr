import { describe, expect, it } from "vitest";
import {
  isMonthlyLimit,
  linePushPanel,
  quotaExhaustedDetail,
  quotaUsageOf,
  quotaUsageText,
} from "../shared/line-quota.js";

describe("辨識 LINE 每月推播額度用完", () => {
  it("只有 429 且訊息寫明 monthly limit 才算額度用完", () => {
    expect(isMonthlyLimit(429, "You have reached your monthly limit.")).toBe(
      true,
    );
    expect(isMonthlyLimit(429, "Too many requests")).toBe(false);
    expect(isMonthlyLimit(429, undefined)).toBe(false);
    expect(isMonthlyLimit(403, "You have reached your monthly limit.")).toBe(
      false,
    );
  });

  it("用量說明寫進健康項後，看板讀得回本月已用與上限", () => {
    const limited = quotaUsageText({ limit: 200, used: 37 });
    expect(limited).toBe("本月已用 37／上限 200 則");
    expect(quotaUsageOf(limited)).toEqual({ used: 37, limit: 200 });
    expect(
      quotaUsageOf(`${quotaExhaustedDetail}（本月已用 200／上限 200 則）`),
    ).toEqual({ used: 200, limit: 200 });
    expect(quotaUsageOf(quotaUsageText({ limit: null, used: 5 }))).toEqual({
      used: 5,
      limit: null,
    });
    expect(quotaUsageOf(quotaExhaustedDetail)).toBeNull();
  });
});

describe("設定頁的 LINE 推播卡片", () => {
  const failures = { direct: 2, group: 3, stale: 4 };

  it("額度用完時顯示用量與額度說明，停用重送與測試通知", () => {
    const panel = linePushPanel(
      [
        {
          name: "line_quota",
          ok: false,
          detail: `${quotaExhaustedDetail}（本月已用 200／上限 200 則）`,
        },
      ],
      failures,
    );
    expect(panel.blocked).toBe(true);
    expect(panel.usage).toBe("本月已用 200／上限 200");
    expect(panel.notice).toContain(
      "LINE 本月推播額度已用完，額度恢復前重送也會失敗",
    );
    expect(panel.retryDisabled).toBe(true);
    expect(panel.testDisabled).toBe(true);
    expect(panel.failedText).toContain("額度恢復前重送也會失敗");
    expect(panel.failedText).not.toContain("確認 LINE 正常");
  });

  it("額度正常時可重送，確認框寫出私訊、群組與略過的則數", () => {
    const panel = linePushPanel(
      [{ name: "line_quota", ok: true, detail: "本月已用 12／上限 200 則" }],
      failures,
    );
    expect(panel.blocked).toBe(false);
    expect(panel.notice).toBeNull();
    expect(panel.usage).toBe("本月已用 12／上限 200");
    expect(panel.retryDisabled).toBe(false);
    expect(panel.failed).toBe(5);
    expect(panel.failedText).toBe(
      "有 5 則通知重試 3 次仍送不出去（私訊 2 則、群組 3 則）。請先用「服務連線」確認 LINE 正常，再重送。",
    );
    expect(panel.confirm).toBe(
      "會重送私訊 2 則、群組 3 則（群組依人數計入額度）；已過期的 4 則略過。",
    );
  });

  it("還沒查過額度、也沒有失敗通知時不顯示多餘的提示", () => {
    const panel = linePushPanel([], { direct: 0, group: 0, stale: 0 });
    expect(panel).toMatchObject({
      blocked: false,
      usage: null,
      notice: null,
      failedText: null,
      retryDisabled: false,
    });
  });
});
