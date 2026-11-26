import { readFileSync } from "node:fs";
import postcss, { type Container } from "postcss";
import { describe, expect, it } from "vitest";
import { cn } from "../src/lib/utils";

const sheet = postcss.parse(readFileSync("src/styles.css", "utf8"));
const theme = new Map<string, string>();
sheet.walkAtRules("theme", (rule) => {
  rule.walkDecls((declaration) => {
    theme.set(declaration.prop, declaration.value);
  });
});

function pixels(property: string) {
  const value = theme.get(property) ?? "";
  const match = /^(\d*\.?\d+)(rem|px)?$/.exec(value);
  if (!match) throw new Error(`無法量出 ${property} 的長度：${value}`);
  return Number(match[1]) * (match[2] === "rem" ? 16 : 1);
}

function declarations(rule: Container) {
  const result = new Map<string, string>();
  rule.walkDecls((declaration) => {
    result.set(declaration.prop, declaration.value);
  });
  return result;
}

describe("看板的設計代幣", () => {
  it("手機的開關與選項各自保留四十四像素的觸控範圍", () => {
    for (const slot of ["switch", "select-item"]) {
      const sizes = new Map<string, string>();
      sheet.walkAtRules("media", (media) => {
        if (!media.params.includes("max-width")) return;
        media.walkRules((rule) => {
          if (!rule.selectors.includes(`[data-slot="${slot}"]`)) return;
          for (const [name, value] of declarations(rule))
            sizes.set(name, value);
        });
      });
      for (const axis of ["min-height", "min-width"]) {
        const units = /^--spacing\((\d+)\)$/.exec(sizes.get(axis) ?? "");
        expect(
          Number(units?.[1] ?? 0) * pixels("--spacing"),
          slot,
        ).toBeGreaterThanOrEqual(44);
      }
    }
  });

  it("元件與頁面的類別合併時，保留字級與字色並讓頁面覆寫同類尺寸", () => {
    expect(cn("text-caption", "text-muted-foreground")).toBe(
      "text-caption text-muted-foreground",
    );
    expect(cn("max-w-overlay", "max-w-media-dialog")).toBe(
      "max-w-media-dialog",
    );
    expect(cn("w-media-dialog", "w-full")).toBe("w-full");
    expect(cn("md:grid-cols-project", "md:grid-cols-group")).toBe(
      "md:grid-cols-group",
    );
  });

  it("內文為十四像素，輔助文字可讀，頁首上限二十像素", () => {
    expect(pixels("--text-sm")).toBe(14);
    expect(pixels("--text-xs")).toBeGreaterThanOrEqual(12);
    expect(pixels("--text-xs")).toBeLessThanOrEqual(13);
    expect(pixels("--text-lg")).toBeGreaterThan(pixels("--text-sm"));
    expect(pixels("--text-xl")).toBe(20);
    expect(pixels("--text-2xl")).toBeLessThanOrEqual(20);
    const headingSizes: string[] = [];
    sheet.walkAtRules("utility", (rule) => {
      if (rule.params === "heading-page")
        rule.walkDecls("font-size", (declaration) => {
          headingSizes.push(declaration.value);
        });
    });
    expect(headingSizes).toEqual(["var(--text-xl)"]);
  });

  it("間距以四像素遞增，圓角限定為零、二、四、六像素", () => {
    expect(pixels("--spacing")).toBe(4);
    const corners = ["none", "xs", "sm", "md"].map((size) =>
      pixels(`--radius-${size}`),
    );
    expect(corners).toEqual([0, 2, 4, 6]);
  });

  it("深淺色都有可辨識的狀態與浮層；平面清單不投影", () => {
    const palettes = new Map<string, Map<string, string>>();
    sheet.walkRules((rule) => {
      if (rule.selector === ":root" || rule.selector === ".dark")
        palettes.set(rule.selector, declarations(rule));
    });
    expect(palettes.size).toBe(2);
    for (const palette of palettes.values()) {
      for (const tone of ["good", "warn", "danger"]) {
        expect(palette.get(`--${tone}`)).toBeTruthy();
        expect(palette.get(`--${tone}-soft`)).toBeTruthy();
      }
      expect(palette.get("--background")).not.toBe(palette.get("--popover"));
      expect(palette.get("--shadow-raised-value")).toBeTruthy();
    }
    expect(theme.get("--shadow-card")).toBe("none");
  });
});
