import { expect, test, type Request } from "@playwright/test";
import {
  defaultState,
  discordGroup,
  emitDashboardEvent,
  group,
  mockDashboard,
  task,
} from "./dashboard-fixture";

const managementPages = ["群組", "專案", "定期檢查", "系統", "成員", "設定"];

test("手機群組頁顯示平台標籤，可以用鍵盤篩選 LINE 與 Discord", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page, { state: { groups: [group, discordGroup] } });
  await page.goto("/groups");
  const line = page.getByRole("button", { name: new RegExp(group.name) });
  const discord = page.getByRole("button", {
    name: new RegExp(discordGroup.name),
  });
  await expect(line.getByText("LINE", { exact: true })).toBeVisible();
  await expect(discord.getByText("Discord", { exact: true })).toBeVisible();
  const platform = page.getByRole("combobox", { name: "聊天平台" });
  expect((await platform.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await platform.focus();
  await platform.press("Enter");
  await page
    .getByRole("option", { name: "Discord", exact: true })
    .press("Enter");
  await expect(discord).toBeVisible();
  await expect(line).toHaveCount(0);
  await platform.press("Enter");
  await page.getByRole("option", { name: "LINE", exact: true }).press("Enter");
  await expect(line).toBeVisible();
  await expect(discord).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});

test("聊天室可以查看 Discord 頻道與發言者", async ({ page }) => {
  await mockDashboard(page, { state: { groups: [group, discordGroup] } });
  await page.goto(`/chat?group=${encodeURIComponent(discordGroup.id)}`);
  await expect(
    page.getByRole("combobox", { name: "選擇聊天室" }),
  ).toContainText(discordGroup.name);
  await expect(page.getByText("小林", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("請確認示範服務是否正常。")).toBeVisible();
});

test("375px 底部只顯示四格，並可用鍵盤從「更多」前往群組", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page);
  await page.goto("/");
  await expect(page.getByText(task.title, { exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "看板導覽" });
  const buttons = nav.getByRole("button");
  const more = nav.getByRole("button", { name: "更多", exact: true });
  await expect(buttons).toHaveCount(4);
  for (const [index, name] of [/^收件匣/, "任務", "聊天室", "更多"].entries()) {
    const button = buttons.nth(index);
    await expect(button).toHaveAccessibleName(name);
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  }
  // 頁首的鈴鐺與重新整理在手機也要好按。
  for (const name of [/^通知/, "重新整理"]) {
    const box = (await page.getByRole("button", { name }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await expect(more).not.toHaveAttribute("aria-current", "page");

  await more.press("Enter");
  const menu = page.getByRole("menu", { name: "更多" });
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveText([...managementPages, "登出"]);
  for (const item of await items.all()) {
    // 選單開啟有縮放動畫，boundingBox 會量到縮小中的高度；改量元素本身的高度。
    expect(
      await item.evaluate((el) => (el as HTMLElement).offsetHeight),
    ).toBeGreaterThanOrEqual(44);
  }
  const groups = menu.getByRole("menuitem", { name: "群組", exact: true });
  await expect(groups).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "專案" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(groups).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/groups$/);
  await expect(
    page.getByRole("heading", { name: "群組", level: 1 }),
  ).toBeFocused();
  await expect(page.getByText(group.name, { exact: true })).toBeVisible();
  await expect(more).toHaveAttribute("aria-current", "page");
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  await testInfo.attach("375px 群組頁與底部導覽", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });

  await more.press("Enter");
  await expect(groups).toHaveAttribute("aria-current", "page");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  await testInfo.attach("375px 群組頁的更多選單", {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
});

test("一般成員的「更多」選單沒有管理頁", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page, {
    routes: {
      "/api/me": { id: "2", login: "小林", csrf: "test-only", role: "member" },
    },
  });
  await page.goto("/groups");
  await expect(page.getByText(task.title, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  const nav = page.getByRole("navigation", { name: "看板導覽" });
  await expect(nav.getByRole("button")).toHaveCount(4);
  const more = nav.getByRole("button", { name: "更多", exact: true });
  await expect(more).not.toHaveAttribute("aria-current", "page");
  await more.press("Enter");
  await expect(
    page.getByRole("menu", { name: "更多" }).getByRole("menuitem"),
  ).toHaveText(["登出"]);
});

const isStateRequest = (request: Request) => {
  const url = new URL(request.url());
  return url.pathname === "/api/state" && url.searchParams.has("activity");
};

for (const pending of [false, true]) {
  test(`首次連線時狀態${pending ? "還在讀取" : "剛讀完"}只讀一次，重連會再讀一次`, async ({
    page,
  }) => {
    await mockDashboard(page);
    let releaseInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    let replies = 0;
    const updatedTitle = "確認範例畫面可重新開啟";
    await page.route("**/api/state?activity=*", async (route) => {
      const first = ++replies === 1;
      if (first && pending) await initialRead;
      await route.fulfill({
        json: {
          ...defaultState,
          tasks: first ? [task] : [{ ...task, title: updatedTitle }],
        },
      });
    });
    const reads: string[] = [];
    page.on("request", (request) => {
      if (isStateRequest(request)) reads.push(new URL(request.url()).search);
    });
    const firstRequest = page.waitForRequest(isStateRequest);
    await page.goto("/");
    await firstRequest;
    // 桌面會自動打開第一筆，標題同時出現在佇列與審核面板；只看佇列。
    const initialTask = page
      .getByRole("list", { name: "待決策佇列" })
      .getByText(task.title, { exact: true });
    if (!pending) await expect(initialTask).toBeVisible();
    await emitDashboardEvent(page, "connected");
    releaseInitialRead();
    await expect(initialTask).toBeVisible();
    expect(reads).toEqual(["?activity=80"]);

    await emitDashboardEvent(page, "error");
    const nextRequest = page.waitForRequest(isStateRequest);
    await emitDashboardEvent(page, "connected");
    await nextRequest;
    await expect(page.getByText(updatedTitle, { exact: true })).toBeVisible();
    expect(reads).toEqual(["?activity=80", "?activity=80"]);

    const updateRequest = page.waitForRequest(isStateRequest);
    await emitDashboardEvent(page, "update");
    await updateRequest;
    expect(reads).toEqual(["?activity=80", "?activity=80", "?activity=80"]);
  });
}

test("首次讀取失敗後，連線成功會重新讀取看板狀態", async ({ page }) => {
  await mockDashboard(page);
  await page.route("**/api/state?activity=*", (route) =>
    route.fulfill({ status: 503, json: { error: "範例服務暫時無法回應" } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "重試", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/state?activity=*");
  await emitDashboardEvent(page, "connected");
  // 桌面會自動打開第一筆，標題同時出現在佇列與審核面板；只看佇列。
  await expect(
    page
      .getByRole("list", { name: "待決策佇列" })
      .getByText(task.title, { exact: true }),
  ).toBeVisible();
});
