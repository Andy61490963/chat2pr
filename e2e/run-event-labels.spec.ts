import { expect, test } from "@playwright/test";
import { completedRun, detail, mockDashboard, task } from "./dashboard-fixture";

test("同次執行分列備援提示與推論錯誤，保留事件內容與失敗結果", async ({
  page,
}) => {
  const failed = { ...task, status: "failed" as const };
  const run = { ...completedRun, outcome: "failed", observed: true };
  const fallback =
    "Model metadata for `demo-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
  const failure = "範例推論失敗";
  const events = [fallback, failure].map((detail, i) => ({
    seq: i + 1,
    at: run.started_at,
    phase: "code",
    kind: "error",
    detail,
  }));
  await mockDashboard(page, {
    state: { tasks: [failed] },
    routes: {
      [`/api/tasks/${failed.id}`]: { ...detail, task: failed, runs: [run] },
      [`/api/tasks/${failed.id}/runs/${run.id}/events`]: {
        events,
        hasOlder: false,
        nextBefore: null,
      },
    },
  });
  await page.goto(`/tasks?task=${failed.id}`);
  const drawer = page.getByRole("dialog", { name: failed.title });
  await drawer.getByRole("tab", { name: /^執行紀錄/ }).click();
  const log = drawer.getByRole("list", { name: "執行事件" });
  const rows = log.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  const hint = rows.nth(0);
  const error = rows.nth(1);
  await expect(hint.getByText("提示", { exact: true })).toBeVisible();
  await expect(error.getByText("錯誤", { exact: true })).toBeVisible();
  for (const [row, message] of [
    [hint, fallback],
    [error, failure],
  ] as const) {
    await row.getByText("檢視內容").click();
    await expect(row.getByText(message, { exact: true })).toBeVisible();
  }
  const errorColor = await error
    .getByText("錯誤")
    .evaluate((label) => getComputedStyle(label).color);
  await expect(hint.getByText("提示")).not.toHaveCSS("color", errorColor);
  await expect(
    drawer.locator("dt", { hasText: "執行結果" }).locator("+ dd"),
  ).toHaveText("未完成，需要處理");
});
