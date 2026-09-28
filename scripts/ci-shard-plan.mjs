// Chooses which of a browser suite's sub-shards each verify.yml job runs.
//
// CI runs each browser suite as SUBSHARDS Playwright sub-shards
// (`playwright test --shard=k/SUBSHARDS`), each on a fresh dev server, spread
// over JOBS jobs. Playwright splits a suite by test count, a spec file per
// project at a time, so sub-shards differ by many minutes: the draft-merge
// specs alone are about 14 minutes of one. Three neighbouring sub-shards to a
// job made one job run 45 minutes while others took 18. This estimates each
// sub-shard's minutes from the tests Playwright will put in it and
// scripts/ci-shard-timings.json, then deals the sub-shards out longest first,
// each to the job with the least work so far.
//
// What a sub-shard holds is still Playwright's own `--shard` split; this only
// decides which job runs it, and every sub-shard goes to exactly one job. A
// wrong or missing estimate makes the jobs less even, never skips a test.
//
//   node scripts/ci-shard-plan.mjs <suite> <subshards> <jobs> <job>
//     prints the sub-shards job <job> runs, ascending; the whole plan goes to stderr.
//   node scripts/ci-shard-plan.mjs <suite> <subshards> --check
//     lists every sub-shard with Playwright itself and exits 1 if this script's
//     view of the split differs (run it after upgrading Playwright).
//
// scripts/ci-shard-timings.mjs refreshes the timings from finished jobs' logs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* A restored server's warm-up and the gap between sub-shards, per sub-shard. */
const PER_SUBSHARD_SECONDS = 80;

const [suite, subshardsArg, jobsArg, jobArg] = process.argv.slice(2);
const fail = (message) => {
  console.error(`[plan] ${message}`);
  process.exit(1);
};
const subshards = Number(subshardsArg);
const check = jobsArg === "--check";
const jobs = Number(jobsArg);
const job = Number(jobArg);
if (!/^[a-z]+$/.test(suite ?? "") || !Number.isInteger(subshards) || subshards < 1) {
  fail("usage: ci-shard-plan.mjs <suite> <subshards> (<jobs> <job> | --check)");
}
if (!check && !(Number.isInteger(jobs) && jobs >= 1 && jobs <= subshards && Number.isInteger(job) && job >= 1 && job <= jobs)) {
  fail(`job ${jobArg} of ${jobsArg} jobs for ${subshards} sub-shards is not a plan`);
}
/* Playwright's split below assumes even shards. */
if (process.env.PWTEST_SHARD_WEIGHTS) fail("PWTEST_SHARD_WEIGHTS is set; this script assumes even shards");

/* The suite's tests as Playwright lists them (JSON reporter; nothing runs). */
function list(...args) {
  let out;
  let status = 0;
  try {
    out = execFileSync(resolve("node_modules/.bin/playwright"), ["test", `--config=playwright.${suite}.config.ts`, "--list", "--reporter=json", ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    out = error.stdout;
    status = error.status ?? 1;
  }
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    fail(`Playwright did not list the ${suite} suite (exit ${status})`);
  }
  if (report.errors?.length) fail(`Playwright could not list the ${suite} suite: ${report.errors[0].message}`);
  if (status) fail(`Playwright listed the ${suite} suite with exit ${status}`);
  return report;
}

/* Playwright walks testDir sorting each folder's entries by name. */
function byPath(a, b) {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i].localeCompare(y[i]);
  return x.length - y.length;
}

/* One entry per project and spec file, in the order Playwright shards them:
   projects as configured, then files as it walks testDir. The JSON report
   merges a file's projects, so the order is rebuilt here. */
function groups(report) {
  const counts = new Map();
  const visit = (node, file) => {
    for (const spec of node.specs ?? []) {
      for (const { projectName } of spec.tests) {
        if (!counts.has(projectName)) counts.set(projectName, new Map());
        const files = counts.get(projectName);
        files.set(file, (files.get(file) ?? 0) + 1);
      }
    }
    for (const child of node.suites ?? []) visit(child, file);
  };
  for (const fileSuite of report.suites) visit(fileSuite, fileSuite.file);
  const found = [];
  for (const { name } of report.config.projects) {
    const files = counts.get(name);
    if (!files) continue;
    for (const file of [...files.keys()].sort(byPath)) found.push({ project: name, file, tests: files.get(file) });
  }
  return found;
}

/* Playwright's filterForShard with even weights: shard sizes by test count,
   the first (total % n) shards one larger, and each group goes whole to the
   shard that holds its first test. */
function split(all, n) {
  const total = all.reduce((sum, g) => sum + g.tests, 0);
  const shards = Array.from({ length: n }, () => []);
  const ends = [];
  let end = 0;
  for (let i = 0; i < n; i++) ends.push((end += Math.floor(total / n) + (i < total % n ? 1 : 0)));
  let at = 0;
  for (const g of all) {
    shards[ends.findIndex((e) => at < e)].push(g);
    at += g.tests;
  }
  return shards;
}

const key = (g) => `${g.project}|${g.file}`;
const report = list();
const all = groups(report);
const shards = split(all, subshards);

if (check) {
  let differs = 0;
  for (let k = 1; k <= subshards; k++) {
    const actual = groups(list(`--shard=${k}/${subshards}`)).map((g) => `${key(g)}:${g.tests}`).sort();
    const expected = shards[k - 1].map((g) => `${key(g)}:${g.tests}`).sort();
    if (actual.join("\n") !== expected.join("\n")) {
      differs += 1;
      console.error(`[plan] sub-shard ${k}/${subshards}: Playwright lists ${actual.length} groups, this script expected ${expected.length}`);
    }
  }
  const tests = all.reduce((sum, g) => sum + g.tests, 0);
  if (differs) fail(`${differs} of ${subshards} sub-shards differ from Playwright's split of the ${suite} suite`);
  console.error(`[plan] ${suite}: Playwright's split of ${tests} tests matches this script's for all ${subshards} sub-shards`);
  process.exit(0);
}

/* Seconds per group: its recorded time scaled to its current test count; a
   file not recorded for this project takes its average over the projects that
   have it, and a file never recorded the suite's average per test. */
let timings;
try {
  timings = JSON.parse(readFileSync(new URL("./ci-shard-timings.json", import.meta.url), "utf8"));
} catch (error) {
  fail(`scripts/ci-shard-timings.json: ${error.message}`);
}
const malformed =
  timings && typeof timings === "object" && !Array.isArray(timings)
    ? Object.entries(timings).find(([, v]) => !(Array.isArray(v) && v.length === 2 && v[0] >= 0 && v[1] > 0))
    : ["the file", timings];
if (malformed) fail(`scripts/ci-shard-timings.json: ${malformed[0]} is not [seconds, tests]`);
const projects = new Set(report.config.projects.map((p) => p.name));
let suiteSeconds = 0;
let suiteTests = 0;
const byFile = new Map();
for (const [name, [seconds, tests]] of Object.entries(timings)) {
  const [project, file] = name.split("|");
  if (!projects.has(project)) continue;
  suiteSeconds += seconds;
  suiteTests += tests;
  const f = byFile.get(file) ?? { seconds: 0, tests: 0 };
  f.seconds += seconds;
  f.tests += tests;
  byFile.set(file, f);
}
const perTest = suiteTests ? suiteSeconds / suiteTests : 1;
function seconds(g) {
  const known = timings[key(g)];
  if (known) return (known[0] / known[1]) * g.tests;
  const f = byFile.get(g.file);
  return (f ? f.seconds / f.tests : perTest) * g.tests;
}

const cost = shards.map((held, i) => ({
  k: i + 1,
  tests: held.reduce((sum, g) => sum + g.tests, 0),
  seconds: Math.round(held.reduce((sum, g) => sum + seconds(g), 0)),
}));
/* Longest first, each to the job with the least work so far; ties go to the
   lower sub-shard and the lower job, so every job computes the same plan. */
const plan = Array.from({ length: jobs }, () => ({ load: 0, subshards: [] }));
for (const c of [...cost].sort((a, b) => b.seconds - a.seconds || a.k - b.k)) {
  let least = 0;
  for (let j = 1; j < jobs; j++) if (plan[j].load < plan[least].load) least = j;
  plan[least].subshards.push(c.k);
  plan[least].load += c.seconds + PER_SUBSHARD_SECONDS;
}
for (const p of plan) p.subshards.sort((a, b) => a - b);

const dealt = plan.flatMap((p) => p.subshards).sort((a, b) => a - b);
if (dealt.length !== subshards || dealt.some((k, i) => k !== i + 1)) fail("the plan does not run every sub-shard exactly once");

const tests = cost.reduce((sum, c) => sum + c.tests, 0);
console.error(`[plan] ${suite}: ${tests} tests in ${subshards} sub-shards over ${jobs} jobs, by estimated minutes of specs`);
plan.forEach((p, j) => {
  const minutes = p.subshards.reduce((sum, k) => sum + cost[k - 1].seconds, 0) / 60;
  const held = p.subshards.map((k) => `${k} (${cost[k - 1].tests} tests, ${(cost[k - 1].seconds / 60).toFixed(1)} min)`).join(", ");
  console.error(`[plan] job ${j + 1}: ${minutes.toFixed(1)} min: ${held}${j + 1 === job ? "  <- this job" : ""}`);
});
console.log(plan[job - 1].subshards.join(" "));
