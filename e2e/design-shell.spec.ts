import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  completedRun,
  detail,
  mockDashboard,
  mockInboxReview,
  task,
} from "./dashboard-fixture";

test.use({
  viewport: { width: 1440, height: 900 },
  colorScheme: "light",
  reducedMotion: "reduce",
});

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const dir = process.env.DESIGN_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, name + ".png"),
      animations: "disabled",
    });
  }
}

test("收件匣並列佇列與所選任務，鍵盤可移動到下一筆", async ({ page }) => {
  const { tasks } = await mockInboxReview(page);
  await page.goto("/");
  const queue = page.getByRole("list", { name: "待決策佇列" });
  const row = (index: number) =>
    queue.getByRole("button", { name: new RegExp(tasks[index].title) });
  await row(0).press("j");
  await expect(row(1)).toBeFocused();
  await row(1).press("k");
  await expect(row(0)).toBeFocused();
  await expect(
    page
      .getByRole("region", { name: "審核面板" })
      .getByRole("heading", { name: tasks[0].title }),
  ).toBeVisible();
  await capture(page, "收件匣");
});

test("任務詳情以任務名稱標示審核抽屜，可用 Escape 關閉", async ({ page }) => {
  await mockDashboard(page);
  await page.clock.setFixedTime(new Date("2026-01-01T12:00:00Z"));
  await page.goto(`/tasks?task=${task.id}`);
  const dialog = page.getByRole("dialog", { name: task.title });
  await expect(dialog.getByRole("tab", { selected: true })).toBeVisible();
  await capture(page, "任務詳情");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("側欄可用鍵盤開啟設定，頁首接住焦點", async ({ page }) => {
  await mockDashboard(page);
  await page.clock.setFixedTime(new Date("2026-01-01T12:00:00Z"));
  await page.goto("/");
  const settings = page
    .getByRole("navigation", { name: "看板導覽" })
    .getByRole("button", { name: "設定", exact: true });
  await settings.press("Enter");
  await expect(settings).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "設定", level: 1 }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "AI 執行模式" }),
  ).toBeVisible();
  await capture(page, "設定");
});

test("執行觀察頁可從分頁開啟並讀到執行結果", async ({ page }) => {
  const ready = { ...task, status: "ready" as const };
  await mockDashboard(page, {
    state: { tasks: [ready] },
    routes: {
      [`/api/tasks/${ready.id}`]: {
        ...detail,
        task: ready,
        runs: [completedRun],
      },
      [`/api/tasks/${ready.id}/runs/${completedRun.id}/events`]: {
        events: [],
        hasOlder: false,
        nextBefore: null,
      },
    },
  });
  await page.clock.setFixedTime(new Date("2026-01-01T12:00:00Z"));
  await page.goto(`/tasks?task=${ready.id}`);
  const tab = page.getByRole("tab", { name: /^執行紀錄/ });
  await tab.press("Enter");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const run = page.getByRole("region", { name: "Codex 執行紀錄" });
  const outcome = run.getByText("執行結果", { exact: true });
  await expect(run.getByText("執行已結束", { exact: true })).toBeVisible();
  await run.evaluate(el => el.scrollIntoView({ block: "center" }));
  await expect(outcome).toBeInViewport({ ratio: 1 });
  await capture(page, "執行觀察");
});
