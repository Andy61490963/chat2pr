import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";

function links(file: string) {
  const markdown = readFileSync(file, "utf8");
  return Array.from(markdown.matchAll(/\]\(([^)#]+)\)/g), ([, path]) =>
    resolve(dirname(file), path),
  );
}

it("根目錄與專案慣例能連到前端規範，再走到元件展示與截圖測試", () => {
  const rules = "src/AGENTS.md";
  const guide = "docs/design-system.md";
  for (const source of ["AGENTS.md", "docs/conventions.md"]) {
    expect(links(source)).toContain(resolve(rules));
  }
  expect(links(rules)).toContain(resolve(guide));
  for (const target of [
    "e2e/design-system-gallery.tsx",
    "e2e/design-system.spec.ts",
  ]) {
    expect(links(guide)).toContain(resolve(target));
    expect(existsSync(target)).toBe(true);
  }
});

it("歷史盤點列出各檔案和總數，並連到可查詢現況的基準", () => {
  const guide = readFileSync("docs/design-system.md", "utf8");
  const rows = new Map(
    Array.from(
      guide.matchAll(/^\| `((?:src|shared)\/[^|]+)` \| \d+ \| (\d+) \|$/gm),
      ([, file, count]) => [file, Number(count)],
    ),
  );
  expect(rows.size).toBeGreaterThan(0);
  const total = [...rows.values()].reduce((sum, count) => sum + count, 0);
  expect(guide).toContain(`本輪保留 ${total} 筆`);
  expect(links("docs/design-system.md")).toContain(resolve("tests/design-tokens.baseline.tsv"));
  expect(guide).not.toMatch(/\.tsx?:\d+|基底行號/);
});

it("前端規則明列手機可點擊尺寸、展示截圖位置與清單元件", () => {
  const rules = readFileSync("src/AGENTS.md", "utf8");
  expect(rules).toMatch(/375px[^。\n]*44\s*×\s*44px/);
  expect(rules).toContain("設計系統前後截圖");
  expect(rules).toContain("改版後");
  expect(readFileSync("docs/conventions.md", "utf8")).toMatch(
    /DataList.{0,20}ListRow/,
  );
});

it("遷移頁面的資料寬度經有名稱的變數傳遞，選單沿用可用寬度工具", () => {
  for (const [path, token] of [
    ["src/app/docker-disk.tsx", "--disk-used-width"],
    ["src/app/query-report.tsx", "--diagram-width"],
    ["src/app/tasks.tsx", "max-w-select-available"],
  ]) {
    expect(readFileSync(path, "utf8"), path).toContain(token);
  }
});
