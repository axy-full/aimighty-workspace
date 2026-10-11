// Decides how much of the browser suite a pull request runs (docs/ci.md).
//
//   node scripts/ci-select.mjs <event> <base-ref> < changed-files.txt
//     event: pull_request | push. Reads one changed path per line on stdin.
//     Prints the plan as JSON; with $GITHUB_OUTPUT set, also writes `mode` and `runs` there.
//
// Three modes:
//   full  the whole browser suite (today's 22 jobs). Every push to release/1 or main, every PR into main, and any PR
//         that touches a path that is not on the slim list below. When in doubt, full.
//   slim  a PR into release/1 whose every changed path is on the slim list: the specs it touches plus a fixed guard set.
//   docs  a PR that only changes documentation: no browser specs (the unit shards and `core` still run).
// Every mode but docs also runs the five-minute test. The unit shards and `core` run in every mode.
//
// Nothing here skips a test inside a suite; it only decides which spec files a PR runs in the browser.
import { readdirSync, readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* Which browser suite runs a spec file: the same patterns as playwright.workbench.config.ts and playwright.customer.config.ts
   (tests/unit/ci-select.spec.ts fails if either config drifts from these). */
export const WORKBENCH_SPEC = /(workbench|movie-export)\.spec\.ts$/;
export const CUSTOMER_SPEC = /(astra-gen|topaz-gen|account-security|workspace-security|pipelines|customer|recovery-race|upload-recovery|workspace-audit|management-scope|account-identity|platform-desk)\.spec\.ts$/;

const V12_SPEC = /^tests\/[^/]+-v12-[^/]*workbench\.spec\.ts$/;

/* ── The fixed guard set: every slim run executes these, whatever the PR touches ───────────────────────────────── */
export const GUARDS = {
  /* Every paid control carries its price (unit scan: tests/unit/spend-buttons.spec.ts runs in the unit shards; this is the rendered pages). */
  workbench: ["tests/spend-buttons-workbench.spec.ts", "tests/demo-board-everyone-audit-workbench.spec.ts"],
  /* A customer's board and sign-in, with the switch off. */
  customer: ["tests/customer.spec.ts"],
  /* "Switch off: customers unchanged": every new-interface spec's own switch-off test, found by name. */
  switchOffGrep: "switch off",
};

/* ── Paths that may run slim. Anything not matched here, or matched by NEVER, is a full run ───────────────────── */
const DOCS = [/^docs\//, /^[^/]+\.md$/, /^design\//];
/* A new-interface file is slim-eligible unless it is shared UI, or it names money. */
const V12_AREA = [/^components\/v12\/(?!ui\/)/, /^lib\/v12\//];
/* Money, price, quote, approval and sign-in words in a path: always a full run, even under components/v12 or lib/v12. */
const NEVER = [
  /(quote|price|pricing|spend|unpriced|approval|credit|ledger|billing|budget|payment|stripe|topup|auth|session|signin|signup|invite|tenant|workspace|middleware|permission|privacy)/i,
  /^(app\/api|middleware|lib\/(?!v12\/))/,
  /^components\/v12\/ui\//,
  /^tests\/(helpers|unit\/spend|unit\/ui-names|unit\/one-design|unit\/signin|unit\/.*privacy|unit\/.*tooltip)/,
  /^\.github\//,
  /^package(-lock)?\.json$/,
  /^playwright[^/]*\.config\.ts$/,
  /^scripts\/ci-/,
  /^(next|tsconfig|eslint|postcss)[^/]*\.(m?js|ts|json)$/,
];
const SLIM_OK = [
  ...DOCS,
  ...V12_AREA,
  /^tests\/[^/]+\.spec\.ts$/,
  /^tests\/redesign\//,
  /^tests\/unit\/(?!spend|ui-names|one-design|signin)[^/]+\.spec\.ts$/,
  /^scripts\/redesign\//,
];

const isDocs = (path) => DOCS.some((re) => re.test(path));
const never = (path) => NEVER.some((re) => re.test(path)) && !isDocs(path) && !/^tests\/[^/]+-v12-[^/]*\.spec\.ts$/.test(path) && !/^tests\/redesign\//.test(path) && !/^tests\/unit\/v12-/.test(path);

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
  [/^lib\/v12\/board\//, A("board-frame", "board-kinds", "shots", "deliver", "campaign", "rounds")],
  [/^lib\/v12\/campaign\.ts$/, A("campaign")],
  [/^lib\/v12\/(deliver|ppm|csv)\.ts$/, A("deliver")],
  [/^lib\/v12\/home\.ts$/, [...A("home"), "tests/home-v12-layout-workbench.spec.ts"]],
  [/^lib\/v12\/(library|useLibraryTray|mention)\.ts$/, A("library-tray")],
  [/^lib\/v12\/make\.ts$/, A("make")],
  [/^lib\/v12\/(menus|keymap)\.ts$/, A("menus", "shell")],
  [/^lib\/v12\/rounds\.ts$/, A("rounds")],
  [/^lib\/v12\/(lowCredit|useLowCredit)[^/]*\.ts$/, A("settings-billing", "header")],
  [/^lib\/v12\/(render[A-Za-z]*|typicalTime[A-Za-z.]*|queuePosition[A-Za-z.]*|boardRing)\.ts$/, A("render")],
];
/* Anything under the new interface that no row names (shared CSS, dev tools, a new area): every new-interface spec. */
const areaSpecs = (path) => { for (const [re, list] of AREAS) if (re.test(path)) return list; return ALL_V12; };

const unique = (list) => [...new Set(list)];

/**
 * @param {{ event: string, base: string, files: string[], specs: string[] }} input
 *   `specs`: every tests/*.spec.ts in the repository (a mapped spec that does not exist is dropped, never invented).
 */
export function select({ event, base, files, specs }) {
  const reasons = [];
  const full = (reason) => ({ mode: "full", reasons: [...reasons, reason], runs: [], fiveMinute: true });
  if (event !== "pull_request") return full(`${event} to ${base}: the whole suite after every merge`);
  if (base !== "release/1") return full(`pull request into ${base}: the whole suite`);
  const changed = unique(files.filter(Boolean));
  if (!changed.length) return full("no changed files could be read: the whole suite");

  const loud = changed.filter((path) => never(path) || !SLIM_OK.some((re) => re.test(path)));
  if (loud.length) return full(`touches ${loud.slice(0, 5).join(", ")}${loud.length > 5 ? ` and ${loud.length - 5} more` : ""}: money, sign-in, tenant separation or shared code`);

  if (changed.every(isDocs)) return { mode: "docs", reasons: ["documentation only: the unit shards and core, no browser specs"], runs: [], fiveMinute: false };

  const exists = new Set(specs);
  const v12 = specs.filter((s) => V12_SPEC.test(s));
  const picked = new Set();
  for (const path of changed) {
    if (/^tests\/[^/]+\.spec\.ts$/.test(path)) { if (exists.has(path)) picked.add(path); continue; } // a changed spec runs itself
    if (!V12_AREA.some((re) => re.test(path))) continue;
    const list = areaSpecs(path);
    for (const s of list === ALL_V12 ? v12 : list) if (exists.has(s)) picked.add(s);
  }
  const guardsFull = new Set([...GUARDS.workbench, ...GUARDS.customer].filter((s) => exists.has(s)));
  const whole = new Set([...picked, ...guardsFull]);
  const inSuite = (re) => [...whole].filter((s) => re.test(s)).sort();
  const workbenchSpecs = inSuite(WORKBENCH_SPEC);
  const customerSpecs = inSuite(CUSTOMER_SPEC);
  const switchOff = v12.filter((s) => !whole.has(s)).sort();

  const runs = [];
  if (workbenchSpecs.length) runs.push({ name: "specs this PR touches, and the spend guard", suite: "workbench", grep: null, specs: workbenchSpecs });
  if (switchOff.length) runs.push({ name: `switch off: customers unchanged (${switchOff.length} specs, their own switch-off tests)`, suite: "workbench", grep: GUARDS.switchOffGrep, specs: switchOff });
  if (customerSpecs.length) runs.push({ name: "customer smoke", suite: "customer", grep: null, specs: customerSpecs });
  reasons.push(`new-interface and test paths only: ${[...picked].length} spec file(s) from the changed paths, plus the fixed guard set`);
  return { mode: "slim", reasons, runs, fiveMinute: true };
}

/* ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────── */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [event = "pull_request", base = "release/1"] = process.argv.slice(2);
  const files = readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const specs = readdirSync("tests").filter((n) => /\.spec\.ts$/.test(n)).map((n) => `tests/${n}`);
  const plan = select({ event, base, files, specs });
  console.error(`[ci-select] ${plan.mode}: ${plan.reasons.join("; ")}`);
  for (const run of plan.runs) console.error(`[ci-select]   ${run.suite}${run.grep ? ` --grep "${run.grep}"` : ""}: ${run.name}: ${run.specs.join(" ")}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\nfive_minute=${plan.fiveMinute}\nruns=${JSON.stringify(plan.runs)}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
