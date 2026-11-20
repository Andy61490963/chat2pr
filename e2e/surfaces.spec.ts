import { expect, test } from "@playwright/test";
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
  { path: "/system", title: "系統", content: /^最後盤點 / },
  { path: "/settings", title: "設定", content: /^方案 demo/ },
];

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
      reason: "Codex 訂閱額度已達上限",
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

test("LINE 推播額度用完時，每個看板頁面都提示替代取回答案的方式", async ({
  page,
}) => {
  await mockDashboard(page, {
    state: {
      health: [
        {
          name: "line_quota",
          ok: false,
          detail: "LINE 本月推播額度已用完",
          checked_at: new Date().toISOString(),
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
        .filter({ hasText: /LINE 本月推播額度已用完.*群組回答/ });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("/進度");
    });
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
    await page.goto("/system");
    const tunnel = flowFrame(page).locator("#n-tunnel");
    await expect(tunnel).toContainText(title);
    await expect(tunnel).toContainText(sub);
    if (entry !== "ngrok") await expect(tunnel).not.toContainText("ngrok");
  });

test("系統頁的架構動畫可以播放，並跟著看板外觀切換深色", async ({ page }) => {
  await mockDashboard(page, { routes: systemWithEntry("cloudflare") });
  await page.goto("/system");
  const frame = flowFrame(page);
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

for (const [entry, title] of [
  ["cloudflare", "Cloudflare Tunnel 固定 HTTPS 入口"],
  ["ngrok", "ngrok 固定 HTTPS 入口"],
  ["external", "自備的固定 HTTPS 入口"],
] as const)
  test(`系統頁的流程說明依入口設定顯示：${entry}`, async ({ page }) => {
    await mockDashboard(page, { routes: systemWithEntry(entry) });
    await page.goto("/system");
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
  {
    name: "開放所有專案網路",
    settings: { container_network: "open" },
    expected: "所有專案已開放網路",
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
