import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { RunView } from "../shared/observation";
import type { Task } from "../shared/types";
import { completedRun, detail, mockDashboard, task } from "./dashboard-fixture";

// 一次走到 PR、途中自動修復一次的修改任務；階段時間取自真實執行的形狀，名稱都是虛構的。
const ready: Task = {
  ...task,
  id: "88888888-8888-4888-8888-888888888888",
  title: "調整範例報表的日期欄位",
  mode: "change",
  status: "ready",
};
const at = (clock: string) => `2026-01-05T${clock}.000Z`;
const run: RunView = {
  ...completedRun,
  id: "demo-phase-run",
  observed: true,
  started_at: at("10:00:00"),
  completed_at: at("10:23:00"),
  heartbeat_at: at("10:23:00"),
  deadline: at("10:30:00"),
  phases: [
    ["issue", "10:00:00"],
    ["install", "10:01:00"],
    ["test", "10:01:30"],
    ["code", "10:03:12"],
    ["test", "10:08:54"],
    ["review", "10:10:20"],
    ["verify", "10:13:46"],
    ["code", "10:13:46"],
    ["test", "10:18:39"],
    ["review", "10:19:37"],
    ["publish", "10:22:53"],
  ].map(([phase, clock]) => ({ phase, at: at(clock) })),
};

for (const width of [1280, 375]) {
  test(`執行紀錄顯示各階段花費時間與距離上限還剩多少（${width}px）`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    await mockDashboard(page, {
      state: { tasks: [ready] },
      routes: {
        [`/api/tasks/${ready.id}`]: {
          ...detail,
          task: ready,
          runs: [run],
          queue: null,
        },
        [`/api/tasks/${ready.id}/runs/${run.id}/events`]: {
          events: [],
          hasOlder: false,
          nextBefore: null,
        },
      },
    });
    await page.goto(`/tasks?task=${ready.id}`);
    const drawer = page.getByRole("dialog", { name: ready.title });
    await drawer.getByRole("tab", { name: /^執行紀錄/ }).click();
    const times = drawer.getByRole("region", { name: "各階段花費時間" });
    await expect(times).toBeVisible();
    const rows = await times.locator("dt").allInnerTexts();
    expect(rows).toEqual(["準備", "測試", "修改", "審查", "修復", "建立 PR"]);
    await expect(times.locator("dd")).toHaveText([
      "1.5 分鐘",
      "4.1 分鐘",
      "5.7 分鐘",
      "6.7 分鐘（最多）",
      "4.9 分鐘",
      "不到 1 分鐘",
    ]);
    await expect(
      times.getByText("單次執行上限 30 分鐘，距離上限還剩 7 分鐘"),
    ).toBeVisible();
    await page.evaluate(() =>
      Promise.all(
        document.getAnimations().map((a) => a.finished.catch(() => undefined)),
      ),
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const { violations } = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .analyze();
    expect(violations).toEqual([]);
  });
}

test("被自動接續的執行在執行紀錄顯示「逾時，已自動接續」，鈴鐺也用同一個標籤", async ({
  page,
}) => {
  const resumed: RunView = {
    ...run,
    id: "demo-resumed-run",
    outcome: "auto_resumed",
    phases: run.phases!.slice(0, 6),
  };
  const notice = {
    id: "notice-auto-resume",
    task_id: null,
    kind: "auto_resume",
    disposition: "result",
    title: ready.title,
    text: `工作逾時，已保留修改並自動接續一次：${ready.title}`,
    created_at: "2026-01-05T10:30:00Z",
  };
  await mockDashboard(page, {
    state: { tasks: [ready], alerts: [notice], alertsSeenAt: null },
    routes: {
      [`/api/tasks/${ready.id}`]: {
        ...detail,
        task: ready,
        runs: [resumed],
        queue: null,
      },
      [`/api/tasks/${ready.id}/runs/${resumed.id}/events`]: {
        events: [],
        hasOlder: false,
        nextBefore: null,
      },
    },
  });
  await page.goto(`/tasks?task=${ready.id}`);
  const drawer = page.getByRole("dialog", { name: ready.title });
  await drawer.getByRole("tab", { name: /^執行紀錄/ }).click();
  await expect(
    drawer.locator("dt", { hasText: "執行結果" }).locator("+ dd"),
  ).toHaveText("逾時，已自動接續");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^通知(?:，|$)/ }).click();
  await expect(
    page
      .getByRole("menuitem", { name: /工作逾時，已保留修改/ })
      .getByText("逾時，已自動接續", { exact: true }),
  ).toBeVisible();
});
