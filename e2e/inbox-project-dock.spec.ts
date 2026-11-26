import { expect, test } from "@playwright/test";
import { assignmentWorkbenchFixture, mockDashboard } from "./dashboard-fixture";

test.use({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });

test("手機選取專案後，唯一的指定按鈕留在底部，捲動後仍能送出所選專案與需求版本", async ({ page }) => {
  const { state, details, tasks: [task], frontend, backend } = assignmentWorkbenchFixture("query");
  const endpoint = `/api/tasks/${task.id}`;
  await mockDashboard(page, { state: { ...state }, routes: { [endpoint]: details.get(task.id) } });
  const requests: unknown[] = [];
  const conflict = "群組綁定已更新，請重新選擇專案。";
  await page.route(`**${endpoint}/actions`, (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: conflict } });
  });
  await page.goto(`/?review=${task.id}`);
  const dialog = page.getByRole("dialog", { name: task.title });
  const section = dialog.getByRole("region", { name: "處理專案" });
  const submit = dialog.getByRole("button", { name: "指定專案", exact: true });
  await expect(submit).toHaveCount(1);
  await expect(submit).toBeDisabled();
  await section.getByRole("checkbox", { name: frontend.name, exact: true }).check();
  await section.getByRole("checkbox", { name: backend.name, exact: true }).check();
  await expect(submit).toBeEnabled();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
  const before = (await submit.boundingBox())!;
  const sectionTop = (await section.boundingBox())!.y;
  await page.mouse.move(160, 390);
  await page.mouse.wheel(0, 500);
  await expect.poll(async () => (await section.boundingBox())!.y).toBeLessThan(sectionTop - 80);
  await expect(submit).toBeInViewport({ ratio: 1 });
  const after = (await submit.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect(after.y).toBeGreaterThan(812 * 0.65);
  expect(after.height).toBeGreaterThanOrEqual(44);
  expect(await submit.evaluate((button) => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  })).toBe(true);

  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText(conflict);
  expect(requests).toEqual([{
    action: "assign",
    version: task.version,
    project_id: frontend.id,
    related_project_ids: [backend.id],
  }]);
  await expect(section.getByRole("checkbox", { name: backend.name, exact: true })).toBeChecked();
});
