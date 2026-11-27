import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { ChatPage } from "../shared/chat";
import {
  defaultState,
  group,
  mockDashboard,
  project,
  task,
} from "./dashboard-fixture";

const pendingReply = "範例服務已恢復，可以再次查詢。";
const chat: ChatPage = {
  messages: [],
  bot_messages: [
    {
      id: "73",
      kind: "group_answered",
      task_id: task.id,
      task_title: task.title,
      created_at: task.updated_at,
      text: pendingReply,
      delivery: {
        status: "pending",
        reason: "quota",
        note: "LINE 本月推播額度已用完",
      },
    },
  ],
  next: null,
};
const chatRoute = { [`/api/groups/${group.id}/messages`]: chat };

// 等各頁的清單或資料載入後再量寬度，避免只驗到登入或載入中的骨架。
const pages = [
  { path: "/", title: "收件匣", content: task.title },
  { path: "/tasks", title: "任務", content: task.title },
  { path: "/chat", title: "聊天室", content: pendingReply },
  { path: "/groups", title: "群組", content: group.name },
  { path: "/projects", title: "專案", content: project.name },
  { path: "/checks", title: "定期檢查", content: /^還沒有定期檢查/ },
  { path: "/system", title: "系統", content: "每件任務要切到看板" },
  { path: "/settings", title: "設定", content: /^方案 demo/ },
];

test("專案列表只顯示驗證結果，測試指令可在詳情查看", async ({ page }) => {
  const command =
    'dotnet test Demo.sln --filter "Category!=Slow&Category!=External"';
  const manual = { ...project, name: "範例手動驗證", test_command: command };
  const partial = {
    ...project,
    id: "project-partial",
    name: "範例部分驗證",
    setup_mode: "auto",
    setup_status: command,
    setup_plan: {
      branch: "main",
      sha: "demo",
      fingerprint: "demo",
      configVersion: 1,
      install: "",
      test: command,
      verification: "partial",
      explanation: "只執行範例單元測試。",
      evidence: [],
    },
  } satisfies typeof project;
  const failed = {
    ...manual,
    id: "project-failed",
    name: "範例驗證失敗",
    validated_at: null,
    validation_error: command,
  };
  const validating = {
    ...manual,
    id: "project-validating",
    name: "範例驗證進行中",
    validated_at: null,
    validation_progress: "你的專案正在執行基底測試。",
  };
  const unverified = {
    ...manual,
    id: "project-unverified",
    name: "範例未驗證",
    validated_at: null,
  };
  await mockDashboard(page, {
    state: { projects: [manual, partial, failed, validating, unverified] },
  });
  await page.goto("/projects");
  const lists = page.locator("#project-sections");
  await lists.getByText("沒有群組使用（1 個）", { exact: true }).click();
  for (const [name, result] of [
    [manual.name, "通過"],
    [partial.name, "部分通過"],
    [failed.name, "失敗"],
    [validating.name, "驗證中"],
    [unverified.name, "需要驗證"],
  ]) {
    const row = lists.getByRole("button").filter({ hasText: name });
    await expect(row.getByText(result, { exact: true }).first()).toBeVisible();
  }
  await expect(lists).not.toContainText(command);
  await expect(lists.locator('[title*="dotnet test"]')).toHaveCount(0);
  await lists.getByRole("button").filter({ hasText: manual.name }).click();
  const detail = page.getByRole("dialog", { name: manual.name });
  await expect(
    detail.locator("code").filter({ hasText: command }),
  ).toBeVisible();
});

for (const width of [1280, 920, 375]) {
  test(`${width}px 寬時可讀到完整的群組與專案名稱，頁首操作維持在右上角`, async ({
    page,
  }) => {
    const groupName = "範例北區跨部門服務與資訊系統維護協作小組".repeat(4);
    const projectName =
      "ExamplePlatformReportingAndReconciliationService".repeat(3);
    await page.setViewportSize({ width, height: 812 });
    await mockDashboard(page, {
      state: {
        groups: [{ ...group, name: groupName }],
        projects: [{ ...project, name: projectName }],
      },
    });
    await page.goto("/groups");
    const row = page.getByRole("button").filter({ hasText: groupName });
    for (const name of [groupName, projectName]) {
      const fullName = row.getByText(name, { exact: true });
      await expect(fullName).toBeVisible();
      const fits = await fullName.evaluate((element) => {
        const row = element.closest("button")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const lines = Array.from(range.getClientRects());
        return (
          lines.length > 1 &&
          lines.every(
            (line) => line.left >= row.left && line.right <= row.right,
          )
        );
      });
      expect(fits, name).toBe(true);
    }
    await expect(row.getByText("可修改的專案", { exact: true })).toHaveCSS(
      "position",
      width === 1280 ? "absolute" : "static",
    );

    for (const path of ["/groups", "/projects", "/settings", "/system"]) {
      if (path !== "/groups") await page.goto(path);
      const header = page.getByRole("main").locator("header").first();
      const title = header.getByRole("heading", { level: 1 });
      const refresh = header.getByRole("button", { name: "重新整理" });
      await expect(refresh).toBeVisible();
      const titleBox = (await title.boundingBox())!;
      const refreshBox = (await refresh.boundingBox())!;
      expect(refreshBox.y).toBeLessThan(titleBox.y + titleBox.height);
      expect(refreshBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
    }
    if (width >= 768)
      await expect(
        page.getByRole("complementary").getByText("chat2pr", { exact: true }),
      ).toBeVisible();
  });
}

for (const width of [375, 1440]) {
  test(`等待時間群組範圍可用鍵盤選取與清除（${width}）`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const names = ["示範甲群", "示範乙群", "演練群"];
    await mockDashboard(page, {
      state: {
        ...defaultState,
        groups: names.map((name, index) => ({
          ...group,
          id: `demo-${index}`,
          name,
        })),
      },
    });
    await page.route(/\/api\/metrics\/friction\?/, async (route) => {
      const ids = new URL(route.request().url()).searchParams.getAll(
        "exclude_group_id",
      );
      if (ids.length !== 2) return route.fallback();
      return route.fulfill({
        json: {
          days: 7,
          tasks: 2,
          excludedGroupIds: ids,
          groupId: null,
          firstReplySeconds: 30,
          firstReplySamples: 1,
          firstReplySources: 1,
          firstReplyP95Seconds: 30,
          answerSeconds: 60,
          answerSamples: 1,
          answerSources: 1,
          answerP95Seconds: 60,
          cancelled: 1,
          responsesPerTask: 0,
          dashboardPerTask: 0,
          restated: 0,
          relinked: 0,
          reworkRate: null,
          reworkBase: 0,
        },
      });
    });
    await page.goto("/system");
    const selector = page.getByRole("combobox", { name: "群組", exact: true });
    await selector.selectOption({ label: "排除指定群組" });
    for (const name of names.slice(1)) {
      const checkbox = page.getByRole("checkbox", { name });
      await checkbox.focus();
      const loaded = page.waitForResponse((response) =>
        new URL(response.url()).searchParams
          .getAll("exclude_group_id")
          .includes(`demo-${names.indexOf(name)}`),
      );
      await page.keyboard.press("Space");
      await loaded;
      await expect(checkbox).toBeChecked();
    }
    const scope = page.getByText(
      "近 7 天，範圍：全部群組，排除 2 個（共 2 件任務）",
      { exact: true },
    );
    await expect(scope).toBeVisible();
    await expect(
      page.getByText(
        "中位數，樣本 1 筆，其中 1 筆有來源。第 95 百分位：樣本不足",
        { exact: true },
      ),
    ).toBeVisible();
    const card = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByRole("heading", { name: "使用摩擦" }) });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width === 375) {
      await page.setViewportSize({
        width,
        height: (await card.evaluate((element) => element.scrollHeight)) + 240,
      });
      await card.evaluate((element) =>
        element.scrollIntoView({ block: "center", behavior: "instant" }),
      );
    }
    await card.screenshot({ path: info.outputPath(`等待時間-${width}.png`) });
    await page
      .getByRole("button", { name: "清除", exact: true })
      .press("Enter");
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(scope).toHaveCount(0);
    await expect(
      page.getByText(
        "中位數，樣本 0 筆，其中 0 筆有來源。第 95 百分位：樣本不足",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
  });
}

test("保留上次統計且較慢的回應不能覆蓋新範圍，各列依自己的樣本數顯示百分位", async ({
  page,
}) => {
  await mockDashboard(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/metrics\/friction\?/, async (route) => {
    const days = Number(
      new URL(route.request().url()).searchParams.get("days"),
    );
    if (days === 30) await gate;
    await route.fulfill({
      json: {
        days,
        tasks: days === 90 ? 40 : 25,
        groupId: null,
        excludedGroupIds: [],
        answerSamples: 19,
        answerSources: 19,
        answerSeconds: 40,
        answerP95Seconds: 90,
        firstReplySamples: 20,
        firstReplySources: 19,
        firstReplySeconds: 20,
        firstReplyP95Seconds: 48,
        cancelled: 0,
        responsesPerTask: 0,
        dashboardPerTask: 0,
        restated: 0,
        relinked: 0,
        reworkBase: 0,
        reworkRate: null,
      },
    });
  });
  await page.goto("/system");
  const period = page.getByRole("combobox", { name: "期間", exact: true });
  const slower = page.waitForRequest((request) =>
    request.url().includes("/metrics/friction?days=30"),
  );
  const first = page.getByText(/近 7 天.*25 件任務/);
  await expect(first).toBeVisible();
  await period.selectOption("30");
  await slower;
  try {
    await expect(first).toBeVisible();
    await expect(page.getByText("查詢拿到答案", { exact: true })).toBeVisible();
    await period.selectOption("90");
    await expect(page.getByText(/近 90 天.*40 件任務/)).toBeVisible();
  } finally {
    release();
  }
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/近 90 天.*40 件任務/)).toBeVisible();
  await expect(
    page.getByText(/樣本 19 筆.*第 95 百分位：樣本不足/),
  ).toBeVisible();
  await expect(page.getByText(/樣本 20 筆.*第 95 百分位：48 秒/)).toBeVisible();
});

test("使用摩擦可在系統頁查看", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/settings");
  await expect(page.getByRole("tabpanel", { name: "AI 與執行" })).toBeVisible();
  await expect(page.getByText("使用摩擦", { exact: true })).toHaveCount(0);
  await page.goto("/system");
  await expect(page.getByRole("heading", { name: "使用摩擦" })).toBeVisible();
  await expect(page.getByText("每件任務要切到看板")).toBeVisible();
});

test("主機記憶體不足或訂閱額度用完時，頁首顯示派工自動暫停與原因", async ({
  context,
}) => {
  const now = new Date().toISOString();
  const memoryReason = "Windows 主機可用記憶體不足，暫停派新工作";
  const cases = [
    {
      reason: memoryReason,
      options: {
        state: {
          health: [
            {
              name: "host_resources",
              ok: false,
              detail: memoryReason,
              checked_at: now,
            },
          ],
        },
      },
    },
    {
      reason: "Codex 訂閱額度已達上限，重置時間待確認",
      options: {
        routes: {
          "/api/codex/account": {
            plan: "demo",
            allowed: false,
            limits: [],
            models: [],
            checkedAt: now,
          },
        },
      },
    },
  ];
  for (const { reason, options } of cases) {
    await test.step(reason, async () => {
      const page = await context.newPage();
      await mockDashboard(page, options);
      await page.goto("/");
      const header = page.getByRole("main").locator("header").first();
      const paused = header.getByText("派工自動暫停", { exact: true });
      await expect(paused).toBeVisible();
      await expect(paused).toHaveAttribute("title", reason);
      await expect(header.getByText("自動派工中", { exact: true })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("status").filter({ hasText: reason }),
      ).toBeVisible();
      await page.close();
    });
  }
});

test("你可以儲存個人保留比例並看到 chat2pr 上限與重置時間", async ({
  page,
}) => {
  const checkedAt = "2026-02-01T00:00:00Z";
  const hold =
    "已用到 chat2pr 可用的上限（保留 60% 給你），預計臺北時間 2/6 12:30 重置";
  let reserve = 0;
  await mockDashboard(page, {
    routes: {
      "/api/codex/account": {
        plan: "demo",
        allowed: true,
        limits: [
          {
            id: "demo",
            windows: [
              {
                usedPercent: 40,
                minutes: 10080,
                resetsAt: "2026-02-06T04:30:00Z",
              },
            ],
          },
        ],
        models: [],
        checkedAt,
      },
    },
  });
  await page.route(/\/api\/state\?/, (route) =>
    route.fulfill({
      json: {
        ...defaultState,
        settings: { ...defaultState.settings, codex_reserve_percent: reserve },
        tasks:
          reserve === 60
            ? [
                {
                  ...task,
                  status: "budget_wait",
                  last_error: `${hold}，額度恢復或你調低保留比例至額度可用後會自動繼續。`,
                },
              ]
            : [task],
      },
    }),
  );
  await page.route("**/api/settings/codex-reserve", (route) => {
    expect(route.request().method()).toBe("PUT");
    reserve = route.request().postDataJSON().codex_reserve_percent;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings");
  const input = page.getByRole("spinbutton", { name: "保留給你個人使用（%）" });
  await expect(input).toHaveValue("0");
  const save = page.getByRole("button", { name: "儲存保留比例" });
  await input.fill("91");
  await expect(save).toBeDisabled();
  await input.fill("60");
  await save.click();
  const banner = page.getByRole("status").filter({ hasText: hold });
  await expect(banner).toBeVisible();
  expect(reserve).toBe(60);
  await page.goto("/");
  await expect(
    page
      .getByRole("button")
      .filter({ hasText: task.title })
      .filter({ hasText: hold }),
  ).toBeVisible();
  await page.goto("/settings");
  await expect(input).toHaveValue("60");
  await expect(banner).toBeVisible();
  await input.fill("59");
  await save.click();
  await expect(banner).toHaveCount(0);
  expect(reserve).toBe(59);
});

test("在設定頁的手機畫面查看 LINE 本月用量、上限與預估用完日", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.setFixedTime(new Date("2028-02-11T12:00:00+08:00"));
  await mockDashboard(page, {
    state: {
      groups: [
        { ...group, name: "範例甲群", has_pending_line_push: true },
        { ...group, id: "SampleGroupB", name: "範例乙群", has_pending_line_push: true, member_count: 4, member_count_estimate: 12 },
        { ...group, id: "SampleGroupC", name: "範例丙群", member_count: null },
      ],
      health: [{
        name: "line_quota",
        ok: true,
        detail: "本月已用 100／上限 200 則",
        checked_at: "2028-02-09T16:00:00Z",
      }],
    },
  });
  await page.goto("/settings?tab=notifications");
  const card = page.getByRole("region", { name: "LINE 推播（群組回覆與私訊）", exact: true });
  await expect(card.getByText("本月已用 100／上限 200", { exact: true })).toBeVisible();
  await expect(card.getByText("按本月平均每日用量，預估 2 月 20 日用完。")).toBeVisible();
  await expect(card.getByText(/範例甲群.*人數未知，以 8 人估算/)).toBeVisible();
  await expect(card.getByText(/範例乙群.*上次查得 4 人.*以 12 人估算/)).toBeVisible();
  await expect(card.getByText(/範例丙群.*人數未知/)).toBeHidden();
  await card.getByText("其他群組的推播估值（1）").click();
  await expect(card.getByText(/範例丙群.*人數未知，以 8 人估算/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("在 375px 可以用鍵盤調整 LINE 推播設定並看到私訊暫停", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let policy = {};
  await mockDashboard(page);
  await page.route(/\/api\/state\?/, (route) =>
    route.fulfill({ json: {
      ...defaultState,
      settings: { ...defaultState.settings, ...policy, admin_line_id: "已綁定" },
      health: [{
        name: "line_quota",
        ok: true,
        detail: "本月已用 50／上限 200 則",
        checked_at: "2026-01-10T08:00:00Z",
      }],
    } }),
  );
  await page.route("**/api/settings/line-push", (route) => {
    expect(route.request().method()).toBe("PUT");
    policy = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings?tab=notifications");
  const section = page.getByRole("region", { name: "LINE 推播（群組回覆與私訊）", exact: true });
  const mode = section.getByRole("combobox", { name: "LINE 私訊範圍" });
  const reserve = section.getByRole("spinbutton", { name: "保留給群組回覆的比例（%）" });
  const save = section.getByRole("button", { name: "儲存 LINE 推播設定" });
  await expect(mode).toHaveValue("action");
  await expect(reserve).toHaveValue("70");
  await expect(save).toBeDisabled();
  await mode.focus();
  await page.keyboard.press("ArrowDown");
  await expect(mode).toHaveValue("all");
  await page.keyboard.press("Tab");
  await expect(reserve).toBeFocused();
  await reserve.fill("80");
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(section.getByRole("status").filter({ hasText: "私訊暫停" })).toBeVisible();
  await expect(section.getByRole("button", { name: "送一則測試通知" })).toBeDisabled();
  expect(policy).toEqual({ line_private_mode: "all", line_group_reserve_percent: 80 });
  for (const field of [mode, reserve, save])
    expect((await field.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await section.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(375);
  const accessibility = await new AxeBuilder({ page })
    .include('[aria-labelledby="line-push-title"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.reload();
  await expect(mode).toHaveValue("all");
  await expect(reserve).toHaveValue("80");
});

test("LINE 額度用完時，每頁顯示簡短警示，可用鍵盤展開說明且網址維持原樣", async ({
  page,
}) => {
  await mockDashboard(page, {
    state: {
      health: [
        {
          name: "line_quota",
          ok: false,
          detail: "LINE 本月推播額度已用完",
          checked_at: "2026-01-10T08:00:00Z",
        },
      ],
    },
  });
  for (const { path, title } of [
    ...pages,
    { path: "/members", title: "成員" },
  ]) {
    await test.step(title, async () => {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: title, exact: true }),
      ).toBeVisible();
      const banner = page
        .getByRole("status")
        .filter({ hasText: "LINE 本月推播額度已用完，你仍可在看板查看通知。" });
      await expect(banner).toBeVisible();
      const help = page.getByText(/或在群組輸入 \/進度 取回/);
      await expect(help).toBeHidden();
      const url = page.url();
      const disclosure = page.getByRole("button", { name: "怎麼辦" });
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(disclosure).toHaveAttribute("aria-controls", "line-quota-help");
      await disclosure.press("Enter");
      await expect(help).toBeVisible();
      const collapse = page.getByRole("button", { name: "收起說明" });
      await expect(collapse).toBeFocused();
      await expect(collapse).toHaveAttribute("aria-expanded", "true");
      await expect(page).toHaveURL(url);
      await collapse.press("Space");
      await expect(help).toBeHidden();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(page).toHaveURL(url);
    });
  }
});

test("頁首警示在 375px 可用鍵盤收合，重新整理後保持收合，新事件再展開", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const quota = {
    name: "line_quota",
    ok: false,
    detail: "LINE 本月推播額度已用完",
    checked_at: "2026-01-10T08:00:00Z",
    outage_started_at: "2026-01-10T06:00:00Z",
  };
  let health = [quota];
  await mockDashboard(page);
  await page.route(/\/api\/state\?/, (route) =>
    route.fulfill({ json: { ...defaultState, health } }),
  );
  await page.goto("/");
  const banner = page.getByRole("button", { name: /LINE 本月推播額度已用完/ });
  await expect(banner).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await testInfo.attach("375px 收件匣與額度警示", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  const collapse = page.getByRole("button", { name: "收合頁首警示" });
  const bounds = (await collapse.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.filter(
      ({ impact }) => impact === "serious" || impact === "critical",
    ),
  ).toEqual([]);
  await collapse.focus();
  await page.keyboard.press("Enter");
  const expand = page.getByRole("button", { name: "展開頁首警示（1）" });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(banner).toBeHidden();

  health = [{ ...quota, checked_at: "2026-01-10T09:00:00Z" }];
  await page.reload();
  await expect(expand).toBeVisible();
  await expect(banner).toBeHidden();

  health = [
    {
      ...quota,
      outage_started_at: "2026-01-10T10:00:00Z",
      checked_at: "2026-01-10T10:00:00Z",
    },
  ];
  await page.reload();
  await expect(banner).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");

  // 640px 的瀏覽器在 200% 縮放時，版面以 320 CSS 像素重新排列。
  await page.setViewportSize({ width: 320, height: 812 });
  await banner.click();
  await expect(page.getByText(/或在群組輸入 \/進度 取回/)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});

test("收件匣只在開啟系統紀錄時顯示技術細節", async ({ page }) => {
  const entries = [
    ["attempt", "開始程式修改"],
    ["settings", "管理者恢復派工"],
    ["install_image", "重用衍生映像 line-agentflow-derived:01234567"],
    ["install_review", "系統套件安裝前審查"],
    ["retrieval", "判讀參考：檢索到 20 則舊對話"],
    ["started", "開始開發需求版本 1，基底 89abcdef"],
  ];
  await mockDashboard(page, {
    state: {
      activity: entries.map(([kind, detail], id) => ({
        id,
        kind,
        detail,
        task_id: kind === "settings" ? null : task.id,
        task_title: kind === "settings" ? null : task.title,
        task_mode: kind === "settings" ? null : "query",
        created_at: "2026-01-10T08:00:00Z",
      })),
    },
  });
  await page.goto("/");
  await page.getByRole("tab", { name: /^動態/ }).click();
  const activity = page.getByRole("region", { name: "最近動態" });
  await activity.getByRole("button", { name: /^展開步驟/ }).click();
  await expect(page.getByText("開始調查", { exact: true })).toBeVisible();
  await expect(page.getByText("開始程式修改", { exact: true })).toHaveCount(0);
  await expect(page.getByText("管理者恢復派工", { exact: true })).toBeVisible();
  const system = [
    ...entries.slice(2, 5).map(([, detail]) => detail),
    "開始調查需求版本 1，基底 89abcdef",
  ].map((detail) => page.getByText(detail, { exact: true }));
  for (const entry of system) await expect(entry).toHaveCount(0);
  await page.getByRole("button", { name: "顯示系統紀錄" }).click();
  for (const entry of system) await expect(entry).toBeVisible();
  await page.getByRole("button", { name: "隱藏系統紀錄" }).click();
  for (const entry of system) await expect(entry).toHaveCount(0);
});

test("所有專案開放網路只在設定和專案頁顯示狀態", async ({ page }) => {
  await mockDashboard(page, {
    state: {
      settings: { ...defaultState.settings, container_network: "open" },
    },
  });
  const status = page.getByText(/所有專案已開放網路/);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "收件匣", exact: true }),
  ).toBeVisible();
  await expect(status).toHaveCount(0);
  for (const path of ["/settings", "/projects"]) {
    await page.goto(path);
    await expect(status).toBeVisible();
    await expect(
      page.getByRole("button", { name: "收合頁首警示" }),
    ).toHaveCount(0);
  }
});

test("聊天室標出機器人回覆因額度不足未送出，並能複製該則原文", async ({
  page,
}) => {
  await mockDashboard(page, { routes: chatRoute });
  // 測試中的剪貼簿只在這個頁面內使用，避免改動主機上原有的剪貼簿內容。
  await page.addInitScript(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          copied = value;
        },
        readText: async () => copied,
      },
    });
  });
  await page.goto("/chat");
  const message = page.getByRole("listitem").filter({ hasText: pendingReply });
  await expect(message.getByText("機器人", { exact: true })).toBeVisible();
  await expect(
    message.getByText("額度不足，未送出", { exact: true }),
  ).toBeVisible();
  await message.getByRole("button", { name: "複製文字" }).click();
  await expect(message.getByRole("button", { name: "已複製" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    pendingReply,
  );
});

test("375px 寬時八個看板頁面的內容都能在視窗內閱讀，整頁不需水平捲動", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page, { routes: chatRoute });
  for (const { path, title, content } of pages) {
    await test.step(title, async () => {
      await page.goto(path);
      const main = page.getByRole("main");
      await expect(
        main.getByRole("heading", { level: 1, name: title, exact: true }),
      ).toBeVisible();
      await expect(main.getByText(content, { exact: true })).toBeVisible();
      await expect(page).toHaveTitle(new RegExp(`${title}｜chat2pr$`));
      const width = await page.evaluate(async () => {
        await document.fonts.ready;
        return {
          page: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
        };
      });
      expect
        .soft(width.page, `${title}的整頁寬度`)
        .toBeLessThanOrEqual(width.viewport);
    });
  }
});

const systemWithEntry = (entry: string) => ({
  "/api/system": {
    checkedAt: new Date().toISOString(),
    requiredWorkerRev: "demo",
    runner: { state: "ok" },
    services: [],
    jobs: [],
    images: [],
    volumes: { jobs: 0, sourceCaches: 0 },
    entry,
  },
});
const flowFrame = (page: import("@playwright/test").Page) =>
  page.frameLocator('iframe[title^="系統架構動畫"]');

for (const [entry, title, sub] of [
  ["cloudflare", "Cloudflare Tunnel", "固定 HTTPS 入口"],
  ["ngrok", "ngrok", "固定 HTTPS 入口"],
  ["external", "固定 HTTPS 入口", "自備程序"],
] as const)
  test(`系統架構動畫依入口設定顯示：${entry}`, async ({ page }) => {
    await mockDashboard(page, { routes: systemWithEntry(entry) });
    await page.goto("/system?tab=architecture");
    const tunnel = flowFrame(page).locator("#n-tunnel");
    await expect(tunnel).toContainText(title);
    await expect(tunnel).toContainText(sub);
    if (entry !== "ngrok") await expect(tunnel).not.toContainText("ngrok");
  });

test("系統頁的架構動畫可以播放，並跟著看板外觀切換深色", async ({ page }) => {
  await mockDashboard(page, { routes: systemWithEntry("cloudflare") });
  await page.goto("/system?tab=architecture");
  const frame = flowFrame(page);
  await expect(
    frame.locator("svg text").filter({ hasText: /^chat2pr$/ }).first(),
  ).toHaveText("chat2pr");
  await frame.getByRole("button", { name: "開始播放" }).click();
  await expect(frame.locator("#live-text")).toHaveText("播放中");
  await expect(frame.locator("#lower-title")).toHaveText("成員在群組提需求");
  // 嵌入時不重複顯示頁首，iframe 高度由動畫頁回報，不會出現內部捲軸。
  await expect(frame.locator(".top")).toBeHidden();
  const iframe = page.locator('iframe[title^="系統架構動畫"]');
  await expect
    .poll(async () => (await iframe.boundingBox())?.height ?? 0)
    .toBeGreaterThan(500);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect
    .poll(() =>
      frame.locator("html").evaluate((h) => h.getAttribute("data-theme")),
    )
    .toBe("dark");
});

test("系統架構說明 Discord 補送時可收訊，遇到限流會延後", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/system?tab=architecture");
  const frame = flowFrame(page);
  await frame.getByRole("button", { name: /步：開 PR、回報群組$/ }).press("Enter");
  await expect(frame.locator("#cap-text")).toContainText(
    "Discord 補送時，頻道仍可接收新訊息。",
  );
  await expect(frame.locator("#cap-data")).toContainText("遇到限流時延後補送");
  await frame.locator("#chaps").getByRole("button").first().press("Enter");
  await expect(frame.locator("#cap-title")).toHaveText("成員在群組提需求");
  await expect(frame.getByRole("region", { name: "動畫播放器" })).toBeFocused();
  await expect(page).toHaveURL("/system?tab=architecture");
});

for (const [entry, title] of [
  ["cloudflare", "Cloudflare Tunnel 固定 HTTPS 入口"],
  ["ngrok", "ngrok 固定 HTTPS 入口"],
  ["external", "自備的固定 HTTPS 入口"],
] as const)
  test(`系統頁的流程說明依入口設定顯示：${entry}`, async ({ page }) => {
    await mockDashboard(page, { routes: systemWithEntry(entry) });
    await page.goto("/system?tab=architecture");
    await expect(page.getByText(`LINE 經${title}送 Webhook`)).toBeVisible();
    if (entry !== "ngrok")
      await expect(page.getByText(/ngrok 固定 HTTPS 入口/)).toHaveCount(0);
  });

for (const scenario of [
  {
    name: "手動暫停派工",
    settings: { paused: true },
    expected: "開始派工」恢復排程",
  },
  {
    name: "只暫停新需求判讀",
    settings: { triage_paused: true },
    expected: "已核准的任務照常執行",
  },
  {
    name: "磁碟不足自動暫停",
    settings: {},
    diskDispatchPaused: true,
    expected: "Docker 磁碟空間嚴重不足",
  },
])
  test(scenario.name + "會顯示對應的頂端提醒", async ({ page }) => {
    await mockDashboard(page, {
      state: {
        settings: { ...defaultState.settings, ...scenario.settings },
        diskDispatchPaused: scenario.diskDispatchPaused,
      },
    });
    await page.goto("/");
    await expect(
      page.getByRole("status").filter({ hasText: scenario.expected }),
    ).toBeVisible();
  });
