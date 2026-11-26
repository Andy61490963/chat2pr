import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  assignmentWorkbenchFixture,
  meetingPickList,
  mockDashboard,
  project,
  reviewWorkbenchFixture,
} from "./dashboard-fixture";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

const queue = (page: Page) => page.getByRole("list", { name: "待決策佇列" });
const panel = (page: Page) => page.getByRole("region", { name: "審核面板" });
const row = (page: Page, title: string) =>
  queue(page).getByRole("button", { name: new RegExp(title) });
const approve = (page: Page) =>
  panel(page).getByRole("button", { name: "確認專案與分支並核准修改" });

async function openFixture(page: Page, fixture = reviewWorkbenchFixture()) {
  await mockDashboard(page, {
    state: { ...fixture.state },
    routes: Object.fromEntries(
      [...fixture.details].map(([id, detail]) => [`/api/tasks/${id}`, detail]),
    ),
  });
  await page.route(/\/api\/state(\?|$)/, (route) =>
    route.fulfill({ json: fixture.state }),
  );
  return fixture;
}

async function waitForVisuals(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function checkAxe(page: Page) {
  await waitForVisuals(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations).toEqual([]);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await waitForVisuals(page);
  await testInfo.attach(name, {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
}

test("桌面佇列依等待時間排序，每列只有一個狀態，審核面板依序呈現證據", async ({
  page,
}, testInfo) => {
  const fixture = reviewWorkbenchFixture();
  const firstId = fixture.tasks[0].id;
  const firstDetail = fixture.details.get(firstId)!;
  fixture.details.set(firstId, {
    ...firstDetail,
    task: {
      ...firstDetail.task,
      risk_reasons: ["修改會影響範例匯出流程。"],
      assumptions: ["沿用示範表單的欄位順序。"],
    },
  });
  const { tasks, reviewSource } = await openFixture(page, fixture);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "需要你處理 30" }),
  ).toBeVisible();
  const rows = queue(page).getByRole("listitem");
  await expect(rows).toHaveCount(30);
  await expect(rows.first()).toContainText(tasks[0].title);
  await expect(rows.first()).toContainText("等了 10 小時");
  await expect(rows.nth(1)).toContainText("Discord");
  // 桌面右欄不留白：沒指定案件時直接打開等最久的一筆。
  await expect(page).toHaveURL(`/?review=${tasks[0].id}`);
  await expect(
    panel(page).getByRole("heading", { name: tasks[0].title }),
  ).toBeVisible();
  expect(
    await rows.evaluateAll((items) =>
      items.map((item) => item.querySelectorAll("[data-review-status]").length),
    ),
  ).toEqual(Array(30).fill(1));
  await expect(
    queue(page).getByText("等你核准修改", { exact: true }),
  ).toHaveCount(9);
  await expect(
    queue(page).getByText("等你回答：補充需求", { exact: true }),
  ).toHaveCount(9);
  await expect(
    queue(page).getByText("等你決定：選專案", { exact: true }),
  ).toHaveCount(8);
  await expect(
    queue(page).getByText("等你決定：挑選任務", { exact: true }),
  ).toHaveCount(4);

  await page.getByRole("tab", { name: "最新" }).click();
  await expect(rows.first()).toContainText(tasks.at(-1)!.title);
  await page.getByRole("tab", { name: "等最久" }).click();
  await row(page, tasks[0].title).click();
  await expect(row(page, tasks[0].title)).toHaveAttribute(
    "aria-current",
    "true",
  );
  const review = panel(page);
  await expect(approve(page)).toBeEnabled();
  await expect(review.locator('button[data-variant="default"]')).toHaveCount(1);
  const headings = await review
    .getByRole("heading", { level: 3 })
    .allTextContents();
  expect(headings.slice(0, 4)).toEqual([
    "下一步",
    "來源原文",
    "處理專案",
    "預期驗收條件",
  ]);
  const source = review.getByRole("region", { name: "來源原文" });
  await expect(source.getByText(reviewSource, { exact: true })).toBeVisible();
  await expect(source.getByText("小林", { exact: true }).first()).toBeVisible();
  await expect(
    source.getByText(/\d{1,2}[/]\d{1,2}\s+\d{2}:\d{2}/).first(),
  ).toBeVisible();
  await expect(
    source.getByText("此訊息已撤回", { exact: true }),
  ).toHaveCount(1);
  await expect(
    source.getByText("原文已超過保存期限（30 天）", { exact: true }),
  ).toHaveCount(1);
  const image = source.getByRole("img", { name: "來源圖片" });
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight))
    .toBeGreaterThan(128);
  expect(
    await image.evaluate((img: HTMLImageElement) => img.offsetHeight),
  ).toBeLessThanOrEqual(128);
  const target = review.getByRole("region", { name: "處理專案" });
  await expect(target).toContainText(project.name);
  await expect(
    target.locator("dt", { hasText: "目標分支" }).locator("+ dd"),
  ).toHaveText("main");
  await expect(target).toContainText("需求原文指名測試專案。");
  const acceptance = review.getByRole("region", { name: "預期驗收條件" });
  await expect(acceptance.getByRole("listitem")).toHaveText(
    tasks[0].acceptance[0],
  );
  await expect(acceptance.getByRole("list")).toHaveCSS(
    "list-style-type",
    "disc",
  );
  await expect(
    review.getByRole("list", { name: "風險與待確認事項" }),
  ).toContainText("修改會影響範例匯出流程");
  await expect(
    review.getByRole("region", { name: "我先這樣假設" }),
  ).toContainText("沿用示範表單的欄位順序。");
  for (const name of [/^進行中/, /^待合併/, /^最近動態/]) {
    const heading = page.getByRole("heading", { name });
    await expect(heading).toBeVisible();
    await expect(review.getByRole("heading", { name })).toHaveCount(0);
  }
  await checkAxe(page);
  await capture(page, testInfo, "1440px 審核工作台");
  const reviewHeader = review.locator('[data-slot="sheet-header"]');
  await expect(review).toHaveCSS("overflow-y", "visible");
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect
    .poll(async () => Math.round((await reviewHeader.boundingBox())!.y))
    .toBe(16);
  expect((await review.boundingBox())!.y).toBeLessThan(0);
  await expect(reviewHeader.locator("..").getByRole("button", {
    name: "確認專案與分支並核准修改",
  })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`佇列列的等待時間與狀態固定靠右、數字等寬，佇列與面板是和頁面分得開的卡片（${colorScheme === "dark" ? "深色" : "淺色"}）`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await openFixture(page);
    await page.goto("/");
    await expect(queue(page).getByRole("listitem")).toHaveCount(30);
    await expect(
      panel(page).getByRole("heading", { name: "核對範例需求 01" }),
    ).toBeVisible();
    for (const column of ["[data-review-waiting]", "[data-review-status]"]) {
      const edges = await queue(page)
        .locator(column)
        .evaluateAll((items) =>
          items.map((item) => Math.round(item.getBoundingClientRect().right)),
        );
      expect(new Set(edges).size, `${column} 的右緣應對齊`).toBe(1);
    }
    await expect(
      queue(page).locator("[data-review-waiting]").first(),
    ).toHaveCSS("font-variant-numeric", "tabular-nums");
    // 相鄰兩層表面（頁面與卡片）的亮度要分得出來，深色模式不能黏在一起。
    const luminance = (color: string) => {
      const [r, g, b] = color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map((value) => {
        const c = Number(value) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const page_ = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    for (const surface of [queue(page), panel(page)]) {
      const card = await surface.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      const [light, dark] = [luminance(card), luminance(page_)].sort((a, b) => b - a);
      expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(1.08);
    }
    await checkAxe(page);
  });
}

test("桌面佇列將等最久的待挑選清單排第一、顯示等待時間並自動開啟", async ({
  page,
}) => {
  const fixture = reviewWorkbenchFixture();
  const list = {
    ...meetingPickList,
    createdAt: new Date(Date.now() - 12 * 60 * 60_000).toISOString(),
  };
  fixture.pickLists.push(list);
  await openFixture(page, fixture);
  await page.goto("/");

  const rows = queue(page).getByRole("listitem");
  const title = list.items[0].title;
  await expect(rows.first()).toContainText(title);
  await expect(rows.first()).toContainText("等了 12 小時");
  await expect(row(page, title)).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(`/?review=list-${list.id}`);
  await expect(panel(page).getByRole("checkbox", { name: title })).toBeVisible();

  await page.getByRole("tab", { name: "最新" }).click();
  await expect(rows.first()).toContainText(fixture.tasks.at(-1)!.title);
  await expect(rows.last()).toContainText(title);
});

test("方向鍵移動選取，Enter 只把焦點移到主動作，下一個 Tab 到次要動作", async ({
  page,
}) => {
  const { tasks } = await openFixture(page);
  await page.goto("/");
  const first = row(page, tasks[0].title);
  const second = row(page, tasks[1].title);
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-current", "true");
  await expect(first).toHaveAttribute("tabindex", "-1");
  await expect(second).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-current", "true");
  const action = approve(page);
  await expect(action).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(action).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`review=${tasks[0].id}$`));
  await expect(queue(page).getByRole("listitem")).toHaveCount(30);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(
    panel(page).getByRole("button", { name: "修改這一題" }),
  ).toBeFocused();
});

test("審核網址可重整、上一頁與分享，無效的案件取代網址並選第一筆", async ({
  page,
}) => {
  const { tasks, pickLists } = await openFixture(page);
  await page.goto("/");
  await row(page, tasks[0].title).click();
  await expect(page).toHaveURL(new RegExp(`review=${tasks[0].id}$`));
  await row(page, tasks[1].title).click();
  await expect(panel(page).getByText("要整理哪一個月份？")).toBeVisible();
  await expect(panel(page).getByText("原始內容已到期。")).toBeVisible();
  const sharedUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(sharedUrl);
  await expect(row(page, tasks[1].title)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(panel(page).getByText("要整理哪一個月份？")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`review=${tasks[0].id}$`));
  await expect(approve(page)).toBeVisible();
  await row(page, pickLists[0].items[0].title).click();
  await expect(page).toHaveURL(new RegExp(`review=list-${pickLists[0].id}$`));
  await expect(
    panel(page).getByRole("button", { name: "建立選取的任務" }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    panel(page).getByRole("checkbox", { name: pickLists[0].items[0].title }),
  ).toBeVisible();
  await page.goto("/?review=demo-finished");
  await expect(page).toHaveURL(new RegExp(`review=${tasks[0].id}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`review=list-${pickLists[0].id}$`));
});

test("核准、回答、指定專案與結束成功後前進並聚焦下一筆主動作", async ({
  page,
}) => {
  const { tasks, state } = await openFixture(page);
  const [first, questioned, unassigned, ending, fifth] = tasks;
  const remove = (id: string) => {
    state.tasks = state.tasks.filter((item) => item.id !== id);
  };
  await page.route(`**/api/tasks/${first.id}/actions`, (route) => {
    expect(route.request().postDataJSON()).toEqual({
      action: "approve",
      version: first.version,
      project_id: project.id,
      target_branch: "main",
      config_version: project.config_version,
      binding_version: 1,
    });
    remove(first.id);
    return route.fulfill({ json: { ...first, status: "queued" } });
  });
  await page.route(`**/api/tasks/${questioned.id}/answer`, (route) => {
    expect(route.request().postDataJSON()).toEqual({
      text: "十月",
      version: questioned.version,
    });
    remove(questioned.id);
    return route.fulfill({ json: { ...questioned, status: "queued" } });
  });
  await page.route(`**/api/tasks/${unassigned.id}/actions`, (route) => {
    expect(route.request().postDataJSON()).toEqual({
      action: "assign",
      version: unassigned.version,
      project_id: project.id,
    });
    const assigned = {
      ...unassigned,
      project_id: project.id,
      version: unassigned.version + 1,
    };
    state.tasks = state.tasks.map((item) =>
      item.id === assigned.id ? assigned : item,
    );
    return route.fulfill({ json: assigned });
  });
  await page.route(`**/api/tasks/${ending.id}/actions`, (route) => {
    expect(route.request().postDataJSON()).toEqual({
      action: "reject",
      version: ending.version,
      end_reason: "unclear",
    });
    remove(ending.id);
    return route.fulfill({ json: { ...ending, status: "rejected" } });
  });

  await page.goto("/");
  await row(page, first.title).click();
  await approve(page).click();
  const answerAction = panel(page).getByRole("button", {
    name: "回答問題",
    exact: true,
  });
  await expect(answerAction).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`review=${questioned.id}$`));
  await expect(row(page, first.title)).toHaveCount(0);
  await answerAction.press("Enter");
  const answer = panel(page).getByRole("textbox", { name: "回答這個問題" });
  await expect(answer).toBeFocused();
  await answer.fill("十月");
  await panel(page).getByRole("button", { name: "送出回答" }).click();
  const assignAction = panel(page).getByRole("button", {
    name: "指定專案",
    exact: true,
  });
  await expect(assignAction).toBeFocused();
  await assignAction.press("Enter");
  await expect(approve(page)).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`review=${ending.id}$`));
  await expect(row(page, unassigned.title)).toContainText("等你核准修改");
  await panel(page)
    .getByRole("button", { name: "結束任務", exact: true })
    .click();
  const endDialog = page.getByRole("dialog", { name: "結束任務？" });
  await endDialog.getByRole("radio", { name: "需求不清楚" }).check();
  await endDialog
    .getByRole("button", { name: "結束任務", exact: true })
    .press("Enter");
  await expect(answerAction).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`review=${fifth.id}$`));
  await expect(row(page, ending.title)).toHaveCount(0);
});

for (const width of [1440, 375]) {
  for (const mode of ["query", "change"] as const) {
    const isQuery = mode === "query";
    const taskType = isQuery ? "查詢任務" : "修改程式";
    test(`${taskType}的專案清單可用鍵盤指定且不溢出（${width}px）`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = assignmentWorkbenchFixture(mode);
      await openFixture(page, fixture);
      const {
        frontend,
        backend,
        tasks: [task],
      } = fixture;
      const endpoint = `/api/tasks/${task.id}/actions`;
      await page.route(`**${endpoint}`, (route) =>
        route.fulfill({
          status: 409,
          json: { error: "群組綁定已更新，請重新選擇專案。" },
        }),
      );
      await page.goto("/");
      const inbox = page.getByRole("region", { name: /需要你處理/ });
      await expect(queue(page).getByRole("listitem")).toHaveCount(1);
      await expect(queue(page).getByRole("checkbox")).toHaveCount(0);
      await expect(inbox.getByRole("button", { name: "全選本頁" })).toHaveCount(
        0,
      );
      await expect(inbox.getByRole("button", { name: "清除選取" })).toHaveCount(
        0,
      );
      await row(page, task.title).click();
      const review =
        width === 375
          ? page.getByRole("dialog", { name: task.title })
          : panel(page);
      // 「結束任務」只出現一次（手機曾在專案清單與動作列各出現一個）。
      await expect(
        review.getByRole("button", { name: "結束任務" }),
      ).toHaveCount(1);
      const metadata = review.locator("summary").filter({ hasText: "任務資料" });
      await metadata.press("Enter");
      const fields = review.locator('[data-slot="sheet-header"] dl');
      await expect(fields).toBeVisible();
      await expect(fields.locator("dt")).toHaveText([
        "任務類型",
        "群組",
        "專案",
        "建立",
        "更新",
      ]);
      await expect(fields.locator("dd").first()).toHaveText(taskType);
      // 資訊值用主文字色（高對比），不用淡色。
      await expect(fields.locator("dd").first()).toHaveCSS(
        "color",
        await page.evaluate(() => getComputedStyle(document.body).color),
      );
      await metadata.press("Enter");
      const section = review.getByRole("region", { name: "處理專案" });
      const explanation = isQuery
        ? "查詢可以同時參考多個專案的原始碼"
        : "修改任務只能選一個專案，因為一個 PR 只能開在一個儲存庫";
      const list = section
        .getByRole("group", { name: explanation })
        .getByRole("list");
      await expect(list.getByRole("listitem")).toHaveCount(2);
      await expect(
        section.getByText("尚未指定專案", { exact: true }),
      ).toHaveCount(0);
      await expect(
        section.getByText(task.project_routing!.reason, { exact: true }),
      ).toHaveCount(0);
      await expect(section.getByText(/請先選擇專案|待確認專案/)).toHaveCount(0);
      const submit = (width === 375 ? review : section).getByRole("button", {
        name: "指定專案",
        exact: true,
      });
      await expect(
        review.getByRole("button", { name: /^(確認)?指定專案$/ }),
      ).toHaveCount(1);
      await expect(submit).toBeDisabled();
      const role = isQuery ? "checkbox" : "radio";
      const first = list.getByRole(role, { name: frontend.name, exact: true });
      const second = list.getByRole(role, { name: backend.name, exact: true });
      // 點名稱及儲存庫文字也應能選取，長名稱仍可用鍵盤切換。
      await list.getByText(frontend.repo, { exact: true }).click();
      await expect(first).toBeChecked();
      if (isQuery) {
        await expect(
          list.getByRole("listitem").first().getByText("主要", { exact: true }),
        ).toBeVisible();
        await second.press("Space");
        await expect(second).toBeChecked();
        await expect(first).toBeChecked();
        await list.getByRole("button", { name: /^設為主要/ }).press("Enter");
        await expect(second).toBeFocused();
        await expect(
          list.getByRole("listitem").last().getByText("主要", { exact: true }),
        ).toBeVisible();
      } else {
        await first.press("ArrowDown");
        await expect(second).toBeChecked();
        await expect(first).not.toBeChecked();
      }

      await section.scrollIntoViewIfNeeded();
      await waitForVisuals(page);
      const geometry = await list.getByRole("listitem").evaluateAll((rows) =>
        rows.map((row) => {
          const label = row.querySelector("label")!;
          const text = label.querySelector<HTMLElement>("input + span")!;
          const bounds = row.getBoundingClientRect();
          const textBounds = text.getBoundingClientRect();
          return {
            width: row.clientWidth,
            fits:
              textBounds.left >= bounds.left &&
              textBounds.right <= bounds.right &&
              text.scrollWidth === text.clientWidth,
            touchHeight: label.offsetHeight,
            nameHeight: text.firstElementChild!.getBoundingClientRect().height,
          };
        }),
      );
      expect(geometry[0].width).toBe(geometry[1].width);
      expect(
        geometry.every(({ fits, touchHeight }) => fits && touchHeight >= 44),
      ).toBe(true);
      expect(geometry[1].nameHeight).toBeGreaterThan(geometry[0].nameHeight);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(await review.evaluate((element) => element.scrollWidth)).toBe(
        await review.evaluate((element) => element.clientWidth),
      );
      await checkAxe(page);
      await capture(page, testInfo, `${width}px ${taskType}專案清單`);

      const request = page.waitForRequest(
        (req) => req.url().endsWith(endpoint) && req.method() === "POST",
      );
      await submit.press("Enter");
      expect((await request).postDataJSON()).toEqual({
        action: "assign",
        version: task.version,
        project_id: backend.id,
        ...(isQuery ? { related_project_ids: [frontend.id] } : {}),
      });
      await expect(review.getByRole("alert")).toHaveText(
        "群組綁定已更新，請重新選擇專案。",
      );
      await expect(second).toBeChecked();

      const assigned = {
        ...task,
        project_id: backend.id,
        target_branch: backend.base_branch,
        version: task.version + 1,
        project_routing: {
          ...task.project_routing!,
          ...(isQuery
            ? {
                relatedProjects: [
                  { id: frontend.id, name: frontend.name, repo: frontend.repo },
                ],
              }
            : {}),
        },
      };
      const taskDetail = fixture.details.get(task.id)!;
      await page.route(`**/api/tasks/${task.id}`, (route) =>
        route.fulfill({
          json: {
            ...taskDetail,
            task: assigned,
            projectReview: {
              ...taskDetail.projectReview,
              config_version: backend.config_version,
              project_name: backend.name,
              repo: backend.repo,
              base_branch: backend.base_branch,
            },
          },
        }),
      );
      await page.route(`**${endpoint}`, (route) => {
        fixture.state.tasks = [assigned];
        return route.fulfill({ json: assigned });
      });
      await submit.press("Enter");
      await expect(
        section.getByText(backend.name, { exact: true }),
      ).toBeVisible();
      await expect(submit).toHaveCount(0);
      if (isQuery)
        await expect(
          section.locator("dt", { hasText: "一併查詢（唯讀）" }).locator("+ dd"),
        ).toContainText(frontend.name);
    });
  }
}

test("回答遭拒保留伺服器原因與草稿，鍵盤切換與上一頁會先詢問", async ({
  page,
}) => {
  const { tasks } = await openFixture(page);
  const [first, questioned, unassigned] = tasks;
  const conflict = "任務版本已更新，請再確認一次。";
  await page.route(`**/api/tasks/${questioned.id}/answer`, (route) =>
    route.fulfill({ status: 409, json: { error: conflict } }),
  );
  await page.goto("/");
  await row(page, first.title).click();
  await row(page, questioned.title).click();
  const answer = panel(page).getByRole("textbox", { name: "回答這個問題" });
  await answer.fill("整理十月的範例資料。");
  await panel(page).getByRole("button", { name: "送出回答" }).click();
  await expect(panel(page).getByRole("alert")).toHaveText(conflict);
  await expect(answer).toHaveValue("整理十月的範例資料。");
  const original = page.url();
  await page.goBack();
  const guard = page.getByRole("dialog", { name: "放棄未儲存的修改？" });
  await guard.getByRole("button", { name: "繼續編輯" }).click();
  await expect(page).toHaveURL(original);
  await expect(answer).toHaveValue("整理十月的範例資料。");
  await row(page, questioned.title).focus();
  await page.keyboard.press("ArrowDown");
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "放棄修改" }).click();
  await expect(row(page, unassigned.title)).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("載入失敗顯示伺服器原因並可重新載入，完成最後一筆會清空佇列", async ({
  page,
}) => {
  const fixture = reviewWorkbenchFixture();
  const entry = fixture.tasks[0];
  fixture.state.tasks = [entry];
  fixture.state.pickLists = [];
  const { state, details } = await openFixture(page, fixture);
  let fail = true;
  let releaseResponse!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route(`**/api/tasks/${entry.id}`, async (route) => {
    if (!fail) return route.fulfill({ json: details.get(entry.id) });
    await responseReady;
    return route.fulfill({
      status: 503,
      json: { error: "範例服務暫時離線。" },
    });
  });
  await page.route(`**/api/tasks/${entry.id}/actions`, (route) => {
    state.tasks = [];
    return route.fulfill({ json: { ...entry, status: "rejected" } });
  });
  await page.goto(`/?review=${entry.id}`);
  await expect(panel(page).getByText("載入審核內容中…")).toBeVisible();
  releaseResponse();
  await expect(panel(page).getByRole("alert")).toContainText(
    "範例服務暫時離線。",
  );
  fail = false;
  await panel(page).getByRole("button", { name: "重新載入審核內容" }).click();
  await expect(approve(page)).toBeEnabled();
  await panel(page)
    .getByRole("button", { name: "結束任務", exact: true })
    .click();
  const endDialog = page.getByRole("dialog", { name: "結束任務？" });
  await endDialog.getByRole("radio", { name: "其他" }).check();
  await endDialog
    .getByRole("button", { name: "結束任務", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "都處理完了" })).toBeVisible();
  await expect(page).not.toHaveURL(/review=/);
  await expect(queue(page)).toHaveCount(0);
});

test("1024px 的佇列與面板並排且沒有水平捲動", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 812 });
  const { tasks } = await openFixture(page);
  await page.goto(`/?review=${tasks[0].id}`);
  await expect(approve(page)).toBeVisible();
  const left = (await queue(page).boundingBox())!;
  const right = (await panel(page).boundingBox())!;
  expect(left.width).toBeGreaterThanOrEqual(360);
  expect(left.x + left.width).toBeLessThan(right.x);
  expect(right.x + right.width).toBeLessThanOrEqual(1024);
  // 右欄跟頁面一起捲動，不另外產生一層捲軸。
  expect(
    await panel(page).evaluate((el) =>
      [el, ...el.querySelectorAll("*")].some((node) => {
        const { overflowY } = getComputedStyle(node);
        return (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight + 1
        );
      }),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1024,
  );
});

test("375px 首屏看見三筆，可全頁審核、切換上一筆或下一筆並返回佇列", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const fixture = reviewWorkbenchFixture();
  fixture.state.settings.admin_line_id = null;
  const { tasks } = await openFixture(page, fixture);
  await page.goto("/");
  await expect(queue(page).getByRole("listitem")).toHaveCount(30);
  await waitForVisuals(page);
  const bottom = await page
    .getByRole("navigation", { name: "看板導覽" })
    .evaluate((nav) => nav.getBoundingClientRect().top);
  await expect(
    page.getByRole("heading", { name: "開始使用" }),
  ).not.toBeInViewport();
  for (const entry of tasks.slice(0, 3)) {
    const button = row(page, entry.title);
    const viewport = (await button.boundingBox())!;
    expect(viewport.y).toBeGreaterThanOrEqual(0);
    expect(viewport.y + viewport.height).toBeLessThanOrEqual(bottom);
    expect(
      await button.evaluate(
        (element: HTMLButtonElement) => element.offsetHeight,
      ),
    ).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  await checkAxe(page);
  await capture(page, testInfo, "375px 待決策佇列");

  await row(page, tasks[0].title).press("Enter");
  const dialog = page.getByRole("dialog", {
    name: tasks[0].title,
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "確認專案與分支並核准修改" }),
  ).toBeFocused();
  const nav = dialog.getByRole("navigation", { name: "案件導覽" });
  const previous = nav.getByRole("button", { name: "上一筆" });
  const next = nav.getByRole("button", { name: "下一筆" });
  const back = nav.getByRole("button", { name: "返回佇列" });
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  for (const button of [back, previous, next]) {
    const { width, height } = await button.evaluate(
      (element: HTMLButtonElement) => ({
        width: element.offsetWidth,
        height: element.offsetHeight,
      }),
    );
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await dialog.evaluate((element: HTMLElement) => element.offsetWidth),
  ).toBe(375);
  expect(
    await dialog.evaluate((element) =>
      [...element.querySelectorAll("div")]
        .filter((child) => getComputedStyle(child).overflowY === "auto")
        .every((child) => child.scrollWidth <= child.clientWidth),
    ),
  ).toBe(true);
  await checkAxe(page);
  await capture(page, testInfo, "375px 全頁審核面板");
  await next.click();
  const second = page.getByRole("dialog", {
    name: tasks[1].title,
    exact: true,
  });
  await expect(second.getByRole("button", { name: "回答問題" })).toBeFocused();
  await second.getByRole("button", { name: "上一筆" }).click();
  await expect(dialog).toBeVisible();
  await back.click();
  await expect(dialog).toBeHidden();
  await expect(row(page, tasks[0].title)).toBeFocused();
  await expect(page).not.toHaveURL(/review=/);
});
