import ts from "typescript";
import { getDefaultConfig } from "tailwind-merge";

const bareUtilities = new Set<string>(["group", "peer"]);
for (const group of Object.values(getDefaultConfig().classGroups)) {
  for (const rule of group) {
    if (typeof rule === "string") bareUtilities.add(rule);
    else if (typeof rule === "object")
      for (const [prefix, suffixes] of Object.entries(rule))
        if (suffixes.includes("")) bareUtilities.add(prefix);
  }
}

function looksLikeClassList(text: string) {
  return text
    .trim()
    .split(/\s+/)
    .every(
      (word) =>
        bareUtilities.has(word) ||
        (!/^[a-z][\w+.-]*:\/\//i.test(word) &&
          /^!?-?(?:[\w@*]+[-:(]|\[)/.test(word) &&
          !/[^\x21-\x7e]/.test(word)),
    );
}

// 每個例外只允許把該畫面的資料傳給具名 CSS 變數。固定值仍須放在主題或工具類別。
const dynamicVariables: Record<string, Record<string, string>> = {
  "src/App.tsx": {
    "--quota-left": "用量摘要顯示目前可用的額度百分比。",
  },
  "src/flow/architecture-flow.js": {
    "--scene-progress": "依所選章節和播放時間顯示每個步驟的完成比例。",
  },
  "src/app/docker-disk.tsx": {
    "--disk-used-width": "可用空間變動時同步更新磁碟使用比例。",
  },
  "src/app/query-report.tsx": {
    "--diagram-width": "呈現 SVG 實際量得的圖寬與使用者選定的縮放比。",
  },
  "src/components/ui/form-controls.tsx": {
    "--progress-offset": "依目前進度換算指示器的水平位移。",
  },
};

type TextCheck = (value: string, offset: number) => void;
type StyleVisitor = {
  classes: TextCheck;
  cssText: TextCheck;
  property: (
    name: string,
    value: string,
    offset: number,
    nameOffset: number,
  ) => void;
  dynamic: TextCheck;
};

function propertyName(name: ts.Node) {
  return ts.isStringLiteralLike(name) || ts.isIdentifier(name)
    ? name.text
    : name.getText();
}

function unwrap(value: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isTypeAssertionExpression(value)
  ) {
    return unwrap(value.expression);
  }
  return value;
}

export function inspectScript(
  file: string,
  tree: ts.SourceFile,
  visit: StyleVisitor,
) {
  type Binding = ts.Expression | ts.FunctionDeclaration;
  const bindings = new Map<ts.Node, Map<string, Binding>>();
  const classProperty = /(?:^|[a-z])Class(?:Names?|es)?$|^class(?:Names?)?$/;
  const roots: (() => void)[] = [];
  const inspectedClasses = new Set<ts.Node>();
  const inspectedObjects = new Set<ts.Node>();
  const inspectedShared = new Set<ts.Node>();

  function initializer(name: ts.Identifier) {
    for (
      let owner: ts.Node | undefined = name.parent;
      owner;
      owner = owner.parent
    ) {
      const value = bindings.get(owner)?.get(name.text);
      if (value) return value;
      if (
        ts.isFunctionLike(owner) &&
        owner.parameters.some(
          (p) => ts.isIdentifier(p.name) && p.name.text === name.text,
        )
      )
        return;
    }
  }

  function bind(name: ts.Identifier, value: Binding, parent: ts.Node) {
    const scope =
      ts.findAncestor(
        parent,
        (owner) =>
          ts.isBlock(owner) ||
          ts.isSourceFile(owner) ||
          ts.isModuleBlock(owner),
      ) ?? tree;
    const names = bindings.get(scope) ?? new Map<string, Binding>();
    names.set(name.text, value);
    bindings.set(scope, names);
  }

  function visitReturns(node: ts.Node, inspect: (value: ts.Expression) => void) {
    if (ts.isReturnStatement(node)) {
      if (node.expression) inspect(node.expression);
    } else if (!ts.isFunctionLike(node)) {
      ts.forEachChild(node, (child) => visitReturns(child, inspect));
    }
  }

  function literals(node: ts.Node, check: TextCheck) {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      check(node.getText(tree).slice(1, -1), node.getStart(tree) + 1);
      return;
    }
    ts.forEachChild(node, (child) => literals(child, check));
  }

  function classes(node: ts.Node) {
    if (inspectedClasses.has(node)) return;
    inspectedClasses.add(node);
    if (ts.isIdentifier(node)) {
      const init = initializer(node);
      if (init) classes(init);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      if (node.body && ts.isBlock(node.body)) visitReturns(node.body, classes);
      else if (node.body) classes(node.body);
    } else if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateLiteralToken(node)
    ) {
      literals(node, visit.classes);
    } else if (ts.isConditionalExpression(node)) {
      classes(node.whenTrue);
      classes(node.whenFalse);
    } else if (
      ts.isElementAccessExpression(node) ||
      ts.isPropertyAccessExpression(node)
    ) {
      classes(node.expression);
    } else {
      ts.forEachChild(node, classes);
    }
  }

  function styleValue(
    name: string,
    nameOffset: number,
    expression: ts.Expression,
  ) {
    const value = unwrap(expression);
    if (name.startsWith("--")) {
      if (!dynamicVariables[file]?.[name] || !hasData(value, new Set()))
        visit.dynamic(name, nameOffset);
      return;
    }
    const literal = ts.isStringLiteralLike(value);
    const numeric =
      ts.isNumericLiteral(value) ||
      (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand));
    if (name === "style" || name === "cssText") {
      literals(value, visit.cssText);
      return;
    }
    if (literal || numeric) {
      visit.property(
        name,
        literal ? value.getText(tree).slice(1, -1) : value.getText(tree),
        value.getStart(tree) + Number(literal),
        nameOffset,
      );
    } else {
      visit.dynamic(name, nameOffset);
    }
  }

  function hasData(node: ts.Node, seen: Set<ts.Node>): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const init = initializer(node);
      return init ? hasData(init, seen) : true;
    }
    if (ts.isPropertyAccessExpression(node))
      return hasData(node.expression, seen);
    if (ts.isPropertyAssignment(node)) return hasData(node.initializer, seen);
    return !!ts.forEachChild(
      node,
      (child) => hasData(child, seen) || undefined,
    );
  }

  function styleObject(expression: ts.Expression) {
    const node = unwrap(expression);
    if (inspectedObjects.has(node)) return;
    inspectedObjects.add(node);
    if (ts.isIdentifier(node)) {
      const init = initializer(node);
      if (init && ts.isExpression(init)) styleObject(init);
      else if (node.text !== "undefined")
        visit.dynamic(node.text, node.getStart(tree));
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) styleObject(prop.expression);
        if (
          ts.isShorthandPropertyAssignment(prop) ||
          ts.isPropertyAssignment(prop)
        ) {
          const name = propertyName(prop.name);
          styleValue(
            name,
            prop.name.getStart(tree) +
              Number(ts.isStringLiteralLike(prop.name)),
            ts.isShorthandPropertyAssignment(prop)
              ? prop.name
              : prop.initializer,
          );
        }
      }
    } else if (ts.isConditionalExpression(node)) {
      styleObject(node.whenTrue);
      styleObject(node.whenFalse);
    } else if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
        styleObject(node.left);
      styleObject(node.right);
    } else if (
      ts.isStringLiteralLike(node) ||
      ts.isBinaryExpression(node) ||
      ts.isTemplateExpression(node)
    ) {
      literals(node, visit.cssText);
    } else {
      visit.dynamic(
        node.getFirstToken(tree)?.getText(tree) ?? "style",
        node.getStart(tree),
      );
    }
  }

  // 匯出對照表只讀屬性值；敘述句中的範例類別、物件鍵與網址不當作類別清單。
  function sharedValues(value: Binding) {
    const node = ts.isFunctionDeclaration(value) ? value : unwrap(value);
    if (inspectedShared.has(node)) return;
    inspectedShared.add(node);
    if (ts.isIdentifier(node)) {
      const init = initializer(node);
      if (init) sharedValues(init);
    } else if (
      ts.isElementAccessExpression(node) ||
      ts.isPropertyAccessExpression(node)
    ) {
      sharedValues(node.expression);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      if (node.body && ts.isBlock(node.body))
        visitReturns(node.body, sharedValues);
      else if (node.body) sharedValues(node.body);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties)
        if (ts.isPropertyAssignment(prop)) sharedValues(prop.initializer);
    } else if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(sharedValues);
    } else if (ts.isStringLiteralLike(node) && looksLikeClassList(node.text)) {
      classes(node);
    }
  }

  function gather(n: ts.Node) {
    if (ts.isFunctionDeclaration(n)) {
      if (n.name) bind(n.name, n, n.parent);
      if (
        file.startsWith("shared/") &&
        n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        roots.push(() => sharedValues(n));
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer
    ) {
      bind(n.name, n.initializer, n.parent);
      const init = n.initializer;
      if (n.type?.getText(tree).endsWith("CSSProperties"))
        roots.push(() => styleObject(init));
      if (
        ts.isVariableStatement(n.parent.parent) &&
        n.parent.parent.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        if (classProperty.test(n.name.text)) roots.push(() => classes(init));
        else if (file.startsWith("shared/")) {
          roots.push(() => sharedValues(init));
        }
      }
    }
    if (
      ts.isBindingElement(n) &&
      ts.isObjectBindingPattern(n.parent) &&
      classProperty.test(propertyName(n.propertyName ?? n.name)) &&
      n.initializer
    ) {
      const value = n.initializer;
      roots.push(() => classes(value));
    }
    if (ts.isJsxAttribute(n) || ts.isPropertyAssignment(n)) {
      const name = propertyName(n.name);
      const value =
        n.initializer &&
        (ts.isJsxExpression(n.initializer)
          ? n.initializer.expression
          : n.initializer);
      if (value && classProperty.test(name)) roots.push(() => classes(value));
      if (value && name === "style" && ts.isExpression(value))
        roots.push(() => styleObject(value));
      if (
        value &&
        ts.isJsxAttribute(n) &&
        /^(?:color|fill|stroke|bgcolor)$/i.test(name) &&
        ts.isExpression(value)
      ) {
        roots.push(() => styleValue(name, n.name.getStart(tree), value));
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(tree);
      if (
        /^(?:cn|clsx|cva|classNames|twMerge)$/.test(callee) ||
        /\.classList\.(?:add|remove|toggle|replace|contains)$/.test(callee)
      ) {
        roots.push(() => n.arguments.forEach(classes));
      }
      const [name, value] = n.arguments;
      if (
        callee === "Object.assign" &&
        name &&
        ts.isPropertyAccessExpression(name) &&
        name.name.text === "style"
      ) {
        roots.push(() => n.arguments.slice(1).forEach(styleObject));
      }
      if (name && ts.isStringLiteralLike(name) && value) {
        if (
          callee.endsWith(".setAttribute") &&
          /^(?:class|className)$/.test(name.text)
        )
          roots.push(() => classes(value));
        if (callee.endsWith(".setAttribute") && name.text === "style")
          roots.push(() => styleObject(value));
        if (callee.endsWith(".style.setProperty"))
          roots.push(() =>
            styleValue(name.text, name.getStart(tree) + 1, value),
          );
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(n.left) ||
        ts.isElementAccessExpression(n.left))
    ) {
      const prop = ts.isPropertyAccessExpression(n.left)
        ? n.left.name
        : n.left.argumentExpression;
      const name = ts.isPropertyAccessExpression(n.left)
        ? prop.getText(tree)
        : ts.isStringLiteralLike(prop)
          ? prop.text
          : undefined;
      if (name === "className") roots.push(() => classes(n.right));
      if (
        name &&
        ts.isPropertyAccessExpression(n.left.expression) &&
        n.left.expression.name.text === "style"
      ) {
        roots.push(() =>
          styleValue(
            name,
            prop.getStart(tree) + Number(ts.isStringLiteralLike(prop)),
            n.right,
          ),
        );
      }
    }
    ts.forEachChild(n, gather);
  }
  gather(tree);
  roots.forEach((run) => run());
}
