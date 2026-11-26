import ts from "typescript";

// 每個例外只允許把該畫面的資料傳給具名 CSS 變數。固定值仍須放在主題或工具類別。
const dynamicVariables: Record<string, Record<string, string>> = {
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
  const bindings = new Map<ts.Node, Map<string, ts.Expression>>();
  const roots: (() => void)[] = [];
  const inspectedClasses = new Set<ts.Node>();
  const inspectedObjects = new Set<ts.Node>();

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
      if (init) styleObject(init);
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

  function gather(n: ts.Node) {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer
    ) {
      const scope =
        ts.findAncestor(
          n.parent,
          (owner) =>
            ts.isBlock(owner) ||
            ts.isSourceFile(owner) ||
            ts.isModuleBlock(owner),
        ) ?? tree;
      const names = bindings.get(scope) ?? new Map<string, ts.Expression>();
      names.set(n.name.text, n.initializer);
      bindings.set(scope, names);
      const init = n.initializer;
      if (n.type?.getText(tree).endsWith("CSSProperties"))
        roots.push(() => styleObject(init));
      if (
        /Class(?:es|Name)?$/.test(n.name.text) &&
        ts.isVariableStatement(n.parent.parent) &&
        n.parent.parent.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        roots.push(() => classes(init));
      }
    }
    if (ts.isJsxAttribute(n) || ts.isPropertyAssignment(n)) {
      const name = propertyName(n.name);
      const value =
        n.initializer &&
        (ts.isJsxExpression(n.initializer)
          ? n.initializer.expression
          : n.initializer);
      if (value && (name === "class" || name === "className"))
        roots.push(() => classes(value));
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
      ts.isPropertyAccessExpression(n.left)
    ) {
      const prop = n.left.name;
      if (prop.text === "className") roots.push(() => classes(n.right));
      if (
        ts.isPropertyAccessExpression(n.left.expression) &&
        n.left.expression.name.text === "style"
      ) {
        roots.push(() => styleValue(prop.text, prop.getStart(tree), n.right));
      }
    }
    ts.forEachChild(n, gather);
  }
  gather(tree);
  roots.forEach((run) => run());
}
