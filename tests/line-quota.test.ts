import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLineQuota, groupMemberCount } from "../server/line-quota.js";
import type { Database } from "../server/db.js";
import {
  isMonthlyLimit,
  linePushPanel,
  pushCost,
  quotaExhaustedDetail,
  quotaRemaining,
  quotaShortForGroup,
  quotaUsageOf,
  quotaUsageText,
} from "../shared/line-quota.js";

describe("LINE 查詢錯誤只留下安全訊息", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("額度 API 連線例外不帶外部診斷內容，HTTP 錯誤仍保留狀態碼", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("外部診斷用的虛構標記"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchLineQuota("虛構權杖")).rejects.toThrow(
      /^無法連線至 LINE$/,
    );
    fetch.mockResolvedValue(
      Response.json({ message: "外部診斷用的虛構標記" }, { status: 403 }),
    );
    await expect(fetchLineQuota("虛構權杖")).rejects.toThrow(
      /^讀不到本月推播用量（403）$/,
    );
  });
  it("人數 API 連線失敗維持既有快取，也不儲存外部錯誤", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("外部診斷用的虛構標記")),
    );
    const query = vi.fn();
    const db = {
      one: async () => ({ member_count: 7, fresh: false }),
      query,
    } as unknown as Database;
    expect(await groupMemberCount(db, "group-demo", "虛構權杖")).toBe(7);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toEqual(["group-demo"]);
  });
});

describe("剩餘額度對群組人數", () => {
  it("剩餘則數由說明裡的用量算出；沒查過是未知，沒有上限是無限", () => {
    expect(quotaRemaining(quotaUsageOf("本月已用 195／上限 200 則"))).toBe(5);
    expect(quotaRemaining({ limit: 200, used: 230 })).toBe(0);
    expect(
      quotaRemaining(
        quotaUsageOf(`${quotaExhaustedDetail}（本月已用 200／上限 200 則）`),
      ),
    ).toBe(0);
    expect(quotaRemaining(quotaUsageOf(quotaExhaustedDetail))).toBeNull();
    expect(quotaRemaining({ limit: null, used: 5 })).toBe(Infinity);
  });
  it("群組推播依人數計費，人數未知時當 1 則；私訊 1 則", () => {
    expect(pushCost(8)).toBe(8);
    expect(pushCost(null)).toBe(1);
    expect(pushCost(undefined)).toBe(1);
    expect(pushCost(0)).toBe(1);
    // 剩 5 則、群組 8 人：不夠；私訊只要 1 則。
    expect(5 >= pushCost(8)).toBe(false);
    expect(5 >= pushCost()).toBe(true);
  });
  it("略過群組時說明剩幾則、群組幾人", () => {
    expect(quotaShortForGroup(5, 8)).toBe(
      "推播額度剩 5 則，不足這個群組 8 人，額度恢復後再送",
    );
    expect(quotaShortForGroup(3, null)).toBe(
      "推播額度剩 3 則，不足這個群組的人數，額度恢復後再送",
    );
  });
});

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

  describe("預估推播額度用完日", () => {
    afterEach(() => vi.useRealTimers());

    function panel(detail: string, checked_at = "2028-02-09T16:00:00Z", ok = true) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2028-02-11T12:00:00+08:00"));
      const sample = { name: "line_quota", ok, detail, checked_at };
      return linePushPanel([sample], failures);
    }

    it("依最近查核日和本月日均用量估算，閏年的月底也能顯示", () => {
      expect(panel("本月已用 100／上限 200 則")).toMatchObject({
        usage: "本月已用 100／上限 200",
        forecast: "按本月平均每日用量，預估 2 月 20 日用完。",
      });
      expect(panel("本月已用 70／上限 200 則")).toMatchObject({
        forecast: "按本月平均每日用量，預估 2 月 29 日用完。",
      });
      expect(panel("本月已用 60／上限 200 則")).toMatchObject({
        forecast: "按本月平均每日用量，預估本月不會用完。",
      });
    });

    it("用量不足以估算時保留用量說明，不列出推測日期", () => {
      for (const sample of [
        panel("本月已用 0／上限 200 則"),
        panel("本月已用 100 則，方案沒有推播上限"),
        panel("尚未查到用量"),
        panel("無法連線至 LINE（上次查到本月已用 100／上限 200 則）"),
        panel("本月已用 100／上限 200 則", "無效日期"),
        panel("本月已用 200／上限 200 則", undefined, false),
      ]) {
        expect(sample).toMatchObject({ forecast: null });
      }
    });

    it("跨月後尚未取得新用量時不沿用上月的數字或日期", () => {
      expect(panel("本月已用 100／上限 200 則", "2028-01-31T15:59:00Z")).toMatchObject({
        usage: "尚未取得本月推播用量",
        forecast: null,
      });
    });
  });

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

  it("還沒查過額度時照常私訊，由 LINE 回應判斷是否已達上限", () => {
    const panel = linePushPanel([], { direct: 0, group: 0, stale: 0 });
    expect(panel).toMatchObject({
      blocked: false,
      usage: null,
      notice: null,
      failedText: null,
      retryDisabled: false,
      testDisabled: false,
    });
  });
  it("已知用量達到群組保留門檻時暫停私訊並說明", () => {
    const panel = linePushPanel(
      [{ name: "line_quota", ok: true, detail: "本月已用 150／上限 200 則" }],
      { direct: 0, group: 0, stale: 0 },
      70,
    );
    expect(panel.blocked).toBe(false);
    expect(panel.notice).toEqual(expect.any(String));
    expect(panel.testDisabled).toBe(true);
  });
});
