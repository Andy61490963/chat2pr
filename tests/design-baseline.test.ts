import { describe, expect, it } from "vitest";
import * as baseline from "../scripts/design-baseline";
import { scanStyles } from "../scripts/design-tokens";

const file = "src/app/example.tsx";
const row = '<div className="rounded-lg rounded-lg" />';
const scan = (source: string) => scanStyles(file, source);
const generate = (source: string) => baseline.formatBaseline(scan(source));

describe("設計基準的合併順序", () => {
  it("修改既有違規同行時列出現行行號、原因與修正方式", () => {
    const edited = scan("\n" + row.replace("<div", "<div hidden"));
    expect(() => baseline.checkBaseline(baseline.formatBaseline(edited), generate(row), undefined, () => edited))
      .toThrow(/example\.tsx:2.*大圓角.*這一行被修改過，請順手換成 token/);
  });
  it("檔首插入一行後重新產生基準，既有基準及首次導入皆接受相同樣式", () => {
    const moved = generate("// 虛構頁面\n" + row);
    expect(moved).toBe(generate(row));
    expect(() => baseline.checkBaseline(moved, generate(row))).not.toThrow();
    expect(() =>
      baseline.checkBaseline(moved, null, () => scan(row)),
    ).not.toThrow();
  });

  it("相同行複製一份即使同步更新基準，既有基準及首次導入都會拒絕", () => {
    const duplicate = generate(row + "\n" + row);
    expect(() => baseline.checkBaseline(duplicate, generate(row))).toThrow(
      /只能刪除/,
    );
    expect(() =>
      baseline.checkBaseline(duplicate, null, () => scan(row)),
    ).toThrow(/基底版本/);
  });

  it("首次導入以本次測試的合併提交第一個父版本為準，主線前進後可重新盤點", () => {
    expect(baseline.comparisonBase("pull_request", undefined)).toBe("HEAD^1");
    const advanced = "// 主線新增說明\n" + row;
    expect(() =>
      baseline.checkBaseline(generate(row), null, () => scan(advanced)),
    ).not.toThrow();
  });

  it("批次推送比對推送前的主線，首次建立分支時從空基準開始", () => {
    expect(baseline.comparisonBase("push", "a".repeat(40))).toBe(
      "a".repeat(40),
    );
    expect(baseline.comparisonBase("push", "0".repeat(40))).toBeNull();
    expect(() => baseline.comparisonBase("push", "")).toThrow();
  });
});
