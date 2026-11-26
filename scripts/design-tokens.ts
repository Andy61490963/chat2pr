import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postcss from "postcss";
import ts from "typescript";

import {
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
  pixels: "行內像素須改用尺寸 token",
  dimension: "固定字級、間距或圓角須改用 token",
};
const sourceFile = /\.(?:[cm]?[jt]sx?|css|html|svg)$/i;

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
  }
  function colors(text: string, offset: number, css: boolean) {
    for (const match of text.matchAll(
      /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|\brgba?\([^)]*\)/gi,
    )) {
      // 中文工單編號和網址片段也可能是三位數；樣式中的色碼出現在值的位置。
      if (
        css ||
        !match[0].startsWith("#") ||
        /(?:^|[:(=,'"\[])\s*$/.test(text.slice(0, match.index))
      ) {
        record(offset + match.index, match[0], reasons.color);
      }
    }
  }
  const isDimension =
    /^(?:padding|margin|gap|row-gap|column-gap|font-size|line-height|border(?:-[\w-]+)?-radius)(?:-|$)/;
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
        (theme || palette)
      )
        return;
      const offset =
        decl.source!.start!.offset +
        decl.prop.length +
        (decl.raws.between ?? ":").length;
      colors(decl.value, offset, true);
      if (isDimension.test(decl.prop)) {
        inspect(
          decl.value,
          offset,
          /-?(?:\d*\.)?\d+(?:r?em|px|%)\b|(?:\d*\.)?\d+%/gi,
          reasons.dimension,
        );
      }
      inspect(
        decl.value,
        offset,
        /(?:linear|radial|conic)-gradient\(/gi,
        reasons.effect,
      );
      if (decl.prop === "backdrop-filter")
        inspect(decl.value, offset, /blur\([^)]+\)/gi, reasons.effect);
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
  } else {
    const inspectString = (text: string, offset: number) => {
      utilities(text, offset);
      colors(text, offset, false);
      inspect(text, offset, /-?(?:\d*\.)?\d+px\b/gi, reasons.pixels);
    };
    function isStyleValue(node: ts.Node) {
      return ts.findAncestor(
        node,
        (n) =>
          ((ts.isJsxAttribute(n) || ts.isPropertyAssignment(n)) &&
            n.name.getText(tree) === "style") ||
          (ts.isVariableDeclaration(n) &&
            n.type?.getText(tree).endsWith("CSSProperties") === true) ||
          (ts.isBinaryExpression(n) &&
            /\.style\.[\w]+$/.test(n.left.getText(tree))),
      );
    }
    function visit(node: ts.Node) {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const text = node.getText(tree).slice(1, -1);
        const offset = node.getStart(tree) + 1;
        inspectString(text, offset);
        if (/^px\b/i.test(text) && isStyleValue(node))
          record(offset, text.slice(0, 2), reasons.pixels);
      }
      if (
        ts.isPropertyAssignment(node) &&
        /^(?:padding|margin|gap|rowGap|columnGap|fontSize|borderRadius|inset|top|left|right|bottom|(?:min|max)?(?:width|height))/i.test(
          node.name.getText(tree),
        )
      ) {
        const value = node.initializer;
        if (
          /^-?(?:\d*\.)?\d+$/.test(value.getText(tree)) &&
          Number(value.getText(tree)) !== 0 &&
          isStyleValue(node)
        ) {
          record(value.getStart(tree), value.getText(tree), reasons.pixels);
        }
      }
      ts.forEachChild(node, visit);
    }
    if (/\.(?:html|svg)$/.test(file)) inspectString(source, 0);
    else visit(tree);
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

export function baselineDifference(entries: StyleEntry[], base: StyleEntry[]) {
  const key = (e: StyleEntry) =>
    [e.file, e.reason, e.value, e.context].join("\t");
  const remaining = new Map<string, StyleEntry[]>();
  for (const entry of base) {
    const id = key(entry);
    const group = remaining.get(id);
    if (group) group.push(entry);
    else remaining.set(id, [entry]);
  }
  const added = entries.filter((entry) => !remaining.get(key(entry))?.pop());
  return { added, removed: [...remaining.values()].flat() };
}

function listSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = directory + "/" + entry.name;
    if (entry.isDirectory()) return listSources(path);
    return entry.isFile() && sourceFile.test(path) ? [path] : [];
  });
}

function entriesAt(revision?: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" });
  const paths = revision
    ? git("ls-tree", "-rz", "--name-only", revision, "--", "src/")
        .split("\0")
        .filter((p) => sourceFile.test(p))
    : listSources("src");
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

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.stdout.write(formatBaseline(entriesAt(process.argv[2])));
}
