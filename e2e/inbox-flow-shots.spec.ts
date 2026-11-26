import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { mockInboxFlow } from "./dashboard-fixture";

const folder = process.env.INBOX_SHOTS_DIR;
const stage = process.env.INBOX_SHOTS_STAGE;
test.skip(!folder || !stage, "指定截圖目錄與改版階段才擷取比較圖");

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`${viewport.width} 像素${theme === "dark" ? "深色" : "淺色"}`, () => {
      test.use({ viewport, colorScheme: theme, reducedMotion: "reduce" });
      for (const scene of ["多筆待決策", "長原文", "空佇列", "載入中", "錯誤"]) {
        test(scene, async ({ page }) => {
          await page.addInitScript(value => localStorage.setItem("agentflow-theme", value), theme);
          const { tasks } = await mockInboxFlow(page, scene === "空佇列");
          const first = tasks[0];
          if (scene === "載入中" || scene === "錯誤") {
            await page.route(`**/api/tasks/${first.id}`, route => scene === "載入中"
              ? undefined : route.fulfill({ status: 503, json: { error: "示範服務暫時無法回應" } }));
          }
          const selected = !["空佇列", "多筆待決策"].includes(scene);
          await page.goto(selected ? `/?review=${first.id}` : "/");
          const marker = scene === "錯誤" ? /示範服務暫時無法回應/
            : scene === "載入中" ? /載入審核內容/ : scene === "長原文" ? /第 1 項/
            : scene === "空佇列" ? /都處理完了/ : first.title;
          await expect(page.getByText(marker).filter({ visible: true }).first()).toBeVisible();
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
          });
          await mkdir(folder!, { recursive: true });
          await page.screenshot({ path: join(folder!, `${stage}-${viewport.width}x${viewport.height}-${theme}-${scene}.png`), animations: "disabled" });
        });
      }
    });
  }
}
