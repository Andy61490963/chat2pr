import { expect, test, type Page } from "@playwright/test";
import type { Detail } from "../src/app/shared";
import {
  cancelledTask, exampleMember, group, inboxDetailUnavailable, mockInboxReview,
  project, reviewWorkbenchFixture,
} from "./dashboard-fixture";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

const queue = (page: Page) => page.getByRole("list", { name: "待決策佇列" });
const row = (page: Page, title: string) =>
  queue(page).getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });
const panel = (page: Page) => page.getByRole("region", { name: "審核面板" });
const quickName = { name: "核准修改", exact: true };
const openName = { name: "開啟審核", exact: true };
const hint = (page: Page) => page.getByText(/J\s*[／/]\s*K.*Enter.*Alt/);

test("列上核准先重讀未選取的任務，只送一次確認過的目標與版本並前進", async ({ page }) => {
  const { state, tasks } = await mockInboxReview(page);
  const current = tasks[3];
  const next = tasks[4];
  const order: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/tasks/${current.id}`, async (route) => {
    order.push("重讀");
    await pending;
    await route.fallback();
  });
  await page.route(`**/api/tasks/${current.id}/actions`, (route) => {
    order.push("核准");
    expect(route.request().postDataJSON()).toEqual({
      action: "approve", version: current.version, project_id: project.id,
      target_branch: current.target_branch, config_version: project.config_version,
      binding_version: group.binding_version,
    });
    state.tasks = state.tasks.filter(({ id }) => id !== current.id);
    return route.fulfill({ json: { ...current, status: "queued" } });
  });
  await page.goto("/");
  const target = row(page, current.title);
  const approve = target.getByRole("button", quickName);
  try {
    await expect(target).toContainText(project.name);
    await expect(target).toContainText(current.target_branch!);
    await approve.click();
    await expect.poll(() => order).toEqual(["重讀"]);
    await expect(approve).toBeDisabled();
  } finally {
    release();
  }
  await expect(panel(page).getByRole("heading", { name: next.title })).toBeVisible();
  await expect(target).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /已.*核准/ })).toBeVisible();
  expect(order).toEqual(["重讀", "核准"]);
});

const changes: Record<string, (detail: Detail) => Detail> = {
  新增風險: (detail) => ({ ...detail, task: { ...detail.task, risk_reasons: cancelledTask.risk_reasons } }),
  需求版本變更: (detail) => ({ ...detail, task: { ...detail.task, version: detail.task.version + 1 } }),
  專案不符: (detail) => ({ ...detail, task: { ...detail.task, project_id: null } }),
  分支不符: (detail) => ({ ...detail, task: { ...detail.task, target_branch: null } }),
  專案設定變更: (detail) => ({ ...detail, projectReview: { ...detail.projectReview!, config_version: project.config_version + 1 } }),
  群組綁定變更: (detail) => ({ ...detail, projectReview: { ...detail.projectReview!, binding_version: group.binding_version! + 1 } }),
};

for (const [scenario, change] of Object.entries(changes)) {
  test(`快速核准重讀發現${scenario}時只開啟面板，不送出決定`, async ({ page }) => {
    const { tasks } = await mockInboxReview(page);
    const current = tasks[3];
    const fresh = change({ ...reviewWorkbenchFixture().details.get(current.id)!, task: current });
    await page.route(`**/api/tasks/${current.id}`, (route) => route.fulfill({ json: fresh }));
    const writes = watchActions(page);
    await page.goto("/");
    await expect(panel(page).getByRole("heading", { name: tasks[0].title })).toBeVisible();
    await row(page, current.title).getByRole("button", quickName).click();
    await expect(panel(page).getByRole("heading", { name: current.title })).toBeVisible();
    await expect(panel(page).getByRole("alert")).toContainText(/重新確認/);
    expect(writes).toEqual([]);
  });
}

function watchActions(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/tasks/"))
      writes.push(new URL(request.url()).pathname);
  });
  return writes;
}

test("重讀失敗會保留伺服器原因，不送出核准", async ({ page }) => {
  const { tasks } = await mockInboxReview(page);
  const current = tasks[3];
  await page.route(`**/api/tasks/${current.id}`, (route) =>
    route.fulfill({ status: 503, json: { error: inboxDetailUnavailable } }));
  const writes = watchActions(page);
  await page.goto("/");
  await row(page, current.title).getByRole("button", quickName).click();
  await expect(page.getByRole("alert").filter({ hasText: inboxDetailUnavailable }).first()).toBeVisible();
  expect(writes).toEqual([]);
});

for (const scenario of ["成員", "有風險", "查詢", "回答補問", "選專案", "重試"] as const) {
  test(`${scenario}在列上只能開啟審核，不會直接送出`, async ({ page }) => {
    const { tasks, state } = await mockInboxReview(page);
    const current = tasks[({ 成員: 3, 有風險: 3, 查詢: 3, 回答補問: 1, 選專案: 2, 重試: 6 })[scenario]];
    if (scenario === "成員") {
      await page.route("**/api/me", (route) => route.fulfill({ json: {
        id: exampleMember.github_id, login: exampleMember.login, csrf: "DemoMember1",
        role: exampleMember.role, owner: false,
      } }));
    }
    if (scenario === "有風險" || scenario === "查詢") {
      const changed = scenario === "查詢"
        ? { ...current, mode: "query" as const }
        : { ...current, risk_reasons: cancelledTask.risk_reasons };
      state.tasks = state.tasks.map((entry) => entry.id === current.id ? changed : entry);
      const detail = { ...reviewWorkbenchFixture().details.get(current.id)!, task: changed };
      await page.route(`**/api/tasks/${current.id}`, (route) => route.fulfill({ json: detail }));
    }
    const writes = watchActions(page);
    await page.goto("/");
    const target = row(page, current.title);
    await expect(target.getByRole("button", quickName)).toHaveCount(0);
    const open = target.getByRole("button", openName);
    await expect(open).toHaveAttribute("data-variant", "secondary");
    await open.click();
    await expect(panel(page).getByRole("heading", { name: current.title })).toBeVisible();
    expect(writes).toEqual([]);
  });
}

test("列上標題靠近核取框，滑鼠點選無焦點框，鍵盤移動有焦點框", async ({ page }) => {
  const { tasks: [first, next] } = await mockInboxReview(page);
  await page.goto("/");
  const target = row(page, first.title);
  const title = target.getByText(first.title, { exact: true });
  const checkbox = target.getByRole("checkbox");
  await expect(checkbox).toBeVisible();
  const box = (await checkbox.boundingBox())!;
  const gap = (await title.boundingBox())!.x - (box.x + box.width);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(12);
  const select = target.getByRole("button", { name: new RegExp(first.title) });
  await select.click();
  await expect(select).toHaveCSS("outline-style", "none");
  await page.keyboard.press("j");
  const moved = row(page, next.title).getByRole("button", { name: new RegExp(next.title) });
  await expect(moved).toBeFocused();
  await expect(moved).toHaveCSS("outline-style", "solid");
  await expect(hint(page)).toBeVisible();
});

for (const width of [375, 1440]) {
  test.describe(`${width} 像素觸控裝置`, () => {
    test.use({ hasTouch: true, viewport: { width, height: 812 } });
    test("收件匣隱藏鍵盤操作提示", async ({ page }) => {
      const { tasks } = await mockInboxReview(page);
      await page.goto("/");
      await expect(row(page, tasks[0].title)).toBeVisible();
      await expect(hint(page)).toBeHidden();
    });
  });
}
