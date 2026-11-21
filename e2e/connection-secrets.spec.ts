import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mockDashboard } from "./dashboard-fixture";

const key = "sk-fictional-connection-key-for-tests";
const section = "連線金鑰";

test("擁有者能在手機用鍵盤確認並更新金鑰", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockDashboard(page);
  await page.goto("/settings#settings-secrets");
  const settings = page.getByRole("region", { name: section });
  const input = settings.getByLabel("OpenAI API 金鑰", { exact: true });
  const update = settings.getByRole("button", { name: "更新 OpenAI API 金鑰" });
  await expect(input).toHaveAttribute("type", "password");
  await expect(update).toBeDisabled();
  await input.fill(key);
  await update.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "確認更新連線金鑰" });
  await expect(dialog.getByText("將更新 OpenAI API 金鑰。")).toBeVisible();
  await expect(dialog).not.toContainText(key);
  const scan = () =>
    new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
  expect((await scan()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "先不要" }).click();
  await expect(update).toBeFocused();
  await expect(input).toHaveValue(key);
  await update.click();
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "PUT" && request.url().endsWith("/api/secrets"),
  );
  await dialog.getByRole("button", { name: "確認更新" }).focus();
  await page.keyboard.press("Enter");
  expect((await sent).postDataJSON()).toEqual({ openaiKey: key });
  await expect(input).toHaveValue("");
  const row = settings.getByRole("listitem").filter({
    has: page.getByLabel("OpenAI API 金鑰", { exact: true }),
  });
  await expect(row.getByText("已設定", { exact: true })).toBeVisible();
  await expect(row.getByText("最後更新：沒有更新紀錄")).toHaveCount(0);
  await expect(input).toHaveCSS("min-height", "44px");
  await expect(update).toHaveCSS("min-height", "44px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  expect((await scan()).violations).toEqual([]);
});

test("擁有者可以確認移除 Discord 選填權杖", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/settings#settings-secrets");
  await page.getByRole("checkbox", { name: "移除 Discord 機器人權杖" }).check();
  await page.getByRole("button", { name: "更新 Discord 機器人權杖" }).click();
  const dialog = page.getByRole("dialog", { name: "確認更新連線金鑰" });
  await expect(dialog.getByText("將移除 Discord 機器人權杖。")).toBeVisible();
  await dialog.getByRole("button", { name: "確認移除" }).click();
  const row = page.getByRole("listitem").filter({
    has: page.getByLabel("Discord 機器人權杖", { exact: true }),
  });
  await expect(row.getByText("未設定", { exact: true })).toBeVisible();
});

test("一般管理者只看到權限說明", async ({ page }) => {
  await mockDashboard(page, {
    routes: {
      "/api/me": {
        id: "2",
        login: "小林",
        csrf: "fictional-csrf",
        role: "admin",
        owner: false,
      },
    },
  });
  await page.goto("/settings#settings-secrets");
  await expect(page.getByText("連線金鑰只有擁有者能更新")).toBeVisible();
  await expect(page.getByRole("region", { name: section })).toHaveCount(0);
  await expect(page.getByLabel("OpenAI API 金鑰", { exact: true })).toHaveCount(
    0,
  );
});

test("登入時間超過十分鐘時清空輸入並提供回到連線金鑰的登入連結", async ({
  page,
}) => {
  await mockDashboard(page, { reauthConnectionSecrets: true });
  await page.goto("/settings#settings-secrets");
  const input = page.getByLabel("OpenAI API 金鑰", { exact: true });
  await input.fill(key);
  await page.getByRole("button", { name: "更新 OpenAI API 金鑰" }).click();
  await page.getByRole("button", { name: "確認更新" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "GitHub 登入已超過十分鐘",
  );
  await expect(input).toHaveValue("");
  await expect(
    page.getByRole("link", { name: "使用 GitHub 重新登入" }),
  ).toHaveAttribute("href", "/auth/github?returnTo=settings-secrets");
});
