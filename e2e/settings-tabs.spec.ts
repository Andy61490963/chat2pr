import { expect, test } from "@playwright/test";
import { LINE_QUOTA } from "../shared/line-quota";
import { discordServiceText } from "../shared/status-glossary";
import {
  defaultState,
  emitDashboardEvent,
  mockDashboard,
} from "./dashboard-fixture";

const tabs = [
  { label: "AI 與執行", value: "ai", heading: "AI 執行模式" },
  { label: "通知", value: "notifications", heading: "管理者通知" },
  { label: "連線與金鑰", value: "connections", heading: "服務連線" },
  { label: "資料與外觀", value: "data", heading: "介面外觀" },
] as const;

test("設定分頁可用方向鍵切換，只顯示選取內容並保留網址參數", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.goto("/settings?tab=unknown&source=demo");
  const list = page.getByRole("tablist", { name: "設定分頁" });
  const ai = list.getByRole("tab", { name: "AI 與執行", exact: true });
  await expect(list.getByRole("tab")).toHaveCount(4);
  await expect(ai).toHaveAttribute("aria-selected", "true");
  await ai.focus();
  for (const { label, value, heading } of [...tabs.slice(1), tabs[0]]) {
    await page.keyboard.press("ArrowRight");
    const selected = list.getByRole("tab", { name: new RegExp(`^${label}`) });
    const panel = page.getByRole("tabpanel");
    await expect(selected).toBeFocused();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute(
      "id",
      (await selected.getAttribute("aria-controls"))!,
    );
    await expect(
      panel.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    for (const other of tabs.filter((item) => item.value !== value))
      await expect(
        page.getByRole("heading", { name: other.heading, exact: true }),
      ).toHaveCount(0);
    await expect(page).toHaveURL(`/settings?tab=${value}&source=demo`);
  }
  await page.goBack();
  await expect(
    page.getByRole("tabpanel", { name: "資料與外觀" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("tabpanel", { name: "資料與外觀" }),
  ).toBeVisible();
  await page.goForward();
  await expect(ai).toHaveAttribute("aria-selected", "true");
});

for (const [hash, value, heading] of [
  ["settings-line", "notifications", "管理者通知"],
  ["settings-secrets", "connections", "連線金鑰"],
  ["settings-data", "data", "資料保存"],
] as const) {
  test(`舊設定網址 ${hash} 會開啟包含「${heading}」的分頁`, async ({
    page,
  }) => {
    await mockDashboard(page);
    await page.goto(`/settings?source=demo#${hash}`);
    await expect(page).toHaveURL(`/settings?source=demo&tab=${value}`);
    await expect(
      page
        .getByRole("tabpanel")
        .getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  });
}

test("切換分頁與返回上一個分頁會保留草稿，離開設定仍會提醒", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.goto("/settings");
  const runs = page.getByRole("spinbutton", { name: "每日最多執行次數" });
  const ai = page.getByRole("tab", { name: "AI 與執行" });
  const notifications = page.getByRole("tab", { name: "通知", exact: true });
  await runs.fill("18");
  await notifications.click();
  await expect(runs).toBeHidden();
  await page.goBack();
  await expect(runs).toHaveValue("18");
  await page.goForward();
  await expect(notifications).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "專案", exact: true }).click();
  const reminder = page.getByRole("dialog", { name: "放棄未儲存的修改？" });
  await reminder.getByRole("button", { name: "繼續編輯" }).click();
  await expect(page).toHaveURL("/settings?tab=notifications");
  await ai.click();
  await expect(runs).toHaveValue("18");
});

test("連線待處理數量含 Discord，恢復後隱藏計數", async ({ page }) => {
  const checked_at = new Date().toISOString();
  const healthy = [
    "line",
    LINE_QUOTA,
    "github",
    "codex",
    "runner",
    "tunnel",
    "queue",
    // 沒有紀錄的服務會顯示「未檢查」並算進待處理，測試要列齊。
    "embedder",
    "rag_index",
    "outcomes",
    "retrieval",
    "triage",
  ].map((name) => ({ name, ok: true, checked_at }));
  let health = [
    ...healthy.map((entry) =>
      entry.name === "github"
        ? {
            ...entry,
            ok: false,
            detail: "範例服務讀取失敗，請檢查連線設定。",
          }
        : entry,
    ),
    {
      name: "discord",
      ok: false,
      checked_at,
      detail: discordServiceText.disconnected,
    },
  ];
  await mockDashboard(page);
  // 看板讀狀態時帶查詢參數（/api/state?activity=80），樣式要涵蓋。
  await page.route(/\/api\/state(\?|$)/, (route) =>
    route.fulfill({
      json: { ...defaultState, health },
    }),
  );
  await page.goto("/settings");
  const connections = page.getByRole("tab", { name: /^連線與金鑰/ });
  await expect(connections).toHaveAccessibleName("連線與金鑰 待處理 2 項");
  await expect(connections).toContainText("2");
  await expect(connections).toHaveAttribute("aria-selected", "false");
  health = healthy;
  await emitDashboardEvent(page, "update");
  await expect(connections).toHaveAccessibleName("連線與金鑰");
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test.describe(`設定分頁畫面（${viewport.width}px）`, () => {
    test.use({ viewport });
    for (const { label, value, heading } of tabs) {
      test(`${label}分頁完整顯示並擷取畫面`, async ({ page }, info) => {
        await mockDashboard(page);
        await page.goto(`/settings?tab=${value}`);
        await expect(
          page
            .getByRole("tabpanel")
            .getByRole("heading", { name: heading, exact: true }),
        ).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const list = page.getByRole("tablist", { name: "設定分頁" });
        const selected = list.getByRole("tab", { selected: true });
        await expect(selected).toBeInViewport({ ratio: 0.99 });
        const layout = await list.evaluate((element) => {
          const items = [...element.querySelectorAll('[role="tab"]')].map(
            (tab) => tab.getBoundingClientRect(),
          );
          return {
            pageWidth: document.documentElement.scrollWidth,
            windowWidth: document.documentElement.clientWidth,
            overlaps: items.some(
              (item, index) => index > 0 && item.left < items[index - 1].right,
            ),
            minHeight: Math.min(...items.map((item) => item.height)),
          };
        });
        expect(layout.pageWidth).toBeLessThanOrEqual(layout.windowWidth);
        expect(layout.overlaps).toBe(false);
        if (viewport.width === 375)
          expect(layout.minHeight).toBeGreaterThanOrEqual(44);
        await info.attach(`設定的${label}分頁`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      });
    }
  });
}
