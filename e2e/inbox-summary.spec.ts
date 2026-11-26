import { expect, test } from "@playwright/test";
import {
  inboxDetailUnavailable,
  mockDashboard,
  summaryActivity,
  summaryTasks,
  task,
} from "./dashboard-fixture";

test("收件匣初次讀取失敗後只顯示原因，按重試可讀到待決策案件", async ({ page }) => {
  await mockDashboard(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const stateRequest = /\/api\/state(\?|$)/;
  await page.route(stateRequest, async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: { error: inboxDetailUnavailable } });
  }, { times: 1 });
  const main = page.getByRole("main");
  const loading = main.getByText(/^(載入中…|正在讀取收件匣)$/);
  try {
    await page.goto("/");
    await expect(loading).toBeVisible();
  } finally {
    release();
  }
  const alert = main.getByRole("alert");
  await expect(alert).toContainText(inboxDetailUnavailable);
  await expect(loading).toBeHidden();
  const successfulRead = page.waitForResponse((response) => stateRequest.test(response.url()) && response.ok());
  await main.getByRole("button", { name: "重試", exact: true }).press("Enter");
  await successfulRead;
  await expect(main.getByRole("list", { name: "待決策佇列" })).toContainText(task.title);
  await expect(alert).toBeHidden();
});

test("決定分頁不重複預覽動態，切到動態便能看到四組任務", async ({ page }) => {
  await mockDashboard(page, { state: { tasks: summaryTasks, activity: summaryActivity } });
  await page.goto("/");
  const feed = page.getByRole("region", { name: "最近動態" });
  await expect(page.getByRole("tab", { name: /^決定/ })).toHaveAttribute("aria-selected", "true");
  await expect(feed).toBeHidden();
  await page.getByRole("tab", { name: /^動態/ }).press("Enter");
  for (const { title } of summaryTasks)
    await expect(feed.getByRole("button", { name: title, exact: true })).toBeVisible();
});
