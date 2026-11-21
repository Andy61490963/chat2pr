import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Task } from "../shared/types";
import { group, mockDashboard, project, task } from "./dashboard-fixture";

const archived: Task[] = Array.from({ length: 65 }, (_, i) => ({
  ...task,
  id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
  project_id: i % 2 === 0 ? project.id : null,
  mode: i % 2 === 0 ? "change" : "query",
  status: i % 2 === 0 ? "merged" : "answered",
  title: `範例歷史任務 ${String(i + 1).padStart(2, "0")}`,
  updated_at: new Date(Date.UTC(2026, 0, 10, 0, 65 - i)).toISOString(),
}));
const ready: Task = {
  ...task,
  id: "33333333-3333-4333-8333-333333333333",
  title: "範例匯出待合併",
  status: "ready",
  mode: "change",
  updated_at: "2026-01-11T00:00:00Z",
};
const held: Task = {
  ...task,
  id: "44444444-4444-4444-8444-444444444444",
  title: "範例報表等待額度",
  status: "budget_wait",
  updated_at: "2026-01-12T00:00:00Z",
};

async function mockTasks(page: Page, active: Task[] = []) {
  const tasks = [...active, ...archived].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  await mockDashboard(page, { state: { tasks } });
  await page.route(
    (url) => url.pathname === "/api/tasks",
    (route) => {
      const q = new URL(route.request().url()).searchParams;
      const filtered = tasks.filter(
        (entry) =>
          (q.get("filter") === "all" || archived.includes(entry)) &&
          (!q.has("group") || entry.group_id === q.get("group")) &&
          (!q.has("project") ||
            (entry.project_id ?? "none") === q.get("project")) &&
          (!q.has("q") || entry.title.includes(q.get("q")!)),
      );
      const offset = q.has("beforeId")
        ? filtered.findIndex((entry) => entry.id === q.get("beforeId")) + 1
        : 0;
      const batch = filtered.slice(offset, offset + 30);
      const last = batch.at(-1);
      return route.fulfill({
        json: {
          tasks: batch,
          next:
            last && offset + batch.length < filtered.length
              ? { before: last.updated_at, beforeId: last.id }
              : null,
        },
      });
    },
  );
}

const rows = (page: Page) =>
  page.getByRole("tabpanel").locator("[data-task-id]");
const tabs = (page: Page, name: RegExp) => page.getByRole("tab", { name });

test("預設顯示進行中與待處理，等待額度與待合併的任務都標示種類", async ({
  page,
}) => {
  await mockTasks(page, [held, ready, task]);
  await page.goto("/tasks");
  await expect(tabs(page, /^進行中與待處理/)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rows(page)).toHaveCount(3);
  await expect(
    page
      .getByRole("button", { name: /範例報表等待額度/ })
      .getByText("查詢", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: /範例匯出待合併/ })
      .getByText("修改", { exact: true }),
  ).toBeVisible();
});

for (const width of [1280, 375]) {
  test(`在 ${width}px 可從空狀態查看歷史、捲動或用鍵盤載入下一批`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockTasks(page);
    await page.goto("/tasks");
    await expect(page.getByText("目前沒有進行中或待處理的任務")).toBeVisible();
    await page.getByRole("button", { name: "看已結束的任務" }).press("Enter");
    await expect(tabs(page, /^已結束/)).toBeFocused();
    await expect(rows(page)).toHaveCount(30);
    await expect(rows(page).first()).toContainText(archived[0].title);
    await expect(rows(page).last()).toContainText(archived[29].title);
    await expect(
      page.getByRole("button", { name: /範例歷史任務 31/ }),
    ).toHaveCount(0);

    const more = page.getByRole("button", { name: "載入更多任務" });
    await more.scrollIntoViewIfNeeded();
    await expect(rows(page)).toHaveCount(60);
    await more.press("Enter");
    await expect(rows(page)).toHaveCount(65);
    await expect(rows(page).nth(60)).toBeFocused();
    await expect(rows(page).last()).toContainText(archived.at(-1)!.title);
    await expect(more).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width === 375) {
      for (const tab of await page.getByRole("tab").all()) {
        const box = (await tab.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
  });
}

test("全部按更新時間排列，重新開啟時恢復篩選，網址可指定另一個分頁", async ({
  page,
}) => {
  await mockTasks(page, [ready]);
  await page.goto("/tasks");
  await tabs(page, /^全部/).click();
  await expect(rows(page)).toHaveCount(30);
  await expect(rows(page).first()).toContainText(ready.title);
  await expect(rows(page).last()).toContainText(archived[28].title);

  await page.getByRole("combobox", { name: "群組" }).click();
  await page.getByRole("option", { name: group.name }).click();
  await page.getByRole("combobox", { name: "專案" }).click();
  await page.getByRole("option", { name: "未指定專案" }).click();
  await page.getByRole("combobox", { name: "分組方式" }).click();
  await page.getByRole("option", { name: "依群組分組" }).click();
  await page.getByRole("textbox", { name: "搜尋任務" }).fill("範例歷史任務 64");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(archived[63].title);

  await page.goto("/tasks");
  await expect(tabs(page, /^全部/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "搜尋任務" })).toHaveValue(
    "範例歷史任務 64",
  );
  await expect(page.getByRole("combobox", { name: "群組" })).toHaveText(
    group.name,
  );
  await expect(page.getByRole("combobox", { name: "專案" })).toHaveText(
    "未指定專案",
  );
  await expect(page.getByRole("combobox", { name: "分組方式" })).toHaveText(
    "依群組分組",
  );
  await expect(rows(page)).toHaveCount(1);
  await page.goto("/tasks?filter=active");
  await expect(tabs(page, /^進行中與待處理/)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("textbox", { name: "搜尋任務" })).toBeEmpty();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(ready.title);
});
