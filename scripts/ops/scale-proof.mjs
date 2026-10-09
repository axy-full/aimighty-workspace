#!/usr/bin/env node
// Scale-out proof: runs the production standalone build locally (mocked
// engines, local SQLite files, a fake R2, a local Inngest dev server) as ONE
// process (`node server.js`, today's production) or as a cluster
// (`node cluster.mjs`, WEB_CONCURRENCY), and measures requests per second,
// p95 latency and memory per scenario. See docs/scale-out-proof.md.
//
// It shares a server with production, so it is careful by construction:
// - run it through ~/ops/heavy.sh (nice 19, idle I/O); children inherit that;
// - every load burst is at most 60 s (a closed-loop scenario can overrun by
//   one in-flight step, at most 45 s; the optional big upload is one transfer,
//   not a burst: it runs as long as 500 MiB takes, about 20 s here);
// - before each burst it checks the 1-minute load average;
// - during each burst it polls the production health URL every 2 s and
//   aborts the burst when the p95 of the last 10 samples passes 1 s.
//
// Nothing here talks to a real provider, database or bucket. The only outside
// call is the anonymous GET of --prod-health.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@libsql/client";

const { values: opt } = parseArgs({
  options: {
    standalone: { type: "string" },          // directory holding server.js (and cluster.mjs)
    mode: { type: "string", default: "single" }, // single | cluster
    workers: { type: "string", default: "3" },
    port: { type: "string", default: "3311" },
    "fake-s3": { type: "string" },           // tests/helpers/fake-s3-server.mjs
    "inngest-cli": { type: "string" },       // pinned inngest-cli binary
    "autocannon-dir": { type: "string" },    // a folder with autocannon installed (not a repo dependency)
    scenarios: { type: "string", default: "page,health,quote,generate,upload,inngest" },
    duration: { type: "string", default: "30" },
    connections: { type: "string", default: "20" },
    "big-upload-mib": { type: "string", default: "0" },
    "expect-commit": { type: "string", default: "" },
    "prod-health": { type: "string", default: "https://particl.si/api/health" },
    "max-load": { type: "string", default: "6" },
    out: { type: "string" },
  },
});
for (const need of ["standalone", "fake-s3", "autocannon-dir", "out"]) if (!opt[need]) { console.error(`--${need} is required`); process.exit(2); }
const MODE = opt.mode === "cluster" ? "cluster" : "single";
const PORT = Number(opt.port), BASE = `http://127.0.0.1:${PORT}`;
const DURATION = Math.min(60, Math.max(5, Number(opt.duration)));
const CONNECTIONS = Math.max(1, Number(opt.connections));
const autocannon = createRequire(join(resolve(opt["autocannon-dir"]), "package.json"))("autocannon");
const out = resolve(opt.out);
await mkdir(out, { recursive: true });
const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

/* ---------- small helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const loadAvg = async () => Number((await readFile("/proc/loadavg", "utf8")).split(" ")[0]);
const children = [];
function start(name, cmd, args, options) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  const sink = [];
  child.stdout.on("data", (d) => sink.push(d)); child.stderr.on("data", (d) => sink.push(d));
  child.on("exit", (code, signal) => log("child-exit", { name, code, signal }));
  child.on("error", (error) => { log("child-error", { name, error: String(error?.message ?? error) }); stopAll().finally(() => process.exit(1)); });
  child.logs = () => Buffer.concat(sink).toString();
  return child;
}
/* Never leave a server behind on a box that serves production: a failed start or a
   signal to this harness stops every child and removes the data folder. */
let dataDir = null;
async function stopAll() {
  await Promise.all(children.map((c) => stopChild(c, 10_000).catch(() => {})));
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.once(sig, () => { log("signal", { sig }); stopAll().finally(() => process.exit(code)); });
async function stopChild(child, graceMs = 60_000) {
  if (child.exitCode != null || child.signalCode != null) return { code: child.exitCode, signal: child.signalCode, ms: 0 };
  const t0 = Date.now();
  const done = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  child.kill("SIGTERM");
  const result = await Promise.race([done, sleep(graceMs).then(() => null)]);
  if (result) return { ...result, ms: Date.now() - t0 };
  child.kill("SIGKILL");
  return { ...(await done), ms: Date.now() - t0, forced: true };
}

/* ---------- process-tree memory and CPU (/proc) ---------- */
async function tree(rootPid) {
  const stats = new Map();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      stats.set(Number(entry), { ppid: Number(f[1]), cpuTicks: Number(f[11]) + Number(f[12]) });
    } catch { /* gone */ }
  }
  const pids = [rootPid];
  for (let i = 0; i < pids.length; i++) for (const [pid, s] of stats) if (s.ppid === pids[i]) pids.push(pid);
  const rows = [];
  for (const pid of pids) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const rssKiB = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);
      rows.push({ pid, rssMiB: rssKiB / 1024, cpuTicks: stats.get(pid)?.cpuTicks ?? 0 });
    } catch { /* gone */ }
  }
  return rows;
}
function memorySampler(rootPid) {
  const samples = []; let timer = null;
  return {
    start() { timer = setInterval(async () => { const rows = await tree(rootPid); samples.push({ total: rows.reduce((a, r) => a + r.rssMiB, 0), max: Math.max(0, ...rows.map((r) => r.rssMiB)) }); }, 500); },
    stop() { clearInterval(timer); return { peakTotalMiB: round(Math.max(0, ...samples.map((s) => s.total))), meanTotalMiB: round(samples.reduce((a, s) => a + s.total, 0) / (samples.length || 1)), peakProcessMiB: round(Math.max(0, ...samples.map((s) => s.max))) }; },
  };
}

/* ---------- production guard ---------- */
function prodGuard(url) {
  const window = [], all = []; let timer = null, aborted = null; const listeners = [];
  const probe = async () => {
    const t0 = performance.now(); let ms;
    try { const r = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" }); await r.arrayBuffer(); ms = r.ok ? performance.now() - t0 : 5000; }
    catch { ms = 5000; }
    window.push(ms); all.push(ms); if (window.length > 10) window.shift();
    const p95 = pct(window, 95);
    if (!aborted && window.length >= 5 && p95 > 1000) { aborted = { at: new Date().toISOString(), p95: round(p95) }; log("ABORT-production-p95", aborted); listeners.forEach((f) => f()); }
  };
  return {
    start() { timer = setInterval(probe, 2000); return probe(); },
    stop() { clearInterval(timer); return { samples: all.length, p95Ms: round(pct(all, 95)), maxMs: round(Math.max(0, ...all)), aborted }; },
    onAbort(f) { listeners.push(f); },
    get aborted() { return aborted; },
  };
}
async function preflight(label) {
  const load = await loadAvg();
  if (load > Number(opt["max-load"])) throw new Error(`Load average ${load} is over ${opt["max-load"]}; not starting "${label}".`);
  const g = prodGuard(opt["prod-health"]);
  for (let i = 0; i < 5; i++) { await g.start(); g.stop(); }
  const base = g.stop();
  if (base.p95Ms > 1000) throw new Error(`Production health p95 is already ${base.p95Ms} ms; not starting "${label}".`);
  return { load, prodBaselineP95Ms: base.p95Ms };
}

/* ---------- boot ---------- */
const data = await mkdtemp(join(tmpdir(), "particl-scaleproof-"));
dataDir = data;
await mkdir(join(data, "tenants"), { recursive: true }); await mkdir(join(data, "s3"), { recursive: true });
const S3_PORT = PORT + 1, INNGEST_PORT = PORT + 2;
const helperEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: process.env.LANG ?? "C.UTF-8" };
const fakeS3 = start("fake-s3", process.execPath, [resolve(opt["fake-s3"]), "--port", String(S3_PORT), "--dir", join(data, "s3")], { env: helperEnv });
const scenarios = new Set(opt.scenarios.split(",").map((s) => s.trim()).filter(Boolean));
const useInngest = Boolean(opt["inngest-cli"]);
const inngest = useInngest
  ? start("inngest", resolve(opt["inngest-cli"]), ["dev", "--no-discovery", "--host", "127.0.0.1", "-u", `${BASE}/api/inngest`, "--port", String(INNGEST_PORT)], { env: helperEnv })
  : null;
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: process.env.LANG ?? "C.UTF-8",
  NODE_ENV: "production", PARTICL_DEPLOYMENT: "staging", NEXT_TELEMETRY_DISABLED: "1",
  PORT: String(PORT), HOSTNAME: "127.0.0.1", APP_ORIGIN: BASE,
  ENGINE_MOCK: "1", PAYMENT_PROVIDER: "manual", SUPER_ADMIN_EMAIL: "owner@example.test",
  PLATFORM_DATABASE_URL: `file:${join(data, "platform.db")}`, TURSO_DATABASE_URL: `file:${join(data, "legacy.db")}`,
  KEYRING_SECRET: "scale-proof-keyring-secret-0123456789abcdef", SESSION_SECRET: "scale-proof-session", CRON_SECRET: "scale-proof-cron",
  STORAGE_BACKEND: "r2", R2_ACCOUNT_ID: "scaleproof", R2_ACCESS_KEY_ID: "scaleproof", R2_SECRET_ACCESS_KEY: "scaleproof", R2_BUCKET: "media", R2_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
  GIT_COMMIT_SHA: opt["expect-commit"] || "unknown",
  ...(useInngest ? { DISPATCH_MODE: "inngest", INNGEST_DEV: `http://127.0.0.1:${INNGEST_PORT}`, INNGEST_EVENT_KEY: "scale-proof-event", INNGEST_SIGNING_KEY: "signkey-test-0123456789abcdef" } : {}),
  ...(MODE === "cluster" ? { WEB_CONCURRENCY: opt.workers } : {}),
};
const app = start("app", process.execPath, [MODE === "cluster" ? "cluster.mjs" : "server.js"], { cwd: resolve(opt.standalone), env });
const results = { mode: MODE, workers: MODE === "cluster" ? Number(opt.workers) : 1, duration: DURATION, connections: CONNECTIONS, startedAt: new Date().toISOString(), scenarios: {} };

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if (await fn()) return; } catch { /* not yet */ } await sleep(500); }
  throw new Error(`Timed out waiting for ${what}.`);
}
try {
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).status === 200, 120_000, "app health 200");
  await sleep(2000);
  const idle = await tree(app.pid);
  results.idle = { processes: idle.length, totalMiB: round(idle.reduce((a, r) => a + r.rssMiB, 0)), perProcessMiB: idle.map((r) => round(r.rssMiB)) };
  log("booted", results.idle);

  /* ---------- seed: owner, a billed workspace with credits, a render token ---------- */
  const email = "owner@example.test", password = "scale-proof-password-1";
  const setup = await fetch(`${BASE}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Owner", email, password }) });
  if (!setup.ok) throw new Error(`setup ${setup.status}: ${await setup.text()}`);
  const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("aw_session="));
  let cookie = cookieOf(setup);
  const platform = createClient({ url: env.PLATFORM_DATABASE_URL });
  const account = (await platform.execute({ sql: "SELECT id FROM accounts WHERE email=?", args: [email] })).rows[0].id;
  const WS = "ws_load", now = Date.now(), tenantUrl = `file:${join(data, "tenants", "ws_load.db")}`;
  await platform.batch([
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,?,?,?,1000,1000000)", args: [WS, "load", "Load", tenantUrl, account, now, now] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'owner',0,?)", args: [WS, account, now] },
    { sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,1000000,'scale proof','manual',?,?)", args: [randomUUID(), WS, account, now] },
  ], "write");
  const sw = await fetch(`${BASE}/api/workspaces/switch`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: WS }) });
  if (!sw.ok) throw new Error(`switch ${sw.status}: ${await sw.text()}`);
  cookie = cookieOf(sw) ?? cookie;
  const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json();
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  // What workspace provisioning writes into a new workspace's own database (lib/workspaceProvisioning.ts): the owner as admin.
  await createClient({ url: tenantUrl }).execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES(?,?,?,'!','admin',0,?) ON CONFLICT(id) DO NOTHING", args: [account, email, "Owner", now] });
  const tok = await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { "content-type": "application/json", cookie, "X-Workbench-Scope": scope }, body: JSON.stringify({ name: "scale-proof", scope: "render" }) });
  if (!tok.ok) throw new Error(`token ${tok.status}: ${await tok.text()}`);
  const bearer = { authorization: `Bearer ${(await tok.json()).token}` };
  const still = { prompt: "A red sphere.", model: "gemini-3.1-flash-image", resolution: "512", ratio: "1:1" };

  /* ---------- health shows the commit ---------- */
  const health = await (await fetch(`${BASE}/api/health`)).json();
  results.health = { body: health, commitMatches: opt["expect-commit"] ? health.commit === opt["expect-commit"].slice(0, 7) : null };
  log("health", results.health);

  /* ---------- a burst: autocannon for single requests ---------- */
  async function burst(name, request) {
    const pre = await preflight(name);
    await new Promise((res, rej) => autocannon({ url: `${BASE}${request.path}`, method: request.method ?? "GET", headers: request.headers, body: request.body, connections: Math.min(4, CONNECTIONS), duration: 5 }, (e, r) => (e ? rej(e) : res(r)))); // warm-up, not measured
    const guard = prodGuard(opt["prod-health"]); await guard.start();
    const mem = memorySampler(app.pid); mem.start();
    const cpu0 = await tree(app.pid);
    const latencies = []; let inst;
    const run = new Promise((res, rej) => { inst = autocannon({ url: `${BASE}${request.path}`, method: request.method ?? "GET", headers: request.headers, body: request.body, connections: CONNECTIONS, duration: DURATION }, (err, r) => (err ? rej(err) : res(r))); });
    inst.on("response", (_c, _s, _b, ms) => latencies.push(ms));
    guard.onAbort(() => inst.stop());
    const r = await run;
    const cpu1 = await tree(app.pid);
    const memory = mem.stop(), prod = guard.stop();
    results.scenarios[name] = {
      reqPerSec: round(r.requests.average), p95Ms: round(pct(latencies, 95)), p50Ms: round(pct(latencies, 50)), p99Ms: round(pct(latencies, 99)),
      requests: r.requests.total, non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts, memory, production: prod, ...pre,
      cpuSecondsPerProcess: cpu1.map((p) => round(((p.cpuTicks - (cpu0.find((q) => q.pid === p.pid)?.cpuTicks ?? 0)) / 100), 1)),
    };
    log("burst", { name, ...results.scenarios[name] });
  }

  /* ---------- a closed loop for multi-step flows ---------- */
  async function loop(name, users, step) {
    const pre = await preflight(name);
    const guard = prodGuard(opt["prod-health"]); await guard.start();
    const mem = memorySampler(app.pid); mem.start();
    const until = Date.now() + DURATION * 1000, timings = {}, failures = [];
    let done = 0;
    const record = (k, ms) => (timings[k] ??= []).push(ms);
    const timed = async (k, f) => { const t0 = performance.now(); const v = await f(); record(k, performance.now() - t0); return v; };
    await Promise.all(Array.from({ length: users }, async () => {
      while (Date.now() < until && !guard.aborted) {
        try { await step(timed, record); done++; } catch (e) { failures.push(String(e.message ?? e).slice(0, 160)); await sleep(250); }
      }
    }));
    const memory = mem.stop(), prod = guard.stop();
    const seconds = DURATION;
    results.scenarios[name] = {
      flowsPerSec: round(done / seconds, 2), flows: done, failures: failures.length, failureSamples: [...new Set(failures)].slice(0, 5),
      latency: Object.fromEntries(Object.entries(timings).map(([k, xs]) => [k, { count: xs.length, perSec: round(xs.length / seconds, 1), p50Ms: round(pct(xs, 50)), p95Ms: round(pct(xs, 95)) }])),
      memory, production: prod, ...pre,
    };
    log("loop", { name, ...results.scenarios[name] });
  }

  const json = (h = {}) => ({ "content-type": "application/json", ...bearer, ...h });
  if (scenarios.has("page")) await burst("page", { path: "/review/scale-proof-unknown-link" }); // a real server render on every request (about 11 KB, one indexed lookup): the CPU-bound case
  if (scenarios.has("health")) await burst("health", { path: "/api/health" });
  if (scenarios.has("quote")) await burst("quote", { path: "/api/generate/quote", method: "POST", headers: json(), body: JSON.stringify(still) });
  if (scenarios.has("generate")) await loop("generate-settle", Math.min(CONNECTIONS, 10), async (timed, record) => {
    const quote = await timed("quote", () => fetch(`${BASE}/api/generate/quote`, { method: "POST", headers: json(), body: JSON.stringify(still) }));
    if (!quote.ok) throw new Error(`quote ${quote.status}`);
    const { fingerprint } = await quote.json();
    const gen = await timed("generate", () => fetch(`${BASE}/api/generate`, { method: "POST", headers: json({ "Idempotency-Key": `sp-${randomUUID()}` }), body: JSON.stringify({ ...still, quoteFingerprint: fingerprint }) }));
    if (gen.status >= 300) throw new Error(`generate ${gen.status}: ${(await gen.text()).slice(0, 80)}`);
    const { id } = await gen.json(); const t0 = performance.now();
    for (;;) {
      const job = await timed("poll", () => fetch(`${BASE}/api/jobs/${id}`, { headers: bearer }));
      const status = (await job.json())?.generation?.status;
      if (status === "succeeded") { record("settle", performance.now() - t0); break; }
      if (status === "failed") throw new Error("generation failed");
      if (performance.now() - t0 > 45_000) throw new Error("generation did not settle in 45 s");
      await sleep(250);
    }
  });
  if (scenarios.has("upload")) {
    const chunk = Buffer.alloc(1024 * 1024, 7);
    await loop("upload-1MiB", Math.min(CONNECTIONS, 10), async (timed) => {
      const session = randomUUID();
      const form = new FormData(); form.set("session", session); form.set("index", "0"); form.set("chunk", new Blob([chunk]), "c");
      const c = await timed("chunk", () => fetch(`${BASE}/api/uploads/chunk`, { method: "POST", headers: bearer, body: form }));
      if (!c.ok) throw new Error(`chunk ${c.status}`);
      const f = await timed("finish", () => fetch(`${BASE}/api/uploads/finish`, { method: "POST", headers: json(), body: JSON.stringify({ session, count: 1, filename: "load.bin", purpose: "chat" }) }));
      if (f.status === 202) await waitFor(async () => (await (await fetch(`${BASE}/api/uploads/session?session=${session}`, { headers: bearer })).json()).state === "committed", 30_000, "finish");
      else if (!f.ok) throw new Error(`finish ${f.status}`);
    });
  }
  if (scenarios.has("inngest") && useInngest) {
    const tenant = createClient({ url: tenantUrl });
    await waitFor(async () => Boolean(await fetch(`http://127.0.0.1:${INNGEST_PORT}/`).catch(() => null)), 60_000, "inngest dev server");
    const send = (events) => fetch(`http://127.0.0.1:${INNGEST_PORT}/e/scale-proof-event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(events) });
    const receipt = async (id) => (await tenant.execute({ sql: "SELECT receipt, created_at FROM worker_probe_receipts WHERE id=?", args: [id] }).catch(() => ({ rows: [] }))).rows[0];
    // Correctness: one probe round trip, then readiness (served by any process) reads it back.
    const first = `probe${Date.now()}`;
    await send([{ name: "worker/probe", data: { workspaceId: WS, probeId: first } }]);
    await waitFor(async () => JSON.parse(String((await receipt(first))?.receipt ?? "{}")).status === "succeeded", 90_000, "first probe receipt");
    const readiness = await (await fetch(`${BASE}/api/admin/readiness`, { headers: { cookie } })).json();
    results.inngestProbe = { probeId: first, receipt: JSON.parse(String((await receipt(first)).receipt)), readinessWorker: readiness.worker ?? null };
    log("inngest-probe", results.inngestProbe);
    // Load: a batch of probe events every second for DURATION; callbacks measured by receipt time.
    await loop("inngest-callbacks", 1, async (timed, record) => {
      const ids = Array.from({ length: 10 }, () => `probe${randomUUID().replace(/-/g, "")}`);
      const sentAt = Date.now();
      await timed("send", () => send(ids.map((probeId) => ({ name: "worker/probe", data: { workspaceId: WS, probeId } }))));
      await waitFor(async () => (await Promise.all(ids.map(receipt))).every(Boolean), 45_000, "probe receipts");
      for (const r of await Promise.all(ids.map(receipt))) record("callback", Number(r.created_at) - sentAt);
    });
  }

  /* ---------- 500 MiB chunked upload, chunks spread over the processes ---------- */
  const bigMiB = Number(opt["big-upload-mib"]);
  if (bigMiB > 0) {
    const pre = await preflight("big-upload");
    const guard = prodGuard(opt["prod-health"]); await guard.start();
    const mem = memorySampler(app.pid); mem.start();
    const cpu0 = await tree(app.pid);
    const CHUNK = 3_500_000, total = bigMiB * 1024 * 1024, count = Math.ceil(total / CHUNK), session = randomUUID();
    const bytesOf = (i) => { const n = Math.min(CHUNK, total - i * CHUNK), b = Buffer.allocUnsafe(n); let x = (i + 1) * 2654435761 >>> 0; for (let k = 0; k < n; k += 4) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b.writeUInt32LE(x, k <= n - 4 ? k : n - 4); } return b; };
    const sha = createHash("sha256"); for (let i = 0; i < count; i++) sha.update(bytesOf(i));
    const expected = sha.digest("hex");
    // A fresh connection per chunk (agent:false), so the cluster hands chunks to different processes.
    const postChunk = (i) => new Promise((res, rej) => {
      const boundary = `sp${randomUUID()}`, body = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="session"\r\n\r\n${session}\r\n--${boundary}\r\ncontent-disposition: form-data; name="index"\r\n\r\n${i}\r\n--${boundary}\r\ncontent-disposition: form-data; name="chunk"; filename="c"\r\ncontent-type: application/octet-stream\r\n\r\n`),
        bytesOf(i), Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const req = http.request(`${BASE}/api/uploads/chunk`, { method: "POST", agent: false, headers: { ...bearer, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length } }, (r) => { r.resume(); r.on("end", () => (r.statusCode === 200 ? res() : rej(new Error(`chunk ${i}: ${r.statusCode}`)))); });
      req.on("error", rej); req.end(body);
    });
    const t0 = performance.now(); let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (next < count && !guard.aborted) { const i = next++; await postChunk(i); } }));
    const uploadedS = (performance.now() - t0) / 1000;
    const fin = await fetch(`${BASE}/api/uploads/finish`, { method: "POST", headers: json(), body: JSON.stringify({ session, count, filename: "big.bin", purpose: "chat" }) });
    let upload = fin.status === 200 ? await fin.json() : null;
    if (fin.status === 202) await waitFor(async () => { const s = await (await fetch(`${BASE}/api/uploads/session?session=${session}`, { headers: bearer })).json(); if (s.state === "committed") upload = s.upload; return s.state === "committed"; }, 600_000, "big finish");
    else if (!fin.ok) throw new Error(`big finish ${fin.status}: ${await fin.text()}`);
    const finishedS = (performance.now() - t0) / 1000;
    // Read it back through the app and hash it.
    const back = createHash("sha256"); let backBytes = 0;
    const res = await fetch(`${BASE}${upload?.url ?? `/api/uploads/${upload?.id}`}`, { headers: bearer });
    for await (const part of res.body) { back.update(part); backBytes += part.length; }
    const cpu1 = await tree(app.pid);
    results.bigUpload = {
      mib: bigMiB, chunks: count, uploadSeconds: round(uploadedS), finishSeconds: round(finishedS - uploadedS),
      sha256Expected: expected, sha256Stored: upload?.sha256 ?? null, sha256ReadBack: back.digest("hex"), bytesReadBack: backBytes,
      cpuSecondsPerProcess: cpu1.map((p) => round((p.cpuTicks - (cpu0.find((q) => q.pid === p.pid)?.cpuTicks ?? 0)) / 100, 1)),
      memory: mem.stop(), production: guard.stop(), ...pre,
    };
    results.bigUpload.ok = results.bigUpload.sha256Stored === expected && results.bigUpload.sha256ReadBack === expected;
    log("big-upload", results.bigUpload);
  }
} catch (error) {
  results.error = String(error?.stack ?? error);
  log("error", { error: results.error });
} finally {
  results.shutdown = await stopChild(app, 300_000);
  if (inngest) await stopChild(inngest, 10_000);
  await stopChild(fakeS3, 10_000);
  await rm(data, { recursive: true, force: true }).catch(() => {});
  results.finishedAt = new Date().toISOString();
  const file = join(out, `scale-proof-${MODE}${MODE === "cluster" ? opt.workers : ""}-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(results, null, 2));
  if (results.error) await writeFile(file.replace(/\.json$/, ".app.log"), app.logs());
  log("written", { file });
  // Open database clients and keep-alive sockets would hold the process for minutes.
  process.exit(results.error ? 1 : 0);
}
