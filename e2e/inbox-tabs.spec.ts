import { expect, test } from "@playwright/test";
import { firstSetupHealth, group, mockDashboard, mockInboxReview, reviewWorkbenchFixture, summaryActivity, summaryTasks, unverifiedProject } from "./dashboard-fixture";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

test("決定分頁可以開啟需要你處理的任務清單", async ({ page }) => {
  await mockInboxReview(page);
  await page.goto("/");
  await page.getByRole("tabpanel").getByRole("button", { name: "查看需要你處理的任務" }).click({ timeout: 5000 });
  await expect(page).toHaveURL(/\/tasks\?filter=active&status=todo$/);
});

test("尚未完成首次設定時切換每個分頁仍可找到下一步", async ({ page }) => {
  await mockDashboard(page, { state: { health: firstSetupHealth, projects: [unverifiedProject], groups: [{ ...group, project_ids: [unverifiedProject.id] }] } });
  await page.goto("/");
  for (const name of [/進行中/, /待合併/, /動態/, /決定/]) {
    const tab = page.getByRole("tab", { name });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "開始使用" })).toBeVisible();
    await expect(page.getByText("群組已綁定可派工的專案", { exact: true })).toBeVisible();
  }
});

test("分類筆數只顯示一次，切換分頁才列出對應的全部工作與動態", async ({ page }) => {
  const working = summaryTasks.slice(0, 3);
  const pending = summaryTasks[3];
  const fixture = reviewWorkbenchFixture();
  const decision = fixture.tasks[0];
  await mockDashboard(page, {
    state: {
      tasks: [decision, ...working.map((entry) => ({ ...entry, status: "running" })), { ...pending, status: "ready" }],
      activity: summaryActivity,
    },
    routes: { [`/api/tasks/${decision.id}`]: fixture.details.get(decision.id) },
  });
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "收件匣分類" });
  const decisions = tabs.getByRole("tab", { name: "決定 1", exact: true });
  const moving = tabs.getByRole("tab", { name: "進行中 3", exact: true });
  const ready = tabs.getByRole("tab", { name: "待合併 1", exact: true });
  const activity = tabs.getByRole("tab", { name: `動態 ${summaryActivity.length}`, exact: true });
  await expect(decisions).toHaveAttribute("aria-selected", "true");
  await expect(ready).toBeVisible();
  await expect(activity).toBeVisible();
  await expect(page.getByRole("heading", { name: /需要你處理/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(working[0].title) })).toBeHidden();
  await expect(page.getByRole("region", { name: "最近動態" })).toBeHidden();
  await moving.click();
  for (const entry of working) {
    await expect(page.getByRole("tabpanel").getByText(entry.title, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("list", { name: "待決策佇列" })).toBeHidden();
  await ready.click();
  await expect(page.getByRole("tabpanel").getByText(pending.title, { exact: true })).toBeVisible();
  await activity.click();
  const feed = page.getByRole("region", { name: "最近動態" });
  await expect(feed.getByRole("button", { name: pending.title, exact: true })).toBeVisible();
  await decisions.click();
  await expect(feed).toBeHidden();
});

test("鍵盤提示、卡住任務與排序都在分類右側，切換分類不會重設排序", async ({ page }) => {
  const { tasks } = await mockInboxReview(page);
  await page.goto("/");
  const categories = page.getByRole("tablist", { name: "收件匣分類" });
  const hint = page.getByText(/J／K 切換/);
  const stuck = page.getByRole("button", { name: "卡住的任務 1" });
  const sort = page.getByRole("combobox", { name: "待決策排序" });
  const first = page.getByRole("list", { name: "待決策佇列" }).getByRole("listitem").first();
  await expect(first).toContainText(tasks[0].title);
  const tabsBox = (await categories.boundingBox())!;
  for (const control of [hint, stuck, sort]) {
    await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(tabsBox.x + tabsBox.width - 1);
    expect(Math.abs((box.y + box.height / 2) - (tabsBox.y + tabsBox.height / 2))).toBeLessThan(3);
  }
  await sort.selectOption({ label: "最新" });
  await expect(first).toContainText(tasks.at(-1)!.title);
  await categories.getByRole("tab", { name: /進行中/ }).click();
  await expect(sort).toBeHidden();
  await categories.getByRole("tab", { name: /決定/ }).click();
  await expect(first).toContainText(tasks.at(-1)!.title);
});

test("手機首屏分類保留間距，第二列完整顯示卡住捷徑與排序", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockInboxReview(page);
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "收件匣分類" }).getByRole("tab");
  const stuck = page.getByRole("button", { name: "卡住的任務 1" });
  const sort = page.getByRole("combobox", { name: "待決策排序" });
  await expect(tabs).toHaveCount(4);
  const stuckLabel = (await stuck.getByText("卡住的任務", { exact: true }).boundingBox())!;
  expect(stuckLabel.width).toBeGreaterThanOrEqual(50);
  await expect(page.getByRole("heading", { name: "需要你處理" })).toHaveCount(0);
  const firstTab = (await tabs.first().boundingBox())!;
  let previousRight = firstTab.x - 8;
  for (const control of await tabs.all()) {
    await expect(control).toBeInViewport({ ratio: 1 });
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const gap = await control.evaluate((tab) => {
      const text = document.createRange();
      text.selectNodeContents(tab.firstChild!);
      return tab.lastElementChild!.getBoundingClientRect().left - text.getBoundingClientRect().right;
    });
    expect(gap).toBeGreaterThanOrEqual(4);
    expect(box.x - previousRight).toBeGreaterThanOrEqual(8);
    expect(Math.abs((box.y + box.height / 2) - (firstTab.y + firstTab.height / 2))).toBeLessThan(3);
    previousRight = box.x + box.width;
  }
  for (const control of [stuck, sort]) {
    await expect(control).toBeInViewport({ ratio: 1 });
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y).toBeGreaterThanOrEqual(firstTab.y + firstTab.height);
  }
  const shortcut = (await stuck.boundingBox())!;
  const sorting = (await sort.boundingBox())!;
  expect(sorting.y).toBe(shortcut.y);
  expect(sorting.x).toBeGreaterThan(shortcut.x + shortcut.width);
  await sort.selectOption({ label: "最新" });
  await expect(sort).toHaveValue("newest");
  await stuck.click();
  await expect(page.getByRole("heading", { name: "卡住的任務" })).toBeFocused();
});

test.describe("手機審核面板的焦點", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });
  for (const input of ["點按", "滑鼠", "Enter", "直接連結"] as const) {
    test(`${input}開啟時只有鍵盤顯示焦點框`, async ({ page }) => {
      const { tasks } = await mockInboxReview(page);
      const task = tasks[3];
      await page.goto(input === "直接連結" ? `/?review=${task.id}` : "/");
      const row = page.locator(`[data-review-row="${task.id}"]`);
      if (input === "點按") await row.tap();
      if (input === "滑鼠") await row.click();
      if (input === "Enter") await row.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: /確認專案與分支並核准修改/ })).toBeEnabled();
      await expect.poll(() => dialog.evaluate((sheet) => {
        const active = document.activeElement;
        if (!active || !sheet.contains(active)) return null;
        const style = getComputedStyle(active);
        return active.matches(":focus-visible") && ((parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none") || style.boxShadow !== "none");
      })).toBe(input === "Enter");
    });
  }
});

test("勾選後才出現批次操作，全選、清除及取消最後一筆都更新操作列", async ({ page }) => {
  await mockInboxReview(page);
  await page.goto("/");
  const checks = page.getByRole("list", { name: "待決策佇列" }).getByRole("checkbox");
  const selectAll = page.getByRole("button", { name: "全選本頁" });
  const clear = page.getByRole("button", { name: "清除選取" });
  await expect(checks.first()).toBeVisible();
  await expect(selectAll).toBeHidden();
  await expect(clear).toBeHidden();
  await checks.first().check();
  await expect(clear).toBeVisible();
  await selectAll.click();
  await expect(page.getByRole("button", { name: `結束選取的 ${await checks.count()} 張任務` })).toBeVisible();
  await clear.click();
  await expect(selectAll).toBeHidden();
  await expect(checks.first()).not.toBeChecked();
  await checks.first().check();
  await checks.first().uncheck();
  await expect(clear).toBeHidden();
});

test("有補問草稿時用鍵盤切換分類，可繼續編輯或放棄後離開", async ({ page }) => {
  const { tasks } = await mockInboxReview(page);
  await page.goto(`/?review=${tasks[1].id}`);
  const answer = page.getByRole("textbox", { name: "回答這個問題" });
  const draft = tasks[1].summary;
  await answer.fill(draft);
  const moving = page.getByRole("tab", { name: /進行中/ });
  await moving.press("Enter");
  const guard = page.getByRole("dialog", { name: "放棄未儲存的修改？" });
  await guard.getByRole("button", { name: "繼續編輯" }).press("Enter");
  await expect(guard).toBeHidden();
  await expect(answer).toHaveValue(draft);
  await moving.press("Enter");
  await guard.getByRole("button", { name: "放棄修改" }).press("Enter");
  await expect(moving).toHaveAttribute("aria-selected", "true");
  await expect(answer).toBeHidden();
  await expect(page).not.toHaveURL(/review=/);
  await page.goBack();
  await expect(page).toHaveURL(`/?review=${tasks[1].id}`);
  await expect(page.getByRole("tab", { name: /^決定/ })).toHaveAttribute("aria-selected", "true");
  await expect(answer).toBeVisible();
});
