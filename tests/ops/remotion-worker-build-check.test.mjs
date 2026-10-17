import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The export worker image's build-time runs (ops/remotion-worker/Dockerfile): the fixture render and the deck PDF each run
// under a hard limit (owner, 16 Oct 2026: `timeout -k 10s <N>s`, whole process group, a log line naming the run, the limit
// and the time). The static checks read the Dockerfile; the behaviour checks run the Dockerfile's OWN shell lines for each
// run, with the limit cut to 1 s and the export command swapped for a stand-in, in a fresh temporary folder. Nothing is built,
// nothing leaves the machine, and the lines run never include the step's clean-up (they stop at the "rendered" line).

const DOCKERFILE = readFileSync(new URL("../../ops/remotion-worker/Dockerfile", import.meta.url), "utf8");
const COMMAND = "/usr/local/bin/node /opt/remotion/cli.mjs";
const RUNS = [
  { name: "fixture-clip", done: "rendered" },
  { name: "deck-pdf", done: "printed" },
];
const skip = process.platform === "linux" ? false : "needs Linux, /bin/sh and GNU timeout";

/** The RUN instructions, continuation lines joined, comments dropped. */
function runs() {
  const code = DOCKERFILE.replace(/^#.*\n/gm, "").replace(/\\\n/g, " ");
  return code.split("\n").filter((line) => line.startsWith("RUN ")).map((line) => line.slice(4).trim());
}
/** The one RUN that holds a named build check. */
function runOf(name) {
  const found = runs().filter((r) => r.includes(`echo "build-check ${name}: start`));
  assert.equal(found.length, 1, `one build-time run named ${name}`);
  return found[0];
}
/** That run's lines from its start line to its done line: the timed command and what it says, nothing after. */
function timedPart(name, done) {
  const run = runOf(name);
  const from = run.indexOf(`echo "build-check ${name}: start`);
  const marker = `echo "build-check ${name}: ${done} `;
  const at = run.indexOf(marker);
  assert.ok(from >= 0 && at > from, `${name}: start and ${done} lines, in that order`);
  const end = run.indexOf(";", at) + 1;
  return run.slice(from, end);
}
/** Runs the lines in /bin/sh, in its own process group, ended (the whole group) after `limitMs` if the lines' own limit failed to. */
function sh(script, cwd, limitMs = 15_000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("/bin/sh", ["-c", script], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const guard = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, limitMs);
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    child.on("close", (code) => { clearTimeout(guard); resolve({ code, out, ms: Date.now() - started }); });
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Dockerfile: every build-time run of the export command is under `timeout -k 10s 300s`, and says when it starts and how it ends", () => {
  const all = runs();
  const calls = all.filter((r) => r.includes(COMMAND));
  assert.equal(calls.length, RUNS.length, "the fixture render and the deck PDF, and no other build-time run of the command");
  for (const run of calls) {
    const uses = run.split(COMMAND).length - 1;
    assert.equal(uses, 1, "one call of the command per run");
    assert.match(run, /timeout -k 10s 300s \/usr\/local\/bin\/node \/opt\/remotion\/cli\.mjs/, "the command is the timed one");
  }
  for (const { name, done } of RUNS) {
    const run = runOf(name);
    assert.ok(run.startsWith("set -eu;"), `${name}: set -eu`);
    assert.ok(run.includes(`echo "build-check ${name}: start $(date -u +%Y-%m-%dT%H:%M:%SZ), limit 300 s"`), `${name}: a start line with the time and the limit`);
    assert.ok(run.includes(`echo "build-check ${name}: ended by the 300 s limit at $(date -u +%Y-%m-%dT%H:%M:%SZ)"`), `${name}: a line saying the limit ended it`);
    assert.ok(run.includes(`echo "build-check ${name}: failed (exit $rc) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"`), `${name}: a line saying it failed, with its code`);
    assert.ok(run.includes(`echo "build-check ${name}: ${done} $(date -u +%Y-%m-%dT%H:%M:%SZ)"`), `${name}: a line saying it finished`);
    assert.ok(run.includes("tail -n 40 out.log"), `${name}: the end of its log is printed when it fails`);
    assert.ok(/exit 1; fi;/.test(run), `${name}: a failure fails the build`);
    /* timeout's own codes: 124 when TERM ended it, 137 when it needed KILL after the 10 s grace. */
    assert.ok(run.includes('[ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]'), `${name}: both of timeout's codes read as the limit`);
    /* --foreground would signal only the child, not Chrome under it. */
    assert.ok(!run.includes("--foreground"), `${name}: the whole process group is ended`);
  }
});

for (const { name, done } of RUNS) {
  const part = timedPart(name, done);
  /** The run's own lines, the limit cut to 1 s, the command swapped for `stand`. */
  const scripted = (stand) => `set -eu; ${part.replaceAll("timeout -k 10s 300s", "timeout -k 1s 1s").replaceAll("300 s", "1 s").replace(COMMAND, stand)}`;

  test(`build check ${name}: a run that hangs is ended by the limit, Chrome-like grandchildren too, and the build fails saying so`, { skip }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `particl-build-check-${name}-`));
    const stand = `/bin/sh -c 'sleep 60 & echo $! > grandchild.pid; sleep 60'`;
    const r = await sh(scripted(stand), cwd);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.ms < 15_000, `ended in ${r.ms} ms`);
    assert.match(r.out, new RegExp(`build-check ${name}: start \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ, limit 1 s`));
    assert.match(r.out, new RegExp(`build-check ${name}: ended by the 1 s limit at \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ`));
    assert.doesNotMatch(r.out, new RegExp(`build-check ${name}: ${done}`));
    const pid = Number((await readFile(join(cwd, "grandchild.pid"), "utf8")).trim());
    assert.ok(pid > 0);
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(pid), false, "the grandchild was ended with its group");
  });

  test(`build check ${name}: a run that fails prints its log's end and its code, and the build fails`, { skip }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `particl-build-check-${name}-`));
    const r = await sh(scripted(`/bin/sh -c 'echo "no such library"; exit 3'`), cwd);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no such library/);
    assert.match(r.out, new RegExp(`build-check ${name}: failed \\(exit 3\\) at \\d{4}-`));
    assert.doesNotMatch(r.out, /limit at/);
  });

  test(`build check ${name}: a run that finishes in time says so and goes on`, { skip }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `particl-build-check-${name}-`));
    const r = await sh(`${scripted("/bin/true")} echo next-step`, cwd);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`build-check ${name}: ${done} \\d{4}-`));
    assert.match(r.out, /next-step/);
  });
}
