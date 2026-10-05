import ts from "typescript";

/**
 * The words the owner retired from the UI (design/particl-graphite/README.md §7),
 * spelled in pieces so this file does not match its own search. Matching is
 * case-sensitive on the capitalised word, so lower-case code names (kind: "rig",
 * /api/higgsfield, soul_id) are never counted.
 */
export const OLD_WORDS = [
  ["Mole", "culr"], ["Sub", "atomik"], ["R", "ig"], ["Gen", "jutsu"], ["So", "ul"], ["Higgs", "field"], ["As", "tra"],
].map((parts) => parts.join(""));

/**
 * The old structure's phrases (the five-suite story and its names). They are counted with the
 * words: a string that says "Five suites in one shell" is the same old design as one that says Rig.
 */
export const OLD_PHRASES = [
  ["Five", " suites"], ["Four", " suites"], ["Production", " Studio"], ["Business", " Suite"], ["Viral", " Studio"],
  ["Opens", " in Gen"], ["Open", " in Gen"],
].map((parts) => parts.join(""));

const WORD_RE = new RegExp(`\\b(${OLD_WORDS.join("|")})(?:s|'s|’s)?\\b|\\b(${OLD_PHRASES.join("|")})\\b`, "g");
const ASTRA = OLD_WORDS[OLD_WORDS.length - 1];

/** JSX attributes whose string is code, not words a person reads. */
const CODE_ATTRS = new Set([
  "className", "id", "key", "name", "type", "role", "href", "src", "srcSet", "htmlFor", "style", "target", "rel", "method", "action",
  "variant", "kind", "mode", "size", "value", "defaultValue", "as", "slot", "tabIndex", "autoComplete", "inputMode", "loading", "fill",
  "stroke", "viewBox", "d", "points", "transform", "xmlns",
]);

function attributeName(node: ts.Node): string | undefined {
  const attr = node.parent;
  if (attr && ts.isJsxAttribute(attr)) return attr.name.getText();
  return undefined;
}

/** True when a string literal is code: a module path, a comparison, a case label, a property key, a type. */
function isCodePosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) || ts.isImportTypeNode(parent)) return true;
  if (ts.isCaseClause(parent) && parent.expression === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return true;
  }
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "require") return true;
  /* includes("rig")-style membership tests are code too */
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    if (["includes", "startsWith", "endsWith", "indexOf", "has", "get", "getAll", "set", "append", "delete", "test", "match", "querySelector", "querySelectorAll", "getElementById", "getItem", "setItem", "removeItem", "getAttribute", "setAttribute"].includes(method)) return true;
  }
  if (ts.isJsxAttribute(parent) || (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent))) {
    const name = attributeName(ts.isJsxAttribute(parent) ? parent.initializer ?? node : parent);
    if (name && (CODE_ATTRS.has(name) || name.startsWith("data-"))) return true;
  }
  return false;
}

export type UiWord = { word: string; line: number; text: string };

/** "Astra" is allowed only as Topaz's model name: the same string says Topaz ("Topaz Astra 2"). */
function allowed(word: string, text: string): boolean {
  return word === ASTRA && /topaz/i.test(text);
}

/**
 * Every retired word in the user-visible strings of one source file: JSX text and
 * string or template literals, never comments, identifiers, imports or comparisons.
 */
export function uiWordsIn(fileName: string, source: string): UiWord[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: UiWord[] = [];
  const add = (node: ts.Node, text: string) => {
    for (const m of text.matchAll(WORD_RE)) {
      const word = m[1] ?? m[2];
      if (allowed(word, text)) continue;
      found.push({ word, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.replace(/\s+/g, " ").trim().slice(0, 120) });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node, node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isCodePosition(node)) add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      if (!isCodePosition(node)) {
        add(node, node.head.text + node.templateSpans.map((span) => "{}" + span.literal.text).join(""));
      }
      node.templateSpans.forEach((span) => ts.forEachChild(span.expression, visit));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
