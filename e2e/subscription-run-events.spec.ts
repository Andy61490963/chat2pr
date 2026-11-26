import { expect, test, type Page } from "@playwright/test";
import type { RunEvent } from "../shared/observation";
import { completedRun, detail, mockDashboard, task } from "./dashboard-fixture";

test("執行紀錄直接顯示代理失敗原因，四次重連被拒和其他錯誤仍可查看原文", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const run = {
    ...completedRun,
    observed: true,
    outcome: "failed",
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
  await expect(
    observer.getByText(/訂閱上游回應失敗（上游 HTTP 400）/),
  ).toBeVisible();
  await expect(observer.getByText(/訂閱登入已失效或無法刷新/)).toHaveCount(0);
  const end = events
    .getByRole("listitem")
    .filter({ has: page.getByText("階段結束", { exact: true }) });
  await end.getByText("檢視內容", { exact: true }).click();
  await expect(
    end.getByText("auth（HTTP 401）", { exact: true }),
  ).toBeVisible();

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

test("舊執行只有階段結束明細時，看板不推測訂閱失敗原因", async ({ page }) => {
  const run = { ...completedRun, observed: true, outcome: "failed" };
  const detailText = "auth（HTTP 401）";
  await mockDashboard(page, {
    routes: {
      [`/api/tasks/${task.id}`]: { ...detail, runs: [run] },
      [`/api/tasks/${task.id}/runs/${run.id}/events`]: {
        events: [
          {
            seq: 1,
            at: run.started_at,
            phase: "review",
            kind: "phase_end",
            exitCode: 1,
            detail: detailText,
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
  const observer = drawer.getByRole("region", { name: "Codex 執行紀錄" });
  const end = observer
    .getByRole("list", { name: "執行事件" })
    .getByRole("listitem");
  await end.getByText("檢視內容", { exact: true }).click();
  await expect(end.getByText(detailText, { exact: true })).toBeVisible();
  await expect(end.getByText("階段結束", { exact: true })).toBeVisible();
  await expect(observer.getByText("訂閱失敗原因", { exact: true })).toHaveCount(
    0,
  );
  await expect(observer.getByText(/訂閱登入已失效或無法刷新/)).toHaveCount(0);
});

async function openRunEvents(page: Page, events: RunEvent[]) {
  const run = { ...completedRun, observed: true };
  await mockDashboard(page, {
    routes: {
      [`/api/tasks/${task.id}`]: { ...detail, runs: [run] },
      [`/api/tasks/${task.id}/runs/${run.id}/events`]: {
        events,
        hasOlder: false,
        nextBefore: null,
      },
    },
  });
  await page.goto(`/tasks?task=${task.id}`);
  const drawer = page.getByRole("dialog", { name: task.title });
  await drawer.getByRole("tab", { name: /^執行紀錄/ }).click();
  return drawer.getByRole("list", { name: "執行事件" });
}

test("指令開始與結束都沒有結束碼時，執行紀錄仍能查看兩筆命令內容", async ({ page }) => {
  const command = "npm run check";
  const result = `${command}\n示範檢查已中斷`;
  const event = { at: completedRun.started_at, phase: "code", exitCode: null };
  const list = await openRunEvents(page, [
    { ...event, seq: 1, kind: "command_start", detail: command },
    { ...event, seq: 2, kind: "command_end", detail: result },
  ]);
  const start = list.getByRole("listitem").filter({ hasText: "開始執行命令" });
  const end = list.getByRole("listitem").filter({ hasText: "命令執行結果" });
  await start.getByText("檢視內容", { exact: true }).click();
  await expect(start.locator("pre")).toHaveText(command);
  await end.getByText("檢視內容", { exact: true }).click();
  await expect(end.locator("pre")).toHaveText(result);
  await expect(list.getByText(/結束碼/)).toHaveCount(0);
});

test("執行紀錄直接顯示已丟棄的容器事件總數", async ({ page }) => {
  const list = await openRunEvents(page, [
    {
      seq: 1,
      at: completedRun.started_at,
      phase: "code",
      kind: "worker_event_rejected",
      rejectedCount: 3,
    },
  ]);
  const rejected = list.getByRole("listitem");
  await expect(rejected.getByText("容器事件已丟棄", { exact: true })).toBeVisible();
  await expect(rejected.getByText("累計 3 筆", { exact: true })).toBeVisible();
});
