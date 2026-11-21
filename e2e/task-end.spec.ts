import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  cancelledTask,
  closedPrTask,
  detail,
  mockDashboard,
  rejectedTask,
} from "./dashboard-fixture";

for (const width of [375, 1280]) {
  for (const theme of ["light", "dark"] as const) {
    test(`已結束任務在 ${width}px 的${theme === "light" ? "淺色" : "深色"}看板說明結束方式`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const tasks = [rejectedTask, cancelledTask, closedPrTask];
      await mockDashboard(page, {
        state: { tasks },
        routes: Object.fromEntries(
          tasks.map((task) => [`/api/tasks/${task.id}`, { ...detail, task }]),
        ),
      });
      await page.goto("/tasks");
      await page.getByRole("tab", { name: /^進行中與待處理/ }).focus();
      await page.keyboard.press("ArrowRight");
      const panel = page.getByRole("tabpanel", { name: /^已結束/ });
      const rejected = panel.getByRole("button", {
        name: new RegExp(rejectedTask.title),
      });
      await expect(rejected.getByText("已拒絕", { exact: true })).toBeVisible();
      await expect(rejected).toContainText("小林於 11/20 拒絕");
      await expect(rejected.getByRole("img")).toHaveCount(0);
      const cancelled = panel.getByRole("button", {
        name: new RegExp(cancelledTask.title),
      });
      await expect(
        cancelled.getByText("已取消", { exact: true }),
      ).toBeVisible();
      await expect(cancelled).toContainText("小陳於 11/20 取消");
      await expect(cancelled.getByRole("img")).toHaveCount(0);
      const closed = panel.getByRole("button", {
        name: new RegExp(closedPrTask.title),
      });
      await expect(
        closed.getByText("PR 已關閉", { exact: true }),
      ).toBeVisible();
      await expect(
        closed.getByRole("img", { name: "站別軌道，結束前到達PR站" }),
      ).toBeVisible();
      await expect(panel.getByText("無法判定站別")).toHaveCount(0);
      expect(
        await panel.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      const verifyLayout = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await testInfo.attach(name, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      };
      const scan = async (selector: string) => {
        const { violations } = await new AxeBuilder({ page })
          .include(selector)
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        expect(violations).toEqual([]);
      };
      await verifyLayout("已結束任務清單");
      await scan('[role="tabpanel"][data-state="active"]');

      await cancelled.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog", { name: cancelledTask.title });
      const header = drawer.locator('[data-slot="sheet-header"]');
      const summary = header.getByText(
        /小陳於 11\/20\s+10:30 取消，原因是範例報表已由小林整理/,
      );
      await expect(summary).toBeInViewport();
      await expect(header.getByText("已取消", { exact: true })).toBeVisible();
      await expect(drawer.getByText("無法判定站別")).toHaveCount(0);
      const reopen = header.getByRole("button", { name: "重新開啟" });
      await expect(reopen).toBeInViewport();
      await expect(reopen).toHaveAccessibleDescription(
        "重新開啟後回到待審核，確認專案並核准才會派工。",
      );
      if (width === 375) {
        const bounds = await reopen.boundingBox();
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
        expect(bounds?.width).toBeGreaterThanOrEqual(44);
      }
      await expect(
        drawer
          .getByRole("list", { name: "風險與待確認事項" })
          .getByRole("listitem"),
      ).toHaveText(["共用設備帳密需要人工審核", "設備主檔寫入需要人工審核"]);
      expect(
        await drawer.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      expect(
        await drawer
          .locator(":scope > .overflow-y-auto")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await verifyLayout("已取消任務詳情");
      await scan('[data-slot="sheet-content"]');
    });
  }
}
