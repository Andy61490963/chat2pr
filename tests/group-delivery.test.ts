import { describe, expect, it } from "vitest";
import {
  claimingNote,
  deliveryLabel,
  deliveryNotice,
  deliveryState,
  rateLimitedPrefix,
  repliesOffNote,
  replyFailedNote,
  replyGaveUpNote,
  supersededNote,
  undelivered,
} from "../shared/group-delivery.js";
import {
  expiredNote,
  quotaExhaustedDetail,
  quotaShortForGroup,
} from "../shared/line-quota.js";
import * as server from "../server/group-replies.js";
import { LinePushRejected, LineQuotaExhausted } from "../server/line-quota.js";
import { discordDeliveryNotes } from "../shared/status-glossary.js";

const sentAt = "2026-11-18T01:00:00.000Z";
const state = (row: Partial<Parameters<typeof deliveryState>[0]> = {}) =>
  deliveryState({
    sent_at: null,
    attempts: 0,
    last_error: null,
    ...row,
  });

describe("群組訊息送達狀態", () => {
  it("Discord 待送通知不受 LINE 額度影響，限流和權限錯誤提供處理說明", () => {
    const delivery = deliveryState(
      { sent_at: null, attempts: 0, last_error: null },
      { platform: "discord", quotaBlocked: true },
    );
    expect(deliveryLabel(delivery)).toBe("等待送出");
    const rate = deliveryState(
      { sent_at: null, attempts: 0, last_error: discordDeliveryNotes.rate },
      { platform: "discord", quotaBlocked: true },
    );
    expect(rate).toEqual({ status: "pending", reason: "rate", note: discordDeliveryNotes.rate });
    expect(deliveryNotice(rate, "group_answered")).toBe(
      "查詢回答還沒送到群組。Discord 暫時限制送訊速度，系統會在解除限制後重試。",
    );
    const denied = deliveryState(
      { sent_at: null, attempts: 3, last_error: discordDeliveryNotes.permission },
      { platform: "discord" },
    );
    expect(deliveryLabel(denied)).toBe("送不出去");
    expect(deliveryNotice(denied)).toContain("請管理者檢查權限後再試");
  });
  it("已送出：sent_at 有值且沒有錯誤", () => {
    expect(
      state({ sent_at: sentAt, has_message_id: true, attempts: 1 }),
    ).toEqual({ status: "sent", reason: null, note: "已送到群組" });
    expect(deliveryNotice(state({ sent_at: sentAt }), "group_merged")).toBe(
      "合併通知已送到群組。",
    );
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
    expect(deliveryNotice(d, "group_answered")).toBe(
      "查詢回答沒有送到群組，因為 LINE 本月推播額度已用完。可請群組成員用 /進度 取回，或在看板查看並轉達。",
    );
    expect(deliveryLabel(d)).toBe("額度不足，未送出");
  });
  it("額度用完期間排入或排在後面的通知（last_error 仍空）也說額度用完；已送出、略過、放棄的不受影響", () => {
    const blocked = { quotaBlocked: true };
    const queued = deliveryState(
      { sent_at: null, attempts: 0, last_error: null },
      blocked,
    );
    expect(queued).toEqual({
      status: "pending",
      reason: "quota",
      note: "LINE 本月推播額度已用完",
    });
    expect(deliveryNotice(queued)).toContain(
      "群組訊息沒有送到群組，因為 LINE 本月推播額度已用完。",
    );
    // 之前限流失敗過、還沒到 3 次：暫停期間不會再試，原因改說額度。
    expect(
      deliveryState(
        {
          sent_at: null,
          attempts: 1,
          last_error: `Error: ${rateLimitedPrefix}，稍後會再送（429）`,
        },
        blocked,
      ).reason,
    ).toBe("quota");
    expect(
      deliveryState({ sent_at: sentAt, attempts: 1, last_error: null }, blocked)
        .status,
    ).toBe("sent");
    expect(
      deliveryState(
        { sent_at: sentAt, attempts: 0, last_error: repliesOffNote },
        blocked,
      ).status,
    ).toBe("skipped");
    expect(
      deliveryState(
        { sent_at: sentAt, attempts: 0, last_error: claimingNote },
        blocked,
      ).status,
    ).toBe("claiming");
    expect(
      deliveryState(
        {
          sent_at: null,
          attempts: 3,
          last_error: "Error: LINE 通知失敗（500）",
        },
        blocked,
      ),
    ).toMatchObject({ status: "failed", reason: "error" });
  });
  it("剩餘額度不夠群組人數也算額度原因", () => {
    const d = state({ last_error: "剩餘推播額度不足群組人數，額度恢復後再送" });
    expect(d).toMatchObject({ status: "pending", reason: "group_size" });
    expect(deliveryNotice(d)).toContain(
      "群組訊息沒有送到群組，因為 LINE 剩餘推播額度不夠這個群組的人數。",
    );
    // flushNotifications 實際寫入的字（人數已知與未知兩種）。
    for (const members of [12, null])
      expect(
        state({ last_error: quotaShortForGroup(3, members) }),
      ).toMatchObject({ status: "pending", reason: "group_size" });
  });
  it("伺服器實際寫入的「補送多次失敗」算送不出去", () => {
    expect(state({ last_error: replyGaveUpNote })).toMatchObject({
      status: "failed",
      reason: "reply_failed",
      note: "以 /進度 補送多次失敗",
    });
    // 額度用完期間也一樣：/進度 已不再取回，要管理者代為轉達。
    expect(
      deliveryState(
        { sent_at: null, attempts: 0, last_error: replyGaveUpNote },
        { quotaBlocked: true },
      ).status,
    ).toBe("failed");
  });
  it("一般限流與其他錯誤：未滿 3 次是送出中，滿 3 次是送不出去", () => {
    // flushNotifications 寫入的是 redact(String(e))：前面帶「Error: 」。
    const stored = (message: string) => String(new Error(message));
    const rate = state({
      attempts: 1,
      last_error: stored(`${rateLimitedPrefix}，稍後會再送（429）`),
    });
    expect(rate).toMatchObject({ status: "pending", reason: "rate" });
    expect(deliveryNotice(rate)).toBe(
      "群組訊息還沒送到群組，因為 LINE 暫時限制推播速度。系統會再試。",
    );
    expect(
      deliveryNotice(
        state({
          attempts: 3,
          last_error: stored(`${rateLimitedPrefix}，稍後會再送（429）`),
        }),
      ),
    ).toBe("群組訊息重試 3 次後仍沒有送到群組，因為 LINE 暫時限制推播速度。需要時請在看板查看並轉達。");
    const failed = state({
      attempts: 3,
      last_error: stored("LINE 通知失敗（500）"),
    });
    expect(failed).toEqual({
      status: "failed",
      reason: "error",
      note: "LINE 回應錯誤（500）",
    });
    expect(deliveryNotice(failed)).toBe(
      "群組訊息重試 3 次後仍沒有送到群組，因為 LINE 無法處理這則訊息。需要時請在看板查看並轉達。",
    );
    expect(state({ attempts: 0 })).toEqual({
      status: "pending",
      reason: null,
      note: "排隊等待送出",
    });
    expect(deliveryNotice(state())).toBe("群組訊息正在排隊等待送到群組。");
  });
  it("不回傳原始錯誤：認不得的錯誤只留狀態碼或通用說明", () => {
    const d = state({
      attempts: 3,
      last_error: "Error: connect ECONNREFUSED 10.0.0.5:443 token=[已遮罩]",
    });
    expect(d.note).toBe("連不上 LINE");
    expect(JSON.stringify(d)).not.toContain("10.0.0.5");
    expect(
      state({
        attempts: 1,
        last_error:
          "TimeoutError: The operation was aborted due to timeout at fictional-host",
      }).note,
    ).toBe("連不上 LINE");
    const other = state({
      attempts: 3,
      last_error: "Error: 意外的內部訊息 fictional-secret-path",
    });
    expect(other.note).toBe("LINE 沒有收下這則訊息");
    expect(JSON.stringify(other)).not.toContain("fictional-secret-path");
  });
  it("以 /進度 補送中、補送失敗、補送多次失敗", () => {
    const claiming = state({ sent_at: sentAt, last_error: claimingNote });
    expect(claiming.status).toBe("claiming");
    expect(undelivered(claiming)).toBe(true);
    expect(deliveryNotice(claiming, "group_question")).toBe(
      "補問正在透過成員的 /進度 指令補送到群組。",
    );
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
    expect(deliveryNotice(off, "group_answered")).toBe(
      "查詢回答沒有送到群組，因為群組回覆已關閉。如需恢復通知，請確認群組回覆設定。",
    );
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
    expect(replyGaveUpNote).toBe(server.replyGaveUpNote);
    expect(supersededNote).toBe(server.supersededNote);
    expect(state({ last_error: String(new LinePushRejected(429)) }).reason).toBe("rate");
    expect(state({ last_error: new LineQuotaExhausted().message }).reason).toBe("quota");
  });
});
