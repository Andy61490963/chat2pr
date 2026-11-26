import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { ChatPage } from "../shared/chat";
import type { ScheduledCheck } from "../shared/checks";
import {
  detail,
  group,
  mockDashboard,
  project,
  task,
} from "./dashboard-fixture";

const question = "要查哪個月份的資料？";
const message = "請整理範例服務的狀態。";
const member = "example-member";
const skipped = {
  id: "example-skip",
  task_id: null,
  kind: "triage_skipped",
  detail:
    "你在「範例看板跨部門設計與開發討論群組」的訊息屬於同事之間的分工，系統未建立任務。",
  created_at: task.created_at,
};
const chat: ChatPage = {
  messages: [
    {
      id: "example-message",
      sender: member,
      type: "text",
      text: message,
      received_at: task.created_at,
      quoted_id: null,
      quoted_text: null,
      quoted_sender: null,
      quoted_bot_id: null,
      availability: "readable",
      revoked: false,
      expired: false,
      has_image: false,
      image_state: null,
      routing: "processed",
      tasks: [{ id: task.id, title: task.title, status: task.status }],
    },
  ],
  bot_messages: [
    {
      id: "1",
      task_id: task.id,
      task_title: task.title,
      kind: "group_answered",
      created_at: task.updated_at,
      text: "已整理範例服務的狀態。",
      delivery: {
        status: "pending",
        reason: "quota",
        note: "LINE 本月推播額度已用完",
      },
    },
  ],
  next: null,
};
const check: ScheduledCheck = {
  id: "example-check",
  group_id: group.id,
  project_id: project.id,
  name: "範例服務檢查",
  kind: "http",
  target: "https://demo.invalid/health",
  condition: {},
  interval_minutes: 60,
  daily_at: null,
  notify: "group",
  quiet_from: null,
  quiet_to: null,
  alert_text: "範例服務異常",
  recovered_text: "範例服務已恢復",
  rationale: "",
  investigate: false,
  status: "active",
  version: 1,
  approved_version: 1,
  approved_by: "demo-admin",
  created_by: "demo-admin",
  state: "ok",
  consecutive_errors: 0,
  last_run_at: task.updated_at,
  next_run_at: null,
  last_investigated_at: null,
  source_task_id: null,
  created_at: task.created_at,
  updated_at: task.updated_at,
};

const screens: {
  name: string;
  path: string;
  loaded: string | RegExp;
  width?: number;
  signedOut?: boolean;
  moreMenu?: boolean;
}[] = [
  { name: "收件匣", path: "/", loaded: task.title },
  { name: "手機收件匣", path: "/", loaded: task.title, width: 375 },
  { name: "審核工作台的面板", path: `/?review=${task.id}`, loaded: question },
  { name: "手機全頁審核", path: `/?review=${task.id}`, loaded: question, width: 375 },
  { name: "任務清單", path: "/tasks", loaded: task.title },
  { name: "任務詳情", path: `/tasks?task=${task.id}`, loaded: question },
  { name: "聊天室", path: "/chat", loaded: message },
  { name: "群組", path: "/groups", loaded: group.name },
  {
    name: "手機群組頁的「更多」選單",
    path: "/groups",
    loaded: group.name,
    width: 375,
    moreMenu: true,
  },
  { name: "專案", path: "/projects", loaded: project.name },
  { name: "成員", path: "/members", loaded: member },
  { name: "定期檢查", path: "/checks", loaded: check.name },
  { name: "系統的執行分頁", path: "/system", loaded: "每件任務要切到看板" },
  {
    name: "系統的容器與磁碟分頁",
    path: "/system?tab=disk",
    loaded: /^最後盤點 /,
  },
  {
    name: "系統的網路分頁",
    path: "/system?tab=network",
    loaded: /^使用預設清單，共/,
  },
  {
    name: "系統的架構分頁",
    path: "/system?tab=architecture",
    loaded: "工作容器各階段的權限",
  },
  { name: "設定的 AI 與執行分頁", path: "/settings", loaded: /^方案 demo/ },
  {
    name: "設定的通知分頁",
    path: "/settings?tab=notifications",
    loaded: "管理者通知送到",
  },
  {
    name: "設定的連線與金鑰分頁",
    path: "/settings?tab=connections",
    loaded: "OpenAI API 金鑰",
  },
  {
    name: "設定的資料與外觀分頁",
    path: "/settings?tab=data",
    loaded: "介面外觀",
  },
  { name: "登入", path: "/", loaded: "使用 GitHub 登入", signedOut: true },
];
const narrowScreens = screens
  .filter(
    ({ path, signedOut, width }) =>
      !width &&
      (signedOut ||
        ["/tasks", "/chat", "/groups", "/projects", "/system", "/settings"]
          .includes(path.split("?")[0])),
  )
  .map((screen) => ({
    ...screen,
    name: `${screen.name}（375px）`,
    width: 375,
  }));

test("方向鍵切換任務狀態與詳情時，選取的分頁會標示對應面板", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.goto("/tasks");
  await page.getByRole("tab", { name: /^進行中與待處理/ }).focus();
  await page.keyboard.press("ArrowRight");
  const ended = page.getByRole("tabpanel", { name: /^已結束/ });
  await expect(ended.getByText("目前沒有已結束的任務")).toBeVisible();
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
    "aria-controls",
    (await ended.getAttribute("id"))!,
  );
  await page.keyboard.press("ArrowLeft");
  const list = page.getByRole("tabpanel", { name: /^進行中與待處理/ });
  await list.getByRole("button", { name: new RegExp(task.title) }).click();
  const drawer = page.getByRole("dialog", { name: task.title });
  await drawer.getByRole("tab", { name: /^來源訊息/ }).focus();
  await page.keyboard.press("ArrowRight");
  const history = drawer.getByRole("tabpanel", { name: "時間軸" });
  await expect(history.getByText("還沒有紀錄。")).toBeVisible();
  await expect(drawer.getByRole("tab", { selected: true })).toHaveAttribute(
    "aria-controls",
    (await history.getAttribute("id"))!,
  );
});

test("外觀選項可用方向鍵選取，重新載入後保留深色偏好", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/settings?tab=data");
  const theme = page.getByRole("radiogroup", { name: "介面外觀" });
  await theme.getByRole("radio", { name: "跟隨系統" }).focus();
  await page.keyboard.press("ArrowLeft");
  const dark = theme.getByRole("radio", { name: "深色" });
  await expect(dark).toBeChecked();
  await expect(dark).toBeFocused();
  await page.reload();
  await expect(dark).toBeChecked();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});

for (const theme of ["light", "dark"] as const) {
  test.describe(theme === "light" ? "淺色可及性" : "深色可及性", () => {
    test.use({ colorScheme: theme });
    test("手機任務篩選面板", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mockDashboard(page);
      await page.goto("/tasks");
      await page.getByRole("button", { name: /^篩選，已套用/ }).press("Enter");
      const panel = page.getByRole("dialog", { name: "任務篩選" });
      await expect(
        panel.getByRole("combobox", { name: "分組方式" }),
      ).toBeVisible();
      const close = panel.getByRole("button", { name: "關閉" });
      const box = (await close.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(375);
      await page.evaluate(() => document.fonts.ready);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(violations).toEqual([]);
    });
    for (const screen of [...screens, ...narrowScreens]) {
      test(screen.name, async ({ page }) => {
        const width = screen.width;
        if (width) await page.setViewportSize({ width, height: 812 });
        await mockDashboard(page, {
          state: { activity: [skipped] },
          routes: {
            [`/api/tasks/${task.id}`]: {
              ...detail,
              task: { ...task, question: { text: question, choices: [] } },
            },
            [`/api/groups/${group.id}/messages`]: chat,
            "/api/members": [
              {
                github_id: "2",
                login: member,
                role: "member",
                added_by: "demo-admin",
                created_at: task.created_at,
              },
            ],
            "/api/checks": [{ ...check, last_summary: "範例服務正常" }],
          },
        });
        if (screen.signedOut) {
          await page.route("**/api/me", (route) =>
            route.fulfill({ status: 401, json: { error: "請先登入" } }),
          );
        }
        await page.goto(screen.path);
        if (screen.path === "/" && !screen.signedOut) {
          await expect(
            page.getByRole("list", { name: "待決策佇列" })
              .getByRole("button", { name: new RegExp(task.title) }),
          ).toBeVisible();
        } else {
          await expect(page.getByText(screen.loaded, { exact: true })).toBeVisible();
        }
        if (screen.signedOut) {
          await expect(
            page
              .getByText("chat2pr", { exact: true })
              .filter({ visible: true }),
          ).toBeVisible();
          await expect(page).toHaveTitle("chat2pr｜群組需求到 PR");
        }
        if (screen.path === "/" && !screen.signedOut) {
          await page.getByRole("tab", { name: "最近動態" }).click();
          const reason = page.getByText(skipped.detail, { exact: true });
          await expect(reason).toHaveCount(0);
          await page.getByRole("button", { name: "顯示系統紀錄" }).click();
          await expect(reason).toBeVisible();
          expect(
            await reason.evaluate(
              (element) => element.scrollHeight <= element.clientHeight,
            ),
          ).toBe(true);
        }
        if (screen.path === "/system?tab=disk")
          await expect(
            page.getByRole("heading", { name: "提醒與清理規則" }),
          ).toBeVisible();
        if (screen.path === "/system?tab=network")
          await expect(
            page.getByRole("spinbutton", { name: "最多保留幾個" }),
          ).toBeVisible();
        if (screen.path === "/system?tab=architecture")
          await expect(
            page
              .frameLocator('iframe[title^="系統架構動畫"]')
              .getByRole("button", { name: "開始播放" }),
          ).toBeVisible();
        expect(
          await page
            .locator("html")
            .evaluate((element) => element.classList.contains("dark")),
        ).toBe(theme === "dark");
        await page.evaluate(() => document.fonts.ready);
        if (screen.path === "/system?tab=architecture" && width) {
          for (const name of ["工作容器各階段的權限", "資料存放位置"]) {
            const section = page.getByRole("region", { name, exact: true });
            await expect(section).toBeVisible();
            expect(
              await section.evaluate((element) =>
                [element, ...element.querySelectorAll("*")].some(
                  (child) =>
                    child.clientWidth > 0 &&
                    child.scrollWidth > child.clientWidth,
                ),
              ),
              `${name}應完整顯示於手機寬度內`,
            ).toBe(false);
          }
        }
        if (screen.moreMenu) {
          await page
            .getByRole("button", { name: "更多", exact: true })
            .press("Enter");
          await expect(page.getByRole("menu", { name: "更多" })).toBeVisible();
        }
        await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
        const { violations } = await new AxeBuilder({ page }).analyze();
        const failures = violations
          .filter(
            (rule) => rule.impact === "serious" || rule.impact === "critical",
          )
          .map((rule) => ({
            rule: rule.id,
            impact: rule.impact,
            elements: rule.nodes.map((node) => ({
              selector: node.target,
              message: node.failureSummary,
            })),
          }));
        expect(failures).toEqual([]);
      });
    }
  });
}
