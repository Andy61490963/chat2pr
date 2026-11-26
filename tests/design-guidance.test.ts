import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseBaseline } from "../scripts/design-baseline";

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

it("每個仍有例外的來源檔案都能在盤點表找到原始行號", () => {
  const guide = readFileSync("docs/design-system.md", "utf8");
  const rows = new Map(
    Array.from(
      guide.matchAll(/^\| `(src\/[^|]+)` \| \d+ \| ([\d、]+) \| \d+ \|$/gm),
      ([, file, lines]) => [file, new Set(lines.split("、").map(Number))],
    ),
  );
  const baseline = parseBaseline(
    readFileSync("tests/design-tokens.baseline.tsv", "utf8"),
  );
  for (const { file, line } of baseline) {
    expect(rows.get(file)?.has(line), file + ":" + line).toBe(true);
  }
});
