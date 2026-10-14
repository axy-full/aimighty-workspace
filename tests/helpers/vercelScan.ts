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
export type Kind = "import" | "removed-module" | "env" | "host" | "cli";
export type Hit = { kind: Kind; text: string; line: number };

/** Modules whose import is Vercel's. */
export const bannedSpecifier = (spec: string) =>
  spec.startsWith("@vercel/") || spec === "@ai-sdk/gateway" || spec.startsWith("@ai-sdk/gateway/") || spec === "vercel" || spec.startsWith("vercel/");
/** The scoped names alone: as a bare string "vercel" is also the ledger's engine name, only an import counts for the unscoped package. */
const bannedScoped = (spec: string) => spec.startsWith("@vercel/") || spec === "@ai-sdk/gateway" || spec.startsWith("@ai-sdk/gateway/");
/** A package name as a dependency or lockfile entry: Vercel's own, the gateway, or the unscoped CLI package. */
export const bannedPackage = (name: string) => name.startsWith("@vercel/") || name === "@ai-sdk/gateway" || name === "vercel";
/** An alias such as "npm:@vercel/blob@1" names the real package after the colon. */
export const aliasOf = (range: string) => (range.startsWith("npm:") ? range.slice(4).replace(/@[^@/]*$/, "") : null);
/** Our own modules that carry Vercel and go; an import that resolves to one counts, so nothing new can lean on them. */
export const REMOVED_MODULES = ["lib/gateway", "lib/vercelKeys", "lib/engines/vercel", "lib/storage/blob"];
const ENV_NAME = /\b(?:VERCEL(?:_[A-Z0-9_]+)?|AI_GATEWAY_[A-Z0-9_]+)\b/g;
const ENV_EXACT = /^(?:VERCEL(?:_[A-Z0-9_]+)?|AI_GATEWAY_[A-Z0-9_]+)$/;
const HOST = /vercel\.app|vercel\.sh|vercel\.com|vercel-storage\.com|x-vercel-|vercel-cron/i;
/** The Vercel CLI or its GitHub action used from a script, a package.json command or a workflow. */
const CLI = /\b(?:npx\s+)?vercel\s+(?:deploy|build|pull|env|link|--prod)\b|\bvercel-action\b|\bamondnet\/vercel-action\b/i;

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
    const cli = CLI.exec(value);
    if (cli) hits.push({ kind: "cli", text: "vercel CLI", line: at(node) });
  };
  const walk = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node)) specifier(node.argument);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier(node.arguments[0]);
    if (ts.isIdentifier(node)) { if (ENV_EXACT.test(node.text)) hits.push({ kind: "env", text: node.text, line: at(node) }); }
    else if (ts.isStringLiteralLike(node)) {
      if (specifiers.has(node)) classify(node.text, node);
      /* A string that IS a banned package name counts wherever it is (require.resolve("@vercel/blob"), a module mock, const m = "@vercel/blob"); a module of ours that goes counts in tests as a mock. */
      else if (bannedScoped(node.text)) hits.push({ kind: "import", text: node.text, line: at(node) });
      else if (options.mocks && (node.text.startsWith("@/lib/") || node.text.startsWith(".")) && removedModule(node.text, file)) hits.push({ kind: "removed-module", text: node.text, line: at(node) });
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
    if (CLI.test(line)) hits.push({ kind: "cli", text: "vercel CLI", line: i + 1 });
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

/** Never read as code: documents, the design and brand folders, fixtures, assets, the tools' own settings. Everything else tracked is read by default, root files included. */
export const NOT_SCANNED = ["docs/", "design/", "brand/", ".claude/", "tests/fixtures/", "public/", "node_modules/"];
const TEXT_NAMES = (file: string) => /\.(?:ya?ml|sh)$/.test(file) || /(?:^|\/)Dockerfile$/.test(file);

export type Counts = { source: Record<string, number>; tests: Record<string, number>; hits: Record<string, Hit[]> };

/** Every tracked file's count, in the two groups the allowance file keeps (source and tests). */
export function scanRepository(files: string[] = tracked(), own: string[] = []): Counts {
  const counts: Counts = { source: {}, tests: {}, hits: {} };
  for (const file of files) {
    if (own.includes(file) || file.endsWith(".md") || NOT_SCANNED.some((prefix) => file.startsWith(prefix)) || !existsSync(file)) continue;
    const isTest = file.startsWith("tests/");
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
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((section) =>
    Object.entries(manifest[section] ?? {}).filter(([name, range]) => bannedPackage(name) || bannedPackage(aliasOf(String(range)) ?? "")).map(([name]) => `${section}:${name}`));
}
export function lockfileHits(): { key: string; via: string[] }[] {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages?: Record<string, { name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }> };
  const packages = lock.packages ?? {};
  /* The real name of an installed package: its path's last segment, or the `name` field an alias carries. */
  const nameOf = (key: string) => packages[key]?.name ?? key.split("node_modules/").pop() ?? "";
  return Object.keys(packages).filter((key) => key && bannedPackage(nameOf(key))).sort().map((key) => {
    const name = key.split("node_modules/").pop()!;
    const via = Object.entries(packages).filter(([from, p]) => from && [p.dependencies, p.optionalDependencies, p.peerDependencies].some((deps) => deps && (name in deps || Object.values(deps).some((range) => aliasOf(range) === nameOf(key))))).map(([from]) => from.split("node_modules/").pop()!);
    return { key, via: [...new Set(via)].sort() };
  });
}
export const trackedForbidden = (files: string[] = tracked()) =>
  files.filter((f) => f === "vercel.json" || f === ".vercelignore" || f === "vercel.ts" || f === "public/vercel.svg" || f.startsWith(".vercel/") || f.includes("/.vercel/") || f.endsWith("/vercel.json") || f.endsWith("/.vercelignore"));
