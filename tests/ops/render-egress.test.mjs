import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { judge, probe, OPTIONS } from "../../ops/render-worker/check-egress.mjs";
import { judge as judgeRelay, secretNames } from "../../ops/render-worker/check-relay.mjs";

// The egress gate (ops/render-worker/README.md, Verify step 1) as a hard test: the script the owner runs in a worker's terminal
// is judged here against canned outputs. A name that resolves, or a connection that reaches the internet, anywhere it should not,
// is a failure and a non-zero exit. The README says no render until it passes. Nothing here touches a network.

const SCRIPT = fileURLToPath(new URL("../../ops/render-worker/check-egress.mjs", import.meta.url));
const README = readFileSync(fileURLToPath(new URL("../../ops/render-worker/README.md", import.meta.url)), "utf8");
const APP = "app-container:3000";
const GOOD = ["blocked dns ENOTFOUND", "blocked https://example.com ENOTFOUND", "blocked http://1.1.1.1 ENETUNREACH", `blocked http://${APP} ENOTFOUND`];
const withLine = (lines, index, line) => lines.map((l, i) => (i === index ? line : l));
const run = (args, stdin) => spawnSync(process.execPath, [SCRIPT, ...args], { input: stdin, encoding: "utf8", env: { PATH: process.env.PATH } });

test("option c (the relay): all four lines blocked is a pass, and the app line must be blocked (only the relay is on both networks)", () => {
  assert.deepEqual(judge(GOOD, "c", APP), { ok: true, failures: [] });
  const reached = withLine(GOOD, 3, `REACHED http://${APP} 200`);
  const verdict = judge(reached, "c", APP);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(";"), /app: REACHED .* \(option c expects blocked\)/);
});

test("options a and b differ only in the app line: a expects REACHED, b expects blocked", () => {
  assert.equal(OPTIONS.a.app, "REACHED"); assert.equal(OPTIONS.b.app, "blocked");
  assert.equal(judge(withLine(GOOD, 3, `REACHED http://${APP} 200`), "a", APP).ok, true);
  assert.equal(judge(GOOD, "a", APP).ok, false);
  assert.equal(judge(GOOD, "b", APP).ok, true);
});

test("a name that resolves is a failure in every option, even with no route", () => {
  for (const option of ["a", "b", "c"]) {
    const verdict = judge(withLine(GOOD, 0, "RESOLVED example.com 93.184.216.34"), option, APP);
    assert.equal(verdict.ok, false, option);
    assert.match(verdict.failures[0], /DNS: RESOLVED/);
  }
});

test("a connection that reaches the internet is a failure in every option, for each of the two internet lines", () => {
  for (const option of ["a", "b", "c"]) for (const [index, url] of [[1, "https://example.com"], [2, "http://1.1.1.1"]]) {
    const verdict = judge(withLine(GOOD, index, `REACHED ${url} 200`), option, APP);
    assert.equal(verdict.ok, false, `${option} ${url}`);
    assert.match(verdict.failures.join(";"), /internet: REACHED/);
  }
});

test("a missing, repeated, unknown or unreadable line is a failure, never a pass; so is an unknown option or no output", () => {
  for (let i = 0; i < GOOD.length; i++) assert.equal(judge(GOOD.filter((_, j) => j !== i), "c", APP).ok, false, `line ${i} missing`);
  assert.equal(judge([...GOOD, GOOD[1]], "c", APP).ok, false, "a repeated line");
  assert.equal(judge([...GOOD, "something else entirely"], "c", APP).ok, false, "an unrecognised line");
  assert.equal(judge(GOOD.map((l) => l.replace("blocked", "REACHED")), "c", APP).ok, false);
  assert.equal(judge(GOOD, "d", APP).ok, false);
  assert.equal(judge([], "c", APP).ok, false);
  assert.equal(judge(undefined, "c", APP).ok, false);
  assert.equal(judge(GOOD.map((l) => `  ${l}  `), "c", APP).ok, true, "surrounding spaces are not a difference");
  assert.equal(judge(GOOD, "c", "another-app:3000").ok, false, "the app line must be for the app that was named");
});

test("the script's exit code: 0 only on PASS; 1 on a resolved name, a reached address, a wrong option or empty input; it prints the verdict", () => {
  const pass = run(["--option", "c", "--from-stdin"], GOOD.join("\n"));
  assert.equal(pass.status, 0); assert.match(pass.stdout, /EGRESS GATE: PASS/);
  for (const [label, lines] of [["resolved", withLine(GOOD, 0, "RESOLVED example.com 1.2.3.4")], ["reached", withLine(GOOD, 2, "REACHED http://1.1.1.1 200")], ["app reached in c", withLine(GOOD, 3, `REACHED http://${APP} 200`)], ["empty", []]]) {
    const got = run(["--option", "c", "--from-stdin"], lines.join("\n"));
    assert.equal(got.status, 1, label); assert.match(got.stdout, /EGRESS GATE: FAIL/, label); assert.match(got.stdout, /No render until this passes/, label);
  }
  const noOption = run(["--from-stdin"], GOOD.join("\n"));
  assert.equal(noOption.status, 1); assert.match(noOption.stdout, /give --option a, b or c/);
  const noApp = run(["--option", "c"], "");
  assert.equal(noApp.status, 1); assert.match(noApp.stdout, /give --app/);
});

test("probe() prints the lines the README names, from injected lookups and fetches (a blocked network, then a leaky one)", async () => {
  const code = (c) => Object.assign(new TypeError("fetch failed"), { cause: { code: c } });
  const blocked = await probe({ app: APP, lookup: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); }, fetcher: async () => { throw code("ENETUNREACH"); } });
  assert.deepEqual(blocked, ["blocked dns ENOTFOUND", "blocked https://example.com ENETUNREACH", "blocked http://1.1.1.1 ENETUNREACH", `blocked http://${APP} ENETUNREACH`]);
  assert.equal(judge(blocked, "c", APP).ok, true);
  const leaky = await probe({ app: APP, lookup: async () => ({ address: "93.184.216.34" }), fetcher: async (url) => (url.includes("example.com") ? { status: 200 } : (() => { throw code("ECONNREFUSED"); })()) });
  assert.deepEqual(leaky.slice(0, 2), ["RESOLVED example.com 93.184.216.34", "REACHED https://example.com 200"]);
  const verdict = judge(leaky, "c", APP);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(";"), /DNS: RESOLVED.*internet: REACHED/);
});

test("the relay check fails on a secret-looking variable, a worker that does not answer 401, or a port that is open; names only, never values", () => {
  assert.deepEqual(secretNames({ PATH: "/x", RELAY_WORKERS: "1", ASTRA_WORKER_SECRET: "v", NODE_VERSION: "22" }), ["ASTRA_WORKER_SECRET"]);
  assert.equal(judgeRelay({ secretNames: [], workers: [{ n: 1, status: 401 }], closed: [{ port: 8790, open: false }] }).ok, true);
  for (const bad of [{ secretNames: ["X_TOKEN"], workers: [{ n: 1, status: 401 }] }, { secretNames: [], workers: [{ n: 1, status: 200 }] }, { secretNames: [], workers: [{ n: 1, status: null }] }, { secretNames: [], workers: [] }, { secretNames: [], workers: [{ n: 1, status: 401 }], closed: [{ port: 8790, open: true }] }])
    assert.equal(judgeRelay(bad).ok, false);
  assert.doesNotMatch(JSON.stringify(judgeRelay({ secretNames: ["ASTRA_WORKER_SECRET"], workers: [{ n: 1, status: 401 }] })), /test-secret/);
});

test("the README makes the gate hard: no real render until it passes, the command is named, and option c's app line is blocked", () => {
  assert.match(README, /node \/app\/check-egress\.mjs --option c --app/);
  assert.match(README, /No real render until it passes/i);
  assert.match(README, /EGRESS GATE: PASS/);
  assert.match(README, /node \/app\/check-relay\.mjs/);
});
