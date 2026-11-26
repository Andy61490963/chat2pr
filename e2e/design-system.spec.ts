import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

async function expectTouchTarget(control: Locator) {
  const size = await control.evaluate((el) => ({
    width: (el as HTMLElement).offsetWidth,
    height: (el as HTMLElement).offsetHeight,
  }));
  expect(size.width).toBeGreaterThanOrEqual(44);
  expect(size.height).toBeGreaterThanOrEqual(44);
}

for (const width of [375, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`元件展示支援鍵盤、焦點與狀態（${width}px，${theme === "light" ? "淺色" : "深色"}）`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("/e2e/design-system.html");
      await expect(
        page.getByRole("heading", { level: 1, name: "範例工單" }),
      ).toBeVisible();
      const capture = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() =>
          Promise.all(
            document.getAnimations().map((animation) => animation.finished),
          ),
        );
        const filename = `${name}-${width}-${theme}.png`;
        const dir = process.env.DESIGN_SHOTS_DIR;
        if (dir) await mkdir(dir, { recursive: true });
        const body = await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: dir && join(dir, filename),
        });
        await info.attach(filename, { body, contentType: "image/png" });
      };
      expect(await page.locator("html").evaluate((el) => el.scrollWidth)).toBe(
        width,
      );
      const title = page.getByRole("heading", { level: 1 });
      expect(
        await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeLessThanOrEqual(20);
      if (width === 375) {
        for (const name of ["查看工單", "操作說明", "停止工單"]) {
          await expectTouchTarget(page.getByRole("button", { name }));
        }
      }
      await page.getByRole("textbox", { name: "工單名稱" }).fill("範例檢查");
      await page.getByRole("textbox", { name: "備註" }).fill("範例設備已就緒");
      await page.getByRole("checkbox", { name: "需要複核" }).press("Space");
      await expect(
        page.getByRole("checkbox", { name: "需要複核" }),
      ).toBeChecked();
      const toggle = page.getByRole("switch", { name: "啟用工序" });
      await toggle.press("Space");
      await expect(toggle).toBeChecked();
      if (width === 375) await expectTouchTarget(toggle);
      await page.getByRole("combobox", { name: "站別" }).press("Enter");
      const option = page.getByRole("option", { name: "複核站" });
      if (width === 375) await expectTouchTarget(option);
      await option.press("Enter");
      await expect(page.getByRole("combobox")).toHaveText("複核站");
      await page.getByRole("tab", { name: "工序" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tabpanel", { name: "紀錄" })).toBeVisible();
      await capture("空狀態");
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByRole("listitem")).toContainText("範例批次");
      await capture("共用元件");
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.getByRole("button", { name: "操作說明" }).focus();
      await expect(page.getByRole("tooltip")).toContainText(
        "查看工序的填寫方式",
      );
      await capture("工具提示");
      await page.keyboard.press("Escape");
      for (const [name, role] of [
        ["查看工單", "dialog"],
        ["停止工單", "alertdialog"],
      ] as const) {
        const trigger = page.getByRole("button", { name });
        await trigger.press("Enter");
        const dialog = page.getByRole(role, { name });
        await expect(dialog).toBeVisible();
        await capture(name);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
      }
    });
  }
}
