import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConcurrency, parseHeapMb } from "../../ops/selfhost/cluster.mjs";

// ops/selfhost/cluster.mjs is copied next to a tiny fake server.js in a scratch
// directory, as the Dockerfile places it next to Next's standalone server.js.
// The fake answers its pid, has a slow route, and on SIGTERM does what Next
// 16.3.8's start-server does: close the server, let in-flight requests finish,
// then exit 143. Everything binds 127.0.0.1; nothing leaves the machine.

const CLUSTER = fileURLToPath(new URL("../../ops/selfhost/cluster.mjs", import.meta.url));
const SECRET = "cluster-test-secret-value-0123456789";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_SERVER = `const http = require("node:http");
const v8 = require("node:v8");
if (process.env.FAKE_CRASH === "1") process.exit(3);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/slow") {
    process.stdout.write(JSON.stringify({ fake: "slow-start", pid: process.pid }) + "\\n");
    setTimeout(() => res.end(JSON.stringify({ pid: process.pid, slow: true })), Number(url.searchParams.get("ms") || 1000));
    return;
  }
  if (url.pathname === "/heap") { res.end(JSON.stringify({ pid: process.pid, heapLimit: v8.getHeapStatistics().heap_size_limit })); return; }
  res.end(JSON.stringify({ pid: process.pid }));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
if (process.env.FAKE_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
else {
  let started = false;
  const cleanup = (code) => { if (started) return; started = true; server.close(() => process.exit(code)); };
  process.on("SIGTERM", () => cleanup(143));
  process.on("SIGINT", () => cleanup(130));
}
`;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function start(env = {}, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cluster-start-"));
  await copyFile(CLUSTER, join(dir, "cluster.mjs"));
  await writeFile(join(dir, "server.js"), FAKE_SERVER);
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, "cluster.mjs")], {
    cwd: dir,
    env: { PATH: process.env.PATH, PORT: String(port), DATABASE_TOKEN: SECRET, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  let stdout = "", buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try { lines.push(JSON.parse(line)); } catch { lines.push({ raw: line }); }
    }
  });
  child.stderr.resume();
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const events = (name) => lines.filter((l) => l.component === "cluster" && l.event === name);
  /** Distinct pids answering on the one port, until `count` of them have answered. */
  const answering = async (count, timeoutMs) => {
    const pids = new Set();
    await waitFor(async () => {
      try { pids.add((await get(port, "/pid")).body.pid); } catch { /* not listening yet */ }
      return pids.size >= count;
    }, `${count} pids answering`, timeoutMs);
    return pids;
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (!options.keep) await rm(dir, { recursive: true, force: true });
  };
  return { child, port, lines, events, exited, answering, stop, stdout: () => stdout };
}

test("WEB_CONCURRENCY: an integer 1..16, else 3 and flagged", () => {
  for (const [raw, workers, invalid] of [
    [undefined, 3, false], ["", 3, false], [" 4 ", 4, false], ["1", 1, false], ["16", 16, false],
    ["0", 3, true], ["17", 3, true], ["-2", 3, true], ["2.5", 3, true], ["abc", 3, true], ["3x", 3, true], ["1e1", 3, true],
  ]) assert.deepEqual(parseConcurrency(raw), { workers, invalid }, String(raw));
});

test("N workers start and answer on one port; lifecycle lines are JSON and carry no environment values", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "3" });
  try {
    const pids = await run.answering(3);
    assert.equal(pids.size, 3);
    assert.ok(!pids.has(run.child.pid), "the primary serves nothing itself");
    assert.deepEqual(run.events("start").map((l) => [l.mode, l.workers]), [["cluster", 3]]);
    const forked = new Set(run.events("fork").map((l) => l.worker));
    for (const pid of pids) assert.ok(forked.has(pid), "every answering pid was logged as forked");
    assert.ok(!run.stdout().includes(SECRET));
  } finally { await run.stop(); }
});

test("an invalid WEB_CONCURRENCY is logged and 3 workers run", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "lots" });
  try {
    await run.answering(3);
    assert.equal(run.events("invalid-concurrency").length, 1);
    assert.ok(!run.stdout().includes("lots"), "the raw value is not echoed");
    assert.deepEqual(run.events("start").map((l) => l.workers), [3]);
  } finally { await run.stop(); }
});

test("a killed worker is restarted after its back-off", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "2", CLUSTER_BACKOFF_MS: "50" });
  try {
    const before = await run.answering(2);
    const victim = [...before][0];
    process.kill(victim, "SIGKILL");
    await waitFor(() => run.events("fork").length >= 3, "a third fork");
    const exit = run.events("exit").find((l) => l.worker === victim);
    assert.equal(exit.signal, "SIGKILL");
    assert.equal(exit.expected, false);
    const restart = run.events("restart")[0];
    assert.equal(restart.delayMs, 50);
    assert.equal(restart.attempt, 1);
    const fresh = run.events("fork").at(-1);
    assert.equal(fresh.slot, exit.slot);
    const after = await waitFor(async () => {
      const pids = await run.answering(2);
      return pids.has(fresh.worker) ? pids : null;
    }, "the restarted worker answering");
    assert.ok(!after.has(victim));
    assert.equal(run.child.exitCode, null, "the primary keeps running");
  } finally { await run.stop(); }
});

test("a crash loop makes the primary exit 1 instead of spinning", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "2", FAKE_CRASH: "1", CLUSTER_BACKOFF_MS: "10", CLUSTER_CRASH_LIMIT: "5" });
  try {
    const { code } = await run.exited;
    assert.equal(code, 1);
    const loop = run.events("crash-loop");
    assert.equal(loop.length, 1);
    assert.equal(loop[0].exits, 6);
    assert.equal(run.events("exit").filter((l) => !l.expected).length, 6);
    assert.ok(run.events("restart").length >= 4);
    /* Back-off doubles per slot. */
    const delays = run.events("restart").filter((l) => l.slot === 1).map((l) => l.delayMs);
    assert.deepEqual(delays, delays.map((_, i) => 10 * 2 ** i));
    assert.deepEqual(run.events("stopped").map((l) => l.exitCode), [1]);
  } finally { await run.stop(); }
});

test("SIGTERM lets an in-flight slow request finish, ignores a second signal, then exits 0", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "3" });
  try {
    await run.answering(3);
    const slow = get(run.port, "/slow?ms=1500");
    await waitFor(() => run.lines.some((l) => l.fake === "slow-start"), "the slow request to arrive");
    run.child.kill("SIGTERM");
    await sleep(100);
    run.child.kill("SIGTERM");
    const response = await slow;
    assert.equal(response.status, 200);
    assert.equal(response.body.slow, true);
    const { code } = await run.exited;
    assert.equal(code, 0);
    assert.deepEqual(run.events("shutdown").map((l) => [l.reason, l.workers]), [["SIGTERM", 3]]);
    assert.equal(run.events("signal-during-shutdown").length, 1);
    const exits = run.events("exit");
    assert.equal(exits.length, 3);
    for (const exit of exits) { assert.equal(exit.code, 143); assert.equal(exit.expected, true); }
    assert.equal(run.events("restart").length, 0);
    assert.equal(run.events("force-kill").length, 0);
    assert.deepEqual(run.events("stopped").map((l) => l.exitCode), [0]);
    /* The slow worker outlived the others' quick exits only by its request. */
    const slowPid = run.lines.find((l) => l.fake === "slow-start").pid;
    assert.equal(exits.at(-1).worker, slowPid);
  } finally { await run.stop(); }
});

test("a worker that ignores SIGTERM is killed after CLUSTER_STOP_GRACE_MS, then the primary exits 0", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "2", FAKE_IGNORE_TERM: "1", CLUSTER_STOP_GRACE_MS: "300" });
  try {
    await run.answering(2);
    const at = Date.now();
    run.child.kill("SIGTERM");
    const { code } = await run.exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - at >= 300);
    assert.equal(run.events("force-kill").length, 2);
    for (const exit of run.events("exit")) assert.equal(exit.signal, "SIGKILL");
  } finally { await run.stop(); }
});

test("WEB_CONCURRENCY=1 is today's single process: server.js serves in the started process and exits as Next does", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "1" });
  try {
    const pids = await run.answering(1);
    assert.deepEqual([...pids], [run.child.pid]);
    assert.deepEqual(run.events("start").map((l) => [l.mode, l.workers]), [["single", 1]]);
    assert.equal(run.events("fork").length, 0);
    run.child.kill("SIGTERM");
    assert.equal((await run.exited).code, 143);
  } finally { await run.stop(); }
});

test("WORKER_HEAP_MB: an integer 128..16384, else 896 and flagged", () => {
  for (const [raw, mb, invalid] of [
    [undefined, 896, false], ["", 896, false], ["128", 128, false], [" 2048 ", 2048, false], ["16384", 16384, false],
    ["127", 896, true], ["16385", 896, true], ["1.5", 896, true], ["1g", 896, true], ["-512", 896, true],
  ]) assert.deepEqual(parseHeapMb(raw), { mb, invalid }, String(raw));
});

const MB = 1024 * 1024;
/** Every worker's V8 heap limit, once `count` workers have answered. */
async function heapLimits(run, count) {
  const limits = new Map();
  await waitFor(async () => {
    try { const { body } = await get(run.port, "/heap"); limits.set(body.pid, body.heapLimit); } catch { /* not listening yet */ }
    return limits.size >= count;
  }, `${count} heap answers`);
  return [...limits.values()];
}
/* heap_size_limit is the old-space cap plus the young generation (192 MB on Node 24 here). */
const about = (limit, mb) => limit >= mb * MB && limit <= (mb + 256) * MB;

test("each worker's heap is capped at WORKER_HEAP_MB, 896 MB by default", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "2" });
  try {
    for (const limit of await heapLimits(run, 2)) assert.ok(about(limit, 896), `${limit / MB} MB`);
    assert.deepEqual(run.events("start").map((l) => l.heapMb), [896]);
  } finally { await run.stop(); }
  const small = await start({ WEB_CONCURRENCY: "2", WORKER_HEAP_MB: "256" });
  try {
    for (const limit of await heapLimits(small, 2)) assert.ok(about(limit, 256), `${limit / MB} MB`);
  } finally { await small.stop(); }
  const invalid = await start({ WEB_CONCURRENCY: "2", WORKER_HEAP_MB: "64" });
  try {
    for (const limit of await heapLimits(invalid, 2)) assert.ok(about(limit, 896), `${limit / MB} MB`);
    assert.equal(invalid.events("invalid-heap").length, 1);
  } finally { await invalid.stop(); }
});

test("a heap size already set in NODE_OPTIONS wins over WORKER_HEAP_MB", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "2", WORKER_HEAP_MB: "512", NODE_OPTIONS: "--max-old-space-size=200" });
  try {
    for (const limit of await heapLimits(run, 2)) assert.ok(about(limit, 200), `${limit / MB} MB`);
    assert.deepEqual(run.events("start").map((l) => l.heapMb), ["inherited"]);
  } finally { await run.stop(); }
});

test("WEB_CONCURRENCY=1 leaves the single process's heap as it was", { timeout: 30_000 }, async () => {
  const run = await start({ WEB_CONCURRENCY: "1", WORKER_HEAP_MB: "256" });
  try {
    const [limit] = await heapLimits(run, 1);
    assert.ok(!about(limit, 256), `${limit / MB} MB: no cap was added`);
  } finally { await run.stop(); }
});
