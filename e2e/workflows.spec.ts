import { expect, test } from "@playwright/test";
import type { Detail } from "../src/app/shared";
import type { Task } from "../shared/types";
import { detail, mockDashboard, task } from "./dashboard-fixture";

test("任務詳情顯示排隊原因與失敗後的處理建議", async ({ page }) => {
  const queued: Task = { ...task, title: "整理範例清單", status: "queued" };
  const failed: Task = {
    ...task,
    id: "22222222-2222-4222-8222-222222222222",
    title: "檢查範例專案",
    status: "failed",
    last_error: "設定問題：找不到測試指令。\n建議：請到專案頁補上測試指令。",
  };
  const queuedDetail: Detail = {
    ...detail,
    task: queued,
    queue: {
      code: "waiting",
      position: 2,
      text: "工作名額已滿，等待空位",
      hint: null,
      retry_at: null,
    },
  };
  await mockDashboard(page, {
    state: { tasks: [queued, failed] },
    routes: {
      [`/api/tasks/${queued.id}`]: queuedDetail,
      [`/api/tasks/${failed.id}`]: { ...detail, task: failed, queue: null },
    },
  });
  await page.goto("/tasks");
  await page.getByRole("button", { name: /整理範例清單/ }).click();
  const queuedDrawer = page.getByRole("dialog", { name: queued.title });
  await expect(
    queuedDrawer.getByRole("status", { name: "排隊原因" }),
  ).toContainText("排隊中（第 2 位）：工作名額已滿，等待空位");
  await queuedDrawer.getByRole("button", { name: "關閉", exact: true }).click();
  await page.getByRole("button", { name: /檢查範例專案/ }).click();
  const failedDrawer = page.getByRole("dialog", { name: failed.title });
  await expect(
    failedDrawer.getByText(/建議：請到專案頁補上測試指令/),
  ).toBeVisible();
  await expect(
    failedDrawer.getByRole("button", { name: "前往專案設定" }),
  ).toBeVisible();
});

test("補問回答遇到版本衝突時保留已輸入的文字", async ({ page }) => {
  const pending: Task = {
    ...task,
    status: "awaiting_approval",
    question: { text: "要整理哪個月份的清單？", choices: [] },
  };
  await mockDashboard(page, {
    state: { tasks: [pending] },
    routes: { [`/api/tasks/${pending.id}`]: { ...detail, task: pending } },
  });
  const conflict = "任務版本已更新，請再確認一次。";
  const answerPath = `/api/tasks/${pending.id}/answer`;
  await page.route(`**${answerPath}`, (route) =>
    route.fulfill({ status: 409, json: { error: conflict } }),
  );
  await page.goto(`/tasks?task=${pending.id}`);
  const answer = page.getByRole("textbox", { name: "回答這個問題" });
  const draft = "請整理十月份的清單。";
  await answer.fill(draft);
  const response = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === answerPath &&
      res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "送出回答" }).click();
  const result = await response;
  expect(result.status()).toBe(409);
  expect(result.request().postDataJSON()).toMatchObject({
    text: draft,
    version: pending.version,
  });
  await expect(page.getByText(conflict, { exact: true })).toBeVisible();
  await expect(answer).toHaveValue(draft);
});

test("通知鈴鐺可用鍵盤開關選單、移動焦點並前往對應頁面", async ({ page }) => {
  const notice = {
    id: "notice-project",
    task_id: null,
    kind: "repo_found",
    title: "範例專案已恢復",
    text: "可以繼續處理需求",
    created_at: "2026-01-01T08:00:00Z",
  };
  const service = {
    ...notice,
    id: "notice-service",
    kind: "service_up",
    title: "範例服務已恢復",
  };
  await mockDashboard(page, {
    state: { alerts: [notice, service], alertsSeenAt: null },
  });
  await page.goto("/");
  const bell = page.getByRole("button", { name: /^通知(?:，|$)/ });
  await bell.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(bell).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  // 桌面通知開關依瀏覽器支援與否出現在最前面，從最後一則通知開始移動。
  await page.keyboard.press("End");
  const last = menu.getByRole("menuitem", { name: /範例服務已恢復/ });
  await expect(last).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(
    menu.getByRole("menuitem", { name: /範例專案已恢復/ }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(last).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "設定", exact: true }),
  ).toBeVisible();
  await expect(menu).toBeHidden();
});

test("取消完全開放容器網路的確認對話框後不送出設定", async ({ page }) => {
  await mockDashboard(page);
  const updates: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/settings"
    ) {
      updates.push(request.url());
    }
  });
  await page.goto("/settings");
  const network = page.getByRole("switch", { name: "完全開放容器網路" });
  await expect(network).not.toBeChecked();
  await network.click();
  await page.getByRole("button", { name: "儲存設定" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "確定要套用這些變更？",
  });
  await expect(
    confirmation.getByText("容器網路：隔離 → 完全開放"),
  ).toBeVisible();
  await confirmation.getByRole("button", { name: "先不要" }).click();
  await expect(confirmation).toBeHidden();
  await expect(network).toBeChecked();
  await expect(page.getByText("有修改尚未儲存", { exact: true })).toBeVisible();
  expect(updates).toHaveLength(0);
});

test("專案的完全存取要先確認才開啟，取消不送出", async ({ page }) => {
  await mockDashboard(page);
  const bodies: unknown[] = [];
  await page.route("**/api/projects/project-demo/full-access", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: { id: "project-demo", full_access: true },
    });
  });
  await page.goto("/projects");
  await page.getByText("測試專案", { exact: true }).first().click();
  const section = page.getByRole("region", { name: "完全存取" });
  await expect(section.getByText("關閉", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "開啟完全存取" }).click();
  const dialog = page.getByRole("dialog", {
    name: "開啟「測試專案」的完全存取？",
  });
  await expect(dialog).toContainText("帳號能寫入，AI 就可能寫入");
  await dialog.getByRole("button", { name: "先不要" }).click();
  await expect(dialog).toBeHidden();
  expect(bodies).toHaveLength(0);
  await section.getByRole("button", { name: "開啟完全存取" }).click();
  await dialog.getByRole("button", { name: "開啟完全存取" }).click();
  await expect.poll(() => bodies).toEqual([{ enabled: true }]);
});
