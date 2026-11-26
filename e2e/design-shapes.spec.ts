import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { detail, mockDashboard, task } from "./dashboard-fixture";

async function expectRound(mark: Locator) {
  await expect(mark).toBeVisible();
  const round = await mark.evaluate((el) => {
    const { width, height } = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomLeftRadius, css.borderBottomRightRadius]
      .every((r) => r.endsWith("%") ? parseFloat(r) >= 50 : parseFloat(r) >= Math.min(width, height) / 2);
  });
  expect(round).toBe(true);
}

for (const width of [375, 1440]) {
  for (const screen of ["收件匣", "審核面板", "設定", "系統"]) {
    test(`${screen}保留狀態與控制項形狀（${width}px 淺色）`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      const change = {
        ...task, mode: "change" as const,
        suggestions: [
          { label: "依月份排列", summary: "按月份顯示清單", acceptance: ["能選月份"] },
          { label: "依主題排列", summary: "按主題顯示清單", acceptance: ["能選主題"] },
        ],
      };
      await mockDashboard(page, {
        state: { tasks: [change] },
        routes: { [`/api/tasks/${change.id}`]: { ...detail, task: change } },
      });
      if (screen === "收件匣") {
        await page.goto("/");
        await expectRound(page.locator("main header button").locator("span.size-1\\.5"));
        await expectRound(page.getByTitle("通知", { exact: true }).locator("span[aria-hidden]"));
        await expectRound(page.getByRole("navigation").getByRole("button", { name: /收件匣/ }).locator("span:has(> .sr-only)"));
        if (width === 375) await page.getByRole("button", { name: "更多", exact: true }).click();
        const account = page.getByText("demo-admin", { exact: true }).filter({ visible: true }).first();
        await expectRound(account.locator("..").locator('span[aria-hidden="true"]').first());
      } else if (screen === "審核面板") {
        await page.goto(`/tasks?task=${change.id}`);
        const group = page.getByRole("radiogroup", { name: /可選方案/ });
        const radios = group.getByRole("radio");
        await radios.first().press("Space");
        await expect(radios.first()).toBeChecked();
        for (const radio of await radios.all()) await expectRound(radio.locator("+ span"));
        await group.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await expect(group).toBeInViewport();
      } else {
        const settings = screen === "設定";
        await page.goto(settings ? "/settings?tab=connections" : "/system?tab=disk");
        if (settings) await page.getByText("全部服務", { exact: true }).click();
        const rows = page.getByRole("tabpanel").getByRole("listitem");
        const service = settings ? rows.filter({ has: page.getByText("LINE", { exact: true }) }) : rows.filter({ hasText: "負責建立與回收工作容器的主機程序" });
        const mark = service.locator(":scope > span").first();
        await expectRound(mark);
        await service.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await expect(mark).toBeInViewport();
      }
      const dir = process.env.DESIGN_SHOTS_DIR;
      if (dir) {
        await mkdir(dir, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ animations: "disabled", path: join(dir, `${screen}-${width}-light.png`) });
      }
    });
  }
}
