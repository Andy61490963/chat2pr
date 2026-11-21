import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { PickList } from "../shared/pick-list";
import type { Task } from "../shared/types";
import { defaultState, group, mockDashboard, task } from "./dashboard-fixture";

const pending: Task[] = [
  task,
  {
    ...task,
    id: "22222222-2222-4222-8222-222222222222",
    title: "整理範例清單",
    status: "failed",
  },
  {
    ...task,
    id: "33333333-3333-4333-8333-333333333333",
    title: "更新範例圖示",
  },
];
const queued: Task = {
  ...task,
  id: "44444444-4444-4444-8444-444444444444",
  title: "匯出範例報表",
  status: "queued",
};
const pickList: PickList = {
  id: "example-meeting",
  groupId: group.id,
  version: 1,
  items: [
    {
      id: "example-item",
      title: "補上範例說明",
      summary: "補上範例畫面的使用說明。",
    },
  ],
};

for (const width of [1280, 375]) {
  test(`用鍵盤選取並批次結束任務（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockDashboard(page);
    let ended = false;
    await page.route("**/api/state*", (route) =>
      route.fulfill({
        json: {
          ...defaultState,
          tasks: ended ? [queued] : [...pending, queued],
          pickLists: [pickList],
        },
      }),
    );
    await page.route("**/api/tasks/batch-end", (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({
        tasks: pending.map(({ id, status, version }) => ({
          id,
          status,
          version,
        })),
        reason: "範例工作已另外處理",
        notify: false,
      });
      ended = true;
      return route.fulfill({ json: { ended: 2, skipped: 1 } });
    });

    await page.goto("/");
    const inbox = page.getByRole("region", { name: /需要你處理/ });
    const list = inbox.getByRole("article", { name: "待挑選清單" });
    const listItem = list.getByRole("checkbox", {
      name: pickList.items[0].title,
    });
    const first = inbox.getByRole("checkbox", {
      name: `選取「${task.title}」`,
    });
    await expect(inbox.getByRole("checkbox")).toHaveCount(4);
    await expect(listItem).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: `選取「${queued.title}」` }),
    ).toHaveCount(0);
    const hitArea = await first.locator("..").boundingBox();
    expect(hitArea?.width).toBeGreaterThanOrEqual(44);
    expect(hitArea?.height).toBeGreaterThanOrEqual(44);
    await first.press("Space");
    await expect(first).toBeChecked();
    await expect(
      inbox.getByRole("button", { name: "結束選取的 1 張任務" }),
    ).toBeVisible();

    const selectAll = inbox.getByRole("button", { name: "全選本頁" });
    await selectAll.press("Enter");
    await expect(inbox.getByRole("checkbox", { checked: true })).toHaveCount(3);
    await expect(listItem).not.toBeChecked();
    const clear = inbox.getByRole("button", { name: "清除選取" });
    await clear.press("Enter");
    await expect(inbox.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(clear).toBeFocused();
    await selectAll.press("Enter");
    const trigger = inbox.getByRole("button", { name: "結束選取的 3 張任務" });
    await trigger.press("Enter");

    const dialog = page.getByRole("dialog", { name: "結束 3 張任務？" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    await dialog.getByRole("button", { name: "保留任務" }).press("Enter");
    await expect(trigger).toBeFocused();
    await expect(inbox.getByRole("checkbox", { checked: true })).toHaveCount(3);
    await trigger.press("Enter");
    await dialog
      .getByRole("textbox", { name: /結束原因/ })
      .fill("範例工作已另外處理");
    await dialog
      .getByRole("checkbox", { name: "依群組回覆設定通知" })
      .press("Space");
    await expect(dialog.getByText(/你這次不會通知群組/)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target }) => target),
      })),
    ).toEqual([]);

    await dialog
      .getByRole("button", { name: "結束任務", exact: true })
      .press("Enter");
    await expect(page.getByRole("status")).toHaveText(
      "已結束 2 張任務，略過 1 張狀態或需求已變更的任務。",
    );
    await expect(inbox.getByRole("checkbox")).toHaveCount(1);
    await expect(listItem).toBeVisible();
    await expect(inbox).toBeFocused();
  });
}

test("成員仍可結束單張任務", async ({ page }) => {
  await mockDashboard(page, {
    routes: {
      "/api/me": {
        id: "2",
        login: "demo-member",
        csrf: "test-only",
        role: "member",
        owner: false,
      },
    },
  });
  await page.goto("/");
  const inbox = page.getByRole("region", { name: /需要你處理/ });
  await expect(
    inbox.getByRole("button", { name: "結束任務", exact: true }),
  ).toBeVisible();
  await expect(inbox.getByRole("checkbox")).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "全選本頁" })).toHaveCount(0);
});
