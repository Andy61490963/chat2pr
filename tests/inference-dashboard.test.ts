import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, reset, session } from "./helpers.js";
import { buildApp } from "../server/app.js";
import { probeInference } from "../server/inference-health.js";
import { HttpRunner } from "../server/execution.js";

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
