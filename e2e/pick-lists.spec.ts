import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { PickList } from "../shared/pick-list";
import { defaultState, group, mockDashboard, task } from "./dashboard-fixture";

const list: PickList = {
  id: "example-meeting",
  groupId: group.id,
  version: 1,
  items: [
    "調整首頁色彩",
    "縮短說明文字",
    "對齊表格欄位",
    "更新匯出檔名",
    "增加空白提示",
    "調整列印版面",
  ].map((title, index) => ({
    id: `example-item-${index}`,
    title,
    summary: `${title}並保留原有功能。`,
  })),
};

for (const width of [1280, 375]) {
  test(`可以在 ${width}px 勾選並建立兩張待確認任務`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockDashboard(page, { state: { tasks: [], pickLists: [list] } });
    await page.route(`**/api/pick-lists/${list.id}/resolve`, async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({
        version: list.version,
        itemIds: [list.items[0].id, list.items[4].id],
      });
      await page.route("**/api/state?*", (stateRoute) =>
        stateRoute.fulfill({
          json: {
            ...defaultState,
            pickLists: [],
            tasks: [list.items[0], list.items[4]].map((item) => ({
              ...task,
              id: item.id,
              title: item.title,
              summary: item.summary,
              mode: "change",
            })),
          },
        }),
      );
      await route.fulfill({ json: { created: 2 } });
    });
    await page.goto("/");
    const card = page.getByRole("article", { name: "待挑選清單" });
    await expect(card.getByText(group.name)).toBeVisible();
    await expect(card.getByRole("checkbox")).toHaveCount(6);
    const first = card.getByRole("checkbox", { name: list.items[0].title });
    await expect(first).toHaveAccessibleDescription(list.items[0].summary);
    const create = card.getByRole("button", { name: "建立選取的任務" });
    await expect(create).toBeDisabled();
    await first.focus();
    await page.keyboard.press("Space");
    await expect(first).toBeChecked();
    expect(
      await first.evaluate((input) => getComputedStyle(input).outlineStyle),
    ).toBe("solid");
    await card.getByText(list.items[4].title, { exact: true }).click();
    expect(
      await card
        .getByText(list.items[4].title, { exact: true })
        .evaluate(
          (title) => title.closest("label")!.getBoundingClientRect().height,
        ),
    ).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    expect(
      (
        await new AxeBuilder({ page })
          .include("article[aria-labelledby^='pick-list-']")
          .analyze()
      ).violations,
    ).toEqual([]);
    await create.click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText("已建立 2 張待確認任務")).toBeVisible();
    await expect(
      page.getByText(list.items[0].title, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(list.items[4].title, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(list.items[1].title, { exact: true }),
    ).toHaveCount(0);
  });
}

test("全部不做可以返回清單，也可以一次結束", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page, { state: { tasks: [], pickLists: [list] } });
  await page.route(`**/api/pick-lists/${list.id}/resolve`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      version: list.version,
      itemIds: [],
    });
    await page.route("**/api/state?*", (stateRoute) =>
      stateRoute.fulfill({
        json: { ...defaultState, pickLists: [], tasks: [] },
      }),
    );
    await route.fulfill({ json: { created: 0 } });
  });
  await page.goto("/");
  const card = page.getByRole("article", { name: "待挑選清單" });
  const dismiss = card.getByRole("button", { name: "全部不做" });
  const dialog = page.getByRole("dialog", { name: "這 6 項待辦全部不做？" });
  await dismiss.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "返回清單" }).click();
  await expect(dismiss).toBeFocused();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "全部不做" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("已選擇全部不做，清單已結束")).toBeVisible();
  await expect(page.getByText("都處理完了")).toBeVisible();
});
