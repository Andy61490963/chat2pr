import { expect, it, vi } from "vitest";
import {
  InferenceSchedule,
  capacitySample,
  visibleHealth,
} from "../server/inference-health.js";

it("同一輪派工與探測共享一次記憶體取樣，推論失敗後十五分鐘確認", async () => {
  const read = vi.fn(async () => ({ known: true, hold: null }));
  const sample = capacitySample(read);
  await Promise.all([sample(), sample()]);
  expect(read).toHaveBeenCalledTimes(1);
  let now = 0;
  const schedule = new InferenceSchedule(() => now);
  const probe = vi.fn(async () => "failed" as const);
  await schedule.tick(probe);
  now = 15 * 60000 - 1;
  await schedule.tick(probe);
  expect(probe).toHaveBeenCalledTimes(1);
  now++;
  await schedule.tick(probe);
  expect(probe).toHaveBeenCalledTimes(2);
  now += 15 * 60000;
  await schedule.tick(probe);
  expect(probe).toHaveBeenCalledTimes(2);
  await schedule.tick(probe, "示範模型");
  expect(probe).toHaveBeenCalledTimes(3);
});

it("登入與額度正常仍不能掩蓋真實推論的上游錯誤", () => {
  const row = (name: string, ok: boolean, detail: string) => ({
    name,
    ok,
    detail,
    checked_at: new Date(0),
  });
  const prerequisites = [
    row("codex", true, "連線正常"),
    row("codex_subscription_gate", true, "額度可用"),
  ];
  expect(visibleHealth(prerequisites).some((item) => item.ok)).toBe(false);
  const failure = row(
    "codex_inference",
    false,
    "訂閱上游回應失敗（上游 HTTP 502）",
  );
  expect(visibleHealth([...prerequisites, failure], 0)).toMatchObject(
    prerequisites.map(({ name }) => ({ ...failure, name })),
  );
  expect(visibleHealth([...prerequisites, failure])[1]).toMatchObject({
    quota: { ok: true, detail: "額度可用" },
  });
});

it("首次與六小時後探測，階段失敗提早探測，暫停時保留待辦", async () => {
  let now = 0;
  const schedule = new InferenceSchedule(() => now);
  const probe = vi.fn(async () => true);
  await schedule.tick(probe);
  now += 6 * 3600_000 - 1;
  await schedule.tick(probe);
  expect(probe).toHaveBeenCalledTimes(1);
  now++;
  await schedule.tick(probe);
  schedule.request();
  now += 15 * 60000;
  await schedule.tick(async () => false);
  await schedule.tick(probe);
  expect(probe).toHaveBeenCalledTimes(3);
});

it("重啟十次與全天頻繁部署不重複消耗；每六小時仍更新一次", async () => {
  let now = 0;
  let reading: { ok: boolean; checked_at: Date; outage_started_at: Date | null } | undefined;
  const probe = vi.fn(async () => { reading = { ok: true, checked_at: new Date(now), outage_started_at: null }; return true; });
  for (let minute = 0; minute < 1440; minute++) {
    now = minute * 60000;
    const schedule = new InferenceSchedule(() => now, async () => reading);
    await schedule.tick(probe);
    if (minute === 10) expect(probe).toHaveBeenCalledTimes(1);
  }
  expect(probe).toHaveBeenCalledTimes(4);
});

it("故障兩小時，執行中及每分鐘的補測要求合併，仍能確認異常及恢復", async () => {
  let now = 0;
  const sent: number[] = [];
  const schedule = new InferenceSchedule(() => now);
  const probe = async () => { sent.push(now / 60000); schedule.request(); return now < 120 * 60000 ? 'failed' as const : true; };
  for (let minute = 0; minute <= 136; minute++) {
    now = minute * 60000;
    if (minute < 120) schedule.request();
    await schedule.tick(probe);
  }
  expect(sent).toEqual([0,15,135]);
});

it("暫停、額度不足或過期是未確認，不當作連線失敗", () => {
  const checked_at = new Date(0);
  const login = { name: 'codex', ok: true, detail: '已登入', checked_at };
  const good = { ...login, name: 'codex_inference' };
  for (const [rows, reason] of [[[login,good], '派工暫停中'], [[login,good,{...login,name:'codex_subscription_gate',ok:false,detail:'額度不足'}], ''], [[login,good], '']] as const) {
    expect(visibleHealth([...rows], 8*3600000, reason)[0]).toMatchObject({ inferenceStatus:'unknown',ok:false,detail:expect.stringMatching(/暫停|額度|過期/) });
  }
});

it('健康時的提早補測與例行探測分開，兩次額外名額用完後仍可在六小時到期時檢查', async () => {
  let now = 0;
  let extra = 0;
  const regular: number[] = [];
  const schedule = new InferenceSchedule(() => now);
  const probe = async (early: boolean) => {
    if (!early) regular.push(now / 60000);
    else if (++extra > 2) return 'unavailable' as const;
    return true;
  };
  for (let minute = 0; minute <= 750; minute++) {
    now = minute * 60000;
    if (minute) schedule.request();
    await schedule.tick(probe);
  }
  expect(regular).toEqual([0, 390, 750]);
});
