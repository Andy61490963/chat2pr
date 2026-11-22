import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  discordOnlySetup,
  firstSetupHealth,
  group,
  mockDashboard,
  project,
  task,
  unverifiedProject,
} from "./dashboard-fixture";

test("有可派工的群組綁定時，未配對私訊通知也完成首次設定", async ({ page }) => {
  await mockDashboard(page, { state: { health: firstSetupHealth } });
  await page.goto("/");
  await expect(
    page.getByText(task.title, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "開始使用" })).toHaveCount(0);
});

test("唯一群組綁到未驗證專案時，手機仍顯示必須設定與選配", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page, {
    state: {
      health: firstSetupHealth,
      projects: [project, unverifiedProject],
      groups: [{ ...group, project_ids: [unverifiedProject.id] }],
    },
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "必須設定", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "選配", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("必須設定已完成 5 / 6")).toBeVisible();
  await expect(
    page.getByText("群組已綁定可派工的專案", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("管理者私訊通知已配對", { exact: true })).toBeVisible();
  const action = page.getByRole("button", { name: /^前往.*群組已綁定/ });
  expect(
    await action.evaluate((element) => (element as HTMLElement).offsetHeight),
  ).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished)),
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations).toEqual([]);
});

test("只接通 Discord 且有可派工的綁定時，首次設定完成", async ({ page }) => {
  await mockDashboard(page, { state: discordOnlySetup });
  await page.goto("/");
  await expect(
    page.getByText(task.title, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "開始使用" })).toHaveCount(0);
});
