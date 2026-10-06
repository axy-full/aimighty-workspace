import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, normalize } from "node:path";
import { PAID_PATTERNS, SPEND_LABEL } from "./paidRoutes";

/**
 * Finds the screens that can spend and the buttons that must say what they cost.
 *
 * 1. The paid path. A string that names a paid route (tests/helpers/paidRoutes.ts) puts its enclosing top-level
 *    declaration on the paid path. A declaration that uses (calls, reads, passes) a paid-path declaration is on it too,
 *    across files, by the names it imports. Rendering a component (<Foo />) does not carry the path: the component
 *    owns its own button.
 * 2. The files that matter: .tsx files with JSX and at least one declaration on the paid path. Each must carry the
 *    opt-in (`data-spend`, `spendAttrs(`, `<SpendButton`).
 * 3. The labels: a button whose own text starts with a spend verb (Make, Render, Recreate, Again…) must carry it too.
 *
 * Static analysis cannot see which handler a JSX element runs through a prop, so (2) is per file. The rendered pages
 * close the gap one element at a time: tests/spend-buttons-workbench.spec.ts.
 */

/** A table (an object or array literal) is data: reading it is not a call, so it does not carry the paid path to its readers. */
type Decl = { name: string; refs: Set<string>; called: Set<string>; routes: Set<string>; direct: Set<string>; data: boolean };
type Mod = {
  path: string;
  tops: Map<string, Decl>;
  imports: Map<string, { from: string | null; name: string }>;
  exports: Map<string, string>;
  reexports: Map<string, { from: string; name: string }>;
  starFrom: string[];
  hasJsx: boolean;
  /** A button, a form or an onClick: the file renders something a person can press. */
  hasControl: boolean;
  optedIn: boolean;
  labels: { line: number; label: string }[];
};

const SCOPE = ["app/", "components/", "lib/"];

export function sourceFiles(): string[] {
  const run = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.split("\n").filter((path) => /\.tsx?$/.test(path) && !/\.d\.ts$/.test(path) && SCOPE.some((root) => path.startsWith(root)) && !path.startsWith("app/api/") && existsSync(path));
}

/** A string or template as the text a route check reads: holes are `{}`. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => "{}" + span.literal.text).join("");
  return null;
}

const PASCAL = /^[A-Z][a-z]/;

function resolve(from: string, spec: string, files: Set<string>): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? normalize(join(dirname(from), spec)) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (files.has(candidate)) return candidate;
  return null;
}

function parse(path: string, files: Set<string>, read: (path: string) => string): Mod {
  const source = read(path);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const mod: Mod = { path, tops: new Map(), imports: new Map(), exports: new Map(), reexports: new Map(), starFrom: [], hasJsx: false, hasControl: false, optedIn: false, labels: [] };

  const declare = (name: string, node: ts.Node, exported: boolean) => {
    let init: ts.Node | undefined = ts.isVariableDeclaration(node) ? node.initializer : undefined;
    while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init) || ts.isNonNullExpression(init))) init = init.expression;
    const decl: Decl = { name, refs: new Set(), called: new Set(), routes: new Set(), direct: new Set(), data: !!init && (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) };
    const visit = (n: ts.Node) => {
      if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
      if (ts.isImportDeclaration(n)) return;
      const text = literalText(n);
      if (text !== null && text.startsWith("/api/")) {
        for (const route of PAID_PATTERNS) if (route.pattern.test(text)) decl.direct.add(route.dir);
      }
      if (ts.isIdentifier(n)) {
        const parent = n.parent;
        const isName = (ts.isPropertyAccessExpression(parent) && parent.name === n) || (ts.isPropertyAssignment(parent) && parent.name === n)
          || (ts.isJsxAttribute(parent) && parent.name === n) || (ts.isJsxOpeningElement(parent) && parent.tagName === n)
          || (ts.isJsxClosingElement(parent) && parent.tagName === n) || (ts.isJsxSelfClosingElement(parent) && parent.tagName === n)
          || (ts.isBindingElement(parent) && parent.propertyName === n) || (ts.isParameter(parent) && parent.name === n)
          || (ts.isPropertySignature(parent) && parent.name === n) || (ts.isMethodDeclaration(parent) && parent.name === n);
        const callee = ts.isCallExpression(parent) && parent.expression === n;
        if (!isName && (callee || !PASCAL.test(n.text))) decl.refs.add(n.text);
        if (!isName && callee) decl.called.add(n.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    const had = mod.tops.get(name);
    if (had) { had.refs.forEach((r) => decl.refs.add(r)); had.called.forEach((r) => decl.called.add(r)); had.direct.forEach((r) => decl.direct.add(r)); }
    mod.tops.set(name, decl);
    if (exported) mod.exports.set(name, name);
  };

  const hasExport = (node: ts.Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const hasDefault = (node: ts.Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  const bindingNames = (name: ts.BindingName): string[] => (ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name))));

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause && ts.isStringLiteral(stmt.moduleSpecifier) && !stmt.importClause.isTypeOnly) {
      const from = resolve(path, stmt.moduleSpecifier.text, files);
      const clause = stmt.importClause;
      if (clause.name) mod.imports.set(clause.name.text, { from, name: "default" });
      const named = clause.namedBindings;
      if (named && ts.isNamedImports(named)) for (const el of named.elements) if (!el.isTypeOnly) mod.imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
      if (named && ts.isNamespaceImport(named)) mod.imports.set(named.name.text, { from, name: "*" });
    } else if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text ?? "default";
      declare(name, stmt, hasExport(stmt));
      if (hasExport(stmt) && hasDefault(stmt)) mod.exports.set("default", name);
    } else if (ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text ?? "default";
      declare(name, stmt, hasExport(stmt));
      if (hasExport(stmt) && hasDefault(stmt)) mod.exports.set("default", name);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) for (const name of bindingNames(d.name)) declare(name, d, hasExport(stmt));
    } else if (ts.isExportAssignment(stmt)) {
      declare("default", stmt.expression, true);
    } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
      const from = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? resolve(path, stmt.moduleSpecifier.text, files) : null;
      if (!stmt.exportClause) { if (from) mod.starFrom.push(from); continue; }
      if (ts.isNamedExports(stmt.exportClause)) for (const el of stmt.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const exported = el.name.text; const local = (el.propertyName ?? el.name).text;
        if (stmt.moduleSpecifier) { if (from) mod.reexports.set(exported, { from, name: local }); } else mod.exports.set(exported, local);
      }
    }
  }

  /* JSX facts: any JSX, the opt-in, and the labels of buttons. */
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) mod.hasJsx = true;
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "data-spend") mod.optedIn = true;
    if (ts.isJsxAttribute(n) && /^on(Click|Submit|Press)$/.test(n.name.getText(sf))) mod.hasControl = true;
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^(button|Button|SpendButton|form)$/.test(n.tagName.getText(sf))) mod.hasControl = true;
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === "SpendButton") mod.optedIn = true;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^spendAttrs\w*$/.test(n.expression.text)) mod.optedIn = true;
    if (ts.isJsxElement(n) && /^(button|Button)$/.test(n.openingElement.tagName.getText(sf))) {
      const attrs = n.openingElement.attributes.properties;
      const marked = attrs.some((a) => (ts.isJsxAttribute(a) && a.name.getText(sf) === "data-spend") || ts.isJsxSpreadAttribute(a) && /spendAttrs\w*\(/.test(a.expression.getText(sf)));
      const texts: string[] = [];
      for (const child of n.children) {
        if (ts.isJsxText(child)) texts.push(child.text.replace(/\s+/g, " ").trim());
        else if (ts.isJsxExpression(child) && child.expression) { const t = literalText(child.expression); if (t !== null) texts.push(t.trim()); }
      }
      const aria = attrs.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "aria-label");
      const ariaText = aria?.initializer && ts.isStringLiteral(aria.initializer) ? aria.initializer.text : null;
      const label = [texts.find((t) => t), ariaText].find((t) => t && SPEND_LABEL.test(t));
      if (label && !marked) mod.labels.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, label });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return mod;
}

export type SpendSite = {
  path: string; routes: string[]; declarations: string[]; optedIn: boolean;
  /** For each route: the chain of declarations from this file's own to the string that names the route. */
  chains: Record<string, string[]>;
  /** Elements with a press handler that reaches a paid declaration by name. A guide, not a verdict: verify each. */
  candidates: { line: number; tag: string; attr: string; text: string; strong: boolean }[];
};
export type SpendReport = {
  /** Component files on the paid path, with the routes they reach. */
  sites: SpendSite[];
  /** Buttons whose label is a spend verb and that do not carry data-spend. */
  labels: { path: string; line: number; label: string }[];
};

export function scanSpend(files = sourceFiles(), read: (path: string) => string = (path) => readFileSync(path, "utf8")): SpendReport {
  const set = new Set(files);
  const mods = new Map(files.map((path) => [path, parse(path, set, read)]));

  /** Follow imports and re-exports to the module that declares a name. */
  const origin = (path: string, name: string, depth = 0): { path: string; name: string } | null => {
    const mod = mods.get(path);
    if (!mod || depth > 8) return null;
    const local = mod.exports.get(name);
    if (local !== undefined) {
      const imported = mod.imports.get(local);
      return mod.tops.has(local) || !imported?.from ? { path, name: local } : origin(imported.from, imported.name, depth + 1);
    }
    const re = mod.reexports.get(name);
    if (re) return origin(re.from, re.name, depth + 1);
    for (const from of mod.starFrom) { const found = origin(from, name, depth + 1); if (found && mods.get(found.path)?.tops.has(found.name)) return found; }
    return null;
  };

  /* routes[decl] grows until nothing changes. */
  const key = (path: string, name: string) => `${path}#${name}`;
  const routes = new Map<string, Set<string>>();
  /** Why a declaration is on the path to a route: the declaration it got the route from. */
  const via = new Map<string, string>();
  for (const mod of mods.values()) for (const decl of mod.tops.values()) routes.set(key(mod.path, decl.name), new Set(decl.direct));
  for (let changed = true; changed;) {
    changed = false;
    for (const mod of mods.values()) {
      for (const decl of mod.tops.values()) {
        const mine = routes.get(key(mod.path, decl.name))!;
        let source = "";
        const take = (from: Set<string> | undefined) => { if (from) for (const r of from) if (!mine.has(r)) { mine.add(r); changed = true; via.set(`${key(mod.path, decl.name)}|${r}`, source); } };
        for (const ref of decl.refs) {
          if (ref !== decl.name && mod.tops.has(ref)) {
            if (mod.tops.get(ref)!.data && !decl.called.has(ref)) continue;
            source = key(mod.path, ref); take(routes.get(source)); continue;
          }
          const imported = mod.imports.get(ref);
          if (!imported?.from) continue;
          if (imported.name === "*") {
            const target = mods.get(imported.from);
            if (target) for (const exported of target.exports.keys()) { const o = origin(imported.from, exported); if (o) { source = key(o.path, o.name); take(routes.get(source)); } }
            continue;
          }
          const o = origin(imported.from, imported.name);
          if (o && !(mods.get(o.path)?.tops.get(o.name)?.data && !decl.called.has(ref))) { source = key(o.path, o.name); take(routes.get(source)); }
        }
      }
    }
  }

  /** The names in a file that stand for something on the paid path, and the press handlers that use them. */
  const candidatesOf = (mod: Mod): SpendSite["candidates"] => {
    const paid = new Set<string>();
    for (const decl of mod.tops.values()) {
      for (const ref of decl.refs) {
        const local = ref !== decl.name && mod.tops.get(ref);
        if (local) { if (routes.get(key(mod.path, ref))!.size && !(local.data && !decl.called.has(ref))) paid.add(ref); continue; }
        const imported = mod.imports.get(ref);
        if (!imported?.from) continue;
        const o = imported.name === "*" ? null : origin(imported.from, imported.name);
        if (imported.name === "*" ? mods.get(imported.from)?.exports.size : o && routes.get(key(o.path, o.name))?.size) paid.add(ref);
      }
      if (decl.direct.size) paid.add(decl.name);
    }
    const sf = ts.createSourceFile(mod.path, read(mod.path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    /** `strong` is a direct use of a paid function (called or passed); weak is through an object (`composer.dispatch`), which may be anything on it. */
    const uses = (node: ts.Node, strong = false): boolean => {
      let found = false;
      const walk = (n: ts.Node) => {
        if (found) return;
        if (ts.isIdentifier(n) && paid.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
          if (!strong || !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) { found = true; return; }
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
      return found;
    };
    /* A nested function or constant that uses a paid name is itself one. */
    for (let grew = true; grew;) {
      grew = false;
      const visit = (n: ts.Node) => {
        if ((ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) || (ts.isFunctionDeclaration(n) && n.name && n.body)) {
          const name = (n as ts.VariableDeclaration | ts.FunctionDeclaration).name!.getText(sf);
          if (!paid.has(name) && uses(ts.isVariableDeclaration(n) ? n.initializer! : n.body!)) { paid.add(name); grew = true; }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const out: SpendSite["candidates"] = [];
    const SKIP = /^on(Change|Input|Focus|Blur|Key\w*|Mouse\w*|Pointer\w*|Drag\w*|Drop|Scroll|Close|Cancel|Dismiss|Select|OpenChange|Toggle|Resize|Load|Error)$/;
    const labelOf = (el: ts.JsxElement | ts.JsxSelfClosingElement) => {
      const attrs = (ts.isJsxElement(el) ? el.openingElement : el).attributes.properties;
      const aria = attrs.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && /^(aria-label|label|title|data-testid)$/.test(a.name.getText(sf)));
      const own = aria?.initializer && ts.isStringLiteral(aria.initializer) ? aria.initializer.text : "";
      const kids = ts.isJsxElement(el) ? el.children.map((c) => (ts.isJsxText(c) ? c.text : ts.isJsxExpression(c) && c.expression ? (literalText(c.expression) ?? "") : "")).join(" ") : "";
      return (own || kids).replace(/\s+/g, " ").trim().slice(0, 50);
    };
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const opening = ts.isJsxElement(n) ? n.openingElement : n;
        for (const a of opening.attributes.properties) {
          if (!ts.isJsxAttribute(a) || !/^on[A-Z]/.test(a.name.getText(sf)) || SKIP.test(a.name.getText(sf)) || !a.initializer || !uses(a.initializer)) continue;
          out.push({ line: sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1, tag: opening.tagName.getText(sf), attr: a.name.getText(sf), text: labelOf(n), strong: uses(a.initializer, true) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  };

  const sites: SpendSite[] = [];
  const labels: SpendReport["labels"] = [];
  for (const mod of [...mods.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const hit of mod.labels) labels.push({ path: mod.path, ...hit });
    if (!mod.path.endsWith(".tsx") || !mod.hasJsx || !mod.hasControl) continue;
    const reach = new Set<string>();
    const declarations: string[] = [];
    const chains: Record<string, string[]> = {};
    for (const decl of mod.tops.values()) {
      const r = routes.get(key(mod.path, decl.name))!;
      if (!r.size) continue;
      declarations.push(decl.name);
      for (const route of r) {
        reach.add(route);
        if (chains[route]) continue;
        const chain = [key(mod.path, decl.name)];
        for (let at = chain[0]; via.get(`${at}|${route}`) && chain.length < 12; ) { at = via.get(`${at}|${route}`)!; chain.push(at); }
        chains[route] = chain;
      }
    }
    if (reach.size) sites.push({ path: mod.path, routes: [...reach].sort(), declarations, optedIn: mod.optedIn, chains, candidates: candidatesOf(mod) });
  }
  return { sites, labels };
}
