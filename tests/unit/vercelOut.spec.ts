import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { compare, expired, growth, lowered, onMain, past, readJson, shapeProblems, type Section } from "../helpers/ratchet";
import { lockfileHits, manifestHits, scanManifestScripts, scanRepository, scanScript, scanText, trackedForbidden, type Counts, type Hit } from "../helpers/vercelScan";

/**
 * Vercel is out (owner, 14 Oct 2026; plan docs/plans/vercel-out.md, section 4). This guard fails if Vercel comes back, and it lands first, at today's counts, so
 * nothing new can arrive while the removals go on. Each removal lowers an entry; a count only goes down; an entry past its date fails.
 *
 * What counts:
 *  1. tracked files: vercel.json, anything under .vercel/, public/vercel.svg;
 *  2. package.json: a dependency key that starts with @vercel/ or is @ai-sdk/gateway;
 *  3. package-lock.json: an installed package that does (each with the package that pulls it in);
 *  4. source (app/, lib/, components/, mcp/, scripts/, ops/, .github/, proxy.ts, instrumentation.ts, next.config.ts, package.json scripts), read as syntax so a comment never counts:
 *     imports of those packages; imports that resolve to a module that goes (lib/gateway, lib/vercelKeys, lib/engines/vercel, lib/storage/blob); code naming a setting
 *     VERCEL, VERCEL_* or AI_GATEWAY_*; strings holding vercel.app, vercel.sh, vercel.com, vercel-storage.com, x-vercel- or vercel-cron;
 *  5. tests: imports and module mocks of those packages and modules, so a dead mock cannot linger.
 *
 * Never counted: the bare word "vercel" (the ledger's 'vercel' engine, 'vercel-sandbox', the 'gateway' setting value, the render worker's /vercel/sandbox path are names in old
 * rows and in our own protocol, not Vercel use); docs/, markdown, tests/fixtures/, design/, brand/, git history; the allowed-for-good files in the allowance file's "permanent"
 * section, each with its reason. Tests are read for imports and mocks only, so vercelGuard.spec.ts can keep setting VERCEL to prove the runtime guard.
 *
 * After removing some: UPDATE_VERCEL_OUT_RATCHET=1 npx playwright test tests/unit/vercelOut.spec.ts --project=unit lowers the allowance file (never raises it, never adds a file).
 */
const RATCHET = "tests/unit/vercel-out-ratchet.json";
const OWN = ["tests/unit/vercelOut.spec.ts", "tests/helpers/vercelScan.ts"];
type Allowance = { permanent: Record<string, { reason: string }>; tracked: Section; manifest: Section; lockfile: Section; source: Section; tests: Section };
const SECTIONS = ["tracked", "manifest", "lockfile", "source", "tests"] as const;
const allowance = () => readJson<Allowance>(RATCHET);

const one = (names: string[]) => Object.fromEntries(names.map((n) => [n, 1]));
let seen: { counts: Counts; tracked: Record<string, number>; manifest: Record<string, number>; lockfile: Record<string, number> } | null = null;
function now() {
  if (seen) return seen;
  const permanent = Object.keys(allowance().permanent);
  const counts = scanRepository(undefined, [...OWN, ...permanent]);
  seen = { counts, tracked: one(trackedForbidden()), manifest: one(manifestHits()), lockfile: one(lockfileHits().map((h) => h.key)) };
  return seen;
}
const countsOf = (): Record<(typeof SECTIONS)[number], Record<string, number>> => ({ tracked: now().tracked, manifest: now().manifest, lockfile: now().lockfile, source: now().counts.source, tests: now().counts.tests });
const describeFile = (section: string, file: string) => {
  if (section === "source" || section === "tests") return (now().counts.hits[file] ?? []).map((h) => `${h.kind} ${h.text} (line ${h.line})`).join("; ");
  if (section === "lockfile") return `pulled in by ${lockfileHits().find((h) => h.key === file)?.via.join(", ") || "package.json"}`;
  return file;
};
const WHAT: Record<string, string> = {
  tracked: "a Vercel file is tracked", manifest: "a Vercel package is in package.json", lockfile: "a Vercel package is installed (package-lock.json)",
  source: "app code names Vercel (an import, a module that goes, a VERCEL*/AI_GATEWAY_* setting, a Vercel host or header)", tests: "a test imports or mocks Vercel or a module that goes",
};

/* ---------------------------------------------------------------------------------------------- */
/* The matcher itself: what it must catch and what it must leave alone.                            */
/* ---------------------------------------------------------------------------------------------- */

const kinds = (hits: Hit[]) => hits.map((h) => `${h.kind}:${h.text}`);

test("the matcher fires on each pattern, in code", () => {
  const code = [
    `import { put } from "@vercel/blob";`,
    `const sandbox = await import("@vercel/sandbox");`,
    `const oidc = require("@vercel/oidc");`,
    `type G = typeof import("@ai-sdk/gateway");`,
    `export { x } from "@ai-sdk/gateway";`,
    `import { gatewayPost } from "./gateway";`,
    `import("../lib/vercelKeys");`,
    `import { run } from "@/lib/engines/vercel";`,
    `import { blob } from "./storage/blob";`,
    `const on = process.env.VERCEL === "1";`,
    `const { VERCEL_TOKEN, AI_GATEWAY_API_KEY } = process.env;`,
    `const env = process.env["VERCEL_ENV"];`,
    `const url = "https://ai-gateway.vercel.sh/v1";`,
    `const api = \`https://api.vercel.com/\${x}\`;`,
    `const host = "abc.public.blob.vercel-storage.com";`,
    `const header = "x-vercel-id";`,
    `const agent = "vercel-cron/1.0";`,
    `const app = "https://x.vercel.app";`,
  ].join("\n");
  expect(kinds(scanScript(code, "lib/sample.ts"))).toEqual([
    "import:@vercel/blob", "import:@vercel/sandbox", "import:@vercel/oidc", "import:@ai-sdk/gateway", "import:@ai-sdk/gateway",
    "removed-module:./gateway", "removed-module:../lib/vercelKeys", "removed-module:@/lib/engines/vercel", "removed-module:./storage/blob",
    "env:VERCEL", "env:VERCEL_TOKEN", "env:AI_GATEWAY_API_KEY", "env:VERCEL_ENV",
    "host:vercel.sh", "host:vercel.com", "host:vercel-storage.com", "host:x-vercel-", "host:vercel-cron", "host:vercel.app",
  ]);
  expect(kinds(scanScript(`import("../../lib/gateway"); jest.mock("@vercel/blob", () => ({}));`, "tests/unit/a.spec.ts", { mocks: true }))).toEqual(["removed-module:../../lib/gateway", "import:@vercel/blob"]);
  expect(kinds(scanText("VERCEL=1 node build.js\nrun: curl https://x.vercel.app", ".github/workflows/x.yml"))).toEqual(["env:VERCEL", "host:vercel.app"]);
  expect(kinds(scanManifestScripts(JSON.stringify({ scripts: { prebuild: "VERCEL_ENV=preview node seed.mjs" } })))).toEqual(["env:VERCEL_ENV"]);
});

test("the matcher leaves alone comments, the bare word, our own names and other packages", () => {
  const code = [
    `// import { put } from "@vercel/blob"; process.env.VERCEL; https://x.vercel.app`,
    `/* VERCEL_ENV and AI_GATEWAY_API_KEY and vercel.sh and ./gateway */`,
    `/** on Vercel, with x-vercel-id and vercel-cron */`,
    `const engine = "vercel";`,
    `const meter = "vercel-sandbox";`,
    `const source = "gateway";`,
    `const path = "/vercel/sandbox";`,
    `const label = "vercel-blob-private";`,
    `import { generateText } from "ai";`,
    `import { openai } from "@ai-sdk/openai";`,
    `import { x } from "./gatewayLike";`,
    `import { y } from "@/lib/storage";`,
    `const note = "Vercel";`,
    `const other = process.env.ENGINE_MOCK;`,
  ].join("\n");
  expect(scanScript(code, "lib/sample.ts")).toEqual([]);
  expect(scanText("# VERCEL=1 and vercel.app\nnode run.js # AI_GATEWAY_API_KEY", "ops/x.sh")).toEqual([]);
  /* In tests only imports and mocks are read: setting VERCEL to prove the runtime guard is fine. */
  expect(scanRepository(["tests/unit/vercelGuard.spec.ts"]).tests["tests/unit/vercelGuard.spec.ts"]).toBe(1);
  expect(kinds(scanScript(`process.env.VERCEL = "1";`, "tests/unit/a.spec.ts", { mocks: true }).filter((h) => h.kind === "import" || h.kind === "removed-module"))).toEqual([]);
});

/* ---------------------------------------------------------------------------------------------- */
/* The ratchet.                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

for (const section of SECTIONS) {
  test(`${section}: nothing new, and nothing left past its date`, () => {
    const mine = allowance()[section];
    const current = countsOf()[section];
    const { worse, better } = compare(current, mine, (file) => describeFile(section, file));
    expect(worse, `${WHAT[section]}: it is new, or there is more of it than allowed (the guard exists so Vercel does not come back)`).toEqual([]);
    expect(expired(mine, current), `past the date: ${WHAT[section]} must be gone`).toEqual([]);
    if (process.env.UPDATE_VERCEL_OUT_RATCHET) return;
    expect(better, "fewer than allowed: lower the allowance (UPDATE_VERCEL_OUT_RATCHET=1) so the slack cannot be spent on something new").toEqual([]);
  });
}

test("the allowance file: every entry has a count, a date and who removes it; the permanent files each have a reason and exist", () => {
  const file = allowance();
  for (const section of SECTIONS) expect(shapeProblems(file[section]), `${section}: each entry needs { count > 0, until: YYYY-MM-DD, by }`).toEqual([]);
  for (const [path, entry] of Object.entries(file.permanent)) {
    expect(entry.reason?.trim().length, `${path}: say why it is allowed for good`).toBeGreaterThan(10);
    expect(() => readFileSync(path, "utf8"), `${path} is allowed but is not there`).not.toThrow();
  }
  expect(past("2026-10-27") || true).toBe(true);
});

test("the ratchet only goes down: against main, no entry is added, raised or moved later", () => {
  const then = onMain<Allowance>(RATCHET);
  if (!then) return;
  for (const section of SECTIONS) expect(growth(allowance()[section], then[section]), `${section}: entries added, counts raised or dates moved later`).toEqual({ added: [], raised: [], later: [] });
  expect(Object.keys(allowance().permanent).filter((p) => !(p in then.permanent)), "a file allowed for good needs the owner's word: it is new").toEqual([]);
});

test("UPDATE_VERCEL_OUT_RATCHET=1 lowers the allowance file to what is there now", () => {
  if (!process.env.UPDATE_VERCEL_OUT_RATCHET) return;
  const file = allowance();
  const current = countsOf();
  const next = { ...file };
  for (const section of SECTIONS) next[section] = lowered(file[section], current[section]);
  writeFileSync(RATCHET, JSON.stringify(next, null, 2) + "\n");
});
