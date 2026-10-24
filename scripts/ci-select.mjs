// Decides how much of the browser suite a pull request runs (docs/ci.md).
//
//   node scripts/ci-select.mjs <event> <base-ref> < changed-files.txt
//     event: pull_request | push. Reads one changed path per line on stdin.
//     Prints the plan as JSON; with $GITHUB_OUTPUT set, also writes `mode` and `runs` there.
//
// Three modes:
//   full  the whole browser suite (today's 22 jobs). Every push to release/1 or main, every PR into main, any PR that
//         changes a browser spec (owner, 19 Oct 2026: such a PR runs the full plan at its head before merge), and any PR
//         that touches a path that is not on the slim list below. When in doubt, full.
//   slim  a PR into release/1 whose every changed path is a presentational new-interface file (CSS, or a component with no
//         fetch and no money word that nothing outside components/v12 imports), a unit test or other non-browser test file,
//         or documentation: the specs its paths map to plus a fixed guard set. Everything in lib/ is full, including lib/v12/.
//   docs  a PR that only changes documentation: no browser specs (the unit shards and `core` still run).
// Every mode but docs also runs the five-minute test. The unit shards and `core` run in every mode.
//
// Nothing here skips a test inside a suite; it only decides which spec files a PR runs in the browser.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/* Which browser suite runs a spec file: the same patterns as playwright.workbench.config.ts and playwright.customer.config.ts
   (tests/unit/ci-select.spec.ts fails if either config drifts from these). */
export const WORKBENCH_SPEC = /(workbench|movie-export)\.spec\.ts$/;
export const CUSTOMER_SPEC = /(astra-gen|topaz-gen|account-security|workspace-security|pipelines|customer|recovery-race|upload-recovery|workspace-audit|management-scope|account-identity|platform-desk)\.spec\.ts$/;

const V12_SPEC = /^tests\/[^/]+-v12-[^/]*workbench\.spec\.ts$/;

/* ── The fixed guard set: every slim run executes these, whatever the PR touches ───────────────────────────────── */
export const GUARDS = {
  /* Every paid control carries its price (unit scan: tests/unit/spend-buttons.spec.ts runs in the unit shards; this is the rendered pages),
     paid sends, money, and the retired sign-in, and the board with the switch off. */
  workbench: [
    "tests/spend-buttons-workbench.spec.ts", "tests/signin-retired-workbench.spec.ts", "tests/r1-port-paid-sends-workbench.spec.ts",
    "tests/audit-money-workbench.spec.ts", "tests/demo-board-everyone-audit-workbench.spec.ts", "tests/marketing-site-workbench.spec.ts",
    "tests/demo-s15-guest-home-workbench.spec.ts",
  ],
  /* A customer's board and sign-in, with the switch off. */
  customer: ["tests/customer.spec.ts"],
  /* "Switch off: customers unchanged": the switch-off browser check every build behind the new-interface switch is held to (it
     lasts when a build is deleted: the prototype-12 build's own were, 23 Oct 2026), plus each new-interface spec's own switch-off
     test, found by name (only specs that have one). */
  switchOff: ["tests/switch-off-customers-workbench.spec.ts"],
  switchOffGrep: "switch off",
};

/* ── Paths that may run slim. Anything not matched here is a full run ───────────────────────────────────────── */
const DOCS = [/^docs\//, /^[^/]+\.md$/, /^design\//];
/* Tests and tooling that run in the unit shards or in a browser spec of their own. Guard tests and shared helpers are never here. */
const TESTS = [
  /^tests\/[^/]+-v12-[^/]*\.spec\.ts$/, /^tests\/redesign\//, /^tests\/unit\/v12-[^/]+\.spec\.ts$/,
  /^tests\/[^/]+\.spec\.ts$/, /^tests\/unit\/(?!spend|ui-names|one-design|signin|ci-select)[^/]+\.spec\.ts$/, /^scripts\/redesign\//,
];
/* Always full, whatever else holds: money, sign-in, tenant separation, shared code, and every guard (when in doubt, full). */
const NEVER = [
  /^lib\//,                                            // all of lib/, including lib/v12/
  /\.server\.tsx?$/,                                   // anything that runs on the server, anywhere
  /^app\//, /^middleware/, /^components\/(?!v12\/)/,   // routes, middleware, every component outside the new interface
  /^components\/v12\/ui\//,                           // shared primitives
  /(quote|price|pricing|spend|unpriced|approval|credit|ledger|billing|budget|payment|stripe|topup|auth|session|signin|signup|invite|tenant|workspace|middleware|permission|privacy)/i,
  /^tests\/(helpers|unit\/spend|unit\/ui-names|unit\/one-design|unit\/signin|unit\/.*privacy|unit\/.*tooltip|unit\/ci-select)/,
  /^\.github\//, /^package(-lock)?\.json$/, /^playwright[^/]*\.config\.ts$/, /^scripts\/ci-/,
  /^(next|tsconfig|eslint|postcss)[^/]*\.(m?js|ts|json)$/,
];
/* A new-interface file whose text touches a price, a hold, a charge, a refund, a cancel, an approval, a workspace id, a fetch or an
   API route is not presentational: full. ("placeholder" is not a hold.) */
const MONEY_TEXT = /quote|price|\bcr\b|credit|charge|billed|\bhold|\bheld|refund|cancel|approv|ledger|workspace_id|fetch\(|\/api\//i;

/* A guard or safety test: any change to one is a full run, and the plan says so for the owner's review. The review client link's
   tenant-separation spec counts as a privacy guard though its name does not say so (owner, 22 Oct 2026: "a small stricter PR that
   teaches scripts/ci-select.mjs to count this test as a privacy guard, so the next change to it runs full"). */
const GUARD_TEST = /^tests\/.*(spend-buttons|spend-ratchet|paidRoutes|helpers\/spend|privacy|switch-off|newInterfaceSwitch|one-design|ui-names|tooltip-audit|signin.?retired|audit-money|r1-port-paid-sends|unit\/demo-gaps-l5-client-link\.spec|unit\/ci-select)/i;
export const isGuardTest = (path) => GUARD_TEST.test(path);
const isDocs = (path) => DOCS.some((re) => re.test(path));
const isTest = (path) => TESTS.some((re) => re.test(path));
const isV12Component = (path) => /^components\/v12\//.test(path);
/* A browser spec: any .spec.ts under tests/, at any depth, outside the unit shards (tests/unit/) and the ops tests (tests/ops/). Owner, 19 Oct 2026: "#840
   merged with the browser suite skipped at its head, which is not 24/24; from now on any PR that touches tests/*.spec.ts or claims to
   fix the suite runs the full plan at its head before merge." So a PR that changes one is a full run, never slim. */
const BROWSER_SPEC = /^tests\/(?!unit\/|ops\/).+\.spec\.ts$/;
export const isBrowserSpec = (path) => BROWSER_SPEC.test(path);

/**
 * Whether a changed path may run slim. `read(path)`: the file's text at the PR's head, or null when it was deleted;
 * `exposed`: the new-interface files that something outside components/v12 imports, directly or through other new-interface files.
 */
function slimOk(path, { read, exposed }) {
  if (isGuardTest(path)) return false;
  if (isDocs(path)) return true;
  if (NEVER.some((re) => re.test(path)) && !isTest(path)) return false;
  if (isTest(path)) return true;
  if (!isV12Component(path)) return false;
  if (/\.css$/.test(path)) return !exposed.has(path); // a stylesheet something outside components/v12 pulls in is shared
  if (!/\.tsx?$/.test(path)) return false;
  const text = read(path);
  if (text == null) return false;
  if (exposed.has(path.replace(/\.tsx?$/, ""))) return false;
  return !MONEY_TEXT.test(text.replace(/placeholder/gi, ""));
}

/* ── Which new-interface specs a path touches (the one place that maps a path to its specs) ───────────────────── */
const A = (...names) => names.map((n) => `tests/${n}-v12-workbench.spec.ts`);
const ALL_V12 = "all";
const AREAS = [
  [/^components\/v12\/(V12Shell\.tsx|shell\/)/, [...A("shell", "header", "menus", "primitives")]],
  [/^components\/v12\/bar\//, [...A("board-frame", "home", "make")]],
  [/^components\/v12\/board\/campaign\//, A("campaign")],
  [/^components\/v12\/board\/(DeliverStage|PpmStage)/, A("deliver")],
  [/^components\/v12\/board\/(stage-grid|stage-pages)/, A("shots", "deliver", "campaign", "board-frame")],
  [/^components\/v12\/board\//, A("board-frame", "board-kinds", "shots", "deliver", "campaign", "rounds")],
  [/^components\/v12\/home\//, [...A("home"), "tests/home-v12-layout-workbench.spec.ts"]],
  [/^components\/v12\/library\//, A("library-tray")],
  [/^components\/v12\/make\//, A("make")],
  [/^components\/v12\/menus\//, A("menus")],
  [/^components\/v12\/render\//, A("render")],
  [/^components\/v12\/rig\//, A("rig")],
  [/^components\/v12\/rounds\//, A("rounds")],
  [/^components\/v12\/settings\//, A("settings-billing")],
];
/* Anything under the new interface that no row names (shared CSS, dev tools, a new area): every new-interface spec. */
const areaSpecs = (path) => { for (const [re, list] of AREAS) if (re.test(path)) return list; return ALL_V12; };

const unique = (list) => [...new Set(list)];
/* The first five paths of a list, and how many more. */
const few = (list) => `${list.slice(0, 5).join(", ")}${list.length > 5 ? ` and ${list.length - 5} more` : ""}`;

/**
 * @param {{ event: string, base: string, files: string[], specs: string[], read?: (path: string) => string | null, exposed?: Set<string> }} input
 *   `specs`: every tests/*.spec.ts in the repository (a mapped spec that does not exist is dropped, never invented).
 */
export function select({ event, base, files, specs, read = () => null, exposed = new Set() }) {
  const reasons = [];
  const full = (reason) => ({ mode: "full", reasons: [...reasons, reason], runs: [], fiveMinute: true });
  if (event !== "pull_request") return full(`${event} to ${base}: the whole suite after every merge`);
  if (base !== "release/1") return full(`pull request into ${base}: the whole suite`);
  const changed = unique(files.filter(Boolean));
  if (!changed.length) return full("no changed files could be read: the whole suite");

  const guards = changed.filter(isGuardTest);
  if (guards.length) reasons.push(`guard test changed: owner review (${few(guards)})`);
  const browserSpecs = changed.filter(isBrowserSpec);
  if (browserSpecs.length) reasons.push(`changes a browser spec (${few(browserSpecs)}): the full plan at its head (owner, 19 Oct 2026: "any PR that touches tests/*.spec.ts … runs the full plan at its head before merge")`);
  const loud = changed.filter((path) => !slimOk(path, { read, exposed }));
  if (loud.length) return full(`touches ${few(loud)}: money, sign-in, tenant separation, shared code, or a new-interface file that is not presentational`);
  if (browserSpecs.length) return { mode: "full", reasons, runs: [], fiveMinute: true };

  if (changed.every(isDocs)) return { mode: "docs", reasons: ["documentation only: the unit shards and core, no browser specs"], runs: [], fiveMinute: false };

  const exists = new Set(specs);
  const v12 = specs.filter((s) => V12_SPEC.test(s));
  const picked = new Set();
  for (const path of changed) { // a changed browser spec never gets here: it made the run full above
    if (!isV12Component(path)) continue;
    const list = areaSpecs(path);
    for (const s of list === ALL_V12 ? v12 : list) if (exists.has(s)) picked.add(s);
  }
  const guardsFull = new Set([...GUARDS.workbench, ...GUARDS.customer].filter((s) => exists.has(s)));
  const whole = new Set([...picked, ...guardsFull]);
  const inSuite = (re) => [...whole].filter((s) => re.test(s)).sort();
  const workbenchSpecs = inSuite(WORKBENCH_SPEC);
  const customerSpecs = inSuite(CUSTOMER_SPEC);
  /* Only the specs that have a switch-off test: a chunk of specs without one would fail with "No tests found". */
  const switchOff = unique([...GUARDS.switchOff.filter((s) => exists.has(s)), ...v12])
    .filter((s) => !whole.has(s) && /switch off/.test(read(s) ?? "")).sort();

  const runs = [];
  if (workbenchSpecs.length) runs.push({ name: "specs this PR touches, and the guard specs", suite: "workbench", grep: null, specs: workbenchSpecs });
  if (switchOff.length) runs.push({ name: `switch off: customers unchanged (${switchOff.length} specs, their own switch-off tests)`, suite: "workbench", grep: GUARDS.switchOffGrep, specs: switchOff });
  if (customerSpecs.length) runs.push({ name: "customer smoke", suite: "customer", grep: null, specs: customerSpecs });
  reasons.push(`presentational new-interface files and tests only: ${[...picked].length} spec file(s) from the changed paths, plus the fixed guard set`);
  return { mode: "slim", reasons, runs, fiveMinute: true };
}

/* ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────── */
/* The new-interface files that something outside components/v12 imports, and everything those import inside it, as module paths without
   an extension (the repository at the PR's head). */
export function exposedV12(root = ".") {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\n");
  return exposedFrom(files, (path) => readFileSync(join(root, path), "utf8"));
}

/* The same, over a given list of repository paths and a reader for them (pure: tests/unit/ci-select.spec.ts runs it on a fixture tree, so
   its rules hold whatever components/v12 holds today). A file that cannot be read imports nothing. */
export function exposedFrom(all, readText) {
  const files = all.filter((p) => /\.(ts|tsx|mjs|css)$/.test(p) && /^(app|components|lib|tests|scripts)\//.test(p));
  const known = new Set(files.map((p) => p.replace(/\.(tsx?|mjs)$/, "")));
  const specifiers = (text) => [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const resolve = (from, spec) => {
    const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(from), spec)) : null;
    if (base === null) return null;
    return known.has(base) ? base : known.has(`${base}/index`) ? `${base}/index` : null;
  };
  const edges = new Map();
  const seeds = new Set();
  for (const path of files) {
    if (/\.css$/.test(path)) continue; // a stylesheet imports nothing that matters here; it is found as an import target
    let text;
    try { text = readText(path); } catch { continue; }
    if (typeof text !== "string") continue;
    const into = specifiers(text).map((spec) => resolve(path, spec)).filter(Boolean);
    const inside = path.startsWith("components/v12/");
    if (inside) edges.set(path.replace(/\.(tsx?|mjs)$/, ""), into.filter((m) => m.startsWith("components/v12/")));
    else for (const m of into) if (m.startsWith("components/v12/")) seeds.add(m);
  }
  const exposed = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const next = queue.pop();
    if (exposed.has(next)) continue;
    exposed.add(next);
    for (const m of edges.get(next) ?? []) queue.push(m);
  }
  return exposed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [event = "pull_request", base = "release/1"] = process.argv.slice(2);
  const files = readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const specs = readdirSync("tests").filter((n) => /\.spec\.ts$/.test(n)).map((n) => `tests/${n}`);
  const read = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
  const plan = select({ event, base, files, specs, read, exposed: event === "pull_request" ? exposedV12() : new Set() });
  console.error(`[ci-select] ${plan.mode}: ${plan.reasons.join("; ")}`);
  for (const run of plan.runs) console.error(`[ci-select]   ${run.suite}${run.grep ? ` --grep "${run.grep}"` : ""}: ${run.name}: ${run.specs.join(" ")}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\nfive_minute=${plan.fiveMinute}\nruns=${JSON.stringify(plan.runs)}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
