import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  answeredDetail,
  defaultState,
  departedLineGroup,
  discordGroup,
  discordHealth,
  emitDashboardEvent,
  exhaustedPushHealth,
  group,
  mockDashboard,
  statusChat,
  statusProjects,
  unnamedLineGroup,
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

    test("群組頁辨識未命名群組並預設收合已離開的群組", async ({
      page,
    }, info) => {
      await mockDashboard(page, {
        state: { groups: [departedLineGroup, unnamedLineGroup, discordGroup] },
      });
      await page.goto("/groups");
      await expect(
        page.getByText("設定 LINE 群組與 Discord 頻道可修改的專案與 AI 記憶"),
      ).toBeVisible();
      const unnamed = page.getByRole("button", { name: /未命名的 LINE 群組/ });
      await expect(unnamed).toContainText(/建立日期 2026\/0?1\/0?1/);
      await expect(unnamed).toContainText(/最近一則訊息.*13:30/);
      await expect(unnamed.locator("time").last()).toHaveAttribute(
        "datetime",
        "2026-01-02T05:30:00Z",
      );
      await expect(page.getByText(/6d7e8f/)).toHaveCount(0);
      await expect(
        page.getByText(discordGroup.name, { exact: true }),
      ).toBeVisible();
      const summary = page.getByText("已離開的群組（1）", { exact: true });
      const departed = page.getByRole("button", { name: /範例舊群組/ });
      await expect(summary).toBeVisible();
      await expect(departed).toBeHidden();
      expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await summary.press("Enter");
      await expect(departed).toBeVisible();
      await expect(departed).toContainText("機器人已離開");
      await verifyLayout(page, info, "main", "群組頁已展開離開的群組");
      await summary.press("Space");
      await expect(departed).toBeHidden();
      await unnamed.press("Enter");
      const dialog = page.getByRole("dialog", { name: "未命名的 LINE 群組" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/6d7e8f/)).toHaveCount(0);
    });

    test("資料保存說明擁有者可更新連線金鑰及本機設定的範圍", async ({
      page,
    }, info) => {
      await mockDashboard(page);
      await page.goto("/settings?tab=data");
      const section = page.getByRole("tabpanel", { name: "資料與外觀" });
      await expect(
        section.getByText("資料保存", { exact: true }),
      ).toBeVisible();
      await expect(
        section.getByText(
          /金鑰只會寫入，不會顯示。擁有者可在「連線金鑰」更新。/,
        ),
      ).toBeVisible();
      await expect(
        section.getByText(/GitHub 與入口設定請在主機的本機設定頁修改。/),
      ).toBeVisible();
      await verifyLayout(
        page,
        info,
        "[role='tabpanel'][data-state='active']",
        "設定頁資料保存",
      );
    });

    test("任務詳情用一句話說明送達狀態，接著問只出現在按鈕", async ({
      page,
    }, info) => {
      const task = answeredDetail.task;
      await mockDashboard(page, {
        state: { tasks: [task] },
        routes: { [`/api/tasks/${task.id}`]: answeredDetail },
      });
      await page.goto(`/tasks?task=${task.id}`);
      const dialog = page.getByRole("dialog");
      const delivery = dialog.getByRole("status", { name: "群組訊息送達狀態" });
      await expect(delivery).toContainText(
        "查詢回答沒有送到群組，因為 LINE 本月推播額度已用完。",
      );
      await expect(delivery).not.toContainText(/[:：]/);
      await expect(dialog.getByText(/接著問/)).toHaveCount(1);
      const followup = dialog.getByRole("button", {
        name: "接著問",
        exact: true,
      });
      const input = dialog.getByRole("textbox", { name: "後續問題" });
      await expect(input).toHaveAccessibleDescription(/沿用原本的專案與分支/);
      await input.fill("示範報表有哪些欄位？");
      await expect(followup).toBeEnabled();
      expect((await followup.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await verifyLayout(
        page,
        info,
        '[data-slot="sheet-content"]',
        "任務詳情送達與追問",
      );
    });

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
      await page.goto("/settings?tab=connections");
      const services = page.getByRole("tabpanel", { name: /^連線與金鑰/ });
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
        "[role=tabpanel][data-state=active]",
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
      await page.goto("/settings?tab=notifications");
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
      await verifyLayout(page, info, "[aria-labelledby='admin-notifications-title']", "設定頁管理者通知與配對");
    });

    test("推播額度用完時，推播列省去重複警示與舊時間", async ({
      page,
    }, info) => {
      await mockDashboard(page, { state: { health: exhaustedPushHealth } });
      await page.goto("/settings?tab=connections");
      const services = page.getByRole("tabpanel", { name: /^連線與金鑰/ });
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
      await verifyLayout(page, info, "[role=tabpanel][data-state=active]", "設定頁服務連線");
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
      const add = page.getByRole("button", { name: "新增定期檢查" });
      const card = page.locator("#scheduled-checks");
      const name = card.getByRole("textbox", { name: "名稱", exact: true });
      await expect(name).toHaveCount(0);
      await add.press("Enter");
      await expect(page).toHaveURL("/checks");
      await expect(name).toBeFocused();
      await expect(name).toBeInViewport();
      await expect(card.locator("[data-slot='card-header'] + [data-slot='card-content'] form")).toHaveCount(1);
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
