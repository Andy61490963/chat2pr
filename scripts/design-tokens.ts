import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postcss from "postcss";
import ts from "typescript";
import { inspectScript } from "./design-style-context";

import {
  baselineDifference,
  fingerprint,
  formatBaseline,
  parseBaseline,
  type StyleEntry,
} from "./design-baseline";

const reasons = {
  arbitrary: "任意工具值須改用具名 token",
  radius: "大圓角須改用規範圓角",
  effect: "漸層或毛玻璃須改用單色表面",
  color: "原始色碼須改用語意色",
  palette: "預設色盤須改用語意色",
  typeSize: "標題字級不可超過二十像素",
  shadow: "只有浮層可用陰影代幣",
  dynamic: "動態樣式須使用已登記的 CSS 變數",
  pixels: "行內像素須改用尺寸 token",
  dimension: "固定字級、間距或圓角須改用 token",
};
export const sourceDirectories = ["src", "shared"];
export const sourceFile = /\.(?:[cm]?[jt]sx?|css|html|svg)$/i;

const namedColor =
  /(?<![\w-])(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)(?![\w-])/gi;
const isColorProperty =
  /^(?:--|color$|background|border|outline|fill$|stroke$|filter$|text-decoration|text-shadow|box-shadow|accent-color|caret-color|stop-color)/;
const isDimension =
  /^(?:padding|margin|gap|row-gap|column-gap|font-size|line-height|border(?:-[\w-]+)?-radius)(?:-|$)/;
const rawLength =
  /(?<![\w.-])[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:r?(?:em|ex|cap|ch|ic|lh)|q|cm|mm|in|pc|pt|px|(?:[sld]?v|cq)(?:w|h|min|max|i|b)|%)(?![\w-])/gi;

export function scanStyles(file: string, input: string): StyleEntry[] {
  const source = input.replaceAll("\r\n", "\n");
  const lines = source.split("\n");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const matches: {
    start: number;
    end: number;
    reason: string;
    value: string;
  }[] = [];
  function record(start: number, value: string, reason: string) {
    matches.push({ start, end: start + value.length, reason, value });
  }
  function inspect(
    text: string,
    offset: number,
    pattern: RegExp,
    reason: string,
  ) {
    for (const match of text.matchAll(pattern)) {
      record(offset + match.index, match[0], reason);
    }
  }
  function utilities(text: string, offset: number) {
    // 變體方括號後接冒號，只有冒號後方的實際工具類別使用設計值。
    inspect(
      text,
      offset,
      /(?<![\w-])(?:-?[\w-]+-\[[^\]\s]+\]|\[(?:--)?[a-z][\w-]*:[^\]\s]+\])(?!(?:\/[\w-]+)?:)/gi,
      reasons.arbitrary,
    );
    inspect(
      text,
      offset,
      /(?<![\w-])(?!(?:data|aria|has|supports)-)-?[a-z][\w-]*-\[(?=\$?$)/gi,
      reasons.arbitrary,
    );
    inspect(
      text,
      offset,
      /(?<![\w-])rounded-(?:(?:[trblse]{1,2})-)?(?:lg|(?:\d+)?xl|full)\b/g,
      reasons.radius,
    );
    inspect(
      text,
      offset,
      /(?<![\w-])(?:bg-(?:gradient|linear|radial|conic)|backdrop-blur)(?:-[\w-]+)?\b/g,
      reasons.effect,
    );
    inspect(
      text,
      offset,
      /(?<![\w-])-?[\w-]+-\((?:[\w-]+:)?--[\w-]+\)/gi,
      reasons.arbitrary,
    );
    inspect(
      text,
      offset,
      /(?<![\w-])(?:bg|text|fill|stroke|border(?:-[trblxyse])?|divide|ring(?:-offset)?|outline|from|via|to|decoration|accent|caret|shadow|placeholder)-(?:black|white|(?:amber|blue|cyan|emerald|fuchsia|gray|green|indigo|lime|mauve|mist|neutral|olive|orange|pink|purple|red|rose|sky|slate|stone|taupe|teal|violet|yellow|zinc)-\d+)(?:\/[\d.]+)?\b/g,
      reasons.palette,
    );
    inspect(
      text,
      offset,
      /(?<![\w-])text-(?:[3-9]|\d{2,})xl\b/g,
      reasons.typeSize,
    );
    inspect(
      text,
      offset,
      /(?<![\w-])(?:inset-|drop-|text-)?shadow(?:-(?!raised\b|none\b)[\w-]+)?(?![\w-])/g,
      reasons.shadow,
    );
  }

  function declarations(
    prop: string,
    text: string,
    offset: number,
    inline: boolean,
    nameOffset?: number,
    spelling = prop,
  ) {
    if (prop === "font") {
      if (nameOffset !== undefined)
        record(nameOffset, spelling, reasons.dimension);
      return;
    }
    if (prop === "box-shadow" || prop === "text-shadow") {
      if (
        text !== "none" &&
        !/^var\(--shadow-raised(?:-value)?\)$/.test(text) &&
        nameOffset !== undefined
      )
        record(nameOffset, spelling, reasons.shadow);
    }
    if (isColorProperty.test(prop) || prop.endsWith("-color")) {
      const paint = text.replace(
        /url\(\s*(?:"[^"]*"|'[^']*'|[^()]*)\s*\)|"[^"]*"|'[^']*'/gi,
        (url) => " ".repeat(url.length),
      );
      inspect(
        paint,
        offset,
        /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color)\([^)]*\)/gi,
        reasons.color,
      );
      inspect(paint, offset, namedColor, reasons.color);
    }
    if (inline || isDimension.test(prop) || prop.startsWith("--")) {
      for (const match of text.matchAll(rawLength)) {
        if (
          parseFloat(match[0]) === 0 ||
          (match[0].endsWith("%") && !isDimension.test(prop))
        )
          continue;
        record(
          offset + match.index,
          match[0],
          inline ? reasons.pixels : reasons.dimension,
        );
      }
    }
    if (prop === "font-size")
      inspect(
        text,
        offset,
        /^(?:xx?-small|small|medium|large|x{1,3}-large|larger|smaller)$/gi,
        reasons.dimension,
      );
    inspect(
      text,
      offset,
      /(?:linear|radial|conic)-gradient\(/gi,
      reasons.effect,
    );
    if (prop.endsWith("filter"))
      inspect(text, offset, /drop-shadow\(/gi, reasons.shadow);
    if (prop.endsWith("backdrop-filter"))
      inspect(text, offset, /blur\([^)]+\)/gi, reasons.effect);
    if (
      inline &&
      (isDimension.test(prop) ||
        /^(?:(?:min-|max-)?(?:width|height)|inset|top|left|right|bottom)$/.test(
          prop,
        )) &&
      text !== "0" &&
      !/^(?:var\(|inherit$|auto$|none$)/.test(text)
    ) {
      record(offset, text, reasons.dimension);
    }
  }
  function inlineCss(text: string, offset: number) {
    for (const match of text.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
      const valueOffset = match.index + match[0].length - match[2].length;
      declarations(
        match[1],
        match[2],
        offset + valueOffset,
        true,
        offset + match.index + match[0].indexOf(match[1]),
      );
    }
    if (text === "px") record(offset, text, reasons.pixels);
  }
  if (file.endsWith(".css")) {
    const sheet = postcss.parse(source);
    sheet.walkDecls((decl) => {
      const parent = decl.parent;
      const theme = parent?.type === "atrule" && parent.name === "theme";
      const palette =
        parent?.type === "rule" &&
        parent.selectors.every((s) => s === ":root" || s === ".dark");
      if (
        file === "src/styles.css" &&
        decl.prop.startsWith("--") &&
        (theme || palette) &&
        parent?.parent?.type === "root"
      )
        return;
      const offset =
        decl.source!.start!.offset +
        decl.prop.length +
        (decl.raws.between ?? ":").length;
      declarations(
        decl.prop,
        decl.value,
        offset,
        false,
        decl.source!.start!.offset,
      );
    });
    sheet.walkAtRules("apply", (rule) => {
      utilities(
        rule.params,
        rule.source!.start!.offset +
          1 +
          rule.name.length +
          (rule.raws.afterName ?? " ").length,
      );
    });
  } else if (/\.(?:html|svg)$/.test(file)) {
    for (const tag of source.matchAll(
      /<!--[\s\S]*?-->|<[a-z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
    )) {
      if (tag[0].startsWith("<!--")) continue;
      for (const attr of tag[0].matchAll(
        /\s(class(?:Name)?|style|color|fill|stroke)\s*=\s*(["'])(.*?)\2/gis,
      )) {
        const offset = tag.index + attr.index + attr[0].indexOf(attr[2]) + 1;
        if (/^class/i.test(attr[1])) utilities(attr[3], offset);
        else if (attr[1].toLowerCase() === "style") inlineCss(attr[3], offset);
        else declarations(attr[1], attr[3], offset, true);
      }
    }
  } else {
    inspectScript(file, tree, {
      classes: utilities,
      cssText: inlineCss,
      dynamic: (name, offset) => record(offset, name, reasons.dynamic),
      property: (name, value, offset, nameOffset) =>
        declarations(
          name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
          value,
          offset,
          true,
          nameOffset,
          name,
        ),
    });
  }
  // 一個工具值只記一筆，例如背景的任意色碼與其中的色碼字串指向同一處。
  let end = -1;
  return matches
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .flatMap((m) => {
      if (m.start < end) return [];
      end = m.end;
      const position = tree.getLineAndCharacterOfPosition(m.start);
      return [
        {
          file,
          line: position.line + 1,
          column: position.character + 1,
          reason:
            file === "src/flow/architecture-flow.js"
              ? "系統架構圖為獨立文件，須連同圖表主題遷移：" + m.reason
              : m.reason,
          value: m.value,
          context: fingerprint(lines[position.line]),
        },
      ];
    });
}

export { baselineDifference };

function listSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = directory + "/" + entry.name;
    if (entry.isDirectory()) return listSources(path);
    return entry.isFile() && sourceFile.test(path) ? [path] : [];
  });
}

export function entriesAt(revision?: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" });
  const paths = revision
    ? git("ls-tree", "-rz", "--name-only", revision, "--", ...sourceDirectories)
        .split("\0")
        .filter((p) => sourceFile.test(p))
    : sourceDirectories.flatMap(listSources);
  return paths
    .sort()
    .flatMap((path) =>
      scanStyles(
        path,
        revision
          ? git("show", revision + ":" + path)
          : readFileSync(path, "utf8"),
      ),
    );
}

export function inventory(baseline: string) {
  return baselineDifference(entriesAt(), parseBaseline(baseline));
}

export function formatInventory(entries: StyleEntry[]) {
  const rows = entries.map((e) =>
    [e.file + ":" + e.line + ":" + e.column, e.reason, e.value, e.context].join(
      "\t",
    ),
  );
  return ["檔案及行欄\t待遷移原因\t樣式\t來源識別", ...rows].join("\n") + "\n";
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  if (process.argv[2] === "--write") {
    writeFileSync(
      "tests/design-tokens.baseline.tsv",
      formatBaseline(entriesAt()),
      "utf8",
    );
  } else {
    process.stdout.write(formatInventory(entriesAt(process.argv[2])));
  }
}
