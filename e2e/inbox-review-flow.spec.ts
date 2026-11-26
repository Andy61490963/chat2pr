import { expect, test, type Locator } from "@playwright/test";
import { mockInboxReview } from "./dashboard-fixture";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

test("佇列可用 J、K 切換，Enter 開啟主動作，回答時輸入不換筆", async ({ page }) => {
  const { tasks } = await mockInboxReview(page);
  await page.goto("/");
  const queue = page.getByRole("list", { name: "待決策佇列" });
  const first = queue.getByRole("button", { name: new RegExp(tasks[0].title) });
  const second = queue.getByRole("button", { name: new RegExp(tasks[1].title) });
  await first.focus();
  await page.keyboard.press("j");
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("k");
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("j");
  await expect(second).toBeFocused();
  await page.keyboard.press("Enter");
  const review = page.getByRole("region", { name: "審核面板" });
  const answer = review.getByRole("button", { name: /回答問題/ });
  await expect(answer).toBeFocused();
  await answer.press("Enter");
  const field = review.getByRole("textbox", { name: "回答這個問題" });
  await expect(field).toBeFocused();
  await field.pressSequentially("jk");
  await expect(field).toHaveValue("jk");
  await expect(page).toHaveURL(new RegExp(`review=${tasks[1].id}$`));
});

test("長原文預設只預覽，展開能讀到最後一行與檢視縮圖，再收合會還原", async ({ page }) => {
  const { tasks, sourceEnd } = await mockInboxReview(page);
  await page.goto(`/?review=${tasks[3].id}`);
  const source = page.getByRole("region", { name: "來源原文" });
  const expand = source.getByRole("button", { name: /展開來源原文/ });
  await expect(expand).toBeVisible();
  await expect(source).toContainText("請幫示範專案整理月底的對帳明細");
  const compact = (await source.boundingBox())!.height;
  await expand.press("Enter");
  const collapse = source.getByRole("button", { name: /收合來源原文/ });
  await expect(collapse).toBeVisible();
  await expect(source.getByText(sourceEnd, { exact: false })).toBeVisible();
  const image = source.getByRole("img", { name: "來源圖片" });
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalHeight)).toBeGreaterThan(128);
  expect((await image.boundingBox())!.height).toBeLessThanOrEqual(128);
  expect((await source.boundingBox())!.height).toBeGreaterThan(compact + 100);
  await collapse.press("Enter");
  await expect(expand).toBeVisible();
  await expect.poll(async () => Math.abs((await source.boundingBox())!.height - compact)).toBeLessThan(2);
});

for (const decision of [
  { title: "核准", index: 3, name: /確認專案與分支並核准修改/, action: "approve", notice: /已.*核准/ },
  { title: "重試", index: 6, name: /^重試/, action: "retry", notice: /已重新排程|已重試/ },
  { title: "結束", index: 3, name: /^結束任務/, action: "reject", notice: /已.*(結束|拒絕)/ },
]) {
  test(`${decision.title}後有完成回饋、選取下一筆並保留閱讀位置`, async ({ page }) => {
    const { state, tasks } = await mockInboxReview(page);
    const current = tasks[decision.index];
    const next = tasks[decision.index + 1];
    const endpoint = `**/api/tasks/${current.id}/actions`;
    await page.route(endpoint, (route) => {
      expect(route.request().postDataJSON()).toMatchObject({ action: decision.action, version: current.version });
      const status = decision.action === "reject" ? "rejected" : "queued";
      state.tasks = state.tasks.map((entry) => entry.id === current.id ? { ...current, status } : entry);
      return route.fulfill({ json: { ...current, status } });
    });
    await page.goto(`/?review=${current.id}`);
    const review = page.getByRole("region", { name: "審核面板" });
    const action = review.getByRole("button", { name: decision.name });
    await expect(action).toBeEnabled();
    const before = await page.evaluate(() => {
      window.scrollTo(0, 400);
      return window.scrollY;
    });
    expect(before).toBeGreaterThan(100);
    await expect(action).toBeInViewport({ ratio: 1 });
    await action.click();
    if (decision.action === "reject") {
      const dialog = page.getByRole("dialog", { name: "結束任務？" });
      await dialog.getByRole("radio", { name: "需求不清楚" }).check();
      await dialog.getByRole("button", { name: "結束任務", exact: true }).press("Enter");
    }
    await expect(page.getByRole("status").filter({ hasText: decision.notice })).toBeVisible();
    await expect(review.getByRole("heading", { name: next.title })).toBeVisible();
    const queue = page.getByRole("list", { name: "待決策佇列" });
    await expect(queue.getByRole("button", { name: new RegExp(current.title) })).toHaveCount(0);
    await expect(queue.getByRole("button", { name: new RegExp(next.title) })).toHaveAttribute("aria-current", "true");
    await expect(review.getByRole("button", { name: /回答問題/ })).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(before - 80);
  });
}

test("手機上捲動審核明細時，三個決定仍留在底部且可點擊", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { tasks } = await mockInboxReview(page);
  await page.goto(`/?review=${tasks[3].id}`);
  const dialog = page.getByRole("dialog", { name: tasks[3].title });
  const actions = [/確認專案與分支並核准修改/, /修改這一題/, /^結束任務/]
    .map((name) => dialog.getByRole("button", { name }));
  const check = async (button: Locator) => {
    await expect(button).toBeInViewport({ ratio: 1 });
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y).toBeGreaterThan(812 * 0.65);
    expect(await button.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    })).toBe(true);
    return box.y;
  };
  const positions = [];
  for (const action of actions) positions.push(await check(action));
  const source = dialog.getByRole("region", { name: "來源原文" });
  const start = (await source.boundingBox())!.y;
  await page.mouse.move(160, 410);
  await page.mouse.wheel(0, 500);
  await expect.poll(async () => (await source.boundingBox())!.y).toBeLessThan(start - 50);
  for (const [index, action] of actions.entries()) {
    expect(Math.abs(await check(action) - positions[index])).toBeLessThan(2);
  }
});
