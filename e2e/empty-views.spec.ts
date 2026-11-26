import { expect, test, type Page } from "@playwright/test";
import type { Task } from "../shared/types";
import { defaultState, mockDashboard, task } from "./dashboard-fixture";

const ended: Task = {
  ...task,
  title: "已整理範例說明",
  status: "answered",
};

function readyDashboard(page: Page, tasks: Task[]) {
  return mockDashboard(page, {
    state: {
      tasks,
      activity: tasks.includes(ended)
        ? [
            {
              id: 1,
              task_id: ended.id,
              task_title: ended.title,
              task_mode: ended.mode,
              kind: "answered",
              detail: "已將範例說明回覆到群組。",
              created_at: ended.updated_at,
            },
          ]
        : [],
      health: ["github", "line", "runner", "codex"].map((name) => ({
        name,
        ok: true,
      })),
      settings: { ...defaultState.settings, admin_line_id: "demo-line" },
    },
  });
}

for (const width of [1280, 375]) {
  test(`收件匣沒有待辦時只顯示一個空狀態（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await readyDashboard(page, [ended]);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "都處理完了" })).toHaveCount(
      1,
    );
    await expect(
      page.getByText("目前沒有需要你處理、執行中或待合併的工作。"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^(需要你處理|進行中|待合併) 0$/ }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/目前沒有執行中的工作|沒有等待合併的 PR/),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "近 7 天已合併 0" }),
    ).toBeInViewport();
    await expect(page.getByRole("heading", { name: "最近動態" })).toBeHidden();
    await page.getByRole("tab", { name: "最近動態" }).click();
    await expect(
      page.getByRole("heading", { name: "最近動態" }),
    ).toBeInViewport();
    await expect(page.getByText(ended.title, { exact: true })).toBeInViewport();
  });

  test(`截圖對照：收件匣與任務頁（${width}px）`, async ({
    page,
    context,
  }, testInfo) => {
    const capture = async (view: Page, name: string) => {
      await view.evaluate(() => document.fonts.ready);
      await testInfo.attach(name, {
        body: await view.screenshot({ animations: "disabled" }),
        contentType: "image/png",
      });
    };
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await readyDashboard(page, [ended]);
    await page.goto("/");
    await expect(page.getByText("都處理完了", { exact: true })).toBeVisible();
    await capture(page, "收件匣無待辦");
    await page.goto("/tasks?filter=active");
    await expect(page.getByText("目前沒有進行中或待處理的任務")).toBeVisible();
    await capture(page, "任務分頁為空");

    const populated = await context.newPage();
    await populated.setViewportSize({ width, height: 812 });
    await populated.emulateMedia({
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await readyDashboard(populated, [task]);
    await populated.goto("/tasks?filter=active");
    await expect(
      populated.getByRole("button", { name: new RegExp(task.title) }),
    ).toBeVisible();
    await capture(populated, "任務分頁有任務");
  });
}

test("有待處理任務時，各分頁顯示對應筆數", async ({ page }) => {
  await readyDashboard(page, [task]);
  await page.goto("/");
  for (const name of ["需要你決定 1", "進行中 0", "待合併 0"]) {
    await expect(
      page.getByRole("tab", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "都處理完了" })).toHaveCount(
    0,
  );
});

test("收件匣合併空狀態時仍顯示等待額度的任務", async ({ page }) => {
  await readyDashboard(page, [{ ...task, status: "budget_wait" }]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "都處理完了" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "等待額度（會自動繼續） 1" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(task.title) }),
  ).toBeVisible();
});

test("已結束與全部分頁本來就空時不顯示任務篩選", async ({ page }) => {
  await readyDashboard(page, []);
  await page.goto("/tasks?filter=closed&q=範例說明");
  const search = page.getByRole("textbox", { name: "搜尋任務" });
  await expect(page.getByText("目前沒有已結束的任務")).toBeVisible();
  await expect(search).toHaveCount(0);
  await page.getByRole("button", { name: "看全部任務" }).press("Enter");
  await expect(page.getByText("還沒有任務")).toBeVisible();
  await expect(search).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
});
