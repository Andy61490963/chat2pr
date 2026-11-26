import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  answeredDetail,
  blockedCheck,
  discordGroup,
  exampleMember,
  group,
  groupMemory,
  mockDashboard,
  project,
  task,
} from "./dashboard-fixture";

const report = "設備範例已完成檢查。";
const screens = [
  { name: "群組", path: "/groups", content: group.name },
  {
    name: "記憶總覽",
    path: "/groups",
    content: groupMemory.content,
    center: true,
  },
  { name: "專案", path: "/projects", content: project.name },
  { name: "成員", path: "/members", content: exampleMember.login },
  { name: "定期檢查", path: "/checks", content: blockedCheck.name },
  {
    name: "聊天室",
    path: `/chat?group=${encodeURIComponent(discordGroup.id)}`,
    content: "請確認示範服務是否正常。",
  },
  { name: "任務", path: "/tasks", content: task.title },
  { name: "同時執行", path: "/system", content: "同時執行" },
  { name: "網路", path: "/system?tab=network", content: /^使用預設清單，共/ },
  {
    name: "磁碟",
    path: "/system?tab=disk",
    content: /^最後盤點 /,
    center: true,
  },
  { name: "查詢報告", path: `/tasks?task=${task.id}`, content: report },
];

for (const width of [375, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`遷移頁面可讀、寬度符合視窗（${width}px，${theme === "light" ? "淺色" : "深色"}）`, async ({
      page,
    }, info) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const answer = { ...answeredDetail.task, answer: report };
      await mockDashboard(page, {
        state: { groups: [group, discordGroup], memories: [groupMemory] },
        routes: {
          "/api/members": [exampleMember],
          "/api/checks": [blockedCheck],
          [`/api/tasks/${task.id}`]: { ...answeredDetail, task: answer },
        },
      });
      for (const screen of screens) {
        await test.step(screen.name, async () => {
          await page.goto(screen.path);
          const content = page
            .getByText(screen.content, { exact: true })
            .first();
          await expect(content).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          if (screen.center) {
            await content.evaluate((el) =>
              el.scrollIntoView({ block: "center" }),
            );
          } else {
            await content.scrollIntoViewIfNeeded();
          }
          await expect(content).toBeInViewport();
          expect(
            await page.locator("html").evaluate((el) => el.scrollWidth),
          ).toBeLessThanOrEqual(width);
          const filename = `${screen.name}-${width}-${theme}.png`;
          const dir = process.env.DESIGN_SHOTS_DIR;
          if (dir) await mkdir(dir, { recursive: true });
          const body = await page.screenshot({
            animations: "disabled",
            path: dir && join(dir, filename),
          });
          await info.attach(filename, { body, contentType: "image/png" });
        });
      }
    });
  }
}
