import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Task } from "../shared/types";
import { detail, mockDashboard, task } from "./dashboard-fixture";

// 失敗說明照 server/failure.ts 的 failureNotice 格式；專案與測試名稱都是虛構的。
const failed: Task = {
  ...task,
  id: "66666666-6666-4666-8666-666666666666",
  title: "修正範例庫存數量",
  mode: "change",
  status: "failed",
  target_branch: "main",
  last_error: [
    "專案問題（執行測試階段）：還沒修改前，目標分支本身就建置或測試失敗。",
    "錯誤重點：失敗的測試（共 2 個）：",
    "・Demo.Shop.Tests.StockTests.Reserve_ShouldLock：Assert.Equal() Failure: Values differ",
    "・Demo.Shop.Tests.StockTests.Release_ShouldUnlock：找不到虛構庫存 B-002",
    "上次通過是 1111111，之後目標分支有 3 個新 commit：https://github.com/demo/shop/compare/1111111...2222222",
    "建議：在看板按「請 AI 修好目標分支」建立修復任務（仍要人工核准），或自行修好目標分支的建置與測試（或改用其他分支）後再到看板重試。",
  ].join("\n"),
};
const repair: Task = {
  ...task,
  id: "77777777-7777-4777-8777-777777777777",
  title: "修復目標分支 main",
  mode: "change",
  status: "awaiting_approval",
  target_branch: "main",
  baseline_repair: true,
  last_error: null,
  summary: "目標分支「main」在修改前就有建置或測試沒有通過，請找出原因並修好。",
};

for (const width of [1280, 375]) {
  test(`基底失敗顯示失敗的測試，並可請 AI 修好目標分支（${width}px）`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    await mockDashboard(page, {
      state: { tasks: [failed] },
      routes: {
        [`/api/tasks/${failed.id}`]: { ...detail, task: failed, queue: null },
        [`/api/tasks/${repair.id}`]: { ...detail, task: repair, queue: null },
      },
    });
    let posted = 0;
    await page.route(`**/api/tasks/${failed.id}/baseline-repair`, (route) => {
      posted++;
      return route.fulfill({ json: repair });
    });
    await page.goto(`/tasks?task=${failed.id}`);
    const drawer = page.getByRole("dialog", { name: failed.title });
    await expect(
      drawer.getByText(
        /Demo\.Shop\.Tests\.StockTests\.Release_ShouldUnlock：找不到虛構庫存 B-002/,
      ),
    ).toBeVisible();
    await expect(
      drawer.getByRole("link", { name: /compare\/1111111/ }),
    ).toBeVisible();
    const fix = drawer.getByRole("button", { name: "請 AI 修好目標分支" });
    await expect(fix).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const { violations } = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .analyze();
    expect(violations).toEqual([]);
    await fix.click();
    expect(posted).toBe(1);
    const opened = page.getByRole("dialog", { name: repair.title });
    await expect(
      opened.getByText("修復目標分支", { exact: true }),
    ).toBeVisible();
    const repaired = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .analyze();
    expect(repaired.violations).toEqual([]);
  });
}
