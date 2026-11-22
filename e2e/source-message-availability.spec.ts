import { expect, test } from "@playwright/test";
import {
  availabilityChat,
  availabilitySources,
  defaultState,
  detail,
  group,
  mockDashboard,
  task,
} from "./dashboard-fixture";

test.use({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });

test("手機任務詳情分別顯示可讀原文、撤回與到期原因", async ({ page }) => {
  await mockDashboard(page, {
    routes: {
      [`/api/tasks/${task.id}`]: { ...detail, sources: availabilitySources },
    },
  });
  await page.goto(`/tasks?task=${task.id}`);
  const drawer = page.getByRole("dialog", { name: task.title });
  const tabs = drawer.getByRole("tablist", { name: "任務紀錄" });
  const sourcesTab = tabs.getByRole("tab", { name: /來源訊息/ });
  const historyTab = tabs.getByRole("tab", { name: "時間軸" });
  await sourcesTab.press("ArrowRight");
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await historyTab.press("ArrowLeft");
  await expect(sourcesTab).toHaveAttribute("aria-selected", "true");
  const panel = drawer.getByRole("tabpanel", { name: /來源訊息/ });
  await expect(panel.getByText("請整理範例畫面。", { exact: true })).toBeVisible();
  await expect(panel.getByText("此訊息已撤回", { exact: true })).toBeVisible();
  await expect(panel.getByText("原文已超過保存期限（30 天）", { exact: true })).toBeVisible();

  await page.evaluate(() => document.fonts.ready);
  const targets = await tabs.getByRole("tab").evaluateAll((items) =>
    items.map((item) => {
      const tab = item as HTMLElement;
      const { left, right } = tab.getBoundingClientRect();
      return { left, right, height: tab.offsetHeight, width: tab.offsetWidth };
    }),
  );
  for (const [index, target] of targets.entries()) {
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.width).toBeGreaterThanOrEqual(44);
    if (index > 0) expect(target.left).toBeGreaterThanOrEqual(targets[index - 1].right);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test("手機聊天室分別顯示撤回與依設定天數計算的到期原因", async ({ page }) => {
  await mockDashboard(page, {
    state: { settings: { ...defaultState.settings, retention_days: 7 } },
    routes: { [`/api/groups/${group.id}/messages`]: availabilityChat },
  });
  await page.goto(`/chat?group=${encodeURIComponent(group.id)}`);
  await expect(page.getByText("請整理範例畫面。", { exact: true })).toBeVisible();
  await expect(page.getByText("此訊息已撤回", { exact: true })).toBeVisible();
  await expect(page.getByText("原文已超過保存期限（7 天）", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
