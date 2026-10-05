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

/** Finds the retired names in one string: the words of the strings a person reads. */
type Matcher = (text: string) => string[];

/**
 * Walks one source file and hands every user-visible string to the matcher: JSX text and
 * string or template literals, never comments, identifiers, imports or comparisons.
 * `inTitle` says the string sits in a page title (metadata, generateMetadata, document.title,
 * a <title> element or a usePageTitle call).
 */
function walk(fileName: string, source: string, find: Matcher, tag: (node: ts.Node) => boolean): (UiWord & { title: boolean })[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: (UiWord & { title: boolean })[] = [];
  const add = (node: ts.Node, text: string) => {
    for (const word of find(text)) {
      found.push({ word, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.replace(/\s+/g, " ").trim().slice(0, 120), title: tag(node) });
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

const oldNames: Matcher = (text) => {
  const words: string[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[1] ?? m[2];
    if (!allowed(word, text)) words.push(word);
  }
  return words;
};

/**
 * Every retired word in the user-visible strings of one source file: JSX text and
 * string or template literals, never comments, identifiers, imports or comparisons.
 */
export function uiWordsIn(fileName: string, source: string): UiWord[] {
  return walk(fileName, source, oldNames, () => false).map(({ word, line, text }) => ({ word, line, text }));
}

/* ------------------------------------------------------------------------------------------ */
/* The wider net (tests/unit/ui-names-guard.spec.ts): every banned name in every UI string.   */
/* ------------------------------------------------------------------------------------------ */

/** The old names as they are read on a screen in capitals (a group heading, a tab). Underscore names (SOUL_ID) are code and are not matched. */
const CAPS_RE = new RegExp(`\\b(${OLD_WORDS.map((word) => word.toUpperCase()).join("|")})\\b`, "g");
/** "Gen" as the name of a place ("Open in Gen", a tab labelled Gen). Runway's "Gen-4" and "Gen 3" are model names, not the page. */
const GEN_RE = /\b(Gen|GEN)\b(?![-\s]?\d)(?!\s+(?:AI|Z|X)\b)/g;
const GEN = "Gen";
/** A string that is nothing but "Generate": the old ⌘K row and tab for the page the Make panel replaced. */
const GENERATE_LABEL_RE = /^\s*Generate\s*$/;

/** Everything banned, for a string a person reads: the retired words and phrases, the same in capitals, and Gen as a place. */
function bannedNames(text: string, navigation: boolean): string[] {
  const words = oldNames(text);
  for (const m of text.matchAll(CAPS_RE)) {
    /* "RIG" in a string that says Topaz is Topaz's ASTRA; the allowance is the same as for the capitalised word. */
    if (m[1] === ASTRA.toUpperCase() && /topaz/i.test(text)) continue;
    words.push(m[1]);
  }
  /* "Open in Gen" is one old phrase already counted above: Gen inside a phrase is not a second name. */
  const phrases = [...text.matchAll(WORD_RE)].filter((m) => m[2]).map((m) => [m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(GEN_RE)) if (!phrases.some(([from, to]) => m.index! >= from && m.index! < to)) words.push(GEN);
  /* Only where a string is a destination (navigation data), "Generate" alone is the old Gen page; as a verb on a button it is fine. */
  if (navigation && GENERATE_LABEL_RE.test(text)) words.push("Generate (label)");
  return words;
}

/** True when the string sits where the browser takes a page title from. */
function inPageTitle(node: ts.Node): boolean {
  for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
    if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name) && up.name.text === "metadata") return true;
    if ((ts.isFunctionDeclaration(up) || ts.isVariableDeclaration(up)) && up.name && ts.isIdentifier(up.name) && up.name.text === "generateMetadata") return true;
    if (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.left.getText() === "document.title") return true;
    if (ts.isJsxElement(up) && up.openingElement.tagName.getText() === "title") return true;
    if (ts.isCallExpression(up) && ts.isIdentifier(up.expression) && /^use(Page)?Title$/.test(up.expression.text)) return true;
  }
  return false;
}

export type BannedName = UiWord & { title: boolean };

/**
 * Every banned name in the user-visible strings of one file: Moleculr, Subatomik, Rig, Genjutsu, Soul,
 * Higgsfield, Gen as a place, Astra unless the same string says Topaz, the old suite phrases, and the
 * same words in capitals. `title` marks a hit inside a page title. `navigation` says the file is
 * navigation data (palette rows, tabs, the header), where a label that is only "Generate" is the old Gen page.
 */
export function bannedNamesIn(fileName: string, source: string, options: { navigation?: boolean } = {}): BannedName[] {
  return walk(fileName, source, (text) => bannedNames(text, !!options.navigation), inPageTitle);
}
