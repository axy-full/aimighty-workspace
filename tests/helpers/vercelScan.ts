import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * What counts as Vercel in this repository, for the guard (tests/unit/vercelOut.spec.ts; plan docs/plans/vercel-out.md section 4).
 *
 * Code is read as syntax, never as text: comments are not syntax, so "on Vercel" in a comment never counts. The bare word "vercel" is never counted (the ledger's
 * 'vercel' engine, 'vercel-sandbox', the 'gateway' setting value and the render worker's /vercel/sandbox path are names in old rows and in our own protocol, not Vercel use).
 */
export type Kind = "import" | "removed-module" | "env" | "host";
export type Hit = { kind: Kind; text: string; line: number };

/** Modules whose import is Vercel's. */
export const bannedSpecifier = (spec: string) => spec.startsWith("@vercel/") || spec === "@ai-sdk/gateway" || spec.startsWith("@ai-sdk/gateway/");
/** Our own modules that carry Vercel and go; an import that resolves to one counts, so nothing new can lean on them. */
export const REMOVED_MODULES = ["lib/gateway", "lib/vercelKeys", "lib/engines/vercel", "lib/storage/blob"];
const ENV_NAME = /\b(?:VERCEL(?:_[A-Z0-9_]+)?|AI_GATEWAY_[A-Z0-9_]+)\b/g;
const ENV_EXACT = /^(?:VERCEL(?:_[A-Z0-9_]+)?|AI_GATEWAY_[A-Z0-9_]+)$/;
const HOST = /vercel\.app|vercel\.sh|vercel\.com|vercel-storage\.com|x-vercel-|vercel-cron/i;

/** A module specifier as a path from the repository root without its extension, or null for a package. */
export function resolved(spec: string, from: string): string | null {
  let target: string | null = null;
  if (spec.startsWith("@/")) target = spec.slice(2);
  else if (spec.startsWith(".")) target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return target ? target.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "") : null;
}
const removedModule = (spec: string, from: string) => { const r = resolved(spec, from); return r !== null && REMOVED_MODULES.includes(r); };

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = { ".ts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX, ".mts": ts.ScriptKind.TS, ".cts": ts.ScriptKind.TS, ".js": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX };
export const isScript = (file: string) => path.extname(file) in SCRIPT_KINDS;

/** Everything in one script file that names Vercel, by syntax. `tests` also counts a string that IS a banned module name (a module mock, a dead one included). */
export function scanScript(text: string, file: string, options: { mocks?: boolean } = {}): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[path.extname(file)] ?? ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const specifiers = new Set<ts.Node>();
  const specifier = (node: ts.Node | undefined) => {
    if (!node) return;
    const lit = ts.isLiteralTypeNode(node) ? node.literal : node;
    if (ts.isStringLiteralLike(lit)) specifiers.add(lit);
  };
  const classify = (spec: string, node: ts.Node) => {
    if (bannedSpecifier(spec)) hits.push({ kind: "import", text: spec, line: at(node) });
    else if (removedModule(spec, file)) hits.push({ kind: "removed-module", text: spec, line: at(node) });
  };
  const literal = (value: string, node: ts.Node) => {
    for (const m of value.matchAll(ENV_NAME)) hits.push({ kind: "env", text: m[0], line: at(node) });
    const host = HOST.exec(value);
    if (host) hits.push({ kind: "host", text: host[0].toLowerCase(), line: at(node) });
  };
  const walk = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node)) specifier(node.argument);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier(node.arguments[0]);
    if (ts.isIdentifier(node)) { if (ENV_EXACT.test(node.text)) hits.push({ kind: "env", text: node.text, line: at(node) }); }
    else if (ts.isStringLiteralLike(node)) {
      if (specifiers.has(node)) classify(node.text, node);
      else if (options.mocks && (bannedSpecifier(node.text) || ((node.text.startsWith("@/lib/") || node.text.startsWith(".")) && removedModule(node.text, file)))) hits.push({ kind: bannedSpecifier(node.text) ? "import" : "removed-module", text: node.text, line: at(node) });
      else literal(node.text, node);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literal(node.text, node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return hits;
}

/** Shell, YAML and Dockerfiles: a line is code until its first `#` that starts a comment (a `#` after whitespace or at the start). */
export function scanText(text: string, file: string): Hit[] {
  const hits: Hit[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "$1");
    for (const m of line.matchAll(ENV_NAME)) hits.push({ kind: "env", text: m[0], line: i + 1 });
    const host = HOST.exec(line);
    if (host) hits.push({ kind: "host", text: host[0].toLowerCase(), line: i + 1 });
  });
  void file;
  return hits;
}

/** The scripts of package.json, read as the commands they are. */
export function scanManifestScripts(text: string): Hit[] {
  const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
  return Object.entries(scripts).flatMap(([name, command]) => scanText(command, `package.json#${name}`).map((h) => ({ ...h, line: 0 })));
}

export const git = (...args: string[]) => {
  const out = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.stdout;
};
export const tracked = (): string[] => git("ls-files").split("\n").filter(Boolean);

/** Roots read as app code, and the root files that belong with them. Docs, markdown, fixtures, design and brand are never read. */
export const SOURCE_ROOTS = ["app/", "lib/", "components/", "mcp/", "scripts/", "ops/", ".github/"];
export const SOURCE_FILES = ["proxy.ts", "instrumentation.ts", "next.config.ts"];
const TEXT_NAMES = (file: string) => /\.(?:ya?ml|sh)$/.test(file) || /(?:^|\/)Dockerfile$/.test(file);

export type Counts = { source: Record<string, number>; tests: Record<string, number>; hits: Record<string, Hit[]> };

/** Every tracked file's count, in the two groups the allowance file keeps (source and tests). */
export function scanRepository(files: string[] = tracked(), own: string[] = []): Counts {
  const counts: Counts = { source: {}, tests: {}, hits: {} };
  for (const file of files) {
    if (own.includes(file) || file.endsWith(".md") || file.startsWith("docs/") || file.startsWith("tests/fixtures/") || !existsSync(file)) continue;
    const isTest = file.startsWith("tests/");
    const isSource = SOURCE_FILES.includes(file) || SOURCE_ROOTS.some((root) => file.startsWith(root));
    if (!isTest && !isSource) continue;
    let hits: Hit[] = [];
    const text = readFileSync(file, "utf8");
    if (isScript(file)) hits = scanScript(text, file, { mocks: isTest });
    else if (!isTest && TEXT_NAMES(file)) hits = scanText(text, file);
    if (isTest) hits = hits.filter((h) => h.kind === "import" || h.kind === "removed-module");
    if (hits.length) { (isTest ? counts.tests : counts.source)[file] = hits.length; counts.hits[file] = hits; }
  }
  if (existsSync("package.json")) {
    const hits = scanManifestScripts(readFileSync("package.json", "utf8"));
    if (hits.length) { counts.source["package.json"] = hits.length; counts.hits["package.json"] = hits; }
  }
  return counts;
}

/** package.json dependency keys that are Vercel's, and package-lock entries that are, each with who pulls it in. */
export function manifestHits(): string[] {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, Record<string, string> | undefined>;
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((section) => Object.keys(manifest[section] ?? {}).filter((name) => name.startsWith("@vercel/") || name === "@ai-sdk/gateway").map((name) => `${section}:${name}`));
}
export function lockfileHits(): { key: string; via: string[] }[] {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages?: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }> };
  const packages = lock.packages ?? {};
  const banned = (key: string) => { const name = key.split("node_modules/").pop() ?? ""; return name.startsWith("@vercel/") || name === "@ai-sdk/gateway"; };
  return Object.keys(packages).filter((key) => key && banned(key)).sort().map((key) => {
    const name = key.split("node_modules/").pop()!;
    const via = Object.entries(packages).filter(([from, p]) => from && [p.dependencies, p.optionalDependencies, p.peerDependencies].some((deps) => deps && name in deps)).map(([from]) => from.split("node_modules/").pop()!);
    return { key, via: [...new Set(via)].sort() };
  });
}
export const trackedForbidden = (files: string[] = tracked()) => files.filter((f) => f === "vercel.json" || f === "public/vercel.svg" || f.startsWith(".vercel/") || f.includes("/.vercel/"));
