import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { group, mockDashboard } from "./dashboard-fixture";

const hint = /近 30 天建立的修改需求多半被拒絕/;

for (const width of [1440, 375]) {
  test(`群組詳情顯示近 30 天修改需求數，拒絕多時建議改成指令觸發（${width}px）`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockDashboard(page, {
      state: {
        groups: [
          { ...group, change_stats: { created: 24, approved: 0, rejected: 24 } },
        ],
      },
    });
    await page.goto("/groups");
    await page.getByRole("button", { name: new RegExp(group.name) }).click();
    const sheet = page.getByRole("dialog", { name: group.name });
    await expect(
      sheet.getByRole("heading", { name: "近 30 天的修改需求" }),
    ).toBeVisible();
    const counts = sheet.locator("dl").filter({ hasText: "建立" });
    await expect(counts.locator("dt")).toHaveText(["建立", "核准", "拒絕"]);
    await expect(counts.locator("dd")).toHaveText(["24 筆", "0 筆", "24 筆"]);
    await expect(sheet.getByText(hint)).toContainText("「指令與引用追問」");

    // 在表單上先改成指令模式時，提示就不再顯示。
    await sheet.getByRole("combobox", { name: "需求觸發方式" }).click();
    await page.getByRole("option", { name: "指令與引用追問" }).click();
    await expect(sheet.getByText(hint)).toHaveCount(0);
    await sheet.getByRole("combobox", { name: "需求觸發方式" }).click();
    await page.getByRole("option", { name: "自動辨識" }).click();
    await expect(sheet.getByText(hint)).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await sheet.getByText(hint).scrollIntoViewIfNeeded();
    await testInfo.attach(`群組修改需求數-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    const { violations } = await new AxeBuilder({ page })
      .include('[data-slot="sheet-content"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(violations).toEqual([]);
  });
}

test("拒絕比例不高或已是指令觸發的群組不顯示建議", async ({ page }) => {
  await mockDashboard(page, {
    state: {
      groups: [
        group,
        {
          ...group,
          id: "group-command",
          name: "指令範例群組",
          trigger_mode: "command",
          change_stats: { created: 9, approved: 0, rejected: 9 },
        },
      ],
    },
  });
  await page.goto("/groups");
  for (const name of [group.name, "指令範例群組"]) {
    await page.getByRole("button", { name: new RegExp(name) }).click();
    const sheet = page.getByRole("dialog", { name });
    await expect(
      sheet.getByRole("heading", { name: "近 30 天的修改需求" }),
    ).toBeVisible();
    await expect(sheet.getByText(hint)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
});
