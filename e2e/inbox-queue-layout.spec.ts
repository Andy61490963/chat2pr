import { expect, test } from "@playwright/test";
import { discordGroup, group, mockInboxReview, project } from "./dashboard-fixture";

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  test.describe(`${viewport.width} 像素佇列`, () => {
    test.use({ viewport, reducedMotion: "reduce" });

    test("各種決策保持等高，標題不被時間與按鈕擠窄", async ({ page }, info) => {
      const { tasks } = await mockInboxReview(page);
      await page.goto("/");
      const rows = page.getByRole("list", { name: "待決策佇列" }).getByRole("listitem");
      await expect(rows).toHaveCount(tasks.length);
      await page.evaluate(async () => { await document.fonts.ready; });
      const boxes = await Promise.all(tasks.map(async (task) => {
        const row = rows.filter({ has: page.getByText(task.title, { exact: true }) });
        const title = row.getByText(task.title, { exact: true });
        const [bounds, heading, wait] = await Promise.all([
          row.boundingBox(), title.boundingBox(), row.locator("[data-review-waiting]").boundingBox(),
        ]);
        if (!bounds || !heading || !wait) throw new Error(`無法量測「${task.title}」`);
        return { bounds, heading, wait };
      }));
      const heights = boxes.map(({ bounds }) => bounds.height);
      const widths = boxes.map(({ heading }) => heading.width);
      const ratios = boxes.map(({ heading, bounds }) => heading.width / bounds.width);
      const result = `視窗 ${viewport.width}，${boxes.length} 列，列高 ${Math.min(...heights)} 至 ${Math.max(...heights)} 像素，標題最窄 ${Math.min(...widths)} 像素，最小占比 ${(100 * Math.min(...ratios)).toFixed(1)}%`;
      console.log(result);
      await info.attach("佇列尺寸實測", { body: result, contentType: "text/plain" });
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
      for (const { heading, wait } of boxes) {
        if (viewport.width === 375) {
          expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0.6);
          expect(heading.y + heading.height).toBeLessThanOrEqual(wait.y);
        } else {
          expect(heading.x + heading.width).toBeLessThanOrEqual(wait.x);
          expect(Math.abs(heading.y + heading.height / 2 - wait.y - wait.height / 2)).toBeLessThanOrEqual(2);
        }
      }
    });
  });
}

test("群組、平台及已知專案分支同列，截短時仍提供完整說明", async ({ page }) => {
  const { tasks } = await mockInboxReview(page);
  await page.goto("/");
  const rows = page.getByRole("list", { name: "待決策佇列" }).getByRole("listitem");
  for (const [index, metadata] of [
    [0, `${group.name} LINE ${project.name}／${tasks[0].target_branch}`],
    [1, `${discordGroup.name} Discord ${project.name}／${tasks[1].target_branch}`],
    [2, `${group.name} LINE`],
  ] as const) {
    const row = rows.filter({ hasText: tasks[index].title });
    const source = row.getByText(metadata, { exact: true });
    await expect(source).toHaveAttribute("title", metadata);
    await expect(source).toHaveCSS("text-overflow", "ellipsis");
    await expect(source).toHaveCSS("white-space", "nowrap");
  }
});
