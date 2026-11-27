import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  answeredDetail,
  blockedCheck,
  checkAttentionRoutes,
  defaultState,
  departedLineGroup,
  discordGroup,
  discordHealth,
  emitDashboardEvent,
  exhaustedPushHealth,
  group,
  groupMemory,
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

async function verifyTouchHeight(control: Locator) {
  const height = await control.evaluate((element) =>
    element instanceof HTMLElement ? element.offsetHeight : 0,
  );
  expect(height).toBeGreaterThanOrEqual(44);
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
          /讀取訊息歷史、傳送訊息、建立公開討論串、在討論串中傳送訊息、加入反應、嵌入連結與附加檔案/,
        ),
      ).toBeVisible();
      await verifyLayout(
        page,
        info,
        "[role=tabpanel][data-state=active]",
        "設定頁 Discord 連線",
      );
    });

    test("管理者可用鍵盤先配對 Discord，再儲存通知目的地", async ({
      page,
    }, info) => {
      const settings = { ...defaultState.settings, admin_line_id: "已綁定" };
      await mockDashboard(page, {
        state: { settings },
        pairingCodes: { line: "abcdef0123456789", discord: "0123456789abcdef" },
      });
      let saves = 0;
      await page.route("**/api/settings/admin-notifications", async (route) => {
        saves++;
        expect(route.request().method()).toBe("PUT");
        expect(route.request().postDataJSON()).toEqual({ admin_notify_platform: "discord" });
        expect(settings.admin_discord_id).toBe("已綁定");
        settings.admin_notify_platform = "discord";
        await route.fulfill({ json: { ok: true } });
      });
      await page.goto("/settings?tab=notifications");
      const region = page.getByRole("region", { name: "管理者通知", exact: true });
      await expect(region.getByRole("status")).toContainText("LINE 私訊");
      await expect(region.getByRole("status")).toContainText("已配對");
      const select = region.getByRole("combobox", { name: "管理者通知送到" });
      const save = region.getByRole("button", { name: "儲存通知設定" });
      await expect(select.locator("option[value=discord]")).toHaveText("Discord（尚未配對）");
      await select.focus();
      await page.keyboard.press("ArrowDown");
      await expect(select).toHaveValue("discord");
      await expect(save).toBeDisabled();
      await expect(region.getByText("請先完成 Discord 配對，再儲存通知設定。")).toBeVisible();
      const pairing = region.getByRole("button", { name: "產生配對碼" });
      await verifyTouchHeight(select);
      await verifyTouchHeight(pairing);
      await pairing.press("Enter");
      await expect(region.getByText("配對 0123456789abcdef")).toBeVisible();
      await expect(region.getByText(/在 10 分鐘內私訊 Discord 機器人/)).toBeVisible();
      await expect(save).toBeDisabled();
      await expect(region.getByRole("status")).toContainText("LINE 私訊");
      expect(saves).toBe(0);
      await verifyLayout(page, info, "[aria-labelledby='admin-notifications-title']", "切換通知目的地前先配對");
      settings.admin_discord_id = "已綁定";
      await emitDashboardEvent(page, "update");
      await expect(select.locator("option[value=discord]")).toHaveText("Discord");
      await expect(region.getByText("Discord 已配對，可以儲存通知設定。")).toBeVisible();
      await expect(save).toBeEnabled();
      await verifyTouchHeight(save);
      await save.press("Enter");
      await expect(region.getByRole("status")).toContainText("Discord 私訊");
      await expect(region.getByRole("status")).toContainText("已配對");
      expect(saves).toBe(1);
    });

    test("群組記憶分欄顯示中繼資料且沒有間隔點", async ({ page }, info) => {
      const namedGroup = { ...group, name: "範例群組" };
      await mockDashboard(page, {
        state: { groups: [namedGroup], memories: [groupMemory] },
      });
      await page.goto("/groups");
      const region = page.getByRole("region", { name: "最近新增的群組記憶" });
      const row = region.getByRole("listitem").filter({ hasText: groupMemory.content });
      await expect(row).toBeVisible();
      for (const field of [namedGroup.name, "不指定專案", "AI 自動記住"]) {
        await expect(row.getByText(field, { exact: true })).toBeVisible();
      }
      await expect(row.locator("time")).toHaveAttribute("datetime", groupMemory.created_at);
      await expect(row).not.toContainText(/[・·]/);
      const edit = region.getByRole("button", { name: "選擇要編輯的群組" });
      await verifyTouchHeight(edit);
      await verifyLayout(page, info, "[aria-labelledby='recent-group-memory-title']", "群組記憶中繼資料");
    });

    test("定期檢查從 22 項篩出 2 項需處理，可展開原因並保留網址", async ({ page }, info) => {
      await mockDashboard(page, { routes: checkAttentionRoutes });
      await page.goto("/checks");
      const filters = page.getByRole("group", { name: "檢查篩選" });
      const all = filters.getByRole("button", { name: "全部" });
      const attention = filters.getByRole("button", { name: "需處理" });
      const list = page.getByRole("list", { name: "定期檢查清單" });
      const rows = list.locator(":scope > li");
      await expect(rows).toHaveCount(22);
      await expect(all).toHaveAttribute("aria-pressed", "true");
      for (const button of [all, attention]) {
        await verifyTouchHeight(button);
      }
      await attention.press("Enter");
      await expect(page).toHaveURL("/checks?filter=attention");
      await expect(rows).toHaveCount(2);
      await page.reload();
      await expect(attention).toHaveAttribute("aria-pressed", "true");
      await expect(rows).toHaveCount(2);
      const device = list.getByRole("button", { name: /示範設備檢查/ });
      const database = list.getByRole("button", { name: /示範資料庫檢查/ });
      await expect(device).toContainText("設備異常");
      await expect(database).toContainText("連線缺失");
      await verifyTouchHeight(device);
      await device.press("Enter");
      await expect(device).toHaveAttribute("aria-expanded", "true");
      await expect(list.getByRole("list", { name: "最近結果明細" }))
        .toContainText("示範設備的溫度超過門檻");
      await database.press("Enter");
      await expect(database).toHaveAttribute("aria-expanded", "true");
      await expect(list.getByText(/這個專案還沒有登記資料庫連線/)).toBeVisible();
      await verifyLayout(page, info, "#scheduled-checks", "定期檢查篩選與異常原因");
      await all.press("Enter");
      await expect(page).toHaveURL("/checks");
      await expect(rows).toHaveCount(22);
      await attention.press("Enter");
      const navigation = page.getByRole("navigation", { name: "看板導覽" });
      if (viewport.width === 375) {
        await navigation.getByRole("button", { name: "更多", exact: true }).press("Enter");
        await page.getByRole("menuitem", { name: "定期檢查", exact: true }).press("Enter");
      } else {
        await navigation.getByRole("button", { name: "定期檢查", exact: true }).press("Enter");
      }
      await expect(page).toHaveURL("/checks");
      await expect(rows).toHaveCount(22);
    });

    test("需處理篩選納入系統無法執行的定期檢查", async ({ page }) => {
      await mockDashboard(page, {
        routes: { ...checkAttentionRoutes, "/api/checks": [blockedCheck] },
      });
      await page.goto("/checks?filter=attention");
      const check = page.getByRole("button", { name: /示範連線檢查/ });
      await expect(check).toContainText("系統無法執行");
      await check.press("Enter");
      await expect(page.getByText(/系統暫時無法執行（讀不到主機執行器）/)).toBeVisible();
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
