import { expect, test, type Page } from "@playwright/test";
import type { Detail } from "../src/app/shared";
import {
  cancelledTask, emitDashboardEvent, exampleMember, expiredProjectConfirmation, group, inboxDetailUnavailable, mockInboxReview,
  project, projectSectionsState, reviewWorkbenchFixture,
} from "./dashboard-fixture";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

const queue = (page: Page) => page.getByRole("list", { name: "待決策佇列" });
const row = (page: Page, title: string) =>
  queue(page).getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });
const panel = (page: Page) => page.getByRole("region", { name: "審核面板" });
const quickName = { name: "核准修改", exact: true };
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
  專案確認失效: (detail) => ({ ...detail, task: { ...detail.task, last_error: expiredProjectConfirmation } }),
  新增風險: (detail) => ({ ...detail, task: { ...detail.task, risk_reasons: cancelledTask.risk_reasons } }),
  需求版本變更: (detail) => ({ ...detail, task: { ...detail.task, version: detail.task.version + 1 } }),
  專案不符: (detail) => ({ ...detail, task: { ...detail.task, project_id: projectSectionsState.projects[0].id } }),
  分支不符: (detail) => ({ ...detail, task: { ...detail.task, target_branch: `${project.base_branch}/${detail.task.id}` } }),
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
    if (scenario === "新增風險") {
      await expect(row(page, current.title).getByText("有風險", { exact: true })).toBeVisible();
      await expect(row(page, current.title).getByRole("button", { name: "查看", exact: true })).toBeVisible();
    }
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

test("選取列的 Alt+Enter 也會重讀，不能用舊面板核准已變更的需求", async ({ page }) => {
  const { tasks: [first] } = await mockInboxReview(page);
  await page.goto("/");
  await expect(panel(page).getByRole("button", { name: "確認專案與分支並核准修改" })).toBeEnabled();
  const stale = changes.需求版本變更({ ...reviewWorkbenchFixture().details.get(first.id)!, task: first });
  await page.route(`**/api/tasks/${first.id}`, (route) => route.fulfill({ json: stale }));
  const writes = watchActions(page);
  await row(page, first.title).getByRole("button", { name: new RegExp(first.title) }).press("Alt+Enter");
  await expect(panel(page).getByRole("alert")).toContainText(/重新確認/);
  expect(writes).toEqual([]);
});

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

test("送出核准遇到版本衝突會在該列保留原因並重新整理佇列", async ({ page }) => {
  const { state, tasks: [first, , , current, removed] } = await mockInboxReview(page);
  await page.route(`**/api/tasks/${current.id}/actions`, (route) => {
    state.tasks = state.tasks.filter(({ id }) => id !== removed.id);
    return route.fulfill({ status: 409, json: { error: "需求版本已更新" } });
  });
  await page.goto("/");
  await row(page, current.title).getByRole("button", quickName).click();
  await expect(row(page, current.title).getByRole("alert")).toContainText("需求版本已更新");
  await expect(row(page, removed.title)).toHaveCount(0);
  await expect(panel(page).getByRole("heading", { name: first.title })).toBeVisible();
  await expect(row(page, current.title).getByRole("button", { name: "查看", exact: true })).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: /已.*核准/ })).toHaveCount(0);
});

for (const change of ["版本變更", "更新時間變更", "離開佇列再返回"] as const) {
  test(`快速核准被拒後，${change}會清掉舊錯誤並重讀後再核准`, async ({ page }) => {
    const { state, tasks } = await mockInboxReview(page);
    const current = tasks[3];
    const target = row(page, current.title);
    const approve = target.getByRole("button", quickName);
    await page.route(`**/api/tasks/${current.id}/actions`, (route) =>
      route.fulfill({ status: 409, json: { error: "需求版本已更新" } }), { times: 1 });
    await page.goto("/");
    await approve.click();
    await expect(target.getByRole("alert")).toHaveText("需求版本已更新");
    await expect(target.getByRole("button", { name: "查看", exact: true })).toBeEnabled();

    if (change === "離開佇列再返回") {
      state.tasks = tasks.map((task) => task.id === current.id ? { ...task, status: "queued" } : task);
      await emitDashboardEvent(page, "update");
      await expect(target).toHaveCount(0);
    }
    const updated = {
      ...current,
      version: change === "版本變更" ? current.version + 1 : current.version,
      updated_at: change === "更新時間變更" ? new Date(Date.parse(current.updated_at) + 1000).toISOString() : current.updated_at,
    };
    state.tasks = tasks.map((task) => task.id === current.id ? updated : task);
    const requests: string[] = [];
    await page.route(`**/api/tasks/${current.id}`, (route) => {
      requests.push("重讀");
      return route.fulfill({ json: { ...reviewWorkbenchFixture().details.get(current.id)!, task: updated } });
    });
    await page.route(`**/api/tasks/${current.id}/actions`, (route) => {
      requests.push("核准");
      expect(route.request().postDataJSON().version).toBe(updated.version);
      state.tasks = tasks.filter((task) => task.id !== current.id);
      return route.fulfill({ json: { ...updated, status: "queued" } });
    });
    await emitDashboardEvent(page, "update");
    await expect(approve).toBeEnabled();
    await expect(target.getByRole("alert")).toHaveCount(0);
    await approve.click();
    await expect(target).toHaveCount(0);
    expect(requests).toEqual(["重讀", "核准"]);
  });
}

test("手機從清單核准後留在清單，選取下一筆並可按 Enter 開啟", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { tasks, state } = await mockInboxReview(page);
  const current = tasks[3];
  const next = tasks[4];
  await page.route(`**/api/tasks/${current.id}/actions`, (route) => {
    state.tasks = state.tasks.filter(({ id }) => id !== current.id);
    return route.fulfill({ json: { ...current, status: "queued" } });
  });
  await page.goto("/");
  await row(page, current.title).getByRole("button", quickName).click();
  const nextRow = row(page, next.title).getByRole("button", { name: new RegExp(next.title) });
  await expect(nextRow).toBeFocused();
  await expect(nextRow).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: next.title })).toBeVisible();
});

for (const scenario of ["成員", "專案確認失效", "有風險", "查詢", "回答補問", "選專案", "重試"] as const) {
  test(`${scenario}在列上只能開啟審核，不會直接送出`, async ({ page }) => {
    const { tasks, state } = await mockInboxReview(page);
    const current = tasks[({ 成員: 3, 專案確認失效: 3, 有風險: 3, 查詢: 3, 回答補問: 1, 選專案: 2, 重試: 6 })[scenario]];
    if (scenario === "成員") {
      await page.route("**/api/me", (route) => route.fulfill({ json: {
        id: exampleMember.github_id, login: exampleMember.login, csrf: "DemoMember1",
        role: exampleMember.role, owner: false,
      } }));
    }
    if (scenario === "有風險" || scenario === "查詢" || scenario === "專案確認失效") {
      const changed = scenario === "查詢"
        ? { ...current, mode: "query" as const }
        : scenario === "專案確認失效" ? { ...current, last_error: expiredProjectConfirmation }
        : { ...current, risk_reasons: cancelledTask.risk_reasons };
      state.tasks = state.tasks.map((entry) => entry.id === current.id ? changed : entry);
      const detail = { ...reviewWorkbenchFixture().details.get(current.id)!, task: changed };
      await page.route(`**/api/tasks/${current.id}`, (route) => route.fulfill({ json: detail }));
    }
    const writes = watchActions(page);
    await page.goto("/");
    const target = row(page, current.title);
    await expect(target.getByRole("button", quickName)).toHaveCount(0);
    const action = { 成員: "查看", 專案確認失效: "查看", 有風險: "查看", 查詢: "查看", 回答補問: "回答補問", 選專案: "選專案", 重試: "重試" }[scenario];
    const open = target.getByRole("button", { name: action, exact: true });
    await expect(target.getByText(/^等你/)).toHaveCount(0);
    await expect(target.getByText("有風險", { exact: true })).toHaveCount(scenario === "有風險" ? 1 : 0);
    await expect(open).toHaveAttribute("data-variant", "secondary");
    await open.click();
    await expect(panel(page).getByRole("heading", { name: current.title })).toBeVisible();
    if (scenario === "專案確認失效") await expect(panel(page).getByText(expiredProjectConfirmation)).toBeVisible();
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

for (const change of ["切到其他分頁", "改選其他案件", "開始編輯審核草稿", "帳號改為成員"] as const) {
  test(`快速核准重讀期間${change}不會送出`, async ({ page }) => {
    const { tasks } = await mockInboxReview(page);
    const [first, other, , current] = tasks;
    const writes = watchActions(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const url = `**/api/tasks/${current.id}`;
    await page.route(url, async (route) => {
      await pending;
      await route.fallback();
    });
    await page.goto("/");
    await expect(panel(page).getByRole("heading", { name: first.title })).toBeVisible();
    const received = page.waitForRequest(url);
    const read = page.waitForResponse(url);
    try {
      await row(page, current.title).getByRole("button", quickName).click();
      await received;
      if (change === "切到其他分頁") {
        await page.getByRole("tab", { name: /^進行中/ }).click();
      } else if (change === "改選其他案件") {
        await row(page, other.title).getByRole("button", { name: "回答補問", exact: true }).click();
      } else if (change === "開始編輯審核草稿") {
        await panel(page).getByRole("button", { name: /修改這一題/ }).click();
        await panel(page).getByRole("textbox", { name: "需求說明" }).fill(other.summary);
      } else {
        await page.route("**/api/me", (route) => route.fulfill({ json: {
          login: exampleMember.login, role: exampleMember.role, owner: false,
        } }));
      }
    } finally {
      release();
    }
    await (await read).finished();
    if (change === "帳號改為成員") {
      await expect(panel(page).getByRole("alert")).toContainText(/身分/);
      await expect(panel(page).getByRole("heading", { name: current.title })).toBeVisible();
    } else {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (change === "改選其他案件") await expect(panel(page).getByRole("heading", { name: other.title })).toBeVisible();
      if (change === "開始編輯審核草稿") await expect(panel(page).getByRole("textbox", { name: "需求說明" })).toHaveValue(other.summary);
      if (change === "切到其他分頁") await expect(page.getByRole("tab", { name: /^進行中/ })).toHaveAttribute("aria-selected", "true");
    }
    expect(writes).toEqual([]);
  });
}
