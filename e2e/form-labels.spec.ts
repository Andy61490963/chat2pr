import { expect, test } from "@playwright/test";
import { mockDashboard } from "./dashboard-fixture";

test("訂閱與 API 模式的下拉選單都能依畫面上的欄位名稱辨識", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.goto("/settings");
  for (const name of ["模型", "需求判讀思考程度", "開發與審查思考程度"]) {
    await expect(
      page.getByRole("combobox", { name, exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("radio", { name: /ChatGPT 訂閱/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: /OpenAI API/ })).toBeChecked();
  for (const name of ["需求辨識模型", "程式開發模型"]) {
    await expect(
      page.getByRole("combobox", { name, exact: true }),
    ).toBeVisible();
  }
});

test("新增專案可依 GitHub 儲存庫標籤找到並操作選單", async ({ page }) => {
  await mockDashboard(page, {
    routes: {
      "/api/repositories": [
        { full_name: "example/demo", default_branch: "main" },
      ],
    },
  });
  await page.goto("/projects");
  await page.getByRole("button", { name: "新增專案" }).click();
  const repo = page
    .getByRole("dialog")
    .getByRole("combobox", { name: "GitHub 儲存庫", exact: true });
  await expect(repo).toBeEnabled();
  await repo.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: /demo/ })).toBeVisible();
});

test("磁碟清理規則的開關與數值各有可辨識的名稱", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/system");
  const rule = "已結束任務的工作區資料卷";
  await expect(
    page.getByRole("switch", { name: rule, exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("spinbutton", { name: rule + "保留天數" }),
  ).toHaveValue("3");
  await expect(
    page.getByRole("spinbutton", { name: "超過上限的建置快取容量上限（GB）" }),
  ).toHaveValue("20");
});
