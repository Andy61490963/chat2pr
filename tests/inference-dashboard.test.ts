import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dashboardAlerts } from "../server/dashboard-alerts.js";
import { db, reset, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { probeInference, recordWorkInference, systemHealth } from "../server/inference-health.js";
import { HttpRunner } from "../server/execution.js";
import { recordWorkInferenceFailure } from '../server/inference-health.js';

vi.mock("../server/config.js", async (original) => ({
  ...(await original<typeof import("../server/config.js")>()),
  secrets: () => ({}),
}));

beforeEach(async () => {
  await reset();
  await db.query("DELETE FROM inference_probe_budget");
  await db.query(
    "DELETE FROM service_health WHERE name IN ('codex','codex_subscription_gate','codex_probe_deferred','codex_inference','host_resources')",
  );
  await db.query(
    'UPDATE settings SET value=value||\'{"ai_mode":"subscription","daily_runs":0,"codex_reserve_percent":30}\'::jsonb',
  );
});
afterEach(async () => {
  await db.query(
    "DELETE FROM service_health WHERE name IN ('codex','codex_subscription_gate','codex_probe_deferred','codex_inference','host_resources')",
  );
});
afterAll(() => db.close());

const deferral = () => db.one<{ detail: string }>("SELECT detail FROM service_health WHERE name='codex_probe_deferred'");

it.each([
  ['完全同時', '000500', 'unknown'],
  ['晚一微秒', '000501', 'unknown'],
  ['早一微秒', '000499', 'failed'],
])('延後紀錄與真實讀數%s時，系統頁與升級後顯示相同結果', async (_scenario, fraction, expected) => {
  const second = '2026-01-01T00:00:00';
  const probeTime = `${second}.000500Z`;
  const now = vi.spyOn(Date, 'now').mockReturnValue(new Date(probeTime).getTime());
  try {
    await db.query(`INSERT INTO service_health(name,ok,detail,reading_ok,checked_at) VALUES
      ('codex_inference',false,'上游回應 502',false,$1),
      ('codex_probe_deferred',false,'稍後檢查',null,$2)`, [probeTime, `${second}.${fraction}Z`]);
    const check = async () => {
      const row = (await systemHealth(db)).find(item => item.name === 'codex');
      expect(row).toMatchObject({ inferenceStatus: expected, detail: expected === 'unknown' ? '稍後檢查 上次真實讀數：上游回應 502' : '上游回應 502' });
    };
    await check();
    await db.migrate();
    await check();
  } finally {
    now.mockRestore();
  }
});

it('首次失敗不把時間進位到未來，後續讀數保留觀測的微秒', async () => {
  const started = new Date('2026-01-01T00:00:00Z');
  const transaction = db.transaction.bind(db);
  const clock = vi.spyOn(db, 'transaction').mockImplementation(fn => transaction(async client => {
    await client.query(`CREATE SCHEMA test_probe_clock;
      CREATE FUNCTION test_probe_clock.now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT timestamptz '2026-01-01T00:00:00.000800Z' $$;
      CREATE FUNCTION test_probe_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$ SELECT timestamptz '2026-01-01T00:00:01.000800Z' $$;
      SET LOCAL search_path = test_probe_clock, pg_catalog, public`);
    const result = await fn(client);
    await client.query('DROP SCHEMA test_probe_clock CASCADE');
    return result;
  }));
  try {
    await recordWorkInferenceFailure(db, null, started, { kind: 'connection' });
    expect(await db.one(`SELECT checked_at <= timestamptz '2026-01-01T00:00:00.000800Z' AS valid
      FROM service_health WHERE name='codex_inference'`)).toEqual({ valid: true });
    await recordWorkInference(db, null, new Date(started.getTime() + 1000));
    expect(await db.one(`SELECT checked_at = timestamptz '2026-01-01T00:00:01.000800Z' AS valid
      FROM service_health WHERE name='codex_inference'`)).toEqual({ valid: true });
  } finally {
    clock.mockRestore();
  }
});

it.each(["成功", "失敗", "工作成功", "工作失敗"])("延後之後取得%s讀數，清除延後列且不產生獨立異常", async source => {
  const runner = new HttpRunner();
  const ok = source.endsWith("成功");
  const failure = { kind: "upstream_http", status: 502 } as const;
  vi.spyOn(runner, "call").mockResolvedValue(ok ? { ok } : { ok, failure });
  const revision = (await db.settingsSnapshot()).revision;
  const probe = (known: boolean) => probeInference(db, runner, revision, async () => ({ known, hold: null }));
  await probe(false);
  const pending = await deferral();
  expect(pending).toMatchObject({ detail: expect.stringContaining("讀不到主機資源") });
  const health = await systemHealth(db);
  expect(health.some(row => row.name === "codex_probe_deferred")).toBe(false);
  expect(health.find(row => row.name === "codex")).toMatchObject({ inferenceStatus: "unknown", detail: pending.detail });
  if (source === "工作成功") await recordWorkInference(db, null, new Date());
  else if (source === "工作失敗") await recordWorkInferenceFailure(db, null, new Date(), failure);
  else await probe(true);
  expect(await deferral()).toBeUndefined();
  expect((await systemHealth(db)).find(row => row.name === "codex")).toMatchObject({ ok, inferenceStatus: ok ? "healthy" : "failed" });
  expect((await dashboardAlerts(db, true)).filter(row => row.kind === "service_down" || row.kind === "service_up")).toEqual([]);
});

it("未採用的工作失敗讀數保留延後原因，不把舊探測時間當成新故障", async () => {
  const runner = new HttpRunner();
  vi.spyOn(runner, "call").mockResolvedValue({ ok: false, failure: { kind: "upstream_http", status: 502 } });
  const revision = (await db.settingsSnapshot()).revision;
  const probe = (known: boolean) => probeInference(db, runner, revision, async () => ({ known, hold: null }));
  await probe(true);
  const previous = await db.one("UPDATE service_health SET checked_at=now()-interval '1 minute' WHERE name='codex_inference' RETURNING checked_at,detail");
  await probe(false);
  const pending = await deferral();
  expect(pending).toBeDefined();
  await recordWorkInferenceFailure(db, null, new Date(), { kind: "connection" });
  expect(await deferral()).toEqual(pending);
  expect(await db.one("SELECT checked_at, detail FROM service_health WHERE name='codex_inference'")).toEqual(previous);
  expect((await systemHealth(db)).find(row => row.name === "codex")).toMatchObject({
    inferenceStatus: "unknown", detail: expect.stringContaining(pending.detail),
  });
});

it("部署冒煙不列出延後說明，但仍列出真實推論失敗", async () => {
  const deploy = readFileSync(new URL("../scripts/deploy.mjs", import.meta.url), "utf8");
  expect(deploy).toMatch(/const failing\s*=\s*smokeHealth\(sql\)/);
  const { smokeHealth } = await import("../scripts/lib/smoke-health.mjs");
  await db.query("INSERT INTO service_health(name,ok,detail) VALUES ('codex_probe_deferred',false,'稍後檢查'),('codex_inference',false,'上游回應失敗')");
  const failures = (await smokeHealth(query => db.query(query))).map(row => row.name);
  expect(failures).toContain("codex_inference");
  expect(failures).not.toContain("codex_probe_deferred");
});

it("升級時只清除同模型已被真實讀數取代的舊延後說明", async () => {
  await db.query(`INSERT INTO service_health(name,ok,detail,reading_ok,checked_at,probe_info) VALUES
    ('codex_inference',true,'成功',true,now()-interval '1 minute','{"model":"modelA"}'),
    ('codex_probe_deferred',false,'稍後檢查',null,now(), '{"model":"modelA"}')`);
  await db.migrate();
  expect(await deferral()).toBeDefined();
  await db.query(`UPDATE service_health SET checked_at=now()-interval '2 minutes',probe_info='{"model":"modelB"}' WHERE name='codex_probe_deferred'`);
  await db.migrate();
  expect(await deferral()).toBeDefined();
  await db.query(`UPDATE service_health SET probe_info='{"model":"modelA"}' WHERE name='codex_probe_deferred'`);
  await db.migrate();
  expect(await deferral()).toBeUndefined();
});

it.each(['quota', 'quota_unavailable', 'concurrent_request', 'runner'])('代理略過或未取得結果（%s）不耗一般及提早補測名額，仍保留冷卻', async reason => {
  const runner = new HttpRunner();
  const call = vi.spyOn(runner, 'call');
  if (reason === 'runner') call.mockRejectedValue(new Error('無法取樣'));
  else call.mockResolvedValue({ ok: false, failure: { kind: reason } });
  const revision = (await db.settingsSnapshot()).revision;
  const probe = () => probeInference(db, runner, revision, async () => ({ known: true, hold: null }), true);
  expect(await probe()).toBe('unavailable');
  await probe();
  expect(call).toHaveBeenCalledTimes(1);
  expect(await db.one('SELECT attempts,early_attempts FROM inference_probe_budget')).toEqual({ attempts: 0, early_attempts: 0 });
  await db.query("UPDATE inference_probe_budget SET reserved_at=now()-interval '16 minutes'");
  call.mockResolvedValue({ ok: true });
  expect(await probe()).toBe(true);
  expect(await db.one('SELECT attempts,early_attempts FROM inference_probe_budget')).toEqual({ attempts: 1, early_attempts: 1 });
});

it('已完成但超過本地上限的探測計一次用量，維持未確認且不發停擺通知', async () => {
  const runner = new HttpRunner();
  vi.spyOn(runner, 'call').mockResolvedValue({ ok:false, skipped:'output_limit' });
  const revision = (await db.settingsSnapshot()).revision;
  const probe = () => probeInference(db, runner, revision, async () => ({ known:true, hold:null }));
  await probe();
  await db.query("UPDATE inference_probe_budget SET reserved_at=now()-interval '16 minutes'");
  await probe();
  await probe();
  const { systemHealth } = await import('../server/inference-health.js');
  expect((await systemHealth(db)).find(row => row.name === 'codex')).toMatchObject({ inferenceStatus:'unknown',detail:expect.stringContaining('探測輸出超過本地上限') });
  expect(await db.one('SELECT attempts FROM inference_probe_budget')).toEqual({ attempts:2 });
  expect(await db.query("SELECT 1 FROM service_health WHERE name='codex_inference'")).toEqual([]);
  expect(await db.query("SELECT 1 FROM notifications WHERE kind='service_down'")).toEqual([]);
});

it('一般名額用完後，可信工作失敗開啟保留名額；後續工作不延後十五分鐘確認與通知', async () => {
  const runner = new HttpRunner();
  const failure = { kind: 'upstream_http', status: 502 } as const;
  const call = vi.spyOn(runner, 'call').mockResolvedValue({ ok: false, failure });
  const revision = (await db.settingsSnapshot()).revision;
  const probe = () => probeInference(db, runner, revision, async () => ({ known: true, hold: null }));
  await db.query("INSERT INTO inference_probe_budget(id,day,attempts,early_attempts) VALUES(true,(now() AT TIME ZONE 'Asia/Taipei')::date,6,2)");
  await recordWorkInferenceFailure(db, null, new Date(), {kind:'output_limit'});
  expect(await probe()).toBe('unavailable');
  await recordWorkInferenceFailure(db, null, new Date(), failure);
  const aged = await db.one("UPDATE service_health SET checked_at=now()-interval '16 minutes',outage_started_at=now()-interval '16 minutes' WHERE name='codex_inference' RETURNING checked_at");
  await recordWorkInferenceFailure(db, null, new Date(), failure);
  expect(await db.one("SELECT checked_at FROM service_health WHERE name='codex_inference'")).toEqual(aged);
  expect(await probe()).toBe('failed');
  expect(call).toHaveBeenCalledTimes(1);
  expect(await db.one('SELECT attempts FROM inference_probe_budget')).toEqual({ attempts: 7 });
  expect(await db.query("SELECT 1 FROM notifications WHERE kind='service_down' AND text LIKE '%502%' ")).toHaveLength(1);
});

it("同日含失敗補測最多八次，並行搶最後一次不會超支，也不占用使用者次數", async () => {
  const runner = new HttpRunner();
  const call = vi.spyOn(runner, "call").mockResolvedValue({ ok: false, failure: { kind: "upstream_http", status: 502 } });
  const revision = (await db.settingsSnapshot()).revision;
  const probe = () => probeInference(db, runner, revision, async () => ({ known: true, hold: null }));
  const age = () => db.query("UPDATE inference_probe_budget SET reserved_at=now()-interval '16 minutes'");
  for (let attempt = 0; attempt < 7; attempt++) { await probe(); await age(); }
  await Promise.all([probe(), probe(), probe()]);
  expect(call).toHaveBeenCalledTimes(8);
  expect(await db.query("SELECT 1 FROM runs")).toEqual([]);
  await db.query("UPDATE inference_probe_budget SET day=day-1,reserved_at=now()-interval '1 day'");
  await probe();
  expect(call).toHaveBeenCalledTimes(9);
});

it("更換模型不沿用舊模型的綠燈，主機無讀數只記待檢不通知推論故障", async () => {
  const runner = new HttpRunner();
  const call = vi.spyOn(runner, "call").mockImplementation(async path => path === "resources" ? { cpus: 4, memFreeMb: 8000, memTotalMb: 16000 } : { ok: true });
  await db.query("INSERT INTO service_health(name,ok,detail) VALUES('codex',true,'已登入')");
  await probeInference(db, runner, (await db.settingsSnapshot()).revision);
  const { systemHealth } = await import("../server/inference-health.js");
  const codex = async () => (await systemHealth(db)).find(row => row.name === "codex");
  expect(await codex()).toMatchObject({ ok: true });
  await db.query(`UPDATE settings SET value=value||'{"codex_model":"modelB"}'::jsonb`);
  expect(await codex()).toMatchObject({ ok: false, detail: expect.stringContaining("尚未") });
  call.mockRejectedValue(new Error("讀不到資源"));
  await probeInference(db, runner, (await db.settingsSnapshot()).revision);
  expect(await codex()).toMatchObject({ ok: false, detail: expect.stringContaining("未送出") });
  expect(await db.query("SELECT 1 FROM notifications WHERE kind='service_down'")).toEqual([]);
});

it("代理回報上游 502 時，兩個系統項目顯示原因與延遲，不占每日執行次數", async () => {
  const runner = new HttpRunner();
  const call = vi
    .spyOn(runner, "call")
    .mockImplementation(async (path) =>
      path === "resources"
        ? { cpus: 4, memFreeMb: 8000, memTotalMb: 16000 }
        : { ok: false, failure: { kind: "upstream_http", status: 502 } },
    );
  const revision = (await db.settingsSnapshot()).revision;
  await db.query(
    "INSERT INTO service_health(name,ok,detail) VALUES ('codex',true,'登入成功'),('codex_subscription_gate',true,'額度可用')",
  );
  await probeInference(db, runner, revision);
  expect(call).toHaveBeenCalledWith(
    "codex/inference-probe",
    { model: null, reservePercent: 30 },
    45000,
  );
  const app = await buildApp(db);
  try {
    const response = await app.inject({
      url: "/api/state",
      headers: await session(),
    });
    expect(response.statusCode).toBe(200);
    for (const name of ["codex", "codex_subscription_gate"])
      expect(response.json().health).toContainEqual(
        expect.objectContaining({
          name,
          ok: false,
          detail: expect.stringMatching(/訂閱上游回應失敗.*HTTP 502.*毫秒/),
        }),
      );
    expect(await db.query("SELECT 1 FROM runs")).toEqual([]);
    expect(
      await db.query(
        "SELECT 1 FROM notifications WHERE kind='service_down' AND text LIKE '%502%'",
      ),
    ).toHaveLength(0);
  } finally {
    await app.close();
  }
});

it("一般探測不得動用最後兩次，真實工作成功不需名額就解除異常", async () => {
  const runner = new HttpRunner();
  const call = vi.spyOn(runner, 'call').mockResolvedValue({ ok: true });
  await db.query("INSERT INTO inference_probe_budget(id,day,attempts) VALUES(true,(now() AT TIME ZONE 'Asia/Taipei')::date,6)");
  const probe = () => probeInference(db, runner, revision, async () => ({ known:true, hold:null }));
  const revision = (await db.settingsSnapshot()).revision;
  await probe();
  expect(call).not.toHaveBeenCalled();
  const {recordWorkInference,systemHealth} = await import('../server/inference-health.js');
  await db.query("INSERT INTO service_health(name,ok,detail,probe_info) VALUES('codex_inference',false,'訂閱回應失敗','{\"model\": null}')");
  await probe();
  expect(call).toHaveBeenCalledTimes(1);
  await db.query("UPDATE inference_probe_budget SET attempts=8");
  await db.query("UPDATE service_health SET ok=false,detail='訂閱回應失敗' WHERE name='codex_inference'");
  await recordWorkInference(db,null,new Date());
  expect((await systemHealth(db)).find(row=>row.name==='codex')).toMatchObject({inferenceStatus:'healthy',ok:true});
  expect(call).toHaveBeenCalledTimes(1);
});

it("派工暫停或主機記憶體過低不呼叫推論代理", async () => {
  const runner = new HttpRunner();
  const call = vi
    .spyOn(runner, "call")
    .mockResolvedValue({ cpus: 4, memFreeMb: 1700, memTotalMb: 16000 });
  expect(
    await probeInference(db, runner, (await db.settingsSnapshot()).revision),
  ).toBe(false);
  expect(call.mock.calls.map(([path]) => path)).toEqual(["resources"]);
  await db.query("UPDATE settings SET value=value||'{\"paused\":true}'::jsonb");
  call.mockClear();
  expect(
    await probeInference(db, runner, (await db.settingsSnapshot()).revision),
  ).toBe(false);
  expect(call).not.toHaveBeenCalled();
});

it('讀不到主機資源只更新略過原因，保留前次 502 類別與時間', async () => {
  const runner = new HttpRunner();
  vi.spyOn(runner,'call').mockResolvedValue({ ok:false, failure:{kind:'upstream_http',status:502} });
  const revision = (await db.settingsSnapshot()).revision;
  await probeInference(db,runner,revision,async () => ({known:true,hold:null}));
  const evidence = () => db.one("SELECT ok,probe_info,checked_at FROM service_health WHERE name='codex_inference'");
  const before = await evidence();
  await probeInference(db,runner,revision,async () => ({known:false,hold:null}));
  expect(await evidence()).toEqual(before);
  const {systemHealth} = await import('../server/inference-health.js');
  expect((await systemHealth(db)).find(row => row.name==='codex')).toMatchObject({inferenceStatus:'unknown',detail:expect.stringMatching(/讀不到主機資源.*502/)});
});

it('執行器回應未附有效失敗證據時，只能顯示未確認', async () => {
  const runner = new HttpRunner();
  vi.spyOn(runner,'call').mockResolvedValue({ ok:false, failure:{kind:'不明原因'} });
  await probeInference(db,runner,(await db.settingsSnapshot()).revision,async () => ({known:true,hold:null}));
  const {systemHealth} = await import('../server/inference-health.js');
  expect((await systemHealth(db)).find(row => row.name==='codex')).toMatchObject({inferenceStatus:'unknown'});
  expect(await db.query("SELECT 1 FROM service_health WHERE name='codex_inference'")).toEqual([]);
});
