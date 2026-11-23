import { describe, expect, it } from "vitest";
import { healthTransition } from "../server/health.js";

const startedAt = Date.UTC(2026, 0, 1);

function monitor(name = "tunnel", confirm = true) {
  let state = {
    ok: true,
    reading_ok: true,
    notified_ok: true,
    checked_at: new Date(startedAt - 60_000),
    outage_started_at: null as Date | null,
  };
  return (minute: number, ok: boolean) => {
    const observedAt = new Date(startedAt + minute * 60_000);
    const next = healthTransition(
      name,
      state,
      ok,
      "探測無回應",
      observedAt,
      confirm,
    );
    state = {
      ok,
      reading_ok: ok,
      notified_ok: next.notifiedOk,
      checked_at: observedAt,
      outage_started_at: next.outageStartedAt,
    };
    return next;
  };
}

describe("服務中斷通知", () => {
  it("有滿 15 分鐘後的異常讀數才確認長時間中斷，短暫中斷仍記在看板", () => {
    const before = {
      ok: false,
      reading_ok: false,
      notified_ok: false,
      checked_at: new Date(startedAt),
      outage_started_at: new Date(startedAt),
    };
    const observe = (minute: number, ok: boolean) =>
      healthTransition(
        "github",
        before,
        ok,
        "範例探測",
        new Date(startedAt + minute * 60_000),
        false,
      );
    expect(observe(14, false).lineOutageConfirmed).toBe(false);
    expect(observe(15, false).lineOutageConfirmed).toBe(true);
    expect(observe(16, true)).toMatchObject({
      lineOutageConfirmed: false,
      notice: { kind: "service_up" },
    });
  });
  it("入口中斷一分鐘後恢復，只留一筆系統紀錄", () => {
    const read = monitor();
    expect(read(0, false).notice).toBeNull();
    expect(read(0.5, false).notice).toBeNull();
    expect(read(1, true)).toMatchObject({ notice: null, briefOutage: null });
    expect(read(2, true)).toMatchObject({
      notice: null,
      briefOutage: "HTTPS 入口中斷約 1 分鐘後恢復",
    });
    expect(read(3, true)).toMatchObject({ notice: null, briefOutage: null });
  });

  it("等待第二次正常讀數的時間不計入入口中斷", () => {
    const read = monitor();
    read(0, false);
    read(1, false);
    read(4, true);
    expect(read(5, true)).toMatchObject({
      notice: null,
      briefOutage: "HTTPS 入口中斷約 4 分鐘後恢復",
    });
  });

  it("入口中斷六分鐘，滿五分鐘和確認恢復時各通知一次", () => {
    const read = monitor();
    expect(read(0, false).notice).toBeNull();
    expect(read(1, false).notice).toBeNull();
    expect(read(4, false).notice).toBeNull();
    expect(read(5, false).notice).toMatchObject({ kind: "service_down" });
    expect(read(5.5, false).notice).toBeNull();
    expect(read(6, true).notice).toBeNull();
    expect(read(7, true).notice).toEqual({
      kind: "service_up",
      text: "服務已恢復：HTTPS 入口",
    });
    expect(read(8, true)).toMatchObject({ notice: null, briefOutage: null });
  });

  it("單次入口探測失敗不通知，其他即時探測的異常照常通報", () => {
    const tunnel = monitor();
    expect(tunnel(0, false).notice).toBeNull();
    expect(tunnel(1, true).notice).toBeNull();
    expect(tunnel(2, true)).toMatchObject({ notice: null, briefOutage: null });
    expect(monitor("github", false)(0, false).notice).toMatchObject({
      kind: "service_down",
    });
  });
});

describe("服務異常白話說明", () => {
  it.each([
    [
      "runner",
      "TypeError: fetch failed",
      "連不上服務，可能是網路中斷",
      "請確認網路和服務是否正常",
    ],
    [
      "runner",
      "ECONNREFUSED",
      "連不上服務，服務可能還沒啟動",
      "請確認服務已啟動",
    ],
    [
      "runner",
      "探測逾時",
      "沒有在預期時間內回應",
      "請稍候到設定頁按「檢查連線」",
    ],
    [
      "runner",
      "TimeoutError: The operation was aborted due to timeout",
      "沒有在預期時間內回應",
      "請稍候到設定頁按「檢查連線」",
    ],
    [
      "line",
      "Error: 無法連線至 LINE",
      "連不上服務，可能是網路中斷",
      "請確認網路和服務是否正常",
    ],
    [
      "host_resources",
      "可用記憶體只剩 1.9 GB（低於 2 GB）",
      "主機記憶體不足",
      "請到系統頁查看記憶體用量",
    ],
    [
      "codex",
      "服務的 Codex 尚未登入，請執行 npm run codex:login",
      "系統讀不到訂閱",
      "請在主機上重新登入 Codex",
    ],
    ["openai", "尚未設定", "所需設定可能未填齊", "請到設定頁確認服務設定"],
    [
      "github",
      "HTTP 403",
      "憑證可能已失效或權限不足",
      "請到設定頁核對憑證和權限",
    ],
    [
      "runner",
      "未識別的範例錯誤",
      "可能是服務暫時異常或設定有誤",
      "請到設定頁查看服務狀態",
    ],
  ])("把探測結果換成可處理的說明（樣本 %#）", (name, detail, cause, action) => {
    // 異常已持續一小時，有通知門檻的服務也已達門檻。
    const { notice } = healthTransition(
      name,
      {
        ok: false,
        reading_ok: false,
        notified_ok: true,
        checked_at: new Date(startedAt),
        outage_started_at: new Date(startedAt - 60 * 60_000),
      },
      false,
      detail,
      new Date(startedAt),
      false,
    );
    expect(notice?.text).toContain(cause);
    expect(notice?.text).toContain(action);
    expect(notice?.text).not.toContain(detail);
  });
});
