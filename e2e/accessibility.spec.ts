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
}[] = [
  { name: "收件匣", path: "/", loaded: task.title },
  { name: "手機收件匣", path: "/", loaded: skipped.detail, width: 375 },
  { name: "任務清單", path: "/tasks", loaded: task.title },
  { name: "任務詳情", path: `/tasks?task=${task.id}`, loaded: question },
  { name: "聊天室", path: "/chat", loaded: message },
  { name: "群組", path: "/groups", loaded: group.name },
  { name: "專案", path: "/projects", loaded: project.name },
  { name: "成員", path: "/members", loaded: member },
  { name: "定期檢查", path: "/checks", loaded: check.name },
  { name: "系統", path: "/system", loaded: /^最後盤點 / },
  { name: "設定", path: "/settings", loaded: /^方案 demo/ },
  { name: "登入", path: "/", loaded: "使用 GitHub 登入" },
];
const narrowScreens = screens
  .filter(({ path }) =>
    ["/groups", "/projects", "/system", "/settings"].includes(path),
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
  await page.getByRole("tab", { name: /^全部/ }).focus();
  await page.keyboard.press("ArrowRight");
  const list = page.getByRole("tabpanel", { name: /^待處理/ });
  await expect(list.getByText(task.title)).toBeVisible();
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute(
    "aria-controls",
    (await list.getAttribute("id"))!,
  );
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
  await page.goto("/settings");
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
        if (screen.name === "登入") {
          await page.route("**/api/me", (route) =>
            route.fulfill({ status: 401, json: { error: "請先登入" } }),
          );
        }
        await page.goto(screen.path);
        await expect(
          page.getByText(screen.loaded, { exact: true }),
        ).toBeVisible();
        if (screen.path === "/" && screen.name !== "登入") {
          const reason = page.getByText(skipped.detail, { exact: true });
          await expect(reason).toBeVisible();
          expect(
            await reason.evaluate(
              (element) => element.scrollHeight <= element.clientHeight,
            ),
          ).toBe(true);
        }
        if (screen.path === "/system") {
          await expect(page.getByText("每件任務要切到看板")).toBeVisible();
        }
        expect(
          await page
            .locator("html")
            .evaluate((element) => element.classList.contains("dark")),
        ).toBe(theme === "dark");
        await page.evaluate(() => document.fonts.ready);
        if (screen.path === "/system" && width) {
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
