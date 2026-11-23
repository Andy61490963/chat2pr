import { describe, expect, it } from "vitest";
import { healthTransition } from "../server/health.js";
import { memoryHold, type MemoryPause } from "../server/capacity.js";
import { tunnelReading } from "../server/tunnel-provider.js";

// 可控制的時鐘：排程器每 10 秒讀一次，分鐘數換算成 Date。
const origin = Date.UTC(2026, 0, 1);
const at = (minute: number) => new Date(origin + minute * 60_000);
const tick = 10 / 60;

type Notice = { minute: number; kind: string };

/** 模擬排程器對一項服務的連續讀數，記下通知與狀態。 */
function service(name: string) {
  let state = {
    ok: true,
    reading_ok: true as boolean | null,
    notified_ok: true as boolean | null,
    checked_at: at(-1),
    outage_started_at: null as Date | null,
  };
  const notices: Notice[] = [];
  const read = (minute: number, ok: boolean, detail = "範例探測") => {
    const next = healthTransition(name, state, ok, detail, at(minute), true);
    state = {
      ok,
      reading_ok: ok,
      notified_ok: next.notifiedOk,
      checked_at: at(minute),
      outage_started_at: next.outageStartedAt,
    };
    if (next.notice) notices.push({ minute, kind: next.notice.kind });
    return next;
  };
  return { read, notices };
}

/** 主機記憶體：暫停判斷與通知都走正式的純函式，回傳每次讀數是否暫停派工。 */
function host() {
  const health = service("host_resources");
  let pause: MemoryPause | null = null;
  const switches: { minute: number; paused: boolean }[] = [];
  const read = (minute: number, memFreeMb: number) => {
    const hold = memoryHold(
      { cpus: 8, memTotalMb: 32768, memFreeMb },
      pause,
      at(minute),
    );
    const paused = hold !== null;
    if (paused !== (pause !== null)) switches.push({ minute, paused });
    pause = hold && { recoveringSince: hold.recoveringSince };
    health.read(minute, !hold, hold?.detail ?? "記憶體充足");
    return paused;
  };
  return { read, switches, notices: health.notices };
}

/** 從 from 到 to（不含）每 10 秒呼叫一次。 */
function run(from: number, to: number, each: (minute: number) => void) {
  for (let m = from; m < to - 1e-9; m += tick) each(m);
}

describe("主機記憶體暫停派工的遲滯與通知去抖動", () => {
  it("在臨界值上下擺動一小時（重現 11/23）：只暫停一次、恢復一次，各通知一次", () => {
    const h = host();
    run(0, 5, (m) => h.read(m, 8192));
    // 低於 2 GB 三分鐘、回升到 2.7 GB 兩分鐘，反覆一小時。
    run(5, 65, (m) => h.read(m, (m - 5) % 5 < 3 ? 1900 : 2700));
    run(65, 80, (m) => h.read(m, 2700));
    expect(h.switches.map((s) => s.paused)).toEqual([true, false]);
    const [paused, resumed] = h.switches;
    expect(paused.minute).toBeCloseTo(5);
    // 最後一次低讀數在第 63 分鐘前，穩定滿 5 分鐘才恢復派工。
    expect(resumed.minute).toBeGreaterThanOrEqual(68);
    expect(resumed.minute).toBeLessThan(69);
    expect(h.notices.map((n) => n.kind)).toEqual([
      "service_down",
      "service_up",
    ]);
  });

  it("短暫掉到臨界值以下：立刻暫停派工，但不通知", () => {
    const h = host();
    run(0, 2, (m) => h.read(m, 8192));
    run(2, 3, (m) => h.read(m, 1900));
    run(3, 20, (m) => h.read(m, 4096));
    expect(h.switches.map((s) => s.paused)).toEqual([true, false]);
    expect(h.notices).toEqual([]);
  });

  it("長時間記憶體不足不漏報：持續三小時只通知一次異常，恢復時通知一次", () => {
    const h = host();
    run(0, 1, (m) => h.read(m, 8192));
    run(1, 181, (m) => h.read(m, 1500));
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].kind).toBe("service_down");
    expect(h.notices[0].minute).toBeLessThanOrEqual(11.5);
    run(181, 195, (m) => h.read(m, 6000));
    expect(h.notices.map((n) => n.kind)).toEqual([
      "service_down",
      "service_up",
    ]);
  });
});

describe("HTTPS 入口通知去抖動", () => {
  it("部署重啟造成一分鐘中斷不通知", () => {
    const t = service("tunnel");
    run(0, 1, (m) => t.read(m, true));
    run(1, 2, (m) => t.read(m, false));
    run(2, 10, (m) => t.read(m, true));
    expect(t.notices).toEqual([]);
  });

  it("持續兩小時的中斷只通知一次異常，恢復通知一次", () => {
    const t = service("tunnel");
    run(0, 1, (m) => t.read(m, true));
    run(1, 121, (m) => t.read(m, false));
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0].minute).toBeLessThanOrEqual(6.5);
    run(121, 125, (m) => t.read(m, true));
    expect(t.notices.map((n) => n.kind)).toEqual([
      "service_down",
      "service_up",
    ]);
  });
});

describe("通道狀態檔的讀數與說明一致", () => {
  const now = Date.UTC(2026, 0, 1, 12);
  const file = (ok: boolean, detail: string, ageMs: number) =>
    JSON.stringify({
      ok,
      detail,
      checked_at: new Date(now - ageMs).toISOString(),
    });

  it("狀態檔過期時判為異常，說明不會沿用檔案裡的「已連線」", () => {
    const reading = tunnelReading(
      file(true, "Cloudflare 固定 HTTPS 入口已連線", 4 * 60_000),
      now,
    );
    expect(reading.ok).toBe(false);
    expect(reading.detail).not.toContain("已連線");
    expect(reading.detail).toContain("4 分鐘沒有更新");
  });

  it("新鮮的正常狀態判為正常；新鮮的異常沿用程序寫的原因", () => {
    expect(tunnelReading(file(true, "已連線", 30_000), now)).toEqual({
      ok: true,
      detail: "固定 HTTPS 入口已連線",
    });
    expect(
      tunnelReading(file(false, "Cloudflare 入口尚未就緒", 30_000), now),
    ).toEqual({ ok: false, detail: "Cloudflare 入口尚未就緒" });
  });

  it("沒有狀態檔時說明尚未啟動", () => {
    expect(tunnelReading(null, now)).toEqual({
      ok: false,
      detail: "尚未啟動 HTTPS 隧道",
    });
  });
});
