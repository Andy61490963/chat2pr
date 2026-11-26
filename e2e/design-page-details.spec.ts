import { expect, test } from "@playwright/test";
import { mockDashboard, project } from "./dashboard-fixture";

test("通知選單內的額度提示只在底部分隔，圖示呈現警告色", async ({ page }) => {
  const text = "範例群組的通知額度已用完";
  await mockDashboard(page, {
    state: {
      alerts: [
        {
          id: "demo",
          task_id: null,
          kind: "line_quota",
          text,
          title: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    },
  });
  await page.goto("/groups");
  await page.getByRole("button", { name: /^通知/ }).click();
  const row = page
    .getByRole("menu")
    .getByRole("status")
    .filter({ hasText: text });
  await expect(row).toBeVisible();
  await expect(row).toHaveCSS("border-bottom-width", "1px");
  for (const side of ["top", "left", "right"]) {
    await expect(row).toHaveCSS(`border-${side}-width`, "0px");
  }
  const color = await row.evaluate((el) => getComputedStyle(el).color);
  await expect(row.locator("svg")).not.toHaveCSS("color", color);
});

test("專案範圍只縮小值的字級，待補資訊表單沿用一般文字色", async ({ page }) => {
  await mockDashboard(page, {
    state: {
      projects: [
        {
          ...project,
          setup_input: {
            id: "demo",
            configVersion: project.config_version,
            reason: "範例設備缺少站別",
            questions: [{ kind: "information", question: "請提供站別" }],
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
      ],
    },
  });
  await page.goto(`/projects?project=${project.id}&tab=overview`);
  const drawer = page.getByRole("dialog", { name: project.name });
  const label = drawer.locator("dt", { hasText: /^範圍$/ });
  await expect(label).toHaveCSS("font-size", "14px");
  await expect(label.locator("+ dd")).toHaveCSS("font-size", "13px");
  await page.goto(`/projects?project=${project.id}&tab=environment`);
  const form = drawer
    .getByRole("status")
    .filter({ hasText: "範例設備缺少站別" });
  const color = await page
    .locator("body")
    .evaluate((el) => getComputedStyle(el).color);
  await expect(form.getByRole("heading")).not.toHaveCSS("color", color);
  await expect(form.getByText("範例設備缺少站別")).toHaveCSS("color", color);
  await expect(form.getByRole("textbox", { name: "1. 請提供站別" })).toHaveCSS(
    "color",
    color,
  );
});
