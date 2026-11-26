import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockInboxFlow, project } from "./dashboard-fixture";

const row = (page: Page, title: string) => page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });
const details = (page: Page, title: string) => row(page, title).getByRole("button", { name: /查看詳情/ });

test("核准一筆後留在清單，按 Enter 直接開啟下一筆", async ({ page }) => {
  const { tasks: [first, next], state } = await mockInboxFlow(page);
  let requests = 0;
  await page.route(`**/api/tasks/${first.id}/actions`, async route => {
    expect(route.request().postDataJSON()).toEqual({ action: "approve", version: first.version, project_id: project.id, target_branch: first.target_branch, config_version: project.config_version, binding_version: 1 });
    requests++;
    state.tasks = state.tasks.filter(task => task.id !== first.id);
    await route.fulfill({ json: { ...first, status: "queued" } });
  });
  await page.goto("/");
  await row(page, first.title).getByRole("button", { name: /核准/ }).click();
  await expect(row(page, first.title)).toHaveCount(0);
  expect(requests).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").getByRole("heading", { name: next.title }).first()).toBeVisible();
});

for (const scenario of ["成員", "風險", "版本變更"] as const) {
  test(`${scenario}時不送出快速核准`, async ({ page }) => {
    const { tasks: [first] } = await mockInboxFlow(page, false, scenario);
    const actions: string[] = [];
    await page.route(/\/api\/tasks\/[^/]+\/actions$/, route => {
      actions.push(route.request().url());
      return route.fulfill({ status: 409, json: { error: "示範版本已變更" } });
    });
    await page.goto("/");
    await expect(page.getByRole("tab", { name: /^需要你決定/ })).toBeVisible();
    const quick = row(page, first.title).getByRole("button", { name: /核准/, disabled: false });
    if (scenario === "版本變更") {
      await quick.click();
      await expect(page.getByText(/版本.*變更|內容.*更新|資料.*更新|重新確認/).first()).toBeVisible();
    } else {
      if (scenario === "風險") await expect(details(page, first.title)).toBeVisible();
      await expect(quick).toHaveCount(0);
    }
    expect(actions).toEqual([]);
  });
}

test("鍵盤切換案件不開啟抽屜，按 Enter 開啟、Esc 返回", async ({ page }) => {
  const { tasks: [first, second, third] } = await mockInboxFlow(page);
  await page.goto("/");
  await details(page, first.title).focus();
  for (const [key, target] of [["j", second], ["ArrowDown", third], ["k", second], ["ArrowUp", first]] as const) {
    await page.keyboard.press(key);
    await expect(details(page, target.title)).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details(page, first.title)).toBeFocused();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${viewport.width} 像素${theme === "dark" ? "深色" : "淺色"}`, () => {
      test.use({ viewport, colorScheme: theme, reducedMotion: "reduce" });
      test("清單與長原文抽屜符合無障礙規範，決定按鈕在畫面內", async ({ page }) => {
        await page.addInitScript(value => localStorage.setItem("agentflow-theme", value), theme);
        const { tasks: [first] } = await mockInboxFlow(page);
        await page.goto("/");
        await expect(details(page, first.title)).toBeVisible();
        const check = async () => {
          await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))));
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
          expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
        };
        await check();
        await details(page, first.title).click();
        const dialog = page.getByRole("dialog");
        const action = dialog.getByRole("button", { name: /核准/ }).first();
        await expect(action).toBeInViewport({ ratio: 1 });
        await check();
        if (viewport.width === 375) {
          await dialog.getByRole("button", { name: /展開.*原文|展開全文/ }).first().click();
          await dialog.getByText(/第 18 項/).last().scrollIntoViewIfNeeded();
          await expect(action).toBeInViewport({ ratio: 1 });
          expect(await action.evaluate(button => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        }
      });
    });
  }
}
