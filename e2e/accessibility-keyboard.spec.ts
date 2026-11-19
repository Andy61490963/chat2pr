import { expect, test } from "@playwright/test";
import { detail, mockDashboard, task } from "./dashboard-fixture";

test("關閉任務詳情與內層的拒絕確認時，焦點逐層回到原按鈕", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/tasks");
  const row = page.getByRole("button", { name: new RegExp(task.title) });
  await row.press("Enter");
  const drawer = page.getByRole("dialog", { name: task.title });
  const reject = drawer.getByRole("button", { name: "拒絕", exact: true });
  await expect(drawer.locator(":focus")).toHaveCount(1);
  // 從詳情取得的初始焦點走到拒絕按鈕，也驗證鍵盤確實能觸及該動作。
  const stops = await drawer
    .locator("button, input, select, textarea, a[href]")
    .count();
  for (
    let i = 0;
    i < stops &&
    !(await reject.evaluate((el) => el === document.activeElement));
    i++
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(reject).toBeFocused();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: "拒絕這個需求？" });
  const cancel = confirm.getByRole("button", { name: "先不要" });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm.getByRole("button", { name: "拒絕需求" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(reject).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(row).toBeFocused();
});

test("可用方向鍵選擇開發方案，再按 Tab 離開選項", async ({ page }) => {
  const change = {
    ...task,
    mode: "change" as const,
    suggestions: [
      {
        label: "依月份排列",
        summary: "按月份顯示清單",
        acceptance: ["能選月份"],
      },
      {
        label: "依主題排列",
        summary: "按主題顯示清單",
        acceptance: ["能選主題"],
      },
    ],
  };
  await mockDashboard(page, {
    state: { tasks: [change] },
    routes: { [`/api/tasks/${task.id}`]: { ...detail, task: change } },
  });
  await page.goto("/tasks");
  await page
    .getByRole("button", { name: new RegExp(task.title) })
    .press("Enter");
  const choices = page.getByRole("radiogroup", { name: /可選方案/ });
  const month = choices.getByRole("radio", { name: /依月份排列/ });
  const topic = choices.getByRole("radio", { name: /依主題排列/ });
  await month.press("Space");
  await expect(month).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(topic).toBeFocused();
  await expect(topic).toBeChecked();
  await expect(month).not.toBeChecked();
  await page.keyboard.press("ArrowUp");
  await expect(month).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(choices.locator(":focus")).toHaveCount(0);
});

test("用方向鍵選擇 AI 執行模式後，取消儲存確認會回到儲存按鈕", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.goto("/settings");
  const modes = page.getByRole("radiogroup", { name: "AI 執行模式" });
  const subscription = modes.getByRole("radio", { name: /ChatGPT 訂閱/ });
  await expect(subscription).toBeChecked();
  await subscription.press("ArrowRight");
  const api = modes.getByRole("radio", { name: /OpenAI API/ });
  await expect(api).toBeChecked();
  await expect(api).toBeFocused();
  const save = page.getByRole("button", { name: "儲存設定" });
  await save.press("Enter");
  const confirm = page.getByRole("dialog", { name: "確定要套用這些變更？" });
  await expect(confirm.getByRole("button", { name: "先不要" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  await expect(save).toBeFocused();
});
