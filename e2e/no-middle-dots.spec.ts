import { expect, test, type Page } from "@playwright/test";
import {
  dashboardSeparatorsTime,
  group,
  groupMemory,
  mockDashboardSeparators,
  project,
  task,
} from "./dashboard-fixture";

test.use({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });

async function checkLayout(page: Page, screen: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const layout = await page.evaluate(() => ({
    text: document.body.innerText,
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
  }));
  expect(layout.text, screen).not.toMatch(/[·・]/);
  expect(layout.contentWidth, screen).toBeLessThanOrEqual(layout.viewportWidth);
}

test("手機看板的欄位以版面或中文標點分隔，頁面不會水平捲動", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(dashboardSeparatorsTime));
  await mockDashboardSeparators(page);
  await page.goto("/");
  const inboxTask = page.getByRole("button", { name: new RegExp(task.title) });
  await expect(inboxTask).toBeVisible();
  await checkLayout(page, "收件匣");
  await page.getByRole("tab", { name: /^進行中/ }).click();
  await expect(
    page.getByText("Codex 修改程式，已 12 分，期限 08:30", { exact: true }),
  ).toBeVisible();
  await checkLayout(page, "進行中");

  await page.getByRole("tab", { name: /^決定/ }).click();
  await inboxTask.press("Enter");
  const taskDrawer = page.getByRole("dialog", { name: task.title });
  await expect(taskDrawer).toBeVisible();
  const evidenceTab = taskDrawer.getByRole("tab", { name: "判讀依據" });
  await evidenceTab.click();
  await taskDrawer.getByText("上下文來源證據（1 筆）", { exact: true }).click();
  const evidence = taskDrawer.getByRole("listitem").filter({
    hasText: "來源已失效或不在目前可用範圍",
  });
  for (const field of ["直接引用", "訊息", "版本 2", "需求辨識選用的來源"]) {
    await expect(evidence.getByText(field, { exact: true })).toBeVisible();
  }
  await expect(
    taskDrawer.locator("summary").filter({ hasText: "來源圖片已到期" }),
  ).toBeVisible();
  await checkLayout(page, "判讀依據");

  const runsTab = taskDrawer.getByRole("tab", { name: /^執行紀錄/ });
  await runsTab.click();
  const runs = taskDrawer.getByRole("region", { name: "Codex 執行紀錄" });
  const events = runs.getByRole("list", { name: "執行事件" });
  await expect(events.getByText("結束碼 1", { exact: true })).toBeVisible();
  const retry = events.getByRole("listitem").filter({ hasText: "訂閱上游重試" });
  await retry.getByText("檢視內容", { exact: true }).click();
  await expect(retry.getByText("上游暫時失敗，已讓 Codex 重試（第 1 次）：upstream_http（HTTP 503）")).toBeVisible();
  await expect(runs.getByText(/^更新於 /)).toBeVisible();
  const picker = runs.getByRole("combobox", { name: /^執行紀錄/ });
  await checkLayout(page, "執行紀錄");
  await picker.press("Enter");
  const option = page.getByRole("option");
  await expect(option.getByText("最新", { exact: true })).toBeVisible();
  await expect(option.getByText("已建立 PR", { exact: true })).toBeVisible();
  await checkLayout(page, "執行紀錄選單");
  await page.keyboard.press("Escape");

  await page.goto("/groups");
  const overview = page
    .getByRole("listitem")
    .filter({ hasText: "範例日期使用民國年。" });
  await expect(overview.getByText(project.name, { exact: true })).toBeVisible();
  await expect(overview.locator("time")).toHaveText("12 分鐘前");
  await checkLayout(page, "群組頁");
  await page
    .getByRole("button", { name: new RegExp(`^${group.name}`) })
    .press("Enter");
  const groupDrawer = page.getByRole("dialog", { name: group.name });
  const memory = groupDrawer
    .getByRole("listitem")
    .filter({ hasText: groupMemory.content });
  await expect(memory.getByText("AI 自動記住", { exact: true })).toBeVisible();
  await expect(memory.getByText(project.name, { exact: true })).toBeVisible();
  await expect(memory.locator("time")).toHaveAttribute(
    "datetime",
    groupMemory.created_at,
  );
  await checkLayout(page, "群組編輯");

  await page.goto("/projects");
  await page
    .getByRole("button", { name: new RegExp(`^${project.name}`) })
    .press("Enter");
  const projectDrawer = page.getByRole("dialog", { name: project.name });
  await expect(projectDrawer).toBeVisible();
  const environmentTab = projectDrawer.getByRole("tab", { name: "環境驗證" });
  await environmentTab.click();
  await projectDrawer.getByText("查看 AI 設定依據", { exact: true }).click();
  await expect(
    projectDrawer.getByText("分支：main", { exact: true }),
  ).toBeVisible();
  await expect(
    projectDrawer.getByText("本次參考專案資訊：設定版本 1", { exact: true }),
  ).toBeVisible();
  const context = projectDrawer.getByRole("region", { name: "專案資訊與環境" });
  await expect(context.getByText("設定版本 1", { exact: true })).toBeVisible();
  await checkLayout(page, "專案環境驗證");
  await projectDrawer.getByRole("tab", { name: "記憶" }).click();
  const projectMemory = projectDrawer.getByRole("listitem").filter({
    hasText: "範例日期使用民國年。",
  });
  await expect(
    projectMemory.getByText("管理者", { exact: true }),
  ).toBeVisible();
  await checkLayout(page, "專案記憶");

  await page.goto("/system?tab=disk");
  const disk = page.getByRole("tabpanel", { name: /^容器與磁碟/ });
  await expect(disk.getByText(/^最後盤點 /)).toBeVisible();
  await checkLayout(page, "系統頁");

  await page.goto("/checks");
  const check = page.getByRole("button", { name: /^示範設備檢查/ });
  await check.press("Enter");
  const recent = page.getByRole("list", { name: "最近結果明細" });
  await expect(recent.getByText("異常", { exact: true })).toBeVisible();
  await expect(
    recent.getByText("示範設備的溫度超過門檻", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/檢查環境：保留中，上次使用 .*，預計 .* 清除/),
  ).toBeVisible();
  await page.getByRole("button", { name: "試跑", exact: true }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "正常，示範設備試跑正常",
    }),
  ).toBeVisible();
  await checkLayout(page, "定期檢查");

  await page.goto("/settings");
  await expect(page.getByText("方案 範例方案", { exact: true })).toBeVisible();
  await expect(page.getByText("已用 25%", { exact: true })).toBeVisible();
  await expect(page.getByText(/^5 小時後重置/)).toBeVisible();
  await checkLayout(page, "設定");
});
