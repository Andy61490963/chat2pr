import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwind from "@tailwindcss/postcss";
import postcss, { type Rule } from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, it } from "vitest";
import { Progress } from "../src/components/ui/form-controls";

const forbidden = [
  "bg-red-500",
  "text-white",
  "border-blue-500",
  "text-3xl",
  "text-9xl",
  "rounded-lg",
  "rounded-xl",
  "rounded-2xl",
  "rounded-3xl",
  "rounded-4xl",
  "rounded-full",
  "shadow",
  "shadow-card",
  "shadow-2xl",
  "inset-shadow-sm",
  "drop-shadow-lg",
  "text-shadow-lg",
];
const valid = [
  "bg-background",
  "border-input",
  "text-danger",
  "text-sm",
  "text-xl",
  "rounded",
  "rounded-sm",
  "rounded-md",
  "shadow-raised",
  "shadow-none",
  "bg-transparent",
];
const dynamic = {
  "origin-floating": [
    "transform-origin",
    "var(--radix-popper-transform-origin)",
  ],
  "max-h-floating": ["max-height", "var(--radix-popper-available-height)"],
  "h-select-trigger": ["height", "var(--radix-select-trigger-height)"],
  "min-w-select-trigger": ["min-width", "var(--radix-select-trigger-width)"],
  "max-w-select-available": [
    "max-width",
    "var(--radix-select-content-available-width)",
  ],
  "w-disk-used": ["width", "var(--disk-used-width)"],
  "progress-offset": ["transform", "translateX(var(--progress-offset))"],
};
const rules = new Map<string, Rule>();

beforeAll(async () => {
  const path = resolve("src/styles.css");
  const candidates = [...forbidden, ...valid, ...Object.keys(dynamic)];
  // 與看板使用同一個編譯器和主題；只掃描這份候選清單，避免倚賴本機其他檔案。
  const css = readFileSync(path, "utf8").replace(
    '@import "tailwindcss";',
    '@import "tailwindcss" source(none);',
  );
  const result = await postcss([tailwind({ optimize: false })]).process(
    css + '\n@source inline("' + candidates.join(" ") + '");',
    { from: path },
  );
  result.root.walkRules((rule) => {
    for (const selector of rule.selectors) rules.set(selector, rule);
  });
});

it("編譯樣式時只開放看板的色盤、字級、圓角與浮層陰影", () => {
  expect(valid.filter((name) => !rules.has("." + name))).toEqual([]);
  expect(forbidden.filter((name) => rules.has("." + name))).toEqual([]);
});

it("浮層、磁碟與進度樣式使用對應的執行期量測值", () => {
  for (const [name, [property, value]] of Object.entries(dynamic)) {
    const rule = rules.get("." + name);
    const declarations = rule?.nodes.filter((node) => node.type === "decl");
    expect(
      declarations?.some(
        (declaration) =>
          declaration.prop === property && declaration.value === value,
      ),
      name,
    ).toBe(true);
  }
});

it("進度列只把未完成百分比交給樣式表", () => {
  for (const [value, offset] of [
    [0, "-100%"],
    [75, "-25%"],
    [100, "0%"],
  ] as const) {
    const html = renderToStaticMarkup(createElement(Progress, { value }));
    expect(html).toContain(`style="--progress-offset:${offset}"`);
  }
});
