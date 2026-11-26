import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { dashboardAlerts } from "../server/dashboard-alerts.js";
import { healthTransition, recordHealth } from "../server/health.js";
import { db, reset, session } from "./helpers.js";

vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({}),
}));

const name = "codex_inference";
const minute = 60_000;

function monitor() {
  const at = (minutes: number) => new Date(minutes * minute);
  let before: Parameters<typeof healthTransition>[1] = {
    ok: true, notified_ok: true, reading_ok: true, checked_at: at(-1), outage_started_at: null,
  };
  return (minutes: number, ok: boolean) => {
    const now = at(minutes);
    const next = healthTransition(name, before, ok, "示範推論", now, false);
    before = {
      ok, reading_ok: ok, checked_at: now, notified_ok: next.notifiedOk,
      outage_started_at: next.outageStartedAt, line_outage_confirmed: next.lineOutageConfirmed,
    };
    return next.notice?.kind;
  };
}

it("鈴鐺在十五分鐘後再次讀到失敗才通知，真實成功只解除一次", () => {
  const read = monitor();
  expect([read(0, false), read(14.99, false), read(15, false), read(30, false),
    read(31, true), read(32, true)])
    .toEqual([undefined, undefined, "service_down", undefined, "service_up", undefined]);
});

it("單次失敗後即使超過十五分鐘才成功，也不補發未確認的恢復通知", () => {
  const read = monitor();
  expect([read(0, false), read(20, true)]).toEqual([undefined, undefined]);
});

describe("推論讀數與鈴鐺同步結案", () => {
  const clear = () => db.query("DELETE FROM service_health WHERE name=$1", [name]);
  const observe = (ok: boolean, started: Date, model: string | null = null) =>
    recordHealth(db, name, ok, ok ? "示範工作成功" : "示範推論失敗", {
      inferenceObservation: { model, started }, probe: { model, latencyMs: 7 },
    });
  const reading = () => db.one("SELECT ok,probe_info FROM service_health WHERE name=$1", [name]);
  const notices = () => dashboardAlerts(db, true).then(rows => rows.filter(row => row.kind === "service_down"));
  const establishOutage = async () => {
    await observe(false, new Date(Date.now() - 1000));
    await db.query("UPDATE service_health SET outage_started_at=clock_timestamp()-interval '16 minutes' WHERE name=$1", [name]);
    await observe(false, new Date());
  };

  beforeEach(async () => {
    await reset();
    await clear();
    await db.query(`UPDATE settings SET value=value||'{"ai_mode":"subscription"}'::jsonb WHERE id=1`);
  });
  afterEach(clear);
  afterAll(() => db.close());

  it("先開始卻較晚返回的工作或探測不得改寫讀數或產生通知", async () => {
    const younger = new Date();
    const older = new Date(younger.getTime() - minute);
    await observe(true, younger);
    await observe(false, older);
    expect(await reading()).toMatchObject({ ok: true, probe_info: { started: younger.toISOString(), model: null } });
    await observe(false, new Date(younger.getTime() + 1));
    await observe(true, older);
    expect(await reading()).toMatchObject({ ok: false });
    expect(await notices()).toEqual([]);
  });

  it("儲存前再次核對訂閱模式與模型，不接受不符的讀數", async () => {
    await observe(false, new Date(), "modelA");
    expect(await reading()).toBeUndefined();
    await db.query(`UPDATE settings SET value=value||'{"ai_mode":"api"}'::jsonb WHERE id=1`);
    await observe(false, new Date());
    expect(await reading()).toBeUndefined();
    expect(await notices()).toEqual([]);
  });

  it("切到金鑰模式時結案不報恢復，切回也不復活舊通知或舊工作", async () => {
    await establishOutage();
    const [outage] = await notices();
    expect(outage.disposition).toBe("action");
    const oldWork = new Date(Date.now() - minute);
    const app = await buildApp(db, undefined, undefined, undefined, { call: vi.fn().mockResolvedValue({}) });
    try {
      const headers = await session();
      const change = async (ai_mode: string) => {
        const response = await app.inject({
          method: "PUT", url: "/api/settings", headers,
          payload: { ...(await db.settings()), paused: true, ai_mode, codex_model: null,
            coding_effort: "medium", triage_effort: "low" },
        });
        expect(response.statusCode).toBe(200);
      };
      await change("api");
      expect(await notices()).toMatchObject([{ id: outage.id, disposition: "resolved" }]);
      expect(await db.query("SELECT 1 FROM notifications WHERE kind='service_up' OR sent_at IS NULL")).toEqual([]);
      await change("subscription");
      await observe(false, oldWork);
      expect(await reading()).toBeUndefined();
      expect(await notices()).toMatchObject([{ id: outage.id, disposition: "resolved" }]);
    } finally {
      await app.close();
    }
  });

  it("舊版在金鑰模式留下的未結案異常不列入待處理", async () => {
    await establishOutage();
    await db.query(`UPDATE settings SET value=value||'{"ai_mode":"api"}'::jsonb WHERE id=1`);
    expect(await notices()).toMatchObject([{ disposition: "resolved" }]);
  });

  it("前次中斷的通知不能代表這次中斷", async () => {
    await establishOutage();
    await db.query("UPDATE notifications SET line_outage_started_at=line_outage_started_at-interval '1 day' WHERE kind='service_down'");
    expect(await notices()).toMatchObject([{ disposition: "resolved" }]);
  });

  it("下一次故障尚未發通知時，上次的故障通知仍是歷史紀錄", async () => {
    await establishOutage();
    const [old] = await notices();
    const now = Date.now();
    await observe(true, new Date(now + 1));
    await observe(false, new Date(now + 2));
    expect(await notices()).toMatchObject([{ id: old.id, disposition: "resolved" }]);
    await db.query("UPDATE service_health SET outage_started_at=clock_timestamp()-interval '17 minutes' WHERE name=$1", [name]);
    await observe(false, new Date(now + 3));
    expect(await notices()).toMatchObject([
      { disposition: "action" }, { id: old.id, disposition: "resolved" },
    ]);
  });
});
