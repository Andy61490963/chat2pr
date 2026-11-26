import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baselineDifference,
  inventory,
  scanStyles,
} from "../scripts/design-tokens";
import { checkBaseline, formatBaseline } from "../scripts/design-baseline";

const page = "src/app/example.tsx";
const tokens = (source: string, file = page) =>
  scanStyles(file, source).map((entry) => entry.value);

describe("看板設計規範", () => {
  it("指出任意尺寸、字級、色碼、漸層、霧化及各方向的大圓角", () => {
    expect(
      tokens(
        '<section className="lg:hover:p-[13px] text-[19px] grid-cols-[1fr_auto] bg-[#abc] rounded-tr-2xl rounded-full bg-gradient-to-r bg-linear-to-r backdrop-blur-sm" />',
      ),
    ).toEqual([
      "p-[13px]",
      "text-[19px]",
      "grid-cols-[1fr_auto]",
      "bg-[#abc]",
      "rounded-tr-2xl",
      "rounded-full",
      "bg-gradient-to-r",
      "bg-linear-to-r",
      "backdrop-blur-sm",
    ]);
  });

  it("指出條件類別、模板及任意 CSS 屬性，保留狀態與子元素選擇器", () => {
    expect(
      tokens(
        'const classes = cn("data-[state=open]:bg-card [&>svg]:size-4", active && `md:hover:rounded-lg ${layout} [padding:7px]`);',
      ),
    ).toEqual(["rounded-lg", "[padding:7px]"]);
  });

  it("指出樣式物件、DOM 樣式與 SVG 字串的固定像素，保留無單位值", () => {
    expect(
      tokens(
        'const page = <div style={{ padding: 13, opacity: 0.5, width: `${percent}%`, marginTop: "2px", color: "#123456" }} />;\nhost.style.cssText = "left:-900px;color:rgb(1 2 3)";\nsvg({ style: "font:500 12px var(--font)" });',
      ),
    ).toEqual([
      "13",
      "width",
      "2px",
      "#123456",
      "-900px",
      "rgb(1 2 3)",
      "font",
    ]);
  });

  it("只允許中央主題宣告使用原始值，其他 CSS 與套用的工具類別也要檢查", () => {
    const css =
      ":root { --paper: #abc; }\n.dark { --paper: rgb(0 0 0); }\n@theme inline { --spacing: 4px; }\n.panel { color: #fff; gap: 1.2rem; border-radius: 11px; @apply md:rounded-xl; --own: #abc; }";
    expect(tokens(css, "src/styles.css")).toEqual([
      "#fff",
      "1.2rem",
      "11px",
      "rounded-xl",
      "#abc",
    ]);
    expect(tokens(":root { --paper: #abc; }", "src/app/example.css")).toEqual([
      "#abc",
    ]);
  });

  it("保留註解、工單編號與語意 tokens", () => {
    expect(
      tokens(
        '// 曾改用 rounded-lg\nconst label = "任務 #128";\nconst input = <div className="data-[state=open]:bg-card [&_svg]:size-4 rounded-md p-2" style={{ color: "var(--foreground)" }} />;',
      ),
    ).toEqual([]);
  });

  it("指出以模板或字串組合的任意類別與樣式像素", () => {
    const content =
      'const page = <div className={`md:p-[${size}px]`} style={{ marginTop: `${size}px`, left: width + "px" }} />;';
    expect(tokens(content)).toEqual(["p-[", "marginTop", "left"]);
  });

  it("既有違規前方增加程式仍可辨識，複製、移到其他檔案或換值均會失敗", () => {
    const content = 'const row = <div className="rounded-lg" />;';
    const base = scanStyles(page, content);
    expect(baselineDifference(scanStyles(page, "\n" + content), base)).toEqual({
      added: [],
      removed: [],
    });
    expect(
      baselineDifference(scanStyles(page, content + "\n" + content), base)
        .added,
    ).toHaveLength(1);
    expect(
      baselineDifference(scanStyles("src/app/other.tsx", content), base).added,
    ).toHaveLength(1);
    expect(
      baselineDifference(scanStyles(page, content.replace("lg", "xl")), base)
        .added,
    ).toHaveLength(1);
    expect(baselineDifference(scanStyles(page, ""), base).removed).toEqual(
      base,
    );
  });

  it("全站逐筆對照基準，新增與已清除但仍保留的例外都應為零", () => {
    const base = readFileSync("tests/design-tokens.baseline.tsv", "utf8");
    const { added, removed } = inventory(base);
    expect(added, "新增的樣式請改用設計 tokens").toEqual([]);
    expect(removed, "已清除的樣式請同步刪除其基準列").toEqual([]);
  });

  it("即使同步改動原始碼與基準，分支也只能刪除基準列", () => {
    const before = scanStyles(
      page,
      'const row = <div className="rounded-lg" />;',
    );
    const after = scanStyles(
      page,
      'const row = <div className="rounded-xl" />;',
    );
    const base = formatBaseline(before);
    expect(() => checkBaseline(formatBaseline([]), base)).not.toThrow();
    expect(() => checkBaseline(formatBaseline(after), base)).toThrow(
      /只能刪除/,
    );
    expect(() =>
      checkBaseline(formatBaseline([...before, ...before]), base),
    ).toThrow(/只能刪除/);
  });

  it("首次建立的基準只能列入基底版本實際存在的原始位置與樣式", () => {
    const original = 'const row = <div className="rounded-lg" />;';
    const readBase = () => scanStyles(page, original);
    expect(() =>
      checkBaseline(formatBaseline(scanStyles(page, original)), null, readBase),
    ).not.toThrow();
    expect(() =>
      checkBaseline(
        formatBaseline(scanStyles(page, original.replace("lg", "xl"))),
        null,
        readBase,
      ),
    ).toThrow(/基底版本/);
  });
});
