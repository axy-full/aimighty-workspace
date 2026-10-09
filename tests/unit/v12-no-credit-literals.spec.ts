import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * No credit number is hardcoded anywhere in the new interface (owner, 10 Oct; docs/redesign-plan.md, item B1).
 *
 * Every price in components/v12/** and lib/v12/** comes from the quote engine through `useQuote` and `<Price>`
 * (lib/v12/quote.ts), or reads "quoted" with a reason from lib/v12/unpriced.ts. This spec reads that source as TypeScript
 * and fails on any credit figure written into it:
 *  - text a person reads (a string, a template's literal parts, JSX text) holding a number before "cr" or "credit(s)":
 *    "43 cr", "up to 12 cr", "$50 for 500 cr", "250 credits";
 *  - a price shape with a figure: `credits: 43`, `estimatedCredits: 9`, `cr: 7`, `upTo: 12`, `atMost: 3`, and the JSX
 *    attribute `credits={43}` or `price={43}`;
 *  - a price helper called with a figure: `exact(43)`, `upTo(12)`, `fmtCredits(500)`, `creditsText(2)`, `priceValue(4, …)`;
 *  - a threshold on credits or a balance: `credits < 100`, `balance >= 50` (the prototype's own placeholder rule).
 * Zero is not a price figure (`credits: 0` as an empty default is fine). Comments are not read: they may cite a sample.
 * A unit label alone (" cr") holds no figure and is never matched.
 *
 * ALLOWED lists the rare exception, each with its reason; an entry that no longer matches anything fails, so the list
 * cannot go stale.
 */

type Finding = { file: string; line: number; rule: string; text: string };
type Allowance = { file: string; text: string; why: string };

/** The exceptions: none so far. Add one only with a reason the owner would accept. */
const ALLOWED: Allowance[] = [];

const ROOTS = ["components/v12", "lib/v12"];

/** Text with a credit figure: a number, then "cr" or "credit(s)". */
const CREDIT_TEXT = /(?<![\w$.])\d[\d,]*(?:\.\d+)?\s*(?:cr|credits?)\b/i;
/** Property names that carry a price in credits. */
const PRICE_KEY = /^(?:\w*credits?|cr|upTo|atMost|price|cost|balance|threshold)$/i;
/** Helpers that turn a figure into a price. */
const PRICE_CALL = /^(?:exact|upTo|priceValue|fmtCredits|creditsText|creditsNumber|creditsUsd|knownQuote)$/;
/** Names whose comparison with a figure is a credit threshold. */
const CREDIT_NAME = /credit|balance/i;
const COMPARISON = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]);

const nameOf = (node: ts.Node): string | null => {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return null;
};
/** A non-zero number literal (also `-43`). */
const figure = (node: ts.Node | undefined): boolean => {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node)) return figure(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return figure(node.operand);
  return ts.isNumericLiteral(node) && Number(node.text.replace(/_/g, "")) !== 0;
};

/** Every credit figure in one file's source. */
export function scanCreditLiterals(file: string, source: string): Finding[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: Finding[] = [];
  const add = (node: ts.Node, rule: string, text = node.getText(sf)) =>
    found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, rule, text: text.replace(/\s+/g, " ").trim().slice(0, 120) });
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (CREDIT_TEXT.test(node.text)) add(node, "credit figure in text", node.text);
    } else if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((span) => "{}" + span.literal.text).join("");
      if (CREDIT_TEXT.test(text)) add(node, "credit figure in text", text);
    } else if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && node.initializer && figure(node.initializer)) {
      const name = nameOf(node.name);
      if (name && PRICE_KEY.test(name)) add(node, "price field with a figure");
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && figure(node.initializer.expression)) {
      if (PRICE_KEY.test(node.name.getText(sf))) add(node, "price attribute with a figure");
    } else if (ts.isCallExpression(node)) {
      const callee = nameOf(node.expression);
      if (callee && PRICE_CALL.test(callee) && figure(node.arguments[0])) add(node, "price helper called with a figure");
    } else if (ts.isBinaryExpression(node) && COMPARISON.has(node.operatorToken.kind)) {
      const [left, right] = [node.left, node.right];
      const named = (side: ts.Node) => { const name = nameOf(side); return Boolean(name && CREDIT_NAME.test(name)); };
      if ((named(left) && figure(right)) || (named(right) && figure(left))) add(node, "credit threshold with a figure");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

const allowedBy = (finding: Finding) => ALLOWED.find((a) => a.file === finding.file && finding.text.includes(a.text));

test("the scanner catches every way a credit figure can be written, and nothing that is not one", () => {
  const caught = (source: string, file = "x.tsx") => scanCreditLiterals(file, source).map((f) => f.rule);
  /* Caught. */
  expect(caught(`const a = <button>Make · 43 cr</button>;`)).toEqual(["credit figure in text"]);
  expect(caught(`const a = "up to 12 cr";`)).toEqual(["credit figure in text"]);
  expect(caught(`const a = "Top up · 500 cr · $50";`)).toEqual(["credit figure in text"]);
  expect(caught(`const a = "250 credits once";`)).toEqual(["credit figure in text"]);
  expect(caught(`const a = \`Redraw all · \${n} frames · 16 cr\`;`)).toEqual(["credit figure in text"]);
  expect(caught(`const a = "1,240 cr";`)).toEqual(["credit figure in text"]);
  expect(caught(`const a = "0.5 cr";`)).toEqual(["credit figure in text"]);
  expect(caught(`const a = { credits: 43 };`)).toEqual(["price field with a figure"]);
  expect(caught(`const a = { estimatedCredits: 9, cr: 7, upTo: 12, atMost: -3 };`)).toEqual(Array(4).fill("price field with a figure"));
  expect(caught(`const a = <P credits={43} />;`)).toEqual(["price attribute with a figure"]);
  expect(caught(`const a = exact(43); const b = upTo(12); const c = fmtCredits(500);`)).toEqual(Array(3).fill("price helper called with a figure"));
  expect(caught(`const low = s.credits < 100;`)).toEqual(["credit threshold with a figure"]);
  expect(caught(`const low = 50 >= balance;`)).toEqual(["credit threshold with a figure"]);
  /* Not caught: no figure, a zero, a comment, a computed figure, a unit label, a share, a size. */
  expect(caught(`// "Make · 43 cr" in the prototype\n/* up to 12 cr */\nconst a = 1;`)).toEqual([]);
  expect(caught(`const a = \`\${n} cr\`; const b = " cr"; const c = "cr";`)).toEqual([]);
  expect(caught(`const a = { credits: 0 }; const b = exact(n); const c = credits > 0; const d = balance >= 0;`)).toEqual([]);
  expect(caught(`const a = <span style={{ height: 32, fontSize: 13 }}>Low on credits · Top up</span>;`)).toEqual([]);
  expect(caught(`const share = 20; const low = balance * 100 < base * share;`)).toEqual([]);
  expect(caught(`const a = "Shot 3 rendering · about 2 min left"; const b = "4 crew";`)).toEqual([]);
});

test("components/v12 and lib/v12 hold no credit figure: every price comes from the quote engine", () => {
  const files = ROOTS.flatMap(sourceFiles);
  expect(files.length, "the new frame's sources were found").toBeGreaterThan(0);
  const findings = files.flatMap((file) => scanCreditLiterals(file, readFileSync(file, "utf8")));
  const blocking = findings.filter((f) => !allowedBy(f)).map((f) => `${f.file}:${f.line} ${f.rule}: ${f.text}`);
  expect(blocking, "a credit number is written into the new interface: price it with useQuote and <Price>, or <Price quote={null} reason=…> with an entry in lib/v12/unpriced.ts").toEqual([]);
  const stale = ALLOWED.filter((a) => !findings.some((f) => allowedBy(f) === a));
  expect(stale, "an allowance that no longer matches anything: remove it").toEqual([]);
  expect(ALLOWED.every((a) => a.why.trim().length >= 12), "each allowance says why").toBe(true);
});
