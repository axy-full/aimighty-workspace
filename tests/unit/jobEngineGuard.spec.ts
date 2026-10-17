import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/*
 * NEW GUARD (stricter only), v30 PR A3 (docs/plans/v30-data-model.md § 4.4): a v30 job's engine is read by two files
 * alone, the store (lib/quotedJobs/store.ts) and the serializer (lib/jobView.ts). Every other file that names the
 * `quoted_jobs` table may not read its engine column, by name or through `*`, so no read model can send an Agent job's
 * engine without going through the serializer (owner's brief, rule 1).
 *
 * And: only the files on IMPORTERS below may import the store or the serializer (none yet: v30 jobs have no route), and
 * only the store names its test-only builder.
 */

/**
 * The files allowed to import lib/quotedJobs/* or lib/jobView.ts from outside them. EMPTY while v30 jobs have no route.
 * PR A9 (History read models) is planned to add its route here: a named, owner-visible addition in its own PR body,
 * which must keep going through lib/jobView.ts. An entry that no longer imports them fails, so the list cannot go stale.
 */
const IMPORTERS: readonly string[] = [];

const STORE = path.join("lib", "quotedJobs", "store.ts");
const VIEW = path.join("lib", "jobView.ts");
const ALLOWED = new Set([STORE, VIEW]);

/* Source files under a root. Never follows a symbolic link; node_modules and .git are skipped at any depth, and `skipHere`
   names directories skipped directly under this root only. */
const ALWAYS_SKIP = new Set(["node_modules", ".git"]);
const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const walk = (root: string, skipHere: ReadonlySet<string> = new Set()): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const full = root === "." ? entry.name : path.join(root, entry.name);
    if (entry.isDirectory()) return ALWAYS_SKIP.has(entry.name) || skipHere.has(entry.name) ? [] : walk(full);
    return entry.isFile() && SOURCE.test(entry.name) ? [full] : [];
  });

/** Every string a file writes: string literals, and template literals with their `${…}` parts read as a space. */
function literals(file: string, text: string): string[] {
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : /\.(mjs|cjs|js)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) out.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" "));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const NAMES_TABLE = /\bquoted_jobs\b/i;
const SQL = /\b(select|from|join|where|returning|update|insert|values|group\s+by|order\s+by)\b/i;
const ENGINE_COLUMN = /\bengine\b/i;
const STAR = /(\bselect\s+(distinct\s+)?\*|\b\w+\.\*|\breturning\s+\*)/i;

/** Why a file outside the two allowed ones would read a job's engine; empty when it does not. */
function engineReads(file: string, text: string): string[] {
  if (ALLOWED.has(file) || !NAMES_TABLE.test(text)) return [];
  const found: string[] = [];
  for (const literal of literals(file, text)) {
    const sql = SQL.test(literal);
    /* Strictest reading: a file that names the table may not name an `engine` column in ANY SQL it writes, so neither a
       join nor a table name held in a constant can carry it. */
    if (sql && ENGINE_COLUMN.test(literal)) found.push(`names the engine column: ${literal.slice(0, 120)}`);
    if (NAMES_TABLE.test(literal) && STAR.test(literal)) found.push(`reads every column of quoted_jobs: ${literal.slice(0, 120)}`);
  }
  return found;
}

const ROOT_SKIP = new Set([".next", ".claude", "tests", "test-results", "coverage", "out", "build", "dist", ".vercel", ".data"]);
const vendor = path.join("public", "vendor") + path.sep;
const scanned = () => walk(".", ROOT_SKIP).filter((f) => !f.startsWith(vendor));

test("the guard catches a read of the engine column (checked against synthetic sources, so it can fail)", () => {
  const bad: [string, string][] = [
    ["lib/history.ts", "db.execute(`SELECT id, engine FROM quoted_jobs WHERE workspace_id=?`)"],
    ["lib/history.ts", "db.execute(\"SELECT j.engine AS e FROM agent_commands c JOIN quoted_jobs j ON j.command_id=c.id\")"],
    ["lib/history.ts", "const T = 'quoted_jobs'; db.execute(`SELECT engine FROM ${T}`)"],
    ["lib/history.ts", "db.execute('SELECT * FROM quoted_jobs')"],
    ["lib/history.ts", "db.execute(`SELECT j.* FROM quoted_jobs j`)"],
    ["app/api/history/route.ts", "sql: `UPDATE quoted_jobs SET status='x' WHERE 1 RETURNING *`"],
    ["components/History.tsx", "const q = <div>{fetch(`/x?sql=${'select engine from quoted_jobs'}`)}</div>;"],
  ];
  for (const [file, text] of bad) expect(engineReads(file, text), text).not.toEqual([]);
  const fine: [string, string][] = [
    ["lib/history.ts", "db.execute(`SELECT id, status, quote_tenths FROM quoted_jobs WHERE workspace_id=?`)"],
    ["lib/meter.ts", "db.execute(`SELECT engine FROM meter_events`)"], // does not name the jobs table
    ["lib/history.ts", "// quoted_jobs.engine is private\nconst copy = 'The engine timed out';"], // a comment, and copy that is not SQL
    [STORE, "SELECT j.* , engine FROM quoted_jobs j"],
    [VIEW, "SELECT engine FROM quoted_jobs"],
  ];
  for (const [file, text] of fine) expect(engineReads(file, text), text).toEqual([]);
});

test("no file but the store and lib/jobView.ts reads a v30 job's engine column", () => {
  const files = scanned();
  // The walk reaches the whole repository outside tests and build output.
  for (const covered of ["proxy.ts", "instrumentation.ts", STORE, VIEW]) expect(files).toContain(covered);
  for (const prefix of ["app", "components", "lib", "scripts", "mcp"]) expect(files.some((f) => f.startsWith(prefix + path.sep)), prefix).toBe(true);
  const offenders = files.flatMap((file) => engineReads(file, readFileSync(file, "utf8")).map((why) => `${file}: ${why}`));
  expect(offenders).toEqual([]);
  // The store does read it (so the guard is pointed at the right column).
  expect(readFileSync(STORE, "utf8")).toMatch(/\bengine TEXT\b/);
});

test("only the listed importers (none yet) import the store or the serializer, and only the store names its test-only builder", async () => {
  const files = scanned();
  const ours = (f: string) => f === VIEW || f.startsWith(path.join("lib", "quotedJobs") + path.sep);
  const importers = files
    .filter((f) => !ours(f))
    .filter((f) => /(quotedJobs|jobView)(["'/]|\.ts)/.test(readFileSync(f, "utf8")));
  expect(importers).toEqual([...IMPORTERS]);
  expect(files.filter((f) => readFileSync(f, "utf8").includes("jobStoreForTests"))).toEqual([STORE]);

  // The store's class is not exported under any name: the factory (db() with requireTenant().id) is the only way in.
  const store = await import("../../lib/quotedJobs/store");
  const { createPlatformDatabaseClient } = await import("../../lib/localDatabaseClient");
  const client = createPlatformDatabaseClient({ url: ":memory:" });
  try {
    const StoreClass = store.jobStoreForTests(client, "ws_identity_probe").constructor;
    expect(Object.values(store)).not.toContain(StoreClass);
  } finally {
    client.close();
  }
  const text = readFileSync(STORE, "utf8");
  expect([...text.matchAll(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g)].map((x) => x[1])).toEqual(["QuotedJobError"]);
  expect(text).not.toMatch(/export\s*\{[^}]*\bJobStore\b/);
  expect(text).not.toMatch(/export\s+default\b/);
  // Every read the store offers returns the serializer's output, never a raw row.
  // Its reads of raw rows are #private (runtime-private, not only to the type checker); no public method returns one.
  expect(text).not.toMatch(/async\s+\w+\([^)]*\)[^{]*Promise<Row/);
  for (const name of ["read", "rows", "jobRow", "commandRow", "scoped", "write", "client"]) expect(text, name).toMatch(new RegExp(`#${name}\\b`));
  expect(text).not.toMatch(/\bprivate\s/);
});
