import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Task } from "../shared/types";
import {
  defaultState,
  detail,
  group,
  indexLimitedDetail,
  mockDashboard,
  project,
  task,
} from "./dashboard-fixture";

test("手機上可核對索引超限時預選的專案，再由管理者核准修改", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { task: pending } = indexLimitedDetail;
  const taskPath = `/api/tasks/${pending.id}`;
  await mockDashboard(page, {
    state: { tasks: [pending] },
    routes: { [taskPath]: indexLimitedDetail },
  });
  let approvalRequests = 0;
  await page.route(`**${taskPath}/actions`, async (route) => {
    approvalRequests++;
    expect(route.request().postDataJSON()).toEqual({
      action: "approve",
      version: pending.version,
      project_id: project.id,
      binding_version: indexLimitedDetail.projectReview?.binding_version,
      config_version: project.config_version,
      target_branch: pending.target_branch,
    });
    await route.fulfill({ json: { ...pending, status: "queued" } });
  });
  await page.goto("/");
  await page
    .getByRole("list", { name: "待決策佇列" })
    .getByRole("button", { name: new RegExp(pending.title) })
    .press("Enter");
  const drawer = page.getByRole("dialog", { name: pending.title });
  const review = drawer.getByRole("region", { name: "處理專案" });
  await expect(review.getByText(project.name, { exact: true })).toBeVisible();
  await expect(
    review.getByText(/程式索引超過上限.*已預選該專案/),
  ).toBeVisible();
  await expect(drawer.getByText("AI 無法判斷要修改哪個專案")).toHaveCount(0);
  const approve = drawer.getByRole("button", {
    name: "確認專案與分支並核准修改",
  });
  await expect(approve).toBeEnabled();
  expect((await approve.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  const { violations } = await new AxeBuilder({ page })
    .include("[role='dialog']")
    .analyze();
  expect(violations).toEqual([]);
  expect(approvalRequests).toBe(0);
  await approve.press("Enter");
  await expect(page.getByText("已確認專案並核准，開始排程")).toBeVisible();
  expect(approvalRequests).toBe(1);
});

const warehouse = {
  ...project,
  id: "22222222-2222-4222-8222-222222222222",
  name: "範例倉庫",
  repo: "example/warehouse",
};
const source = {
  id: "m1",
  type: "text",
  text: "請查範例倉庫的庫存。",
  sender: "範例成員",
  received_at: task.created_at,
  availability: "readable" as const,
  revoked: false,
  has_image: false,
};
const pending: Task = {
  ...task,
  title: "查詢範例庫存",
  project_id: null,
  target_branch: null,
  source_ids: [source.id],
  project_routing: {
    status: "uncertain",
    basis: "none",
    evidence: [],
    reason: "尚未確定目標專案",
    bindingVersion: 1,
    unboundSuggestions: [
      {
        projectId: warehouse.id,
        configVersion: warehouse.config_version,
        reason: "你的訊息提到了這個專案的名稱或儲存庫。",
        sourceIds: [source.id],
      },
    ],
  },
};

for (const width of [1280, 375]) {
  test(`查看建議並一鍵綁定及指定（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockDashboard(page);
    let bound = false;
    const assigned = {
      ...task,
      title: pending.title,
      project_id: warehouse.id,
      version: 2,
    };
    const taskPath = `/api/tasks/${task.id}`;
    await page.route("**/api/state*", (route) =>
      route.fulfill({
        json: {
          ...defaultState,
          projects: [project, warehouse],
          groups: [
            bound
              ? {
                  ...group,
                  binding_version: 2,
                  project_ids: [project.id, warehouse.id],
                }
              : group,
          ],
          tasks: [bound ? assigned : pending],
        },
      }),
    );
    await page.route(`**${taskPath}`, (route) =>
      route.fulfill({
        json: bound
          ? {
              ...detail,
              task: assigned,
              projectReview: {
                binding_version: 2,
                config_version: 1,
                project_name: warehouse.name,
                repo: warehouse.repo,
                base_branch: warehouse.base_branch,
                group_name: group.name,
                confirmed: false,
              },
            }
          : { ...detail, task: pending, sources: [source] },
      }),
    );
    await page.route(`**${taskPath}/actions`, (route) => {
      expect(route.request().postDataJSON()).toEqual({
        action: "bind_assign",
        version: 1,
        project_id: warehouse.id,
      });
      bound = true;
      return route.fulfill({ json: assigned });
    });
    await page.goto("/");
    await page.getByRole("list", { name: "待決策佇列" })
      .getByRole("button", { name: new RegExp(pending.title) }).click();
    const drawer = page.getByRole("dialog", { name: pending.title });
    await expect(
      drawer.getByText("看起來是 範例倉庫（尚未綁定這個群組）"),
    ).toBeVisible();
    await drawer
      .locator("summary")
      .filter({ hasText: "查看引用訊息" })
      .press("Enter");
    await expect(drawer.locator("blockquote")).toHaveText(source.text);
    const bind = drawer.getByRole("button", { name: /綁定並指定這個專案/ });
    const box = await bind.evaluate((button: HTMLButtonElement) => ({
      width: button.offsetWidth, height: button.offsetHeight,
    }));
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map((node) => node.target),
      })),
    ).toEqual([]);
    await bind.press("Enter");
    await expect(
      page.getByText("已綁定並指定專案", { exact: true }),
    ).toBeVisible();
    await expect(
      drawer
        .getByRole("region", { name: "處理專案" })
        .getByText(warehouse.name, { exact: true }),
    ).toBeFocused();
    await expect(
      drawer.getByRole("button", { name: "更換專案" }),
    ).toBeVisible();
    await expect(bind).toHaveCount(0);
  });
}
