import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Task } from "../shared/types";
import {
  cancelledTask,
  completedRun,
  detail,
  mockDashboard,
  task,
} from "./dashboard-fixture";

async function checkMobileAccessibility(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations).toEqual([]);
}

test.use({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });

test("手機收件匣的二十筆待審案件各顯示一個下一步，回答問題直達表單", async ({
  page,
}) => {
  const withQuestion: Task = {
    ...task,
    project_id: null,
    question: { text: "要查哪個月份的資料？", choices: ["十月"] },
    missing: [],
  };
  const missingOnly: Task = {
    ...task,
    id: "demo-missing",
    title: "確認範例欄位",
    missing: ["請提供欄位名稱"],
  };
  await mockDashboard(page, {
    state: {
      tasks: [
        withQuestion,
        missingOnly,
        ...Array.from({ length: 18 }, (_, index) => ({
          ...task,
          id: `demo-approval-${index}`,
          project_id: index === 0 ? null : task.project_id,
          title: `確認範例需求 ${index + 1}`,
        })),
      ],
    },
    routes: { [`/api/tasks/${task.id}`]: { ...detail, task: withQuestion } },
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: /^決定\s*20$/ })).toBeVisible();
  const queue = page.getByRole("list", { name: "待決策佇列" });
  await expect(
    queue.getByText("等你決定：確認需求", { exact: true }),
  ).toHaveCount(17);
  for (const label of [
    "等你決定：選專案",
    "等你回答：補充需求",
    "等你補充：修改需求",
  ]) {
    await expect(queue.getByText(label, { exact: true })).toHaveCount(1);
  }
  for (const label of ["需求等待確認", "等你決定", "審核站"]) {
    await expect(queue.getByText(label, { exact: true })).toHaveCount(0);
  }
  await checkMobileAccessibility(page);

  await queue.getByRole("button", { name: new RegExp(task.title) }).press("Enter");
  const drawer = page.getByRole("dialog", { name: task.title });
  const answerAction = drawer.getByRole("button", { name: "回答問題", exact: true });
  await expect(answerAction).toBeFocused();
  await expect(answerAction).toHaveAttribute("data-variant", "default");
  expect(await answerAction.evaluate((button: HTMLButtonElement) => button.offsetHeight)).toBeGreaterThanOrEqual(44);
  await answerAction.press("Enter");
  const answer = drawer.getByRole("textbox", { name: "回答這個問題" });
  await expect(answer).toBeFocused();
  await expect(answer).toBeInViewport();
  await expect(drawer.getByRole("textbox", { name: "需求說明" })).toBeHidden();

  const acceptance = drawer.getByRole("region", { name: "預期驗收條件" });
  await expect(acceptance.getByRole("listitem")).toHaveText(task.acceptance[0]);
  await expect(acceptance.getByRole("list")).toHaveCSS(
    "list-style-type",
    "disc",
  );
  await expect(acceptance.locator("svg")).toHaveCount(0);
  await checkMobileAccessibility(page);

  await answerAction.press("Enter");
  await expect(answer).toBeFocused();
  await expect(answer).toBeInViewport();
  const amend = drawer.getByRole("button", { name: "修改這一題", exact: true });
  await expect(amend).toHaveAttribute("data-variant", "outline");
  await amend.click();
  await expect(drawer.getByRole("textbox", { name: "需求說明" })).toBeFocused();
});

for (const kind of ["build", "partial"] as const) {
  const isBuild = kind === "build";
  test(`驗收條件保留中性清單，顯示${isBuild ? "建置檢查" : "部分測試"}的實際範圍`, async ({
    page,
  }) => {
    const verified: Task = { ...task, mode: "change", status: "ready" };
    await mockDashboard(page, {
      state: { tasks: [verified] },
      routes: {
        [`/api/tasks/${task.id}`]: {
          ...detail,
          task: verified,
          runs: [
            {
              ...completedRun,
              verification_scope: isBuild
                ? { kind }
                : { kind, limitations: "範例資料庫的查詢流程" },
            },
          ],
        },
      },
    });
    await page.goto(`/tasks?task=${task.id}`);
    const acceptance = page.getByRole("region", { name: "預期驗收條件" });
    await expect(acceptance.getByRole("listitem")).toHaveText(
      task.acceptance[0],
    );
    await expect(acceptance.locator("svg")).toHaveCount(0);
    await expect(
      acceptance.getByText(
        isBuild
          ? "驗證範圍僅包含建置檢查，未執行自動測試。"
          : "只執行了部分自動測試。 未涵蓋的範圍：範例資料庫的查詢流程",
        { exact: true },
      ),
    ).toBeVisible();
  });
}

test("近七天已合併的下鑽符合統計筆數，重新載入仍可清除日期篩選", async ({
  page,
}) => {
  const recent: Task = {
    ...task,
    id: "demo-merged-recent",
    title: "更新範例報表",
    status: "merged",
    mode: "change",
    updated_at: "2026-11-22T02:00:00Z",
  };
  const boundary: Task = {
    ...recent,
    id: "demo-merged-start",
    title: "更新範例表單",
    updated_at: "2026-11-15T16:00:00Z",
  };
  const old: Task = {
    ...recent,
    id: "demo-merged-old",
    title: "更新範例清單",
    updated_at: "2026-11-15T15:59:59.999Z",
  };
  await mockDashboard(page, {
    state: {
      tasks: [recent, boundary, old, cancelledTask],
      totals: {
        tasks: 4,
        activity: 0,
        byStatus: { merged: 3, cancelled: 1 },
        mergedWeek: 2,
        mergedWeekDay: "2026-11-22",
      },
    },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "近 7 天已合併 2", exact: true })
    .press("Enter");
  await expect(page).toHaveURL(/mergedWeek=2026-11-22/);
  const list = page.getByRole("tabpanel", { name: /^已結束/ });
  const row = (entry: Task) =>
    list.getByRole("button", { name: new RegExp(entry.title) });
  await expect(row(recent)).toBeVisible();
  await expect(row(boundary)).toBeVisible();
  await expect(list.getByRole("status")).toHaveText("你已看到 2 筆任務。");
  await expect(row(old)).toHaveCount(0);
  await expect(row(cancelledTask)).toHaveCount(0);
  await expect(
    page.getByText("已合併，更新於 2026/11/16 至 2026/11/22（臺北時間）"),
  ).toBeVisible();
  await checkMobileAccessibility(page);

  await page.reload();
  await expect(list.getByRole("status")).toHaveText("你已看到 2 筆任務。");
  await page.getByRole("button", { name: "清除已合併日期篩選" }).press("Enter");
  await expect(page.getByRole("tab", { name: /^已結束/ })).toBeFocused();
  await expect(page).not.toHaveURL(/mergedWeek=/);
  await expect(row(old)).toBeVisible();
  await expect(row(cancelledTask)).toBeVisible();
  await expect(list.getByRole("status")).toHaveText("你已看到 4 筆任務。");
});
