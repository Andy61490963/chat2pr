import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  diskReport,
  mockDashboard,
  statusProjects,
  systemSnapshot,
} from "./dashboard-fixture";

const tabs = [
  { name: "執行", query: "execution", content: "每件任務要切到看板" },
  { name: "容器與磁碟", query: "disk", content: /^最後盤點 / },
  { name: "網路", query: "network", content: /^使用預設清單，共/ },
  { name: "架構", query: "architecture", content: "工作容器各階段的權限" },
] as const;

test("按方向鍵切換四個系統分頁，重新整理與瀏覽器上一頁會還原分頁", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.goto("/system?tab=unknown&source=demo");
  const tabList = page.getByRole("tablist", { name: "系統分頁" });
  const execution = tabList.getByRole("tab", { name: "執行", exact: true });
  await expect(execution).toHaveAttribute("aria-selected", "true");
  await execution.focus();

  for (const { name, query, content } of [...tabs.slice(1), tabs[0]]) {
    await page.keyboard.press("ArrowRight");
    const selected = tabList.getByRole("tab", { name, exact: true });
    const panel = page.getByRole("tabpanel", { name, exact: true });
    await expect(selected).toBeFocused();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(panel).toHaveAttribute(
      "id",
      (await selected.getAttribute("aria-controls"))!,
    );
    await expect(page.getByRole("tabpanel")).toHaveCount(1);
    await expect(panel.getByText(content)).toBeVisible();
    await expect(page).toHaveURL(`/system?tab=${query}&source=demo`);
  }

  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL("/system?tab=architecture&source=demo");
  await page.reload();
  await expect(page.getByRole("tabpanel", { name: "架構" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("tabpanel", { name: "執行" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("tabpanel", { name: "架構" })).toBeVisible();
});

const lowDisk = {
  ...diskReport,
  level: "low",
  freePercent: 10,
  spaces: diskReport.spaces.map((space) => ({
    ...space,
    freeBytes: 10 * 1024 ** 3,
  })),
};
const unhealthySystem = {
  ...systemSnapshot,
  services: systemSnapshot.services.map((service) => ({
    ...service,
    status: "Up (unhealthy)",
  })),
};

test("待處理數量在其他分頁可見，磁碟恢復後更新數量", async ({ page }) => {
  await mockDashboard(page, {
    state: { projects: statusProjects },
    routes: { "/api/system": unhealthySystem, "/api/system/disk": lowDisk },
  });
  await page.route(
    (url) =>
      url.pathname === "/api/system/disk" &&
      url.searchParams.get("fresh") === "1",
    (route) => route.fulfill({ json: diskReport }),
  );
  await page.goto("/system");
  const tabList = page.getByRole("tablist", { name: "系統分頁" });
  const diskTab = tabList.getByRole("tab", { name: /^容器與磁碟/ });
  await expect(tabList.getByRole("tab", { name: /待處理/ })).toHaveCount(1);
  await expect(diskTab).toHaveAccessibleName(/容器與磁碟 待處理 3 項/);
  await expect(diskTab).toHaveAttribute("aria-selected", "false");
  await diskTab.click();
  await expect(page.getByText("健康檢查未通過", { exact: true })).toBeVisible();
  await expect(page.getByText("空間不足", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新盤點" }).click();
  await expect(page.getByText("空間足夠", { exact: true })).toBeVisible();
  await expect(diskTab).toHaveAccessibleName(/容器與磁碟 待處理 2 項/);
});

test("磁碟通知與派工提醒都會開啟容器與磁碟分頁", async ({ page }) => {
  const notice = {
    id: "demo-disk-notice",
    task_id: null,
    kind: "disk_low",
    disposition: "action",
    title: null,
    text: "範例磁碟可用空間低於提醒門檻，請查看磁碟用量。",
    created_at: diskReport.checkedAt,
  };
  await mockDashboard(page, {
    state: { alerts: [notice], diskDispatchPaused: true },
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: /^通知(?:，|$)/ }).press("Enter");
  await page.getByRole("menuitem", { name: /磁碟空間不足/ }).press("Enter");
  await expect(page).toHaveURL("/system?tab=disk");
  await expect(
    page.getByRole("tabpanel", { name: /^容器與磁碟/ }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "網路", exact: true }).click();
  await page.getByRole("button", { name: "查看系統頁" }).click();
  await expect(page).toHaveURL("/system?tab=disk");
  await expect(
    page.getByRole("tabpanel", { name: /^容器與磁碟/ }),
  ).toBeVisible();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test.describe(`系統頁畫面（${viewport.width}px）`, () => {
    test.use({ viewport });

    for (const { name, query, content } of tabs) {
      test(`${name}分頁可完整顯示並擷取畫面`, async ({ page }, info) => {
        await mockDashboard(page, {
          state: { projects: statusProjects },
          routes: {
            "/api/system": unhealthySystem,
            "/api/system/disk": lowDisk,
          },
        });
        await page.goto(`/system?tab=${query}`);
        const panel = page.getByRole("tabpanel", {
          name: new RegExp(`^${name}`),
        });
        await expect(panel.getByText(content)).toBeVisible();
        await expect(
          page.getByRole("tab", { name: /^容器與磁碟 待處理 3 項$/ }),
        ).toBeVisible();
        if (query === "network")
          await expect(
            panel.getByRole("spinbutton", { name: "最多保留幾個" }),
          ).toBeVisible();
        if (query === "architecture")
          await expect(
            page
              .frameLocator('iframe[title^="系統架構動畫"]')
              .getByRole("button", { name: "開始播放" }),
          ).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(viewport.width);
        if (viewport.width === 375) {
          const tab = page.getByRole("tab", { selected: true });
          await expect(tab).toBeInViewport();
          expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        }
        await info.attach(`${name}（${viewport.width}px）`, {
          body: await page.screenshot({
            fullPage: true,
            animations: "disabled",
          }),
          contentType: "image/png",
        });
        const { violations } = await new AxeBuilder({ page })
          .include('[data-slot="tabs"]')
          .exclude('iframe[title^="系統架構動畫"]')
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        expect(violations).toEqual([]);
      });
    }
  });
}
