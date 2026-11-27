import { expect, it } from "vitest";
import { visibleHealth } from "../server/inference-health.js";

const login = { name: "codex", ok: false, detail: "服務的 Codex 尚未登入，請重新登入。", checked_at: new Date(60000) };
const gate = { name: "codex_subscription_gate", ok: true, detail: "額度可用", checked_at: new Date(0) };
const failure = { name: "codex_inference", ok: false, detail: "訂閱上游回應失敗", checked_at: new Date(0) };

it.each([
  { scenario: "已有推論失敗讀數", probes: [failure] },
  { scenario: "尚無推論讀數", probes: [] },
  { scenario: "先前推論成功", probes: [{ ...failure, ok: true, detail: "真實推論成功" }] },
])("登入失效且$scenario 時，以登入故障的原因與確認時間標示異常", ({ probes }) => {
  const rows = visibleHealth([login, gate, ...probes], 60000);
  for (const name of [login.name, gate.name]) {
    expect(rows.find(row => row.name === name)).toMatchObject({ ok: false, inferenceStatus: "failed", detail: login.detail, checked_at: login.checked_at });
  }
  expect(rows.find(row => row.name === gate.name)?.quota).toMatchObject({ ok: true, detail: gate.detail });
});
