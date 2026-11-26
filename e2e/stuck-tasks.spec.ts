import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  defaultState,
  emitDashboardEvent,
  failedInferenceHealth,
  mockDashboard,
  stuckTasks,
  task,
} from "./dashboard-fixture";

const [queued, pending] = stuckTasks;

for (const width of [375, 1280]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${width === 375 ? "手機" : "桌面"}${theme === "dark" ? "深色" : "淺色"}收件匣`, () => {
      test.use({
        viewport: { width, height: 812 },
        colorScheme: theme,
        reducedMotion: "reduce",
      });

      test("卡住的任務逐筆顯示原因，鍵盤可開啟正確的下一步", async ({
        page,
      }) => {
        await mockDashboard(page, {
          state: {
            tasks: [
              task,
              {
                ...task,
                id: queued.taskId,
                title: queued.title,
                status: "queued",
              },
            ],
            stuckTasks,
          },
        });
        await page.goto("/");
        const section = page.getByRole("region", { name: "卡住的任務" });
        const rows = section.getByRole("listitem");
        await expect(rows).toHaveCount(2);
        for (const entry of stuckTasks) {
          const row = rows.filter({ hasText: entry.title });
          const reason = row.getByText(entry.reason, { exact: true });
          await expect(reason).toBeVisible();
          const action = row.getByRole("button", {
            name: new RegExp(entry.actionLabel),
          });
          await expect(action).toBeVisible();
          if (width === 375) {
            const box = await action.boundingBox();
            const text = await reason.boundingBox();
            expect(box?.height).toBeGreaterThanOrEqual(44);
            expect(box?.width).toBeGreaterThanOrEqual(44);
            expect(box!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
          }
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        expect(
          await page
            .locator("html")
            .evaluate((html) => html.classList.contains("dark")),
        ).toBe(theme === "dark");
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() =>
          Promise.allSettled(
            document.getAnimations().map((animation) => animation.finished),
          ),
        );
        const { violations } = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        expect(violations).toEqual([]);

        await section
          .getByRole("button", { name: new RegExp(pending.actionLabel) })
          .press("Enter");
        const drawer = page.getByRole("dialog", { name: task.title });
        await expect(drawer).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
        await section
          .getByRole("button", { name: new RegExp(queued.actionLabel) })
          .press("Enter");
        await expect(page).toHaveURL(/\/system(?:\?|$)/);
        await expect(
          page.getByRole("heading", { name: "同時執行", exact: true }),
        ).toBeVisible();
      });
    });
  }
}

test("舊版未回傳提醒時仍可使用收件匣，更新後新增和解除提醒", async ({
  page,
}) => {
  await mockDashboard(page);
  let reported: typeof stuckTasks | undefined;
  await page.route(/\/api\/state(\?|$)/, (route) =>
    route.fulfill({
      json: { ...defaultState, tasks: [], stuckTasks: reported, stuckTasksTotal: reported?.length },
    }),
  );
  await page.goto("/");
  const section = page.getByRole("region", { name: "卡住的任務" });
  const clear = page.getByText("都處理完了", { exact: true });
  await expect(clear).toBeVisible();
  await expect(section).toHaveCount(0);

  reported = [pending];
  await emitDashboardEvent(page, "update");
  await expect(section).toBeVisible();
  await expect(clear).toBeHidden();

  reported = [];
  await emitDashboardEvent(page, "update");
  await expect(clear).toBeVisible();
  await expect(section).toHaveCount(0);
});

test("成員看到需要管理者處理的原因，可以開任務但不會進到系統頁", async ({
  page,
}) => {
  await mockDashboard(page, {
    state: { stuckTasks: [{ ...queued, taskId: task.id, title: task.title }] },
    routes: {
      "/api/me": {
        id: "2",
        login: "demoMember",
        role: "member",
        csrf: "demo267",
      },
    },
  });
  await page.goto("/");
  const section = page.getByRole("region", { name: "卡住的任務" });
  await expect(section.getByText(queued.reason, { exact: true })).toBeVisible();
  await expect(
    section.getByText("請管理者查看系統。", { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByRole("button", { name: new RegExp(queued.actionLabel) }),
  ).toHaveCount(0);
  await section.getByRole("button", { name: /查看任務/ }).press("Enter");
  await expect(page.getByRole("dialog", { name: task.title })).toBeVisible();
});

test("系統執行分頁在訂閱帳戶可用但推論失敗時顯示上游原因", async ({ page }) => {
  const detail = "真實推論未通過：訂閱上游回應失敗（上游 HTTP 502）。耗時 27 毫秒，請檢查訂閱代理。";
  const text = `服務異常：Codex 訂閱推論。${detail}`;
  await mockDashboard(page, {
    state: {
      settings: { ...defaultState.settings, ai_mode: "subscription" },
      health: failedInferenceHealth,
      alerts: [{ id: "notice267", task_id: null, title: null, kind: "service_down", disposition: "inbox", text, created_at: "2026-01-01T08:00:00Z" }],
      alertsSeenAt: null,
    },
  });
  await page.goto("/system?tab=execution");
  const execution = page.getByRole("tabpanel", { name: /^執行/ });
  const inference = execution.getByRole("region", { name: "Codex 訂閱推論" });
  await expect(
    inference.getByRole("heading", { name: "Codex 訂閱推論" }),
  ).toBeVisible();
  await expect(inference.getByText("異常", { exact: true })).toBeVisible();
  await expect(inference.getByText(detail, { exact: true })).toBeVisible();
  await expect(page.getByText(/Codex 訂閱推論\s*連線異常，恢復前相關功能會停擺/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("推論異常.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: /^通知(?:，|$)/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText(text, { exact: true })).toBeVisible();
  await menu.screenshot({ path: test.info().outputPath("異常通知.png"), animations: "disabled" });
  await page.goto("/settings?tab=connections");
  const service = page.getByRole("listitem").filter({
    has: page.getByText("Codex 訂閱推論", { exact: true }),
  });
  await expect(service.getByText("異常", { exact: true })).toBeVisible();
  await expect(service).toContainText(detail);
});
