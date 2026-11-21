import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockDashboard, projectSectionsState } from "./dashboard-fixture";

async function verifyProjectLayout(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator("#project-sections")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const { violations } = await new AxeBuilder({ page })
    .include("#project-sections")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations).toEqual([]);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test.describe(`專案分區（${viewport.width}px）`, () => {
    test.use({ viewport });

    test("依分區與名稱排列，驗證進度留在原區，未綁定專案可用鍵盤展開", async ({
      page,
    }, info) => {
      await mockDashboard(page, { state: projectSectionsState });
      await page.goto("/projects");
      await expect(page.getByText("共 8 個專案，3 個可派工")).toBeVisible();

      const regions = page.locator("#project-sections").getByRole("region");
      await expect(regions).toHaveCount(3);
      await expect(regions.nth(0)).toHaveAccessibleName("需要處理");
      await expect(regions.nth(1)).toHaveAccessibleName("可派工");
      await expect(regions.nth(2)).toHaveAccessibleName("沒有群組使用（2 個）");

      const attention = regions.nth(0).getByRole("button");
      const ready = regions.nth(1).getByRole("button");
      const unbound = regions.nth(2);
      const summary = unbound.locator("summary");
      const hiddenProjects = unbound.locator("ul");
      await expect(attention).toHaveCount(3);
      await expect(attention.nth(0)).toHaveAccessibleName(/^待處理專案 1 /);
      await expect(attention.nth(0)).toContainText(
        "你的專案正在排隊等待執行器。",
      );
      await expect(attention.nth(1)).toHaveAccessibleName(/^待處理專案 2 /);
      await expect(attention.nth(1)).toContainText("驗證失敗");
      await expect(attention.nth(2)).toHaveAccessibleName(/^待處理專案 10 /);
      await expect(attention.nth(2)).toContainText("找不到儲存庫");
      await expect(ready).toHaveCount(3);
      await expect(ready.nth(0)).toHaveAccessibleName(/^範例專案 1 /);
      await expect(ready.nth(1)).toHaveAccessibleName(/^範例專案 2 /);
      await expect(ready.nth(1)).toContainText("你的專案正在執行基底測試。");
      await expect(ready.nth(2)).toHaveAccessibleName(/^範例專案 10 /);
      await expect(summary).toHaveAccessibleName("沒有群組使用（2 個）");
      await expect(hiddenProjects).toBeHidden();
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await verifyProjectLayout(page);
      await info.attach("專案分區（預設收合）", {
        body: await page.screenshot({ fullPage: true, animations: "disabled" }),
        contentType: "image/png",
      });

      await ready.last().focus();
      await page.keyboard.press("Tab");
      await expect(summary).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(hiddenProjects).toBeVisible();
      const unboundProjects = hiddenProjects.getByRole("button");
      await expect(unboundProjects).toHaveCount(2);
      await expect(unboundProjects.nth(0)).toHaveAccessibleName(/^示範專案 1 /);
      await expect(unboundProjects.nth(0)).toContainText(
        "你的專案正在安裝相依套件。",
      );
      await expect(unboundProjects.nth(1)).toHaveAccessibleName(/^示範專案 2 /);
      await verifyProjectLayout(page);
      await info.attach("專案分區（展開沒有群組使用）", {
        body: await page.screenshot({ fullPage: true, animations: "disabled" }),
        contentType: "image/png",
      });
      await page.keyboard.press("Space");
      await expect(hiddenProjects).toBeHidden();
    });
  });
}

test("沒有待處理的專案時省略需要處理區", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/projects");
  await expect(page.getByText("共 1 個專案，1 個可派工")).toBeVisible();
  await expect(page.getByRole("region", { name: "需要處理" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "可派工" })).toBeVisible();
});
