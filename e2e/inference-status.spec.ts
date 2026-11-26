import { expect, test } from "@playwright/test";
import {
  defaultState,
  emitDashboardEvent,
  failedInferenceHealth,
  inferenceHealthFixture,
  mockDashboard,
  unknownInferenceScenarios,
} from "./dashboard-fixture";

const scenarios = [
  {
    name: "正常",
    status: "healthy",
    detail: "真實推論成功，耗時 27 毫秒。",
  },
  ...unknownInferenceScenarios,
] as const;

for (const scenario of scenarios) {
  test(`系統頁與連線設定顯示推論${scenario.name}，不誤報服務停擺`, async ({ page }, info) => {
    const paused = "paused" in scenario;
    const quotaBlocked = "quotaBlocked" in scenario;
    const hostHold = "hostHold" in scenario;
    const settings = {
      ...defaultState.settings,
      paused,
      codex_reserve_percent: quotaBlocked ? 20 : 0,
      codex_model: "modelChanged" in scenario ? "demoModelB" : "demoModelA",
    };
    await mockDashboard(page, {
      state: {
        settings,
        health: [
          ...inferenceHealthFixture(scenario.status, scenario.detail, {
            quotaBlocked,
            hoursAgo: "stale" in scenario ? 7 : 0,
          }),
          ...(hostHold ? [{
            name: "host_resources", ok: false, detail: scenario.detail,
            checked_at: new Date().toISOString(),
          }] : []),
        ],
      },
    });
    await page.goto("/system?tab=execution");
    const inference = page.getByRole("region", { name: "Codex 訂閱推論" });
    const label = scenario.status === "healthy" ? "正常" : "未確認";
    const badge = inference.getByText(label, { exact: true });
    await expect(badge).toBeVisible();
    if (scenario.status === "unknown") await expect(badge).not.toHaveClass(/text-(danger|good)\b/);
    await expect(inference.getByText(scenario.detail, { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", {
      name: hostHold ? /^執行.*1 項$/ : "執行", exact: true,
    })).toBeVisible();
    await expect(page.getByText(/連線異常，恢復前相關功能會停擺/)).toHaveCount(0);
    if (quotaBlocked) await expect(page.getByRole("status").filter({ hasText: /保留 20%/ })).toBeVisible();
    if (hostHold) await expect(page.getByRole("status").filter({ hasText: /資源不足，派工自動暫停/ })).toBeVisible();
    if (paused) await expect(page.getByRole("status").filter({ hasText: /派工已暫停，訊息仍會保留/ })).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`推論${scenario.name}.png`),
      fullPage: true,
      animations: "disabled",
    });

    await page.goto("/settings?tab=connections");
    const connections = page.getByRole("tabpanel", { name: /^連線與金鑰/ });
    const row = connections.getByRole("listitem").filter({
      has: page.getByText("Codex 訂閱推論", { exact: true }),
    });
    await expect(connections.getByRole("heading", { name: "服務連線" })).toBeVisible();
    await expect(row).toHaveCount(0);
    await connections.getByText("全部服務", { exact: true }).press("Enter");
    await expect(row.getByText(label, { exact: true })).toBeVisible();
    await expect(row).toContainText(scenario.detail);
    if (scenario.status === "unknown") {
      await expect(row.getByText(label, { exact: true })).not.toHaveClass(/text-(danger|good)\b/);
      await expect(row).not.toContainText("最後確認");
    }
  });
}

test("工作推論成功後，開著的系統頁更新讀數並解除停擺橫幅", async ({ page }, info) => {
  await mockDashboard(page);
  let health = failedInferenceHealth;
  await page.route(/\/api\/state(\?|$)/, (route) =>
    route.fulfill({ json: { ...defaultState, health } }),
  );
  await page.goto("/system?tab=execution");
  const card = page.getByRole("region", { name: "Codex 訂閱推論" });
  const banner = page.getByRole("alert").filter({ hasText: /Codex 訂閱推論.*連線異常/ });
  await expect(card.getByText("異常", { exact: true })).toBeVisible();
  await expect(banner).toBeVisible();

  const detail = "已從實際訂閱工作的成功推論確認可用。";
  health = inferenceHealthFixture("healthy", detail);
  await emitDashboardEvent(page, "update");
  await expect(card.getByText(detail, { exact: true })).toBeVisible();
  await expect(card.getByText("正常", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "執行", exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("推論正常（工作恢復）.png"),
    fullPage: true,
    animations: "disabled",
  });
});
