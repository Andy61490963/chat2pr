import { expect, test } from "@playwright/test";

test("展示頁的深淺佈景使用各自的表面與文字色", async ({ page }) => {
  const backgrounds: string[] = [];
  const foregrounds: string[] = [];
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/e2e/design-system.html");
    await expect(page.getByRole("heading", { name: "範例工單" })).toBeVisible();
    const palette = await page.evaluate(() => {
      const sample = document.createElement("span");
      sample.style.color = "var(--foreground)";
      sample.style.backgroundColor = "var(--background)";
      document.body.append(sample);
      const expected = getComputedStyle(sample);
      const actual = getComputedStyle(document.body);
      const colors = {
        foreground: actual.color,
        background: actual.backgroundColor,
        expectedForeground: expected.color,
        expectedBackground: expected.backgroundColor,
      };
      sample.remove();
      return colors;
    });
    expect(palette.foreground).toBe(palette.expectedForeground);
    expect(palette.background).toBe(palette.expectedBackground);
    foregrounds.push(palette.foreground);
    backgrounds.push(palette.background);
  }
  expect(foregrounds[0]).not.toBe(foregrounds[1]);
  expect(backgrounds[0]).not.toBe(backgrounds[1]);
});

test("桌面分頁平均分配整欄寬度", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e/design-system.html");
  const list = page.getByRole("tablist", { name: "工單內容" });
  const widths = await list.evaluate((el) => {
    const { paddingLeft, paddingRight } = getComputedStyle(el);
    return {
      available:
        el.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight),
      tabs: [...el.querySelectorAll('[role="tab"]')].map(
        (tab) => tab.getBoundingClientRect().width,
      ),
    };
  });
  expect(widths.tabs).toHaveLength(2);
  for (const width of widths.tabs) {
    expect(Math.abs(width - widths.available / 2)).toBeLessThanOrEqual(1);
  }
});

test("手機勾選框維持緊密列高，外觀兩側的透明區域都能點選", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/e2e/design-system.html");
  const checkbox = page.getByRole("checkbox", { name: "需要複核" });
  await checkbox.scrollIntoViewIfNeeded();
  const target = await checkbox.evaluate((el) => {
    const mark = el.firstElementChild!.getBoundingClientRect();
    return {
      height: mark.height,
      width: mark.width,
      x: mark.x,
      y: mark.y,
      rowHeight: el.closest("label")!.getBoundingClientRect().height,
    };
  });
  expect(target.width).toBe(16);
  expect(target.height).toBe(16);
  expect(target.rowHeight).toBeLessThan(44);
  const center = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  for (const dx of [-21, 21]) {
    const x = center.x + dx;
    await expect(
      checkbox.evaluate(
        (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
        { x, y: center.y },
      ),
    ).resolves.toBe(true);
    await page.mouse.click(x, center.y);
    await expect(checkbox).toBeChecked({ checked: dx < 0 });
  }
});

test("無效欄位取得鍵盤焦點時用危險色標出外框", async ({ page }) => {
  await page.goto("/e2e/design-system.html");
  const input = page.getByRole("textbox", { name: "工單名稱" });
  await input.evaluate((el) => el.setAttribute("aria-invalid", "true"));
  await input.focus();
  const paint = await input.evaluate((el) => {
    const marker = document.createElement("span");
    marker.style.color = "var(--danger)";
    el.after(marker);
    const danger = getComputedStyle(marker).color;
    marker.remove();
    const { outlineColor, outlineStyle } = getComputedStyle(el);
    return { danger, outlineColor, outlineStyle };
  });
  expect(paint.outlineStyle).toBe("solid");
  expect(paint.outlineColor).toBe(paint.danger);
});

test("進度列依資料把剩餘四分之一平移出可視範圍", async ({ page }) => {
  await page.goto("/e2e/design-system.html");
  const track = page.getByRole("progressbar", { name: "檢查進度" });
  const geometry = await track.evaluate((el) => {
    const indicator = el.querySelector('[data-slot="progress-indicator"]')!;
    return {
      share:
        (indicator.getBoundingClientRect().right -
          el.getBoundingClientRect().left) /
        el.clientWidth,
      properties: [...(indicator as HTMLElement).style],
    };
  });
  expect(geometry.share).toBeCloseTo(0.75);
  expect(geometry.properties).toEqual(["--progress-offset"]);
});
