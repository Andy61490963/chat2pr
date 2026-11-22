import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  discordGroup,
  discordOnlySetup,
  group,
  mockDashboard,
  project,
  unboundProject,
} from "./dashboard-fixture";

test("從列表開啟記憶後，重新整理、複製網址及瀏覽器上一頁會回到對應分頁", async ({
  page,
  context,
}) => {
  await mockDashboard(page);
  await page.goto("/projects?source=demo");
  await page.getByRole("button", { name: /^測試專案/ }).click();
  const detail = page.getByRole("dialog", { name: project.name });
  await expect(page).toHaveURL(
    "/projects?source=demo&project=project-demo&tab=overview",
  );
  await detail.getByRole("tab", { name: "記憶" }).click();
  await expect(page).toHaveURL(
    "/projects?source=demo&project=project-demo&tab=memory",
  );
  const link = page.url();

  await page.reload();
  await expect(detail.getByRole("tabpanel", { name: "記憶" })).toBeVisible();
  await page.goBack();
  await expect(detail.getByRole("tabpanel", { name: "概況" })).toBeVisible();
  await page.goForward();
  await expect(detail.getByRole("tabpanel", { name: "記憶" })).toBeVisible();

  const other = await context.newPage();
  await mockDashboard(other);
  await other.goto(link);
  await expect(
    other
      .getByRole("dialog", { name: project.name })
      .getByRole("tabpanel", { name: "記憶" }),
  ).toBeVisible();
  await other.getByRole("button", { name: "關閉", exact: true }).click();
  await expect(other).toHaveURL("/projects?source=demo");
});

test("鍵盤切換及瀏覽器上一頁會先詢問是否放棄專案草稿", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/projects?project=project-demo&tab=overview");
  const detail = page.getByRole("dialog", { name: project.name });
  const memory = detail.getByRole("tab", { name: "記憶" });
  await memory.click();
  const draft = detail.getByRole("textbox", { name: "專案記憶內容" });
  await draft.fill("範例日期使用民國年");
  await memory.focus();
  await page.keyboard.press("ArrowRight");
  const reminder = page.getByRole("dialog", { name: "放棄未儲存的修改？" });
  await expect(reminder).toBeVisible();
  await reminder.getByRole("button", { name: "繼續編輯" }).press("Enter");
  await expect(reminder).toBeHidden();
  await expect(page).toHaveURL("/projects?project=project-demo&tab=memory");
  await expect(draft).toHaveValue("範例日期使用民國年");

  await page.goBack();
  await expect(reminder).toBeVisible();
  await reminder.getByRole("button", { name: "繼續編輯" }).click();
  await expect(page).toHaveURL("/projects?project=project-demo&tab=memory");
  await expect(draft).toHaveValue("範例日期使用民國年");
  await page.goBack();
  await reminder.getByRole("button", { name: "放棄修改" }).click();
  await expect(detail.getByRole("tabpanel", { name: "概況" })).toBeVisible();
  await page.goForward();
  await expect(draft).toHaveValue("");
});

test("手機可用鍵盤開啟群組綁定，預先勾選專案且保留原綁定", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page, { state: { projects: [project, unboundProject] } });
  const path = `/projects?project=${unboundProject.id}&tab=overview`;
  await page.goto(path);
  const detail = page.getByRole("dialog", { name: unboundProject.name });
  await expect(
    detail.getByRole("heading", { name: "環境已就緒，下一步綁定群組" }),
  ).toBeVisible();
  const bind = detail.getByRole("button", { name: "綁定群組", exact: true });
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished)),
  );
  expect(
    await bind.evaluate((element) => (element as HTMLElement).offsetHeight),
  ).toBeGreaterThanOrEqual(44);
  const layout = await detail.getByRole("tablist").evaluate((list) => {
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
    return {
      fits:
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth &&
        list.getBoundingClientRect().right <=
          document.documentElement.clientWidth,
      height: Math.min(...tabs.map((tab) => tab.offsetHeight)),
      overlap: tabs.some(
        (tab, index) =>
          index > 0 &&
          tab.offsetLeft <
            tabs[index - 1].offsetLeft + tabs[index - 1].offsetWidth,
      ),
    };
  });
  expect(layout).toMatchObject({ fits: true, overlap: false });
  expect(layout.height).toBeGreaterThanOrEqual(44);
  const { violations } = await new AxeBuilder({ page })
    .include('[data-slot="sheet-content"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations).toEqual([]);

  await bind.press("Enter");
  await expect(page).toHaveURL("/groups");
  const editor = page.getByRole("dialog", { name: group.name });
  await expect(
    editor.getByRole("heading", { name: "可修改的專案" }),
  ).toBeFocused();
  for (const name of [project.name, unboundProject.name]) {
    await expect(
      editor.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  const save = editor.getByRole("button", { name: "儲存變更" });
  await expect(save).toBeEnabled();
  const update = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      new URL(request.url()).pathname === `/api/groups/${group.id}`,
  );
  const conflict = "專案「示範專案」的儲存庫目前找不到，無法綁定";
  await page.route(`**/api/groups/${group.id}`, (route) =>
    route.fulfill({ status: 409, json: { error: conflict } }),
  );
  await save.press("Enter");
  expect((await update).postDataJSON()).toMatchObject({
    project_ids: [project.id, unboundProject.id],
    enabled: group.enabled,
  });
  await expect(page.getByText(conflict, { exact: true })).toBeVisible();
});

test("有多個群組時，選擇群組後才在原有表單帶入專案", async ({ page }) => {
  await mockDashboard(page, {
    state: {
      projects: [project, unboundProject],
      groups: [group, { ...discordGroup, enabled: false }],
    },
  });
  await page.goto(`/projects?project=${unboundProject.id}`);
  await page.getByRole("button", { name: "綁定群組", exact: true }).click();
  await expect(
    page.getByText("選擇要綁定「示範專案」的群組，再儲存變更。"),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /^範例伺服器／#需求/ }).click();
  const editor = page.getByRole("dialog", { name: discordGroup.name });
  await expect(
    editor.getByRole("button", { name: unboundProject.name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    editor.getByRole("switch", { name: "允許這個群組提出需求" }),
  ).not.toBeChecked();
  await expect(
    editor.getByText(
      "若要開始接收需求，請開啟上方的「允許這個群組提出需求」，再儲存變更。",
    ),
  ).toBeVisible();
});

for (const { label, state, example, other } of [
  {
    label: "LINE",
    state: { connectionSecrets: undefined },
    example: "LINE 群組輸入「/任務 確認示範專案的首頁標題」。",
    other: /^Discord 文字頻道提及機器人/,
  },
  {
    label: "Discord",
    state: discordOnlySetup,
    example:
      "Discord 文字頻道提及機器人，並在同一則訊息輸入「確認示範專案的首頁標題」。",
    other: /^LINE 群組輸入/,
  },
]) {
  test(`沒有群組時提供已設定的 ${label} 測試訊息範例`, async ({ page }) => {
    await mockDashboard(page, {
      state: { ...state, projects: [unboundProject], groups: [] },
    });
    await page.goto(`/projects?project=${unboundProject.id}`);
    const detail = page.getByRole("dialog", { name: unboundProject.name });
    await expect(detail.getByText(example)).toBeVisible();
    await expect(detail.getByText(other)).toHaveCount(0);
    await expect(
      detail.getByRole("button", { name: "綁定群組", exact: true }),
    ).toHaveCount(0);
  });
}

test("一般成員開啟專案分享連結時回到收件匣", async ({ page }) => {
  await mockDashboard(page, {
    state: { projects: [unboundProject] },
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
  await page.goto(`/projects?project=${unboundProject.id}&tab=memory`);
  // 回到收件匣；桌面會自動打開第一筆待審案件，網址可能帶 ?review=。
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe("/");
  expect(new URL(page.url()).searchParams.has("project")).toBe(false);
  await expect(
    page.getByRole("dialog", { name: unboundProject.name }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "綁定群組", exact: true }),
  ).toHaveCount(0);
});
