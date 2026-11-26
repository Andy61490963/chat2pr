import { expect, it } from "vitest";
import { groupReplyStatus } from "../shared/group-reply-status.js";
const health = [{ name: "line_quota", ok: false }];
it("關閉總開關時，群組不會回覆", () => {
  expect(
    groupReplyStatus({ reply_mode: "all" }, { group_replies: false }, health),
  ).toEqual({ replies: false, text: "不會回覆，設定頁的總開關已關閉" });
});
it("群組設定為不回覆時，額度不足提示不會蓋過設定", () => {
  expect(groupReplyStatus({ reply_mode: "off" }, {}, health).text).toContain(
    "群組設為不回覆",
  );
});
it.each(["all", "results"] as const)(
  "推播用完時 %s 仍可即時回覆，跨年顯示一月重置",
  (mode) => {
    const result = groupReplyStatus(
      { reply_mode: mode },
      {},
      health,
      new Date("2026-11-30T16:01:00Z"),
    );
    expect(result.replies).toBe(true);
    expect(result.text).toMatch(/收到.*1\/1.*進度/);
    expect(result.text).toMatch(/發言.*重要/);
  },
);
it("離開的群組不列入回覆數", () => {
  expect(
    groupReplyStatus({ left_at: "2026-01-02", reply_mode: "all" }, {}, [])
      .replies,
  ).toBe(false);
});
it("兩種開啟模式只有全部回覆會主動回報等待確認", () => {
  expect(groupReplyStatus({ reply_mode: "all" }, {}, []).text).toContain(
    "整理進度",
  );
  expect(groupReplyStatus({ reply_mode: "results" }, {}, []).text).toBe(
    "會回覆「收到」與結果",
  );
});
