import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The tooltip audit (redesign A3; docs/redesign/inventory.md § 4.3: every icon has a tooltip, name · one line ·
 * shortcut · price). Reads every component of the new interface (components/v12) as source and fails on:
 *  - a <button> that shows no words (an icon, a glyph such as × or ▾, or nothing) and is not the child of a <Tooltip>
 *    with a name;
 *  - an <IconButton> whose tooltip has no name.
 * `title=` and `aria-label` alone do not count: a title is not shown on focus and an aria-label is not shown at all.
 */
const ROOT = path.resolve(__dirname, "../../components/v12");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith(".tsx") ? [full] : [];
  });
}

type Shown = "words" | "icon" | "none";
const merge = (a: Shown, b: Shown): Shown => (a === "words" || b === "words" ? "words" : a === "icon" || b === "icon" ? "icon" : "none");
const ofText = (text: string): Shown => (/[\p{L}\p{N}]/u.test(text) ? "words" : text.trim() ? "icon" : "none");

const tagName = (node: ts.JsxElement | ts.JsxSelfClosingElement) =>
  (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText();
const attributes = (node: ts.JsxElement | ts.JsxSelfClosingElement) =>
  (ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes).properties;
const attribute = (node: ts.JsxElement | ts.JsxSelfClosingElement, name: string) =>
  attributes(node).find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);

/** What a piece of JSX shows a sighted person: words, only an icon or glyph, or nothing. Unknown values count as words. */
function shown(node: ts.Node): Shown {
  if (ts.isJsxText(node)) return ofText(node.text);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return ofText(node.text);
  if (ts.isJsxExpression(node)) return node.expression ? shown(node.expression) : "none";
  if (ts.isParenthesizedExpression(node)) return shown(node.expression);
  if (ts.isConditionalExpression(node)) return merge(shown(node.whenTrue), shown(node.whenFalse));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return shown(node.right);
  if (node.kind === ts.SyntaxKind.NullKeyword) return "none";
  if (ts.isJsxFragment(node)) return node.children.reduce<Shown>((acc, child) => merge(acc, shown(child)), "none");
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const tag = tagName(node);
    if (tag === "svg" || tag === "img" || tag === "video") return "icon";
    /* A Kbd shows a key, not a name. */
    if (tag === "Kbd") return "icon";
    const hidden = attribute(node, "aria-hidden");
    if (!ts.isJsxElement(node)) return "words";
    const inside = node.children.reduce<Shown>((acc, child) => merge(acc, shown(child)), "none");
    return hidden && inside === "words" ? "icon" : inside;
  }
  return "words";
}

/** The JSX element a node sits in (skipping expressions, maps and fragments), or null. */
function parentElement(node: ts.Node): ts.JsxElement | null {
  let at: ts.Node | undefined = node.parent;
  while (at) {
    if (ts.isJsxElement(at)) return at;
    at = at.parent;
  }
  return null;
}

const named = (value: ts.JsxAttribute["initializer"] | ts.Expression | undefined): boolean => {
  if (!value) return false;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text.trim().length > 0;
  if (ts.isJsxExpression(value)) return named(value.expression);
  return true;
};

function audit(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const where = (node: ts.Node) => `${path.relative(path.resolve(ROOT, "../.."), file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagName(node);
      if (tag === "button") {
        const face = ts.isJsxElement(node) ? node.children.reduce<Shown>((acc, child) => merge(acc, shown(child)), "none") : "none";
        if (face !== "words") {
          const parent = parentElement(node);
          const tip = parent && tagName(parent) === "Tooltip" ? parent : null;
          if (!tip || !named(attribute(tip, "name")?.initializer)) out.push(`${where(node)} a button that shows no words has no <Tooltip name>`);
        }
      }
      if (tag === "IconButton") {
        const tooltip = attribute(node, "tooltip")?.initializer;
        const expression = tooltip && ts.isJsxExpression(tooltip) ? tooltip.expression : undefined;
        const name = expression && ts.isObjectLiteralExpression(expression)
          ? expression.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "name")
          : undefined;
        if (!expression || (ts.isObjectLiteralExpression(expression) && !named(name?.initializer))) out.push(`${where(node)} an IconButton has no tooltip name`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

test("every icon-only button in the new interface has a tooltip with a name", () => {
  const all = files(ROOT);
  expect(all.length).toBeGreaterThan(10);
  expect(all.flatMap(audit)).toEqual([]);
});

test("the audit catches a bare icon button, and passes one inside a named Tooltip", () => {
  const sample = (code: string) => {
    const file = path.join(ROOT, "__sample__.tsx");
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found: ts.Node | null = null;
    const find = (n: ts.Node) => { if (!found && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagName(n) === "button") found = n; ts.forEachChild(n, find); };
    find(source);
    return found;
  };
  /* The shape checks themselves, on small samples. */
  const bare = sample(`const a = <button aria-label="Close">×</button>;`)!;
  expect(shown((bare as ts.JsxElement).children[0])).toBe("icon");
  const worded = sample(`const a = <button>Library<Kbd keys="L" /></button>;`)! as ts.JsxElement;
  expect(worded.children.reduce<Shown>((acc, c) => merge(acc, shown(c)), "none")).toBe("words");
  const tipped = sample(`const a = <Tooltip name="Close"><button aria-label="Close">×</button></Tooltip>;`)!;
  const parent = parentElement(tipped);
  expect(parent && tagName(parent)).toBe("Tooltip");
});
