import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  detail,
  mockDashboard,
  rejectedTask,
  task,
} from "./dashboard-fixture";

const axe = async (page: Page, selector: string) => {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const { violations } = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target }) => target),
    })),
  ).toEqual([]);
};

for (const width of [1440, 375]) {
  test(`在審核面板拒絕時選原因並加補充（${width}px）`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockDashboard(page);
    let posted: unknown = null;
    await page.route(`**/api/tasks/${task.id}/actions`, (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ json: { ...task, status: "rejected" } });
    });
    await page.goto(`/?review=${task.id}`);
    // 手機的審核內容開在抽屜裡，桌面在右欄的審核面板。
    const panel =
      width === 375
        ? page.getByRole("dialog", { name: task.title })
        : page.getByRole("region", { name: "審核面板" });
    await panel.getByRole("button", { name: "結束任務", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "結束任務？" });
    const reasons = dialog.getByRole("group", { name: "拒絕原因" });
    await expect(reasons.getByRole("radio")).toHaveCount(6);
    await expect(reasons.locator("label")).toHaveText([
      "不是給 AI 的工作（同事會自己處理）",
      "需求還沒定案",
      "需求不清楚",
      "選不出專案",
      "重複",
      "其他",
    ]);
    await reasons.getByRole("radio", { name: "需求還沒定案" }).check();
    await dialog
      .getByRole("textbox", { name: "補充（選填）" })
      .fill("範例群組還在討論版面");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width === 375)
      for (const target of [
        ...(await reasons.locator("label").all()),
        dialog.getByRole("button", { name: "結束任務", exact: true }),
        dialog.getByRole("button", { name: "先不要" }),
      ])
        expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(
          44,
        );
    await testInfo.attach(`拒絕原因對話框-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await axe(page, '[role="dialog"]');

    await dialog.getByRole("button", { name: "結束任務", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(posted).toEqual({
      action: "reject",
      version: task.version,
      end_reason: "not_settled",
      reason: "範例群組還在討論版面",
    });
  });

  test(`已拒絕任務的摘要與時間軸顯示拒絕原因（${width}px）`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const why = "需求還沒定案；範例群組還在討論版面";
    const rejected = {
      ...rejectedTask,
      end_reason: "not_settled" as const,
      end_summary: { ...rejectedTask.end_summary!, reason: why },
    };
    await mockDashboard(page, {
      state: { tasks: [rejected] },
      routes: {
        [`/api/tasks/${rejected.id}`]: {
          ...detail,
          task: rejected,
          history: [
            {
              id: 1,
              task_id: rejected.id,
              kind: "reject",
              detail: `小林 拒絕（需求版本 1；目標分支 main），原因：${why}`,
              created_at: rejected.updated_at,
            },
          ],
        },
      },
    });
    await page.goto("/tasks");
    await page.getByRole("tab", { name: /^進行中與待處理/ }).focus();
    await page.keyboard.press("ArrowRight");
    await page
      .getByRole("tabpanel", { name: /^已結束/ })
      .getByRole("button", { name: new RegExp(rejected.title) })
      .click();
    const drawer = page.getByRole("dialog", { name: rejected.title });
    await expect(
      drawer.getByText(new RegExp(`小林於 .+ 拒絕，原因是${why}`)),
    ).toBeVisible();
    await drawer.getByRole("tab", { name: "時間軸" }).click();
    await expect(
      drawer.getByText(`小林 拒絕（需求版本 1；目標分支 main），原因：${why}`),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await testInfo.attach(`拒絕原因時間軸-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await axe(page, '[data-slot="sheet-content"]');
  });
}
