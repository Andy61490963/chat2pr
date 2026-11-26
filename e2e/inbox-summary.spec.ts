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

test("最近動態起初只顯示前三組，按看更多才出現第四組", async ({ page }) => {
  await mockDashboard(page, { state: { tasks: summaryTasks, activity: summaryActivity } });
  await page.goto("/");
  const feed = page.getByRole("region", { name: "最近動態" });
  const groups = summaryTasks.map(({ title }) => feed.getByRole("button", { name: title, exact: true }));
  for (const group of groups.slice(0, 3)) await expect(group).toBeVisible();
  await expect(groups[3]).toBeHidden();
  await feed.getByRole("button", { name: "看更多", exact: true }).press("Enter");
  for (const group of groups) await expect(group).toBeVisible();
});
