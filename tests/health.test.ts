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
    return next.notice;
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
    const observe = (minute: number, ok: boolean) => healthTransition(
      "github", before, ok, "範例探測", new Date(startedAt + minute * 60_000), false,
    );
    expect(observe(14, false).lineOutageConfirmed).toBe(false);
    expect(observe(15, false).lineOutageConfirmed).toBe(true);
    expect(observe(16, true)).toMatchObject({
      lineOutageConfirmed: false,
      notice: { kind: "service_up" },
    });
  });
  it("入口中斷兩分鐘後恢復，只通知一次中斷與恢復", () => {
    const read = monitor();
    expect(read(0, false)).toBeNull();
    expect(read(1, false)).toBeNull();
    expect(read(1.5, true)).toBeNull();
    expect(read(2, true)).toEqual({
      kind: "service_up",
      text: "HTTPS 入口曾中斷約 2 分鐘，已恢復。",
    });
    expect(read(3, true)).toBeNull();
  });

  it("入口一達五分鐘門檻就通報一次，確認恢復時再通知", () => {
    const read = monitor();
    expect(read(0, false)).toBeNull();
    expect(read(1, false)).toBeNull();
    expect(read(4, false)).toBeNull();
    expect(read(5, false)).toMatchObject({ kind: "service_down" });
    expect(read(6, false)).toBeNull();
    expect(read(7, true)).toBeNull();
    expect(read(8, true)).toEqual({
      kind: "service_up",
      text: "服務已恢復：HTTPS 入口",
    });
    expect(read(9, true)).toBeNull();
  });

  it("單次入口探測失敗不通知，其他即時探測的異常照常通報", () => {
    const tunnel = monitor();
    expect(tunnel(0, false)).toBeNull();
    expect(tunnel(1, true)).toBeNull();
    expect(tunnel(2, true)).toBeNull();
    expect(monitor("github", false)(0, false)).toMatchObject({
      kind: "service_down",
    });
  });
});
