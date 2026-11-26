import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { join } from "node:path";
import { emitDashboardEvent, inboxDetailUnavailable, mockInboxReview } from "./dashboard-fixture";

async function waitForLayout(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
    await Promise.allSettled(Array.from(document.images, (image) => image.decode()));
  });
}

async function capture(page: Page, info: TestInfo, name: string) {
  await waitForLayout(page);
  const directory = process.env.INBOX_SHOT_DIR;
  const body = await page.screenshot({
    animations: "disabled",
    path: directory ? join(directory, `${name}.png`) : info.outputPath(`${name}.png`),
  });
  await info.attach(name, { body, contentType: "image/png" });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const colorScheme of ["dark", "light"] as const) {
    const label = `${viewport.width}x${viewport.height}-${colorScheme === "dark" ? "深色" : "淺色"}`;
    const mobile = viewport.width === 375;
    test.describe(label, () => {
      test.use({ viewport, colorScheme, reducedMotion: "reduce", timezoneId: "Asia/Taipei" });

      test("列上快速核准截圖", async ({ page }, info) => {
        const { tasks } = await mockInboxReview(page);
        await page.goto("/");
        const row = page.getByRole("list", { name: "待決策佇列" })
          .getByRole("listitem").filter({ hasText: tasks[0].title });
        const approve = row.getByRole("button", { name: /核准修改/ });
        await expect(approve).toBeEnabled();
        await approve.focus();
        await expect(approve).toBeInViewport();
        await capture(page, info, `${label}-列上快速核准`);
      });

      test("收件匣六種狀態截圖", async ({ page }, info) => {
        const { tasks, state } = await mockInboxReview(page);
        const [first, , , long] = tasks;
        const queue = page.getByRole("list", { name: "待決策佇列" });
        const review = mobile
          ? page.getByRole("dialog")
          : page.getByRole("region", { name: "審核面板" });
        const shot = (stateName: string) => capture(page, info, `${label}-${stateName}`);
        await page.goto("/");
        await expect(queue.getByRole("listitem")).toHaveCount(tasks.length);
        await expect(page.getByRole("region", { name: "卡住的任務" })).toContainText(first.title);
        if (!mobile) await expect(review.getByRole("heading", { name: first.title })).toBeVisible();
        expect(await page.locator("html").evaluate((html) => html.classList.contains("dark"))).toBe(colorScheme === "dark");
        await shot("多筆待決策");
        await page.goto(`/?review=${long.id}`);
        const approve = review.getByRole("button", { name: /確認專案與分支並核准修改/ });
        await expect(approve).toBeEnabled();
        await shot("選中長原文");

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const endpoint = `**/api/tasks/${long.id}`;
        await page.route(endpoint, async (route) => {
          await gate;
          await route.fulfill({ status: 503, json: { error: inboxDetailUnavailable } });
        });
        try {
          await page.reload();
          await expect(review.getByRole("status").filter({ hasText: /載入|讀取/ })).toBeVisible();
          await shot("載入審核中");
        } finally {
          release();
        }
        await expect(review.getByRole("alert")).toContainText(inboxDetailUnavailable);
        await shot("載入審核失敗");
        await page.unroute(endpoint);
        await review.getByRole("button", { name: /重新載入|再試一次/ }).click();
        await expect(approve).toBeEnabled();
        await page.goto("/");
        await expect(queue.getByRole("listitem")).toHaveCount(tasks.length);
        await emitDashboardEvent(page, "error");
        await expect(page.getByRole("status").filter({ hasText: /重新連線/ })).toBeVisible({ timeout: 10000 });
        await shot("即時更新離線");
        await emitDashboardEvent(page, "connected");
        state.tasks = [];
        state.stuckTasks = [];
        await emitDashboardEvent(page, "update");
        await expect(page.getByRole("heading", { name: "都處理完了" })).toBeVisible();
        await expect(queue).toHaveCount(0);
        await shot("空佇列");
      });

      test("待決策佇列與長原文審核面板通過無障礙檢查", async ({ page }) => {
        const { tasks } = await mockInboxReview(page);
        await page.goto("/");
        const queue = page.getByRole("list", { name: "待決策佇列" });
        await expect(queue.getByRole("listitem")).toHaveCount(tasks.length);
        const check = async () => {
          await waitForLayout(page);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
          const { violations } = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          expect(violations).toEqual([]);
        };
        await check();
        await queue.getByRole("button", { name: new RegExp(tasks[3].title) }).press("Enter");
        const review = mobile ? page.getByRole("dialog") : page.getByRole("region", { name: "審核面板" });
        await expect(review.getByRole("button", { name: /確認專案與分支並核准修改/ })).toBeFocused();
        await check();
      });
    });
  }
}
