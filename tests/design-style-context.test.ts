import { describe, expect, it } from "vitest";
import { formatInventory, scanStyles } from "../scripts/design-tokens";

const page = "src/app/example.tsx";
const values = (source: string, file = page) =>
  scanStyles(file, source).map((e) => e.value);
const css = (source: string) => values(source, "src/app/example.css");
const classes = (value: string) => values('<div className="' + value + '" />');

describe("依樣式的語法位置檢查設計代幣", () => {
  it.each([
    "valueClassName",
    "footerClassName",
    "indicatorClassName",
    "itemClasses",
    "rowClass",
  ])("辨認 JSX 與物件的 %s 樣式屬性", (name) => {
    expect(
      values(
        `const x = <Demo ${name}="text-[19px]" />; const props = { ${name}: "p-[13px]" };`,
      ),
    ).toEqual(["text-[19px]", "p-[13px]"]);
  });
  it.each([
    "function tone(){ const help = 'm-[7px]'; return 'p-[13px]' }",
    "const tone = () => { const help = 'm-[7px]'; return 'p-[13px]' }",
    "const tone = () => 'p-[13px]'",
  ])("只追蹤同檔函式的類別回傳值（%#）", (fn) => {
    expect(values(fn + "; const row = <div className={tone()} />;")).toEqual([
      "p-[13px]",
    ]);
  });
  it("共用匯出物件會檢查樣式對照值，保留工單、連結與敘述文字", () => {
    expect(
      values(
        'export const tones = { warn: "p-[13px] rounded-3xl", help: "請勿使用 rounded-lg", issue: "#284", href: "#add" } as const;',
        "shared/example.ts",
      ),
    ).toEqual(["p-[13px]", "rounded-3xl"]);
  });
  it("共用對照表可混用無連字號工具與任意值", () => {
    expect(
      values(
        'export const tones = { compact: "grow p-[13px]" };',
        "shared/example.ts",
      ),
    ).toEqual(["p-[13px]"]);
  });
  it("辨認 DOM 方括號樣式指定", () => {
    expect(values('el.style["color"]="red";')).toEqual(["red"]);
  });
  it("辨認以 Object.assign 寫入 DOM 樣式的物件", () => {
    expect(values('Object.assign(el.style,{fontSize:"40px"});')).toEqual([
      "40px",
    ]);
  });
  it("盤點保留當前行欄以便定位，與供審查的穩定基準分開輸出", () => {
    const rows = scanStyles(page, '\n<div className="text-red-500" />');
    expect(formatInventory(rows)).toContain("src/app/example.tsx:2:17\t");
  });
  it("設計屬性也攔截視窗、實體、容器單位，字級關鍵字及捲軸色", () => {
    expect(
      css(
        ".panel { padding: 3vh; border-radius: 9pt; margin-block: 2cqi; font-size: xx-large; scrollbar-color: red transparent; }",
      ),
    ).toEqual(["3vh", "9pt", "2cqi", "xx-large", "red"]);
    expect(
      css(
        ".panel { margin: 0; padding: 0px; border-radius: inherit; font-size: var(--text-sm); gap: --spacing(4); width: 50%; }",
      ),
    ).toEqual([]);
  });
  it("同檔案的同名區域變數各用自己的類別，不會把另一個函式的工單文字當成樣式", () => {
    const source =
      'function description() {const label = "rounded-lg"; return label;} function row() {const label = "rounded-md"; return <div className={label} />}';
    expect(values(source)).toEqual([]);
  });
  it("樣式物件使用備援值時，實際提供樣式的兩種寫法都要檢查", () => {
    const source =
      'const active = { margin: "1rem" }; const page = <div style={active ?? { padding: 8 }} />;';
    expect(values(source)).toEqual(["1rem", "8"]);
  });
  it("擋下預設色盤與超過二十像素的字級，也辨認變體和透明度", () => {
    expect(
      classes(
        "bg-red-500 hover:text-white dark:border-t-slate-300/50 text-5xl sm:text-3xl text-xl text-2xl",
      ),
    ).toEqual([
      "bg-red-500",
      "text-white",
      "border-t-slate-300/50",
      "text-5xl",
      "text-3xl",
    ]);
  });
  it("陰影只使用浮層代幣或明確取消陰影", () => {
    expect(
      classes(
        "shadow shadow-2xl hover:shadow-lg drop-shadow-md shadow-raised shadow-none",
      ),
    ).toEqual(["shadow", "shadow-2xl", "shadow-lg", "drop-shadow-md"]);
    expect(css(".panel { box-shadow: 0 1px 3px black; }")).not.toEqual([]);
  });
  it("拒絕括號任意變數，保留 Radix 狀態和後代選擇器", () => {
    expect(
      classes("data-[state=open]:p-(--gap) [&>svg]:w-(--w) rounded-md"),
    ).toEqual(["p-(--gap)", "w-(--w)"]);
  });
  it("在行內物件辨認 rem、em、具名顏色、各方向的圓角與字級", () => {
    expect(
      values(
        '<div style={{ padding: "1rem", marginTop: ".5em", color: "rebeccapurple", borderTopLeftRadius: 4, fontSize: "medium" }} />',
      ),
    ).toEqual(["1rem", ".5em", "rebeccapurple", "4", "medium"]);
  });
  it("資料計算的行內尺寸只容許已按檔案登記且確實取自資料的 CSS 變數", () => {
    const diagram = "src/app/query-report.tsx";
    const approved = '<img style={{ "--diagram-width": size + "px" }} />';
    expect(values("<img style={{ width: size * zoom }} />", diagram)).toEqual([
      "width",
    ]);
    expect(
      values('<img style={{ "--uncatalogued": size }} />', diagram),
    ).toEqual(["--uncatalogued"]);
    expect(values(approved, diagram)).toEqual([]);
    expect(values(approved)).toEqual(["--diagram-width"]);
    expect(
      values('<img style={{ "--diagram-width": "13px" }} />', diagram),
    ).not.toEqual([]);
  });
  it("攔截原始 CSS 的 HSL、OKLCH、具名顏色與 font 簡寫，限中央主題宣告可使用原始值", () => {
    const sheet =
      ".panel { color: hsl(20 30% 40%); background: oklch(40% .02 55); border: thin solid tomato; font: 600 1rem sans-serif; }";
    expect(css(sheet)).toEqual([
      "hsl(20 30% 40%)",
      "oklch(40% .02 55)",
      "tomato",
      "font",
    ]);
    const vars =
      ":root { --tone: hsl(0 20% 10%); } @theme inline { --color-paper: ivory; }";
    expect(values(vars, "src/styles.css")).toEqual([]);
    expect(css(vars)).toEqual(["hsl(0 20% 10%)", "ivory"]);
  });
  it("共用內容只在 className 等樣式位置檢查，包括引用區域變數與類別陣列", () => {
    expect(
      values(
        'const label = "bg-red-500"; const selected = "bg-blue-500"; const node = { hProperties: { className: ["text-white", selected] } };',
        "shared/example.ts",
      ),
    ).toEqual(["bg-blue-500", "text-white"]);
  });
  it("媒體查詢、觀察範圍、網址錨點、工單編號與說明文字不是樣式", () => {
    expect(
      values(
        'const media = matchMedia("(max-width: 767px)"); new IntersectionObserver(handler, {rootMargin: "16px 0px"}); const id = "#284"; const help = "rounded-lg"; const link = <a href="#add" title="16px">工單</a>;',
      ),
    ).toEqual([]);
  });
  it("拒絕 JSX 字型與陰影簡寫，以及濾鏡內的陰影和具名顏色", () => {
    expect(
      values('<div style={{ font: "caption", boxShadow: "0 0 1px" }} />'),
    ).toEqual(["font", "boxShadow", "1px"]);
    expect(css(".panel { filter: drop-shadow(0 0 1px red); }")).toEqual([
      "drop-shadow(",
      "red",
    ]);
  });
  it("CSS 的圖片網址、SVG 片段與具名變數都不會誤判為原始色碼", () => {
    expect(
      css(
        '.panel { background: url("/img/tomato.png#abc"); fill: url(#add); color: var(--red); }',
      ),
    ).toEqual([]);
  });
  it("登記的樣式變數也不能放入固定常數，無法辨識的行內樣式來源會要求改寫", () => {
    expect(
      values(
        'const fixed = 14; const page = <img style={{ "--diagram-width": fixed }} />;',
        "src/app/query-report.tsx",
      ),
    ).toEqual(["--diagram-width"]);
    expect(
      values("const page = <div style={{ ...props.style }} />"),
    ).not.toEqual([]);
  });
});
