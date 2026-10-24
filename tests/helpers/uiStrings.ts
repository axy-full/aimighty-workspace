import ts from "typescript";

/**
 * The words the owner retired from the UI (design/particl-graphite/README.md §7). "Rig" left this list on 10 Oct 2026:
 * prototype 12 names a board view "Rig" and the owner kept that name (docs/redesign-plan.md, "Owner decisions").
 * spelled in pieces so this file does not match its own search. Matching is
 * case-sensitive on the capitalised word, so lower-case code names (kind: "rig",
 * /api/higgsfield, soul_id) are never counted.
 */
export const OLD_WORDS = [
  ["Mole", "culr"], ["Sub", "atomik"], ["Gen", "jutsu"], ["So", "ul"], ["Higgs", "field"], ["Per", "sona"], ["As", "tra"],
].map((parts) => parts.join(""));

/**
 * The old structure's phrases (the five-suite story and its names). They are counted with the
 * words: a string that says "Five suites in one shell" is the same old design as one that says Moleculr.
 */
export const OLD_PHRASES = [
  ["Five", " suites"], ["Four", " suites"], ["Production", " Studio"], ["Business", " Suite"], ["Viral", " Studio"],
  ["Opens", " in Gen"], ["Open", " in Gen"], ["Marketing", " Studio"], ["marketing", " studio"],
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

/**
 * "Astra" is allowed only as Topaz's model name, and only where it stands right after the word Topaz ("Topaz Astra 2"). A string
 * that merely says Topaz somewhere else ("Topaz upscale or GPT-6 Astra") is not an allowance: GPT-6 Astra and the old 3D tool's name
 * are both banned in anything a person reads.
 */
export function topazAstra(text: string, at: number): boolean {
  return /\bTopaz\s+$/i.test(text.slice(Math.max(0, at - 12), at));
}
function allowed(word: string, text: string, at: number): boolean {
  return word === ASTRA && topazAstra(text, at);
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
    if (!allowed(word, text, m.index ?? 0)) words.push(word);
  }
  return words;
};

/**
 * Every retired word in the user-visible strings of one source file: JSX text and
 * string or template literals, never comments, identifiers, imports or comparisons.
 */
export function uiWordsIn(fileName: string, source: string): UiWord[] {
  return walk(fileName, source, oldNames, () => false).filter(({ word }) => !processorName(fileName, word)).map(({ word, line, text }) => ({ word, line, text }));
}

/**
 * The one exception to the ban on retired vendor names in UI text, by the owner's decision (11 October 2026): the privacy page
 * may NAME the services that receive prompts or files, because it has to say who they are. Processor names only (Higgsfield, the
 * one such name on the ban list), and only in that file: any other file, and every other banned word in this one, is still caught.
 * tests/unit/processorNameException.spec.ts holds the exception to exactly this.
 */
export const PROCESSOR_NAME_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({ "app/(app)/privacy/page.tsx": ["Higgsfield"] });
const processorName = (fileName: string, word: string): boolean => Object.hasOwn(PROCESSOR_NAME_EXCEPTIONS, fileName) && PROCESSOR_NAME_EXCEPTIONS[fileName].includes(word);

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
function bannedNames(text: string, navigation: boolean, commandK: boolean): string[] {
  const words = oldNames(text);
  for (const m of text.matchAll(CAPS_RE)) {
    /* "RIG" in a string that says Topaz is Topaz's ASTRA; the allowance is the same as for the capitalised word. */
    if (m[1] === ASTRA.toUpperCase() && topazAstra(text, m.index ?? 0)) continue;
    words.push(m[1]);
  }
  /* "Open in Gen" is one old phrase already counted above: Gen inside a phrase is not a second name. */
  const phrases = [...text.matchAll(WORD_RE)].filter((m) => m[2]).map((m) => [m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(GEN_RE)) if (!phrases.some(([from, to]) => m.index! >= from && m.index! < to)) words.push(GEN);
  /* Only where a string is a destination (navigation data), "Generate" alone is the old Gen page; as a verb on a button it is fine. */
  if (navigation && GENERATE_LABEL_RE.test(text)) words.push("Generate (label)");
  /* ⌘K lists exactly what the design lists: no Business or Viral suite, and no 01..07 stage numbers on a row. */
  if (commandK) {
    for (const m of text.matchAll(/\b(Business|Viral)\b/g)) words.push(`${m[1]} (suite)`);
    if (/^\s*0[1-9]\b/.test(text) || /^\{\}\s+\{\}$/.test(text.trim())) words.push("01-07 stage number");
  }
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
 * Every banned name in the user-visible strings of one file: Moleculr, Subatomik, Genjutsu, Soul,
 * Higgsfield, Gen as a place, Astra unless it stands right after Topaz, the old suite phrases, and the
 * same words in capitals. `title` marks a hit inside a page title. `navigation` says the file is
 * navigation data (palette rows, tabs, the header), where a label that is only "Generate" is the old Gen page.
 * `commandK` says the file is the ⌘K palette: Business and Viral as suite names and a "01" stage number on a row are banned there too.
 */
export function bannedNamesIn(fileName: string, source: string, options: { navigation?: boolean; commandK?: boolean } = {}): BannedName[] {
  return walk(fileName, source, (text) => bannedNames(text, !!options.navigation, !!options.commandK), inPageTitle).filter(({ word }) => !processorName(fileName, word));
}

/* ------------------------------------------------------------------------------------------ */
/* The design lock (Amendment, 22 October 2026 (iii), C5, E, D12, D13, L2).                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * The lines the owner retired on 22 October 2026 (Amendment (iii) C5 and L2). The owner: "Copy like 'Just make it. The same quote.
 * No questions' is amateur copy." "How many" is "Count" everywhere (v31.13). Matched in any case, as whole words, across any run of
 * whitespace (a JSX line break included).
 */
export const RETIRED_LINES = [
  "Just make it", "No questions", "the editor is the director's", "Show me on my film", "built for small teams", "How many",
  "Describe the node", "kept from Look",
] as const;
/**
 * L2 retires "Show me on my film" outside the ? cards only (R9; C1 keeps it as a teaching device in the product). The ? cards'
 * file goes here when it is built; nothing else may say it. No ? card file exists yet.
 */
export const QUESTION_CARD_FILES: readonly string[] = [];
const RETIRED_LINE_RE = new RegExp(`\\b(${RETIRED_LINES.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]").replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
const normalLine = (text: string) => text.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ");

/** The retired lines in one string a person reads, each as listed in RETIRED_LINES. */
export function retiredLines(text: string): string[] {
  return [...text.matchAll(RETIRED_LINE_RE)].map((m) => RETIRED_LINES.find((line) => line.toLowerCase() === normalLine(m[1])) ?? m[1]);
}

/**
 * Atomik's thinking models are never named to a person (Amendment (iii) E, the owner: "never disclose to the user the models and
 * effort settings"): no model id, family-and-version name or reasoning-effort setting in a string a person reads, or in an API
 * response. The person sees only Thinking · High · Medium · Low. This is the thinking models' counterpart of the engine-name rule:
 * the engines a Director picks (Seedance 2.5, Kling 3.0, GPT Image 2, Grok Imagine, Nano Banana, the Gemini image engines) are named
 * where the Director picks them, so a match followed by "Image" or "Imagine" is an engine and is not counted.
 * Used only through thinkingModelNames (the patterns are global: never call .test on them).
 */
const HYPHEN = "[-‐‑–]";
export const THINKING_MODEL_PATTERNS: readonly RegExp[] = Object.freeze([
  new RegExp(`\\bclaude${HYPHEN}(?:fable|opus|sonnet|haiku|instant|mythos|[0-9])[a-z0-9.\\-]*`, "gi"),
  /\b(?:Claude\s+)?(?:Fable|Opus|Sonnet|Haiku|Mythos)\s+\d+(?:\.\d+)?(?![\d.])/gi,
  new RegExp(`\\bgpt${HYPHEN}?\\d+(?:\\.\\d+)?[a-z]*(?:${HYPHEN}[a-z0-9]+)*`, "gi"),
  /\bGPT\s+\d+(?:\.\d+)?(?![\d.])/g,
  /\bo[1-9](?:-(?:mini|pro|fast|preview))*\b/g,
  new RegExp(`\\bgrok${HYPHEN}\\d[a-z0-9.\\-]*`, "gi"),
  /\bGrok\s+\d+(?:\.\d+)?(?![\d.])/g,
  new RegExp(`\\bgemini${HYPHEN}\\d[a-z0-9.\\-]*`, "gi"),
  /\bGemini\s+\d+(?:\.\d+)?(?![\d.])/g,
  /\breasoning[_ -]?effort\b/gi,
  /\bthinking[_ -]?budget\b/gi,
  /\beffort\s*[:=·]?\s*(?:low|medium|high|xhigh|max)\b/gi,
  /\b(?:low|medium|high|xhigh|max)[- ]effort\b/gi,
]);
/** An engine, not a thinking model: the version is followed directly by Image or Imagine, with at most the model's own qualifiers between. */
const isImageEngine = (text: string, end: number) => /^(?:[\s\-‐‑–]+(?:flash|pro|preview|mini|lite|ultra))*[\s\-‐‑–]+imag(?:e|ine)\b/i.test(text.slice(end, end + 48));

/** Every thinking-model id, family-and-version name or effort setting in one string. */
export function thinkingModelNames(text: string): string[] {
  return THINKING_MODEL_PATTERNS.flatMap((re) => [...text.matchAll(re)].filter((m) => !isImageEngine(text, (m.index ?? 0) + m[0].length) && !/image/i.test(m[0])).map((m) => m[0]));
}

/**
 * The vendor names behind a text model, as words a person could read (case as the vendors write them, so a code key such as "xai" in
 * vendorKey("xai") is not one). Crew is covered by Amendment (iii) §E (owner, 24 Oct 2026, item 14 (a)): no model, vendor or effort.
 */
export const TEXT_VENDOR_PATTERN = /\b(?:xAI|Grok|SpaceX|Anthropic|Claude|OpenAI|ChatGPT|Gemini)\b/g;
/** Every thinking-model name, text vendor name or effort word in one string (the crew's screens and replies). */
export function modelVendorEffortIn(text: string): string[] {
  return [...thinkingModelNames(text), ...[...text.matchAll(TEXT_VENDOR_PATTERN)].map((m) => m[0]), ...[...text.matchAll(/\beffort\b/gi)].map((m) => m[0])];
}
/** Every model, vendor or effort word in the strings a person reads in one file (JSX text and string or template literals, never code). */
export function modelVendorEffortWordsIn(fileName: string, source: string): UiWord[] {
  return walk(fileName, source, modelVendorEffortIn, () => false).map(({ word, line, text }) => ({ word, line, text }));
}

/** JSX attributes the walk above treats as code that a settings row shows as words (`<Row name="…" value="…">`). */
const SKIPPED_WORD_ATTRS = new Set(["name", "value"]);

/**
 * Every string a person reads in one file for the design-lock checks: the walk above, plus the string values of `name` and `value` (SKIPPED_WORD_ATTRS),
 * which that walk skips as code and a settings row shows as words.
 */
function lockedWalk(fileName: string, source: string, find: Matcher): UiWord[] {
  const strip = (hits: (UiWord & { title: boolean })[]) => hits.map(({ word, line, text }) => ({ word, line, text }));
  const found = strip(walk(fileName, source, find, () => false));
  if (!fileName.endsWith(".tsx")) return found;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.initializer && SKIPPED_WORD_ATTRS.has(node.name.getText())) {
      const init = node.initializer;
      const literal = ts.isStringLiteral(init) ? init : ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression)) ? init.expression : null;
      if (literal) for (const word of find(literal.text)) found.push({ word, line: sf.getLineAndCharacterOfPosition(literal.getStart(sf)).line + 1, text: literal.text.replace(/\s+/g, " ").trim().slice(0, 120) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every retired line and every thinking-model name in the strings a person reads in one file. */
export function lockedCopyIn(fileName: string, source: string): { retired: UiWord[]; models: UiWord[] } {
  return {
    retired: lockedWalk(fileName, source, retiredLines).filter(({ word }) => !(word === "Show me on my film" && QUESTION_CARD_FILES.includes(fileName))),
    models: lockedWalk(fileName, source, thinkingModelNames),
  };
}

/**
 * What a v31.16 component writes as words of its own (they must come from lib/copy.ts): JSX text with a letter in it, a string
 * literal placed as a JSX child, and the string value of an attribute a person reads (aria-label, title, placeholder, alt). Code
 * strings ("use client", a route, a method, a class name, a state value) are not read.
 */
export function uiTextIn(fileName: string, source: string): UiWord[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: UiWord[] = [];
  const letters = (text: string) => /\p{L}/u.test(text);
  const add = (node: ts.Node, text: string) => { if (letters(text)) found.push({ word: text.trim(), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim() }); };
  const READ = new Set(["aria-label", "title", "placeholder", "alt"]);
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node, node.text);
    else if (ts.isJsxExpression(node) && node.expression && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) && !ts.isJsxAttribute(node.parent)) add(node, node.expression.text);
    else if (ts.isJsxAttribute(node) && READ.has(node.name.getText()) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) add(init, init.text);
      else if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) add(init, init.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
