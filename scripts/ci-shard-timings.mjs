// Refreshes scripts/ci-shard-timings.json, the seconds scripts/ci-shard-plan.mjs
// expects each spec file to take per project, from finished verify.yml
// browser jobs' logs, for example
//   gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs > job.log
//
// A test's time runs from the previous result line of its sub-shard (or the
// sub-shard's "Running N tests" line) to its own, so it includes launching the
// browser and the hooks. With several logs for one file and project, the
// median is kept. Entries not in the logs stay; entries for spec files that no
// longer exist are dropped.
//
//   node scripts/ci-shard-timings.mjs <job log>...
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const logs = process.argv.slice(2);
if (!logs.length) {
  console.error("usage: ci-shard-timings.mjs <job log>...");
  process.exit(1);
}
const table = new URL("./ci-shard-timings.json", import.meta.url);
const specs = fileURLToPath(new URL("../tests/", import.meta.url));
/* Result lines name spec files from the checkout root. */
const testDir = "tests/";

const stamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
const result = /^\s+(?:✓|✘|-|ok|x)\s+\d+\s+\[([^\]]+)\] › (\S+?):\d+:\d+ › /;
const samples = new Map();
for (const log of logs) {
  const seen = new Map();
  let previous = null;
  for (const raw of readFileSync(log, "utf8").split("\n")) {
    const line = stamp.exec(raw);
    if (!line) continue;
    const at = Date.parse(line[1]);
    const text = line[2].replace(/\x1b\[[0-9;]*m/g, "");
    if (/^Running \d+ tests? using/.test(text)) {
      previous = at;
      continue;
    }
    const test = result.exec(text);
    if (!test || previous === null) continue;
    const file = test[2].startsWith(testDir) ? test[2].slice(testDir.length) : test[2];
    const name = `${test[1]}|${file}`;
    const entry = seen.get(name) ?? [0, 0];
    entry[0] += (at - previous) / 1000;
    entry[1] += 1;
    seen.set(name, entry);
    previous = at;
  }
  for (const [name, entry] of seen) samples.set(name, [...(samples.get(name) ?? []), entry]);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const timings = existsSync(table) ? JSON.parse(readFileSync(table, "utf8")) : {};
for (const [name, entries] of samples) {
  timings[name] = [Math.round(median(entries.map((e) => e[0]))), Math.round(median(entries.map((e) => e[1])))];
}
const kept = Object.keys(timings)
  .filter((name) => existsSync(join(specs, name.split("|")[1])))
  .sort();
writeFileSync(table, `{\n${kept.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(timings[name])}`).join(",\n")}\n}\n`);
console.log(`${samples.size} file and project timings from ${logs.length} logs; ${kept.length} kept in scripts/ci-shard-timings.json`);
