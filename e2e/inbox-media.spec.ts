import { expect, test } from "@playwright/test";
import { mockInboxReview } from "./dashboard-fixture";

test.describe("手機收件匣", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("額度警示只佔一行，點按可展開或收起，首屏看得到第一筆決策", async ({ page }) => {
    const { tasks } = await mockInboxReview(page);
    await page.goto("/");
    const disclosure = page.getByRole("button", { name: /LINE 本月推播額度已用完/ });
    const explanation = page.getByText(/或在群組輸入 \/進度 取回/);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(explanation).toBeHidden();
    const firstRow = page.getByRole("list", { name: "待決策佇列" }).getByRole("listitem").first();
    await expect(firstRow).toContainText(tasks[0].title);
    await expect(firstRow).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    const warning = (await disclosure.boundingBox())!;
    const hide = (await page.getByRole("button", { name: "收合頁首警示" }).boundingBox())!;
    expect(warning.height).toBeGreaterThanOrEqual(44);
    expect(Math.max(warning.y + warning.height, hide.y + hide.height) - Math.min(warning.y, hide.y)).toBeLessThanOrEqual(46);
    await disclosure.tap();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(explanation).toBeVisible();
    await disclosure.tap();
    await expect(explanation).toBeHidden();
  });
});

test("來源縮圖有可辨識的報表圖案，點按後在新分頁顯示完整原圖", async ({ page }) => {
  const { tasks } = await mockInboxReview(page);
  await page.goto(`/?review=${tasks[3].id}`);
  const source = page.getByRole("region", { name: "來源原文" });
  const imageLink = source.getByRole("link", { name: /在新分頁檢視原圖/ });
  const thumbnail = imageLink.getByRole("img", { name: "來源圖片" });
  await expect(thumbnail).toBeVisible();
  const image = await thumbnail.evaluate(async (node: HTMLImageElement) => {
    await node.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 12;
    const context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    context.drawImage(node, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] === 255) colors.add(pixels.slice(index, index + 3).join());
    }
    return { url: node.currentSrc, width: node.naturalWidth, height: node.naturalHeight, colors: colors.size };
  });
  expect(image.colors).toBeGreaterThanOrEqual(3);
  const preview = (await thumbnail.boundingBox())!;
  expect(preview.width).toBeLessThan(image.width);
  expect(preview.height).toBeLessThan(image.height);
  const popupReady = page.waitForEvent("popup");
  await imageLink.click();
  const popup = await popupReady;
  await expect(popup).toHaveURL(image.url);
  const original = popup.locator("img");
  await expect(original).toBeVisible();
  expect(await popup.evaluate(() => document.contentType)).toBe("image/png");
  expect(await original.evaluate(async (node: HTMLImageElement) => {
    await node.decode();
    return [node.naturalWidth, node.naturalHeight];
  })).toEqual([image.width, image.height]);
  expect((await original.boundingBox())!.width).toBeGreaterThan(preview.width);
});
