import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import {
  exampleMember,
  exampleOwner,
  mockDashboard,
} from "./dashboard-fixture";

const memberPath = `/api/members/${exampleMember.github_id}`;
const roleName = `${exampleMember.login} 的角色`;

// 選單開啟有縮放動畫，boundingBox 會量到縮小中的尺寸；改量元素本身的大小。
async function expectTouchTarget(control: Locator) {
  const { width, height } = await control.evaluate((el) => ({
    width: (el as HTMLElement).offsetWidth,
    height: (el as HTMLElement).offsetHeight,
  }));
  expect(width).toBeGreaterThanOrEqual(44);
  expect(height).toBeGreaterThanOrEqual(44);
}

for (const { width, keyboard, label } of [
  { width: 1280, keyboard: true, label: "鍵盤" },
  { width: 375, keyboard: false, label: "滑鼠" },
]) {
  test(`用${label}改選角色時，取消不送出，確認只送出一次`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const requests: unknown[] = [];
    await mockDashboard(page, {
      routes: { "/api/members": [exampleOwner, exampleMember] },
    });
    await page.route(`**${memberPath}`, async (route) => {
      expect(route.request().method()).toBe("PUT");
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...exampleMember, role: "admin" } });
    });

    await page.goto("/members");
    const role = page.getByRole("combobox", { name: roleName });
    await expect(role).toHaveText("成員");
    if (width === 375) {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(375);
    }
    const ownerLabel = page.getByText("擁有者，固定為管理者");
    const owner = page.getByRole("listitem").filter({ has: ownerLabel });
    await expect(ownerLabel).toBeVisible();
    await expect(owner.getByRole("combobox")).toHaveCount(0);
    const pickAdmin = async () => {
      if (keyboard) {
        await role.press("Space");
        const current = page.getByRole("option", { name: "成員", exact: true });
        await expect(current).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(
          page.getByRole("option", { name: "管理者" }),
        ).toBeFocused();
        await page.keyboard.press("Enter");
      } else {
        await expectTouchTarget(role);
        await role.click();
        const option = page.getByRole("option", { name: "管理者" });
        await expectTouchTarget(option);
        await option.click();
      }
    };

    await pickAdmin();
    const dialog = page.getByRole("dialog", { name: "變更成員角色" });
    const cancel = dialog.getByRole("button", { name: "取消" });
    const confirm = dialog.getByRole("button", { name: "確認變更" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(exampleMember.login, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(/原角色\s*成員/)).toBeVisible();
    await expect(dialog.getByText(/新角色\s*管理者/)).toBeVisible();
    await expect(
      dialog.getByText("將取得管理群組、專案、設定、系統與成員名單的權限。"),
    ).toBeVisible();
    expect(requests).toEqual([]);
    if (keyboard) {
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      await expectTouchTarget(cancel);
      await expectTouchTarget(confirm);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(375);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(violations).toEqual([]);
      await cancel.click();
    }
    await expect(dialog).toBeHidden();
    await expect(role).toBeFocused();
    await expect(role).toHaveText("成員");
    expect(requests).toEqual([]);

    await pickAdmin();
    if (keyboard) {
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(confirm).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      await confirm.click();
    }
    await expect(dialog).toBeHidden();
    await expect(role).toHaveText("管理者");
    await expect(role).toBeFocused();
    expect(requests).toEqual([{ role: "admin" }]);
  });
}

test("降為成員會提示移除的權限，名單與提示採用服務回傳的角色", async ({
  page,
}) => {
  const admin = { ...exampleMember, role: "admin" } as const;
  await mockDashboard(page, {
    routes: { "/api/members": [exampleOwner, admin] },
  });
  await page.route(`**${memberPath}`, (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({ role: "member" });
    return route.fulfill({ json: admin });
  });
  await page.goto("/members");
  const role = page.getByRole("combobox", { name: roleName });
  await role.click();
  await page.getByRole("option", { name: "成員", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "變更成員角色" });
  await expect(dialog.getByText(/原角色\s*管理者/)).toBeVisible();
  await expect(dialog.getByText(/新角色\s*成員/)).toBeVisible();
  await expect(
    dialog.getByText("將失去管理群組、專案、設定、系統與成員名單的權限。"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "確認變更" }).click();
  await expect(dialog).toBeHidden();
  await expect(role).toHaveText("管理者");
  await expect(
    page.getByText(`${exampleMember.login} 目前的角色為管理者。`),
  ).toBeVisible();
});

test("服務未確認角色變更時，保留原顯示並提示重新整理", async ({ page }) => {
  await mockDashboard(page, {
    routes: { "/api/members": [exampleOwner, exampleMember] },
  });
  await page.route(`**${memberPath}`, (route) =>
    route.fulfill({ status: 503, body: "Service Unavailable" }),
  );
  await page.goto("/members");
  const role = page.getByRole("combobox", { name: roleName });
  await role.click();
  await page.getByRole("option", { name: "管理者" }).click();
  const dialog = page.getByRole("dialog", { name: "變更成員角色" });
  await dialog.getByRole("button", { name: "確認變更" }).click();
  await expect(dialog).toBeHidden();
  await expect(role).toHaveText("成員");
  await expect(
    page.getByText(/無法確認角色是否已變更.*請重新整理成員名單/),
  ).toBeVisible();
});
