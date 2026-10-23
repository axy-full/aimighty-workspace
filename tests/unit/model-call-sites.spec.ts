import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { MODEL_CALL_FILES, SDK_CONSTRUCTS, closedListProblems, constructCounts, stripComments } from "../helpers/modelCallSites";

/**
 * The closed list of model calls (tests/helpers/modelCallSites.ts), held to the source. Every model call Atomik (or
 * anything else in lib/ and app/) makes is a listed site wrapped by its id (traceModelCall, openModelCall, or runPaidText's
 * `trace: { site: ... }`), behind a listed door; a new one cannot
 * land unlisted, and a listed one cannot quietly disappear. What each site's span carries is proven by
 * tests/unit/model-trace.spec.ts.
 */

const root = process.cwd();
const code = stripComments;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) sources(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(rel.split(path.sep).join("/"));
  }
  return out;
}
const counts = (file: string) => constructCounts(readFileSync(path.join(root, file), "utf8"));

test("every file in lib/ and app/ with a model-call construct is on the closed list, with its exact counts; no door under another name; every agent call inside modelDoor", () => {
  const scanned = [...sources("lib"), ...sources("app")];
  expect(scanned.length).toBeGreaterThan(200);
  expect(closedListProblems(scanned.map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") })))).toEqual([]);
});

/* The stricter checks, shown to fire: each planted source (tests/fixtures/model-call-guard/, never compiled or imported) fails. */
for (const [fixture, as, expected] of [
  ["second-generate.txt", "lib/workbench/suite-agent.ts", [/has .*"agentGenerate":2.*the list says/, /an agent call outside modelDoor at line \d+/]],
  ["aliased-door.txt", "lib/planted-alias.ts", [/textPost is used under another name/, /gatewayPost is used under another name/]],
  ["base-url-fetch.txt", "lib/planted-fetch.ts", [/lib\/planted-fetch\.ts: \{"baseUrl":2\} is not in/]],
] as const) test(`the guard fails on a planted ${fixture.replace(/\.txt$/, "").replace(/-/g, " ")}`, () => {
  const text = readFileSync(path.join(root, "tests/fixtures/model-call-guard", fixture), "utf8");
  const problems = closedListProblems([{ file: as, text }]);
  for (const pattern of expected) expect(problems.some((p) => pattern.test(p)), `${pattern} in ${JSON.stringify(problems)}`).toBe(true);
});

test("every listed file exists, is listed once, and says what it is", () => {
  expect(new Set(MODEL_CALL_FILES.map((e) => e.file)).size).toBe(MODEL_CALL_FILES.length);
  for (const entry of MODEL_CALL_FILES) {
    expect(existsSync(path.join(root, entry.file)), entry.file).toBe(true);
    expect(Boolean(entry.sites?.length || entry.door || entry.notModelCall), entry.file).toBe(true);
    expect(Boolean(entry.notModelCall && (entry.sites?.length || entry.door)), `${entry.file}: a model call or not, not both`).toBe(false);
    /* A construct the list names has to be there (the counts test above checks the rest). */
    expect(counts(entry.file), entry.file).toEqual(entry.constructs);
  }
});

test("the listed sites are exactly lib/modelTrace.ts's sites, each wrapped by its own id in its own file", async () => {
  const { MODEL_SITES } = await import("../../lib/modelTrace");
  const sites = MODEL_CALL_FILES.flatMap((e) => (e.sites ?? []).map((id) => ({ id, file: e.file })));
  expect(sites.map((s) => s.id).sort()).toEqual(Object.keys(MODEL_SITES).sort());
  expect(new Set(sites.map((s) => s.id)).size).toBe(sites.length);
  for (const { id, file } of sites) {
    const text = code(readFileSync(path.join(root, file), "utf8"));
    const wrapped = new RegExp(`(?:\\b(?:traceModelCall|openModelCall)\\(\\s*|\\btrace:\\s*\\{\\s*site:\\s*)["']${id.replace(".", "\\.")}["']`, "g");
    expect((text.match(wrapped) ?? []).length, `${file} wraps ${id} once`).toBe(1);
  }
  /* No other file opens a site's span: every site id lives where the list says. */
  for (const file of [...sources("lib"), ...sources("app")]) {
    const text = code(readFileSync(path.join(root, file), "utf8"));
    for (const match of text.matchAll(/(?:\b(?:traceModelCall|openModelCall)\(\s*|\btrace:\s*\{\s*site:\s*)["']([^"']+)["']/g))
      expect(sites.some((s) => s.id === match[1] && s.file === file), `${file} opens ${match[1]}`).toBe(true);
  }
});

test("every door is wrapped in modelDoor (or says why not), and every AI SDK call passes the telemetry hook with inputs and outputs off", () => {
  for (const entry of MODEL_CALL_FILES) {
    const text = code(readFileSync(path.join(root, entry.file), "utf8"));
    if (entry.door && entry.wrapped === undefined) expect(text, `${entry.file} wraps its door`).toMatch(/\bmodelDoor(?:<[^>]*>)?\(/);
    if (entry.wrapped !== undefined) expect(typeof entry.wrapped === "string" && entry.wrapped.length > 20, `${entry.file} says why it is not wrapped`).toBe(true);
    const sdk = SDK_CONSTRUCTS.reduce((n, name) => n + (entry.constructs[name] ?? 0), 0);
    const hooked = (text.match(/experimental_telemetry:\s*modelTelemetry\(/g) ?? []).length;
    expect(hooked, `${entry.file}: ${sdk} AI SDK calls, ${hooked} with the telemetry hook`).toBeGreaterThanOrEqual(sdk);
  }
  /* The hook itself never records inputs or outputs. */
  const trace = readFileSync(path.join(root, "lib/modelTrace.ts"), "utf8");
  expect(trace).toMatch(/isEnabled: on, recordInputs: false, recordOutputs: false, functionId/);
  expect(trace).not.toMatch(/recordInputs:\s*true|recordOutputs:\s*true/);
});

test("only the tracing modules load Langfuse or OpenTelemetry, and instrumentation loads them only when LANGFUSE_ENABLED is exactly 1 on Node", () => {
  const loaders = [...sources("lib"), ...sources("app"), ...sources("components")].filter((file) =>
    /from\s+["']@(?:langfuse|opentelemetry)\/|import\(\s*["']@(?:langfuse|opentelemetry)\//.test(readFileSync(path.join(root, file), "utf8")));
  expect(loaders).toEqual(["lib/modelTraceExport.ts"]);
  const instrumentation = readFileSync(path.join(root, "instrumentation.ts"), "utf8");
  expect(instrumentation).toContain('if (process.env.NEXT_RUNTIME === "nodejs" && process.env.LANGFUSE_ENABLED === "1") {');
  expect(instrumentation).toContain('await import("./lib/modelTraceExport")');
  expect(instrumentation).not.toMatch(/^import .*(?:modelTraceExport|@langfuse|@opentelemetry)/m);
});
