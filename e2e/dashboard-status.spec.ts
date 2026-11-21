import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  defaultState,
  discordHealth,
  emitDashboardEvent,
  exhaustedPushHealth,
  group,
  mockDashboard,
  statusChat,
  statusProjects,
} from "./dashboard-fixture";

async function verifyLayout(
  page: Page,
  info: TestInfo,
  section: string,
  title: string,
) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
  expect(
    await page
      .locator(section)
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await info.attach(title, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  const { violations } = await new AxeBuilder({ page })
    .include(section)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations).toEqual([]);
}

for (const viewport of [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
]) {
  test.describe(`看板狀態（${viewport.width}px）`, () => {
    test.use({ viewport });

    test("系統頁區分版本符合、需要重新驗證與可清理的映像", async ({
      page,
    }, info) => {
      await mockDashboard(page, { state: { projects: statusProjects } });
      await page.goto("/system?tab=disk");
      const images = page.getByRole("region", { name: /^工作映像/ });
      await expect(
        images.getByText("版本 demo", { exact: true }),
      ).toBeVisible();
      const outdated = images
        .getByRole("listitem")
        .filter({ hasText: "使用中：示範專案" });
      await expect(
        outdated.getByText("過舊，請重新驗證使用它的專案"),
      ).toBeVisible();
      const unused = images.getByText("沒有專案使用，可清理", { exact: true });
      await expect(unused).toBeVisible();
      await expect(unused).toHaveClass(/\bbg-secondary\b/);
      await expect(images.getByText(/下方「Docker 磁碟」/)).toBeVisible();
      await verifyLayout(page, info, "#worker-images", "系統頁工作映像");
    });

    test("服務連線顯示 Discord 狀態，可用鍵盤開啟邀請說明", async ({
      page,
    }, info) => {
      await mockDashboard(page, { state: { health: discordHealth } });
      await page.goto("/settings");
      const services = page.getByRole("region", { name: "服務連線" });
      await expect(services.getByText("已連線", { exact: true })).toBeVisible();
      const invite = services.getByText("邀請機器人到伺服器", { exact: true });
      await invite.focus();
      await invite.press("Enter");
      await expect(
        services.getByText(
          /讀取訊息歷史、傳送訊息、加入反應、嵌入連結與附加檔案/,
        ),
      ).toBeVisible();
      await verifyLayout(
        page,
        info,
        "#settings-services",
        "設定頁 Discord 連線",
      );
    });

    test("管理者可用鍵盤切換通知平台，查看 Discord 配對狀態與配對指示", async ({
      page,
    }, info) => {
      const settings = { ...defaultState.settings, admin_line_id: "已綁定" };
      await mockDashboard(page, { state: { settings }, pairingCode: "0123456789abcdef" });
      await page.route("**/api/settings/admin-notifications", async (route) => {
        expect(route.request().method()).toBe("PUT");
        expect(route.request().postDataJSON()).toEqual({ admin_notify_platform: "discord" });
        settings.admin_notify_platform = "discord";
        await route.fulfill({ json: { ok: true } });
      });
      await page.goto("/settings");
      const region = page.getByRole("region", { name: "管理者通知", exact: true });
      await expect(region.getByRole("status")).toContainText("LINE 私訊");
      await expect(region.getByRole("status")).toContainText("已配對");
      const select = region.getByRole("combobox", { name: "管理者通知送到" });
      await select.focus();
      await page.keyboard.press("ArrowDown");
      await expect(select).toHaveValue("discord");
      await region.getByRole("button", { name: "儲存通知設定" }).press("Enter");
      await expect(region.getByRole("status")).toContainText("Discord 私訊");
      await expect(region.getByRole("status")).toContainText("尚未配對");
      const pairing = region.getByRole("button", { name: "產生配對碼" });
      expect((await pairing.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await pairing.press("Enter");
      await expect(region.getByText("配對 0123456789abcdef")).toBeVisible();
      await expect(region.getByText(/在 10 分鐘內私訊 Discord 機器人/)).toBeVisible();
      settings.admin_discord_id = "已綁定";
      await emitDashboardEvent(page, "update");
      await expect(region.getByRole("status")).toContainText("已配對");
      await verifyLayout(page, info, "section[aria-labelledby='settings-notifications']", "設定頁管理者通知與配對");
    });

    test("推播額度用完時，推播列省去重複警示與舊時間", async ({
      page,
    }, info) => {
      await mockDashboard(page, { state: { health: exhaustedPushHealth } });
      await page.goto("/settings");
      const services = page.getByRole("region", { name: "服務連線" });
      const push = services.getByRole("listitem").filter({
        has: page.getByText("LINE 推播（群組回覆與私訊）", { exact: true }),
      });
      await expect(push).toHaveCount(0);
      const summary = services.getByText("全部服務", { exact: true });
      await summary.focus();
      await summary.press("Enter");
      await expect(
        push.getByText("本月額度用完，見下一列", { exact: true }),
      ).toBeVisible();
      await expect(push).not.toContainText(/需處理|Error:|429|最近一次/);
      const quota = services
        .getByRole("listitem")
        .filter({ has: page.getByText("LINE 推播額度", { exact: true }) });
      await expect(
        quota.getByText("本月推播額度已用完", { exact: false }).first(),
      ).toBeVisible();
      await expect(
        quota.getByText("需處理", { exact: true }).first(),
      ).toBeVisible();
      await verifyLayout(page, info, "#settings-services", "設定頁服務連線");
    });

    test("定期檢查空狀態有可執行的動作和範例，規則可用鍵盤展開", async ({
      page,
    }, info) => {
      await mockDashboard(page);
      await page.goto("/checks");
      await expect(
        page.getByText("還沒有定期檢查", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("例如每小時檢查一次示範服務是否能連線。"),
      ).toBeVisible();
      const rules = page.getByText(/^SQL 檢查需要資料庫連線/);
      await expect(rules).toBeHidden();
      await verifyLayout(page, info, "#scheduled-checks", "定期檢查空狀態");
      const summary = page.getByText("怎麼運作", { exact: true });
      await summary.focus();
      await summary.press("Enter");
      await expect(rules).toBeVisible();
      await page.getByRole("button", { name: "新增定期檢查" }).click();
      await expect(
        page.getByRole("textbox", { name: "名稱", exact: true }),
      ).toBeVisible();
    });

    test("聊天室統一沒有需求的標籤並保留等待辨識", async ({ page }, info) => {
      await mockDashboard(page, {
        state: { groups: [{ ...group, name: "範例群組" }] },
        routes: { [`/api/groups/${group.id}/messages`]: statusChat },
      });
      await page.goto("/chat");
      const messages = page.getByRole("list", { name: "群組訊息" });
      await expect(messages.getByText("沒有需求", { exact: true })).toHaveCount(
        2,
      );
      await expect(
        messages.getByText("等待辨識", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("無法補抓機器人加入前的歷史", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("#chat-timeline")).not.toContainText(/[・·]/);
      await verifyLayout(page, info, "#chat-timeline", "聊天室訊息狀態");
    });
  });
}
