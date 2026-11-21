import { expect, test } from "@playwright/test";
import type { Task } from "../shared/types";
import { defaultState, detail, mockDashboard, task } from "./dashboard-fixture";

const investigation: Task = {
  ...task,
  id: "22222222-2222-4222-8222-222222222222",
  title: "查詢範例機台連線",
  status: "running",
};
const blocked: Task = {
  ...task,
  id: "33333333-3333-4333-8333-333333333333",
  title: "修正範例工單列印",
  mode: "change",
  status: "failed",
  last_error:
    "專案問題（執行測試階段）：列印欄位缺漏。\n建議：補上欄位後重試。",
};
const previous: Task = {
  ...blocked,
  id: "44444444-4444-4444-8444-444444444444",
  title: "整理範例班表",
  last_error: "執行中斷。",
};

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [1280, 375]) {
    test(`站別軌道在${colorScheme === "light" ? "淺色" : "深色"} ${width}px 可讀，並沿用到通知與詳情`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await mockDashboard(page, {
        state: {
          tasks: [task, investigation, blocked, previous],
          health: ["github", "line", "runner", "codex"].map((name) => ({
            name,
            ok: true,
          })),
          settings: { ...defaultState.settings, admin_line_id: "demo-line" },
          alerts: [
            {
              id: "demo-verification",
              task_id: blocked.id,
              kind: "failed",
              title: blocked.title,
              text: "範例任務未通過驗證。",
              created_at: blocked.updated_at,
            },
          ],
        },
        routes: {
          [`/api/tasks/${blocked.id}`]: { ...detail, task: blocked },
        },
      });
      await page.goto("/");
      const withinViewport = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        );
      const capture = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        await testInfo.attach(name, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      };

      await expect(
        page.getByRole("heading", { name: "需要你處理 3", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("img", { name: "站別軌道，目前在審核站" }),
      ).toBeVisible();
      expect(await withinViewport()).toBe(true);
      for (const name of [
        "需要你處理 3",
        "進行中 1",
        "待合併 0",
        "近 7 天已合併 0",
      ]) {
        await expect(
          page.getByRole("button", { name, exact: true }),
        ).toHaveCount(1);
        await expect(page.getByText(name, { exact: true })).toHaveCount(1);
      }
      await capture("收件匣");

      await page.goto("/tasks");
      const queryRow = page.getByRole("button", {
        name: new RegExp(investigation.title),
      });
      await expect(queryRow).toContainText("調查中");
      await expect(queryRow).toContainText("調查站");
      await expect(
        page.getByRole("img", { name: "站別軌道，無法判定站別" }),
      ).toBeVisible();
      expect(await withinViewport()).toBe(true);
      await capture("任務清單");

      const bell = page.getByRole("button", { name: /^通知(?:，|$)/ });
      await bell.focus();
      await page.keyboard.press("Enter");
      const notice = page.getByRole("menuitem", {
        name: new RegExp(blocked.title),
      });
      await expect(notice).toContainText("卡在驗證");
      await notice.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog", { name: blocked.title });
      const track = drawer.getByRole("img", {
        name: /^站別軌道，目前在驗證站/,
      });
      await expect(track).toBeVisible();
      await expect(track.getByText("驗證", { exact: true })).toBeVisible();
      const firstStation = track.getByText("整理需求", { exact: true });
      if (width === 375) await expect(firstStation).toBeHidden();
      else await expect(firstStation).toBeVisible();
      await expect(track).toHaveAccessibleName(
        /依序為整理需求、審核、排程、開發、驗證、PR/,
      );
      expect(await withinViewport()).toBe(true);
      await capture("任務詳情");
    });
  }
}
