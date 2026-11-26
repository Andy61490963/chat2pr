import { expect, test } from "@playwright/test";
import { completedRun, detail, mockDashboard, task } from "./dashboard-fixture";

test("執行紀錄直接顯示代理失敗原因，四次重連被拒和其他錯誤仍可查看原文", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const run = {
    ...completedRun, observed: true, outcome: "failed",
    upstream_failure: { kind: "upstream_http", status: 400 },
  };
  const reconnects = Array.from(
    { length: 4 },
    (_, i) =>
      `Reconnecting... ${i + 1}/4 (unexpected status 403 Forbidden: {"error":{"message":"訂閱轉送失敗，未使用其他計費方式"}}, url: http://relay.example.test/responses)`,
  );
  const denied = "示範服務讀取檔案時回應 HTTP 403";
  const event = { at: run.started_at, phase: "code" };
  await mockDashboard(page, {
    routes: {
      [`/api/tasks/${task.id}`]: { ...detail, runs: [run] },
      [`/api/tasks/${task.id}/runs/${run.id}/events`]: {
        events: [
          ...[denied, ...reconnects].map((detail, index) => ({
            ...event,
            seq: index + 1,
            kind: "error",
            detail,
          })),
          {
            ...event,
            seq: 6,
            kind: "phase_end",
            exitCode: 1,
            detail: "auth（HTTP 401）",
          },
        ],
        hasOlder: false,
        nextBefore: null,
      },
    },
  });
  await page.goto(`/tasks?task=${task.id}`);
  const drawer = page.getByRole("dialog", { name: task.title });
  await drawer.getByRole("tab", { name: /^執行紀錄/ }).click();
  const events = drawer.getByRole("list", { name: "執行事件" });
  const observer = drawer.getByRole("region", { name: "Codex 執行紀錄" });
  await expect(observer.getByText(/訂閱上游回應失敗（上游 HTTP 400）/)).toBeVisible();
  await expect(observer.getByText(/訂閱登入已失效或無法刷新/)).toHaveCount(0);
  const end = events.getByRole("listitem").filter({ has: page.getByText("階段結束", { exact: true }) });
  await end.getByText("檢視內容", { exact: true }).click();
  await expect(end.getByText("auth（HTTP 401）", { exact: true })).toBeVisible();

  const retries = events.getByRole("listitem").filter({
    has: page.getByText("重連被拒（HTTP 403）", { exact: true }),
  });
  await expect(retries).toHaveCount(4);
  await retries.first().getByText("檢視內容", { exact: true }).click();
  await expect(
    retries.first().getByText(reconnects[0], { exact: true }),
  ).toBeVisible();

  const error = events.getByRole("listitem").filter({
    has: page.getByText("錯誤", { exact: true }),
  });
  await expect(error).toHaveCount(1);
  await error.getByText("檢視內容", { exact: true }).click();
  await expect(error.getByText(denied, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});
