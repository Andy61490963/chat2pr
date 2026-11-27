import { expect, test } from "@playwright/test";
import { mockDashboard } from "./dashboard-fixture";

test("獨立架構圖播放時沿實際路徑繪線，章節進度與鏡頭隨播放更新", async ({
  page,
}) => {
  await page.goto("/docs/architecture-flow.html?theme=light");
  const scene = page.getByRole("img", { name: /架構/ });
  await expect(scene).toHaveAttribute("viewBox", "0 0 1600 900");
  await expect(scene.locator("#n-tunnel .t-title")).toHaveCSS(
    "font-size",
    "15.5px",
  );
  await expect(scene.locator("#n-db .t-title")).toHaveCSS(
    "font-size",
    "16.5px",
  );
  await page.getByRole("button", { name: "開始播放" }).press("Enter");
  await expect
    .poll(
      () =>
        scene.locator(".trail").evaluateAll((paths) =>
          paths.some((el) => {
            const css = getComputedStyle(el);
            const length = (el as SVGPathElement).getTotalLength();
            const offset = Math.abs(parseFloat(css.strokeDashoffset));
            return (
              Number(css.opacity) > 0 &&
              css.stroke !== "none" &&
              Math.abs(parseFloat(css.strokeDasharray) - length) < 1 &&
              offset > 0 &&
              offset < length
            );
          }),
        ),
      { intervals: [50] },
    )
    .toBe(true);
  const current = page.locator("#track button").first();
  await expect
    .poll(() =>
      current.evaluate((el) => {
        const width = el.firstElementChild!.getBoundingClientRect().width;
        return width > 0 && width < el.getBoundingClientRect().width;
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "暫停" }).press("Enter");
  await page.getByRole("button", { name: "下一步" }).press("Enter");
  await expect(scene).not.toHaveAttribute("viewBox", "0 0 1600 900");
  await expect(page.locator("#chaps [aria-current=step]")).toContainText(
    "驗證來源",
  );
});

test("看板內嵌架構圖可切換章節，縮放後保留主題色與已完成的步驟", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDashboard(page);
  await page.goto("/system?tab=architecture");
  const frame = page.frameLocator('iframe[title^="系統架構動畫"]');
  const scene = frame.locator("#svg");
  const title = scene.locator("#n-tunnel .t-title");
  await expect(title).toBeVisible();
  const light = await title.evaluate((el) => getComputedStyle(el).fill);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(title).not.toHaveCSS("fill", light);
  await frame.getByRole("button", { name: "下一步" }).press("Enter");
  await expect(scene).not.toHaveAttribute("viewBox", "0 0 1600 900");
  const ticks = frame.locator("#track button");
  expect(
    await ticks
      .first()
      .evaluate(
        (el) =>
          el.getBoundingClientRect().width -
          el.firstElementChild!.getBoundingClientRect().width,
      ),
  ).toBeCloseTo(0, 0);
  await expect(ticks.nth(2).locator("i")).toHaveCSS("width", "0px");
});
