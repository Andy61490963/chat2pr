import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  discordGroup,
  group,
  mockDashboard,
  project,
} from "./dashboard-fixture";

for (const colorScheme of ["light", "dark"] as const) {
  const theme = colorScheme === "light" ? "淺色" : "深色";
  test(`手機可在送出前辨識資料庫與 SSH 憑證的接收對象（${theme}）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await mockDashboard(page, {
      state: {
        projects: [{ ...project, name: "示範專案", full_access: true }],
      },
    });
    await page.goto(`/projects?project=${project.id}`);
    const dialog = page.getByRole("dialog", { name: "示範專案" });
    const accessTab = dialog.getByRole("tab", { name: "連線與權限" });
    await accessTab.press("Enter");
    const access = dialog.getByRole("region", { name: "完全存取" });
    await expect(access.getByText("已開啟", { exact: true })).toBeVisible();
    await expect(access).toContainText("安裝、開發、測試與審查");
    await expect(access).toContainText("直連資料庫與 SSH 主機");
    await expect(access).toContainText(
      "環境驗證的安裝：可連網，工作容器未取得登記的憑證",
    );
    await expect(access).toContainText(
      "經 SSH 跳板的資料庫連線仍由本服務的主機使用",
    );

    const database = dialog.getByRole("region", { name: "資料庫連線" });
    const ssh = dialog.getByRole("region", { name: "SSH 主機" });
    for (const [section, label, description] of [
      [database, "用白話描述連線", "示範資料庫位於 db.example.test"],
      [ssh, "用白話描述主機", "示範主機位於 ssh.example.test"],
    ] as const) {
      const manual = section.getByRole("region", { name: "手動登記" });
      await expect(
        manual.getByText(/密碼與私鑰只寫入、加密保存/),
      ).toBeVisible();
      await expect(manual).toContainText("儲存時不會送給 AI 模型");

      const ai = section.getByRole("region", { name: "交給 AI 整理" });
      const input = ai.getByRole("textbox", { name: label });
      await expect(input).toHaveAccessibleDescription(
        /貼上的內容（含帳密）會送給 AI 模型整理。看板不保存原文。/,
      );
      await expect(ai.getByText(/在下方欄位手動填寫/)).toBeVisible();
      const submit = ai.getByRole("button", { name: "交給 AI 整理" });
      await expect(submit).toBeDisabled();
      await input.fill(description);
      await expect(submit).toBeEnabled();
      await expect(ai.getByText("送出後，AI 模型會收到原文。")).toBeVisible();
      await expect(submit).toHaveAccessibleDescription(
        "送出後，AI 模型會收到原文。",
      );
      expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await expect(
      database
        .getByRole("region", { name: "手動登記" })
        .getByLabel("密碼", { exact: true }),
    ).toBeVisible();
    const addHost = ssh.getByRole("button", { name: "新增 SSH 主機" });
    await expect(addHost).toBeEnabled();
    await addHost.press("Enter");
    await expect(ssh.getByLabel("名稱", { exact: true })).toBeFocused();
    await expect(ssh.getByLabel("登入密碼")).toBeVisible();
    const panel = dialog.getByRole("tabpanel", { name: "連線與權限" });
    const fits = await panel.evaluate(
      (element) =>
        element.parentElement!.scrollWidth <=
        element.parentElement!.clientWidth,
    );
    expect(fits).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(375);
    await page.evaluate(() => document.fonts.ready);
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(violations).toEqual([]);
  });
}

for (const width of [375, 1280]) {
  test(`登入頁說明群組來源與交付方式（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await mockDashboard(page);
    await page.route("**/api/me", (route) =>
      route.fulfill({ status: 401, json: { error: "請先登入" } }),
    );
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "登入控制台" }),
    ).toBeVisible();
    await expect(
      page.getByText("一鍵決定是否上線", { exact: false }),
    ).toHaveCount(0);
    await expect(
      page
        .getByText("到 GitHub 審閱並合併 PR。部署依你們的流程。")
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "在 LINE 群組或 Discord 頻道提需求，AI 整理成任務並交給 Codex 開發。",
      ),
    ).toBeVisible();
  });
}

test("手機聊天室切換群組後會提示對應平台的回覆位置", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page, { state: { groups: [group, discordGroup] } });
  await page.goto("/chat");
  const subtitle = page.getByRole("status").filter({ hasText: "僅供閱讀" });
  await expect(subtitle).toContainText("回覆請用 LINE");

  const selector = page.getByRole("combobox", { name: "選擇聊天室" });
  await selector.press("Enter");
  await page.getByRole("option", { name: discordGroup.name }).click();
  await expect(subtitle).toContainText("回覆請到 Discord 頻道");
  await expect(subtitle).not.toContainText("回覆請用 LINE");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
});

test("沒有聊天室時仍會提示回原本的群組或頻道回覆", async ({ page }) => {
  await mockDashboard(page, { state: { groups: [] } });
  await page.goto("/chat");
  await expect(page.getByText("還沒有聊天室")).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "僅供閱讀" }),
  ).toContainText("回覆請回到原本的群組或頻道");
});
