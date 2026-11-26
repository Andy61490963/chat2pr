import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Task } from "../shared/types";
import {
  detail,
  group,
  mockDashboard,
  project,
  task,
} from "./dashboard-fixture";

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
const working: Task = {
  ...task,
  id: "55555555-5555-4555-8555-555555555555",
  title: "範例庫存查詢",
  status: "running",
  updated_at: "2026-01-13T00:00:00Z",
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
const statusFilter = (page: Page, name: string) =>
  page.getByRole("checkbox", { name, exact: true });

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

test("375px 首屏上半部顯示第一張任務，鍵盤可開關篩選並保留條件", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockTasks(page, [task, held, working, ready]);
  await page.goto("/tasks");
  const tablist = page.getByRole("tablist", { name: "任務分頁" });
  await expect(tablist.getByRole("tab")).toHaveText([
    /^進行中與待處理\s*4$/,
    /^已結束\s*65$/,
    /^全部\s*69$/,
  ]);
  await expect(rows(page)).toHaveCount(4);
  const firstRow = (await rows(page).first().boundingBox())!;
  expect(firstRow.y + firstRow.height).toBeLessThanOrEqual(812 / 2);
  const filters = page.getByRole("button", { name: /^篩選，已套用/ });
  const panel = page.getByRole("dialog", { name: "任務篩選" });
  const search = page.getByRole("textbox", { name: "搜尋任務" });
  await expect(search).toBeVisible();
  await expect(filters).toHaveAccessibleName("篩選，已套用 0 個條件");
  await expect(filters).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  const triggerBox = (await filters.boundingBox())!;
  expect(triggerBox.width).toBeGreaterThanOrEqual(44);
  expect(triggerBox.height).toBeGreaterThanOrEqual(44);
  await filters.press("Enter");
  await expect(panel).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^篩選，已套用/, includeHidden: true }),
  ).toHaveAttribute("aria-expanded", "true");
  for (const name of ["群組", "專案", "分組方式"]) {
    const box = (await panel.getByRole("combobox", { name }).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  for (const name of ["待處理 1", "等待額度 1", "進行中 1", "待合併 1"]) {
    const checkbox = statusFilter(page, name);
    await expect(checkbox).not.toBeChecked();
    const box = (await checkbox.locator("..").boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const waiting = statusFilter(page, "等待額度 1");
  await expect(statusFilter(page, "待處理 1")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(waiting).toBeFocused();
  await page.keyboard.press("Space");
  await expect(waiting).toBeFocused();
  await expect(waiting).toBeChecked();
  await statusFilter(page, "待合併 1").check();
  await expect(statusFilter(page, "待處理 1")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(filters).toBeFocused();
  await expect(filters).toHaveAttribute("aria-expanded", "false");
  await expect(filters).toHaveAccessibleName("篩選，已套用 2 個條件");
  await expect(filters).toHaveText("篩選（2）");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).last()).toContainText(ready.title);
  expect(new URL(page.url()).searchParams.get("status")).toBe("waiting,ready");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  expect(
    await tablist.evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual(
    await tablist.evaluate((element) => element.clientWidth),
  );
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);

  await page.reload();
  await expect(filters).toHaveAccessibleName("篩選，已套用 2 個條件");
  await filters.click();
  await expect(waiting).toBeChecked();
  await expect(statusFilter(page, "待合併 1")).toBeChecked();
  await page.goto("/tasks");
  await expect(filters).toHaveAccessibleName("篩選，已套用 2 個條件");
  await filters.click();
  await expect(waiting).toBeChecked();
  await expect(statusFilter(page, "待合併 1")).toBeChecked();
  await panel.getByRole("button", { name: "關閉" }).click();
  await tabs(page, /^已結束/).click();
  await expect(filters).toHaveAccessibleName("篩選，已套用 0 個條件");
  await filters.click();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await panel.getByRole("combobox", { name: "群組" }).press("Enter");
  const matchingGroup = page.getByRole("option", { name: group.name });
  await expect(page.getByRole("option", { name: "所有群組" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(matchingGroup).toBeFocused();
  await page.keyboard.press("Enter");
  await panel.getByRole("combobox", { name: "專案" }).click();
  await page.getByRole("option", { name: project.name }).click();
  await panel.getByRole("combobox", { name: "分組方式" }).click();
  await page.getByRole("option", { name: "依群組分組" }).click();
  await panel.getByRole("button", { name: "關閉" }).click();
  await expect(filters).toHaveAccessibleName("篩選，已套用 3 個條件");
  await expect(page).toHaveURL(
    /group=group-demo&project=project-demo&by=group/,
  );
  await tabs(page, /^進行中與待處理/).click();
  await expect(filters).toHaveAccessibleName("篩選，已套用 5 個條件");
  await expect(rows(page)).toHaveCount(2);

  await search.fill("範例不存在的任務");
  await expect(filters).toHaveAccessibleName("篩選，已套用 5 個條件");
  await page.getByRole("button", { name: "清除篩選" }).click();
  await expect(search).toBeFocused();
  await expect(filters).toHaveAccessibleName("篩選，已套用 1 個條件");
  await expect(rows(page)).toHaveCount(4);
});

test("收件匣標題與舊的任務分頁網址會開啟對應的狀態篩選", async ({ page }) => {
  await mockTasks(page, [task, held, working, ready]);
  await page.goto("/");
  await page.getByRole("tab", { name: /^進行中\s*1$/ }).click();
  await page
    .getByRole("heading", { name: "進行中 1" })
    .getByRole("button")
    .click();
  await expect(page).toHaveURL(/\/tasks\?filter=active&status=moving$/);
  await expect(tabs(page, /^進行中與待處理/)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(statusFilter(page, "進行中 1")).toBeChecked();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(working.title);
  await page.goto("/tasks?filter=waiting");
  await expect(page).toHaveURL(/\/tasks\?filter=active&status=waiting$/);
  await expect(statusFilter(page, "等待額度 1")).toBeChecked();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(held.title);
});

test("從鈴鐺開啟待合併通知時保留任務詳情並套用待合併篩選", async ({ page }) => {
  await mockDashboard(page, {
    state: {
      tasks: [task, ready],
      alerts: [
        {
          id: "demo-ready",
          task_id: ready.id,
          kind: "ready",
          disposition: "action",
          title: ready.title,
          text: "你可以查看範例 PR。",
          created_at: "2026-01-11T08:00:00Z",
        },
      ],
    },
    routes: { [`/api/tasks/${ready.id}`]: { ...detail, task: ready } },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^通知(?:，|$)/ }).click();
  await page.getByRole("menuitem", { name: /範例匯出待合併/ }).click();
  const dialog = page.getByRole("dialog", { name: ready.title });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("status")).toBe("ready");
  // 詳情開啟後會把焦點移到標題；等焦點就位再按 Esc，避免面板還沒接管鍵盤。
  await expect(
    dialog.getByRole("heading", { name: ready.title }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("aria-hidden");
  await expect(statusFilter(page, "待合併 1")).toBeChecked();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(ready.title);
});

for (const width of [1280, 375]) {
  test(`在 ${width}px 可從空狀態查看歷史、捲動或用鍵盤載入下一批`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockTasks(page);
    await page.goto("/tasks?filter=active&status=waiting");
    await expect(page.getByText("目前沒有進行中或待處理的任務")).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "搜尋任務" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: /^篩選，已套用/ }),
    ).toHaveCount(0);
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
