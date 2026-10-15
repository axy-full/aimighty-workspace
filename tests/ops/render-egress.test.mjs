import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { judge, probe, gatewaysOf, HOST_PORTS, OPTIONS } from "../../ops/render-worker/check-egress.mjs";
import { judge as judgeRelay, secretNames } from "../../ops/render-worker/check-relay.mjs";

// The egress gate (ops/render-worker/README.md, Verify step 1) as a hard test: the script the owner runs in a worker's terminal
// is judged here against canned outputs. A name that resolves, or a connection that reaches the internet, anywhere it should not,
// is a failure and a non-zero exit. The README says no render until it passes. Nothing here touches a network.

const SCRIPT = fileURLToPath(new URL("../../ops/render-worker/check-egress.mjs", import.meta.url));
const README = readFileSync(fileURLToPath(new URL("../../ops/render-worker/README.md", import.meta.url)), "utf8");
const APP = "app-container:3000";
const GATEWAY = "172.20.0.1";
const hostLines = (ip = GATEWAY, state = "blocked") => HOST_PORTS.map((port) => `${state} host:${ip}:${port} ETIMEDOUT`);
const GOOD = ["blocked dns ENOTFOUND", "blocked https://example.com ENOTFOUND", "blocked http://1.1.1.1 ENETUNREACH", `blocked http://${APP} ENOTFOUND`, "blocked host.docker.internal ENOTFOUND", ...hostLines(), "clean env"];
const APP_AT = 3, HOSTNAME_AT = 4, HOST_AT = 5, ENV_AT = GOOD.length - 1;
const withLine = (lines, index, line) => lines.map((l, i) => (i === index ? line : l));
const run = (args, stdin) => spawnSync(process.execPath, [SCRIPT, ...args], { input: stdin, encoding: "utf8", env: { PATH: process.env.PATH } });
const code = (c) => Object.assign(new TypeError("fetch failed"), { cause: { code: c } });
const failures = (lines, option = "c") => judge(lines, option, APP).failures.join(";");

test("option c (the relay): every line blocked is a pass, and the app line must be blocked (only the relay is on both networks)", () => {
  assert.deepEqual(judge(GOOD, "c", APP), { ok: true, failures: [] });
  const verdict = judge(withLine(GOOD, APP_AT, `REACHED http://${APP} 200`), "c", APP);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(";"), /app: REACHED .* \(option c expects blocked\)/);
});

test("options a and b differ only in the app line: a expects REACHED, b expects blocked", () => {
  assert.equal(OPTIONS.a.app, "REACHED"); assert.equal(OPTIONS.b.app, "blocked");
  assert.equal(judge(withLine(GOOD, APP_AT, `REACHED http://${APP} 200`), "a", APP).ok, true);
  assert.equal(judge(GOOD, "a", APP).ok, false);
  assert.equal(judge(GOOD, "b", APP).ok, true);
});

test("a name that resolves is a failure in every option, even with no route", () => {
  for (const option of ["a", "b", "c"]) {
    const verdict = judge(withLine(withLine(GOOD, APP_AT, option === "a" ? `REACHED http://${APP} 200` : GOOD[APP_AT]), 0, "RESOLVED example.com 93.184.216.34"), option, APP);
    assert.equal(verdict.ok, false, option);
    assert.match(verdict.failures[0], /DNS: RESOLVED/);
  }
  assert.match(failures(withLine(GOOD, HOSTNAME_AT, "RESOLVED host.docker.internal 172.17.0.1")), /host name: RESOLVED host\.docker\.internal/);
});

test("a connection that reaches the internet is a failure in every option, for each of the two internet lines", () => {
  for (const option of ["a", "b", "c"]) for (const [index, url] of [[1, "https://example.com"], [2, "http://1.1.1.1"]]) {
    const lines = withLine(withLine(GOOD, APP_AT, option === "a" ? `REACHED http://${APP} 200` : GOOD[APP_AT]), index, `REACHED ${url} 200`);
    const verdict = judge(lines, option, APP);
    assert.equal(verdict.ok, false, `${option} ${url}`);
    assert.match(verdict.failures.join(";"), /internet: REACHED/);
  }
});

test("the HOST is probed: a reached gateway port is a failure, and so is a REFUSED one (the host answered, so a route to it exists), for every port and option", () => {
  for (const option of ["a", "b", "c"]) for (let i = 0; i < HOST_PORTS.length; i++) {
    const base = option === "a" ? withLine(GOOD, APP_AT, `REACHED http://${APP} 200`) : GOOD;
    assert.equal(judge(base, option, APP).ok, true, option);
    for (const line of [`REACHED host:${GATEWAY}:${HOST_PORTS[i]} CONNECTED`, `REACHED host:${GATEWAY}:${HOST_PORTS[i]} ECONNREFUSED`]) {
      const verdict = judge(withLine(base, HOST_AT + i, line), option, APP);
      assert.equal(verdict.ok, false, `${option} ${line}`);
      assert.match(verdict.failures.join(";"), /host: REACHED/);
    }
  }
  assert.match(failures(withLine(GOOD, HOST_AT, `REACHED host:${GATEWAY}:22 ECONNREFUSED`)), /a refusal means the host answered/);
});

test("the host probe cannot be skipped: no gateway line, a missing port, a repeated port or an unexpected port is a failure; two networks means two gateways, all blocked", () => {
  const withoutHost = GOOD.filter((_, i) => i < HOST_AT || i === ENV_AT);
  assert.match(failures(withoutHost), /no host \(gateway\) probe/);
  assert.match(failures(GOOD.filter((_, i) => i !== HOST_AT + 2)), /port 80 was not probed|port 443 was not probed|was not probed/);
  assert.match(failures([...GOOD.slice(0, ENV_AT), GOOD[HOST_AT], "clean env"]), /is repeated/);
  assert.match(failures([...GOOD.slice(0, ENV_AT), `blocked host:${GATEWAY}:9999 ETIMEDOUT`, "clean env"]), /unexpected port 9999/);
  assert.equal(judge([...GOOD.slice(0, ENV_AT), ...hostLines("172.21.0.1"), "clean env"], "c", APP).ok, true);
  assert.match(failures([...GOOD.slice(0, ENV_AT), ...hostLines("172.21.0.1", "REACHED"), "clean env"]), /host: REACHED host:172\.21\.0\.1/);
});

test("the line set is EXACT: any extra REACHED or RESOLVED line (evil.com, an extra URL) fails options b and c, and a allows REACHED only on the app line", () => {
  for (const extra of ["REACHED evil.com 200", "RESOLVED evil.com 6.6.6.6", "REACHED https://evil.com 200", "blocked https://evil.com ENOTFOUND", "REACHED http://evil.com:8080 200", "RESOLVED example.com 1.2.3.4", "LEAK env X"]) {
    for (const option of ["a", "b", "c"]) {
      const base = option === "a" ? withLine(GOOD, APP_AT, `REACHED http://${APP} 200`) : GOOD;
      const verdict = judge([...base.slice(0, ENV_AT), extra, "clean env"], option, APP);
      assert.equal(verdict.ok, false, `${option} ${extra}`);
    }
  }
  assert.equal(judge([...GOOD, "REACHED evil.com 200"], "a", APP).ok, false);
  assert.equal(judge([...withLine(GOOD, APP_AT, `REACHED http://${APP} 200`), `REACHED http://other:3000 200`], "a", APP).ok, false, "a second app line is not allowed in a");
});

test("a worker whose own environment holds an ASTRA_WORKER_SECRET_<N> name fails; the line prints the NAME only, and the probe reads names, never values", async () => {
  assert.match(failures(withLine(GOOD, ENV_AT, "LEAK env ASTRA_WORKER_SECRET_2")), /environment: LEAK env ASTRA_WORKER_SECRET_2/);
  assert.equal(judge(GOOD.slice(0, ENV_AT), "c", APP).ok, false, "a missing env line");
  const lines = await probe({ app: APP, lookup: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); }, fetcher: async () => { throw code("ENETUNREACH"); }, interfaces: {}, tcp: async () => "x", env: { PATH: "/x", ASTRA_WORKER_SECRET_2: "super-secret-value", ASTRA_WORKER_SECRET: "another-value" } });
  assert.deepEqual(lines.slice(-2), ["LEAK env ASTRA_WORKER_SECRET_2", "LEAK env ASTRA_WORKER_SECRET"]);
  assert.doesNotMatch(lines.join("\n"), /super-secret-value|another-value/);
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

test("the script's exit code: 0 only when judged clean; 1 on a resolved name, a reached address or host, a wrong option or empty input; --from-stdin says JUDGED (not probed), never PASS", () => {
  const judged = run(["--option", "c", "--from-stdin"], GOOD.join("\n"));
  assert.equal(judged.status, 0); assert.match(judged.stdout, /JUDGED \(not probed\)/); assert.doesNotMatch(judged.stdout, /EGRESS GATE: PASS/);
  for (const [label, lines] of [["resolved", withLine(GOOD, 0, "RESOLVED example.com 1.2.3.4")], ["reached", withLine(GOOD, 2, "REACHED http://1.1.1.1 200")], ["host", withLine(GOOD, HOST_AT, `REACHED host:${GATEWAY}:22 ECONNREFUSED`)], ["app reached in c", withLine(GOOD, APP_AT, `REACHED http://${APP} 200`)], ["leak", withLine(GOOD, ENV_AT, "LEAK env ASTRA_WORKER_SECRET_1")], ["empty", []]]) {
    const got = run(["--option", "c", "--from-stdin"], lines.join("\n"));
    assert.equal(got.status, 1, label); assert.match(got.stdout, /FAIL/, label); assert.match(got.stdout, /No render until this passes/, label);
  }
  const noOption = run(["--from-stdin"], GOOD.join("\n"));
  assert.equal(noOption.status, 1); assert.match(noOption.stdout, /give --option a, b or c/);
  const noApp = run(["--option", "c"], "");
  assert.equal(noApp.status, 1); assert.match(noApp.stdout, /give --app/);
});

test("gatewaysOf derives each network's gateway (network address + 1) from the container's interfaces and ignores loopback and IPv6", () => {
  assert.deepEqual(gatewaysOf({ lo: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }], eth0: [{ family: "IPv4", address: "172.20.0.5", netmask: "255.255.0.0", internal: false }, { family: "IPv6", address: "fe80::1", netmask: "ffff::", internal: false }], eth1: [{ family: 4, address: "10.1.2.200", netmask: "255.255.255.0", internal: false }] }), ["172.20.0.1", "10.1.2.1"]);
  assert.deepEqual(gatewaysOf({}), []);
});

test("probe() prints the lines the README names, from injected lookups, fetches and connects (a blocked network, then a leaky one)", async () => {
  const interfaces = { eth0: [{ family: "IPv4", address: "172.20.0.5", netmask: "255.255.0.0", internal: false }] };
  const tcpBlocked = async (ip, port) => `blocked host:${ip}:${port} ETIMEDOUT`;
  const blocked = await probe({ app: APP, interfaces, tcp: tcpBlocked, env: { PATH: "/x" }, lookup: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); }, fetcher: async () => { throw code("ENETUNREACH"); } });
  assert.deepEqual(blocked, ["blocked dns ENOTFOUND", "blocked https://example.com ENETUNREACH", "blocked http://1.1.1.1 ENETUNREACH", `blocked http://${APP} ENETUNREACH`, "blocked host.docker.internal ENOTFOUND", ...hostLines().map((l) => l.replace("ETIMEDOUT", "ETIMEDOUT")), "clean env"]);
  assert.equal(judge(blocked, "c", APP).ok, true);
  const leaky = await probe({ app: APP, interfaces, env: {}, tcp: async (ip, port) => `REACHED host:${ip}:${port} ECONNREFUSED`, lookup: async () => ({ address: "93.184.216.34" }), fetcher: async (url) => (url.includes("example.com") ? { status: 200 } : (() => { throw code("ECONNREFUSED"); })()) });
  assert.deepEqual(leaky.slice(0, 2), ["RESOLVED example.com 93.184.216.34", "REACHED https://example.com 200"]);
  const verdict = judge(leaky, "c", APP);
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(";"), /DNS: RESOLVED.*internet: REACHED.*host name: RESOLVED.*host: REACHED/);
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
  assert.match(README, /after every change to the stack, a firewall change, a Docker Engine upgrade or a reboot/i);
  assert.match(README, /three workers are not supported on this 8-core server/i);
  assert.match(README, /host:IP:PORT/);
  assert.match(README, /node \/app\/check-relay\.mjs/);
});
