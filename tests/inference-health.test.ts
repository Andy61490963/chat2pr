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
  expect(visibleHealth([...prerequisites, failure])).toMatchObject(
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
  await schedule.tick(async () => false);
  await schedule.tick(probe);
  expect(probe).toHaveBeenCalledTimes(3);
});
