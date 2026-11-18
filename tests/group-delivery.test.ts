import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  claimingNote,
  deliveryLabel,
  deliveryNotice,
  deliveryState,
  rateLimitedPrefix,
  repliesOffNote,
  replyFailedNote,
  supersededNote,
  undelivered,
} from "../shared/group-delivery.js";
import { expiredNote, quotaExhaustedDetail } from "../shared/line-quota.js";
import * as server from "../server/group-replies.js";

const sentAt = "2026-11-18T01:00:00.000Z";
const state = (row: Partial<Parameters<typeof deliveryState>[0]> = {}) =>
  deliveryState({
    sent_at: null,
    attempts: 0,
    last_error: null,
    ...row,
  });

describe("群組訊息送達狀態", () => {
  it("已送出：sent_at 有值且沒有錯誤", () => {
    expect(
      state({ sent_at: sentAt, has_message_id: true, attempts: 1 }),
    ).toEqual({ status: "sent", reason: null, note: "已送到群組" });
    // LINE 回 409 已收下時沒有訊息 ID，仍算送出。
    expect(state({ sent_at: sentAt, attempts: 1 }).status).toBe("sent");
  });
  it("額度用完：不算失敗次數，維持等待送出並帶額度原因", () => {
    const d = state({ last_error: quotaExhaustedDetail });
    expect(d).toEqual({
      status: "pending",
      reason: "quota",
      note: "LINE 本月推播額度已用完",
    });
    expect(undelivered(d)).toBe(true);
    expect(deliveryNotice(d)).toBe(
      "這則群組訊息沒有送出：LINE 本月推播額度已用完",
    );
    expect(deliveryLabel(d)).toBe("額度不足，未送出");
  });
  it("剩餘額度不夠群組人數也算額度原因", () => {
    const d = state({ last_error: "剩餘推播額度不足群組人數，額度恢復後再送" });
    expect(d).toMatchObject({ status: "pending", reason: "group_size" });
    expect(deliveryNotice(d)).toContain("這則群組訊息沒有送出");
  });
  it("一般限流與其他錯誤：未滿 3 次是送出中，滿 3 次是送不出去", () => {
    const rate = state({
      attempts: 1,
      last_error: `${rateLimitedPrefix}，稍後會再送（429）`,
    });
    expect(rate).toMatchObject({ status: "pending", reason: "rate" });
    expect(deliveryNotice(rate)).toMatch(/^正在送到群組/);
    const failed = state({
      attempts: 3,
      last_error: "LINE 通知失敗（500）",
    });
    expect(failed).toEqual({
      status: "failed",
      reason: "error",
      note: "LINE 回應錯誤（500）",
    });
    expect(deliveryNotice(failed)).toBe(
      "重試 3 次仍沒送出（LINE 回應錯誤（500））",
    );
    expect(state({ attempts: 0 })).toEqual({
      status: "pending",
      reason: null,
      note: "排隊等待送出",
    });
    expect(deliveryNotice(state())).toBe("正在送到群組");
  });
  it("不回傳原始錯誤：認不得的錯誤只留狀態碼或通用說明", () => {
    const d = state({
      attempts: 3,
      last_error: "Error: connect ECONNREFUSED 10.0.0.5:443 token=[已遮罩]",
    });
    expect(d.note).toBe("LINE 沒有收下這則訊息");
    expect(JSON.stringify(d)).not.toContain("10.0.0.5");
  });
  it("以 /進度 補送中、補送失敗、補送多次失敗", () => {
    const claiming = state({ sent_at: sentAt, last_error: claimingNote });
    expect(claiming.status).toBe("claiming");
    expect(undelivered(claiming)).toBe(true);
    expect(deliveryNotice(claiming)).toMatch(/^正在送到群組/);
    // 寫回訊息 ID 後就是已送出。
    expect(
      state({ sent_at: sentAt, last_error: claimingNote, has_message_id: true })
        .status,
    ).toBe("sent");
    expect(state({ last_error: replyFailedNote })).toMatchObject({
      status: "pending",
      reason: "reply_failed",
    });
    expect(
      state({ last_error: "以 /進度 回覆補送失敗多次，已停止補送" }),
    ).toMatchObject({
      status: "failed",
      reason: "reply_failed",
      note: "以 /進度 補送多次失敗",
    });
    expect(state({ attempts: 3, last_error: replyFailedNote }).status).toBe(
      "failed",
    );
  });
  it("略過：群組回覆已關閉、已過期、已有較新的回覆都不算失敗", () => {
    const off = state({ sent_at: sentAt, last_error: repliesOffNote });
    expect(off).toEqual({
      status: "skipped",
      reason: "replies_off",
      note: "群組回覆已關閉，未送出",
    });
    expect(undelivered(off)).toBe(false);
    expect(deliveryNotice(off)).toBe("沒有送到群組：群組回覆已關閉，未送出");
    expect(state({ sent_at: sentAt, last_error: expiredNote })).toMatchObject({
      status: "skipped",
      reason: "expired",
      note: expiredNote,
    });
    expect(
      state({ sent_at: sentAt, last_error: supersededNote }),
    ).toMatchObject({ status: "skipped", reason: "superseded" });
  });
  it("固定文字與伺服器寫入的字一致", () => {
    expect(claimingNote).toBe(server.claimingNote);
    expect(replyFailedNote).toBe(server.replyFailedNote);
    expect(supersededNote).toBe(server.supersededNote);
    // 總開關關閉與一般限流的字直接寫在 flushNotifications 裡。
    const line = readFileSync(
      new URL("../server/line.ts", import.meta.url),
      "utf8",
    );
    expect(line).toContain(`last_error='${repliesOffNote}'`);
    expect(line).toContain(`"${rateLimitedPrefix}`);
    expect(line).toContain("quotaExhaustedDetail");
  });
});
