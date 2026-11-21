import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  activityTask,
  changedCleanup,
  defaultState,
  derivedImageCleanup,
  detail,
  mockDashboard,
  recentActivity,
  repeatedActivity,
  unchangedCleanup,
} from "./dashboard-fixture";

for (const width of [1280, 375]) {
  test(`最近動態合併同日任務，可用鍵盤展開及開啟詳情（${width}px）`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 812 });
    await mockDashboard(page, {
      state: {
        tasks: [activityTask],
        activity: [derivedImageCleanup, ...recentActivity],
      },
      routes: {
        [`/api/tasks/${activityTask.id}`]: { ...detail, task: activityTask },
      },
    });
    await page.goto("/");
    const feed = page.getByRole("region", { name: "最近動態" });
    const title = feed.getByRole("button", {
      name: activityTask.title,
      exact: true,
    });
    await expect(title).toHaveCount(1);
    await expect(feed.getByText("已回覆", { exact: true })).toBeVisible();
    await expect(feed.getByText("16:30", { exact: true })).toBeVisible();
    await expect(feed.getByText(repeatedActivity, { exact: true })).toHaveCount(
      1,
    );
    await expect(feed.getByText("共 2 次", { exact: true })).toBeVisible();
    // 例行 Docker 清理不論有沒有清到東西，都只在系統紀錄。
    await expect(feed.getByText(changedCleanup, { exact: true })).toHaveCount(
      0,
    );
    const system = feed.getByRole("button", { name: "顯示系統紀錄" });
    const unchanged = feed.getByText(unchangedCleanup, { exact: true });
    const derivedCleanup = feed.getByText(derivedImageCleanup.detail, {
      exact: true,
    });
    await expect(unchanged).toHaveCount(0);
    await expect(derivedCleanup).toHaveCount(0);
    await system.press("Enter");
    await expect(unchanged).toBeVisible();
    await expect(derivedCleanup).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await expect(feed.getByText(changedCleanup, { exact: true })).toBeVisible();
    await feed.getByRole("button", { name: "隱藏系統紀錄" }).press("Enter");
    await expect(unchanged).toHaveCount(0);
    await expect(derivedCleanup).toHaveCount(0);

    const expand = feed.getByRole("button", { name: /^展開步驟/ });
    const steps = feed.getByRole("list", { name: "任務步驟" });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(steps).toHaveCount(0);
    if (width === 375) {
      for (const target of [title, expand, system]) {
        const bounds = (await target.boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
      }
    }
    await expand.press("Enter");
    await expect(
      feed.getByRole("button", { name: /^收合步驟/ }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(steps.getByRole("listitem")).toHaveText([
      /16:10.*已自動排程/,
      /16:20.*開始調查/,
      /16:30.*查詢已回覆$/,
    ]);
    await expect(
      feed.getByText(activityTask.title, { exact: true }),
    ).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.evaluate(() => document.fonts.ready);
    const { violations } = await new AxeBuilder({ page })
      .include("section[aria-label='最近動態']")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ).toEqual([]);
    await testInfo.attach(`最近動態展開（${width}px）`, {
      body: await page.screenshot({ animations: "disabled", fullPage: true }),
      contentType: "image/png",
    });

    await title.press("Enter");
    await expect(
      page.getByRole("dialog", { name: activityTask.title }),
    ).toBeVisible();
  });
}

test("載入較早的稽核紀錄後，既有任務列接上更早的步驟", async ({ page }) => {
  const scheduled = recentActivity.at(-1)!;
  const noChange = recentActivity.find(
    ({ detail }) => detail === unchangedCleanup,
  )!;
  const firstPage = [
    ...recentActivity.slice(0, -1),
    ...Array.from({ length: 74 }, (_, index) => ({
      ...noChange,
      id: 100 + index,
    })),
  ];
  const activity = [...firstPage, scheduled];
  await mockDashboard(page);
  await page.route("**/api/state?activity=*", (route) => {
    const limit = Number(
      new URL(route.request().url()).searchParams.get("activity"),
    );
    return route.fulfill({
      json: {
        ...defaultState,
        tasks: [activityTask],
        totals: {
          tasks: 1,
          activity: activity.length,
          byStatus: { answered: 1 },
          mergedWeek: 0,
          unfinishedOmitted: 0,
        },
        activity: activity.slice(0, limit),
      },
    });
  });
  await page.goto("/");
  const feed = page.getByRole("region", { name: "最近動態" });
  const title = feed.getByRole("button", {
    name: activityTask.title,
    exact: true,
  });
  await expect(title).toHaveCount(1);
  await feed.getByRole("button", { name: /^展開步驟/ }).click();
  const steps = feed.getByRole("list", { name: "任務步驟" });
  await expect(steps.getByRole("listitem")).toHaveCount(2);
  await expect(
    feed.getByText("已載入 80 筆紀錄，還有 1 筆紀錄未載入"),
  ).toBeVisible();
  await feed.getByRole("button", { name: "載入更多" }).click();
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  await expect(steps.getByText(/已自動排程/)).toBeVisible();
  await expect(title).toHaveCount(1);
  await expect(feed.getByRole("button", { name: "載入更多" })).toHaveCount(0);
});
