import { expect, test } from "@playwright/test";
import { completedRun, detail, mockDashboard, task } from "./dashboard-fixture";

test("執行紀錄直接顯示代理失敗原因，四次重連被拒和其他錯誤仍可查看原文", async ({ page }) => {
  const run = { ...completedRun, observed: true, outcome: "failed" };
  const reconnects = Array.from({ length: 4 }, (_, i) =>
    `Reconnecting... ${i + 1}/4 (unexpected status 403 Forbidden)`,
  );
  const denied = "示範服務讀取檔案時回應 HTTP 403";
  const event = { at: run.started_at, phase: "code" };
  await mockDashboard(page, {
    routes: {
      [`/api/tasks/${task.id}`]: { ...detail, runs: [run] },
      [`/api/tasks/${task.id}/runs/${run.id}/events`]: {
        events: [
          ...[denied, ...reconnects].map((detail, index) => ({
            ...event, seq: index + 1, kind: "error", detail,
          })),
          { ...event, seq: 6, kind: "phase_end", exitCode: 1, detail: "upstream_http（HTTP 400）" },
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
  await expect(events.getByText(/訂閱上游回應失敗（上游 HTTP 400）/)).toBeVisible();

  const retries = events.getByRole("listitem").filter({
    has: page.getByText("重連被拒（HTTP 403）", { exact: true }),
  });
  await expect(retries).toHaveCount(4);
  await retries.first().getByText("檢視內容", { exact: true }).click();
  await expect(retries.first().getByText(reconnects[0], { exact: true })).toBeVisible();

  const error = events.getByRole("listitem").filter({
    has: page.getByText("錯誤", { exact: true }),
  });
  await expect(error).toHaveCount(1);
  await error.getByText("檢視內容", { exact: true }).click();
  await expect(error.getByText(denied, { exact: true })).toBeVisible();
});
