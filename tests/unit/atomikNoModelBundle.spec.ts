import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { thinkingModelNames } from "../helpers/uiStrings";

/*
 * The owner, 22 Oct 2026 (Amendment (iii) §E): the model behind each Thinking setting is never disclosed. A browser is sent the code of
 * every module a client component imports, so the modules that hold the text models' ids (the verified text catalogue, the checked-in
 * catalogue snapshot, the platform layer's text jobs, the writer's rates, the direct doors' ids) are the server's alone: no client
 * component reaches one, by a static import or a lazy one. A lazy chunk counts: the shell's chunk map names it, so any member can
 * fetch it, and the platform console is one (components/graphite/screens.tsx loads it lazily). Only the platform desk, a page of its
 * own (/admin, the platform owner's), may: it is where the text jobs are set, and the walk stops at it.
 */
const ROOT = process.cwd();
const SERVER_ONLY = ["lib/atomikModelPolicy.ts", "lib/modelCatalog.json", "lib/platformLayer.ts", "lib/refineGate.ts", "lib/textRoute.ts", "lib/modelAliases.ts"];
/** The platform owner's own page (/admin, its own route and chunks): the walk does not enter it. */
const PLATFORM_OWNER = ["app/(app)/admin/"];

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, ...[".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.tsx"].map((ext) => base + ext)])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}
/** The modules a file imports for their values: static imports and re-exports that are not type-only, and every import(). */
const valueImports = new Map<string, string[]>();
function importsOf(file: string): string[] {
  const known = valueImports.get(file);
  if (known) return known;
  const found: string[] = [];
  if (/\.(?:tsx?|mjs|js)$/.test(file)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const add = (node: ts.Expression | undefined) => { if (node && ts.isStringLiteralLike(node)) { const hit = resolve(file, node.text); if (hit) found.push(hit); } };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const typeOnly = clause?.isTypeOnly || (!!clause && !clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly));
        if (!typeOnly) add(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
        const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
        if (!named || !named.length || named.some((e) => !e.isTypeOnly)) add(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  valueImports.set(file, found);
  return found;
}
/** Every server-only module `start` reaches, each with the path it is reached by; `seen` collects every module the walk enters. */
function reached(start: string, seen: Set<string> = new Set()): string[] {
  const from = new Map<string, string | null>([[start, null]]);
  const queue = [start], hits: string[] = [];
  while (queue.length) {
    const file = queue.shift()!;
    for (const next of importsOf(file)) {
      if (from.has(next) || PLATFORM_OWNER.some((dir) => rel(next).startsWith(dir))) continue;
      from.set(next, file);
      seen.add(rel(next));
      if (SERVER_ONLY.includes(rel(next))) {
        const chain: string[] = [];
        for (let at: string | null = next; at; at = from.get(at) ?? null) chain.unshift(rel(at));
        hits.push(chain.join(" → "));
      } else queue.push(next);
    }
  }
  return hits;
}
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) sources(file, out); }
    else if (/\.(?:tsx?|mjs)$/.test(name)) out.push(file);
  }
  return out;
}
const isClient = (file: string) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(readFileSync(file, "utf8"));

test("no client component bundles a module that holds the text models' ids, lazy chunks included; only the platform desk does", () => {
  /* Why these: each holds model ids the matcher catches. */
  for (const file of SERVER_ONLY) expect(thinkingModelNames(readFileSync(file, "utf8")), file).not.toEqual([]);
  const clients = ["app", "components", "lib"].flatMap((dir) => sources(path.join(ROOT, dir))).filter(isClient)
    .filter((file) => !PLATFORM_OWNER.some((dir) => rel(file).startsWith(dir)));
  expect(clients.length).toBeGreaterThan(100);
  expect(clients.map(rel)).toEqual(expect.arrayContaining(["components/graphite/WorkspaceView.tsx", "components/graphite/settings/advanced/PromptRules.tsx", "components/graphite/SuitesApp.tsx"]));
  expect(clients.flatMap((file) => reached(file))).toEqual([]);
  /* The walk follows a lazy import: the shell reaches the platform console through screens.tsx's dynamic import, and its pages. */
  expect(importsOf(path.join(ROOT, "components/graphite/screens.tsx")).map(rel)).toContain("components/v12/platform/PlatformConsole.tsx");
  const shell = new Set<string>();
  reached(path.join(ROOT, "components/graphite/SuitesApp.tsx"), shell);
  expect([...shell]).toEqual(expect.arrayContaining(["components/v12/platform/PlatformConsole.tsx", "components/v12/platform/Rules.tsx", "components/v12/platform/Limits.tsx"]));
  /* The walk finds such an import where one is: the platform desk reads the text jobs on purpose. */
  expect(reached(path.join(ROOT, "app/(app)/admin/page.tsx"))).toEqual(expect.arrayContaining([expect.stringMatching(/lib\/platformLayer\.ts$/)]));
});
