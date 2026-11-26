import { expect, test } from "@playwright/test";
import { mockDashboard, mockInboxReview, reviewWorkbenchFixture, summaryActivity, summaryTasks } from "./dashboard-fixture";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

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

test("手機首屏四個分類、排序與卡住任務捷徑同列且能完整點按", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockInboxReview(page);
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "收件匣分類" }).getByRole("tab");
  const stuck = page.getByRole("button", { name: "卡住的任務 1" });
  const sort = page.getByRole("combobox", { name: "待決策排序" });
  await expect(tabs).toHaveCount(4);
  await expect(page.getByRole("heading", { name: "需要你處理" })).toHaveCount(0);
  const firstTab = (await tabs.first().boundingBox())!;
  let previousRight = firstTab.x;
  for (const control of [...await tabs.all(), stuck, sort]) {
    await expect(control).toBeInViewport({ ratio: 1 });
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(previousRight - 1);
    expect(Math.abs((box.y + box.height / 2) - (firstTab.y + firstTab.height / 2))).toBeLessThan(3);
    previousRight = box.x + box.width;
  }
  await sort.selectOption({ label: "最新" });
  await expect(sort).toHaveValue("newest");
  await stuck.click();
  await expect(page.getByRole("heading", { name: "卡住的任務" })).toBeFocused();
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
