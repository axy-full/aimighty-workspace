// Self-hosted entry point (ops/selfhost/Dockerfile: CMD ["node","cluster.mjs"]).
// Runs WEB_CONCURRENCY copies of Next's standalone server.js (the file next to
// this one) on one port with Node's built-in cluster module. No dependency.
//
//   WEB_CONCURRENCY        workers, an integer 1..16; default 3. Anything else is
//                          logged and 3 is used. 1 is the rollback switch: no
//                          cluster at all, server.js runs in this process exactly
//                          as `node server.js` did (Next handles its own signals).
//   CLUSTER_STOP_GRACE_MS  on SIGTERM/SIGINT, how long workers get to finish
//                          in-flight requests before they are killed; default
//                          290000, under the platform's 300 s stop grace.
//   WORKER_HEAP_MB         each worker's V8 old-space cap (--max-old-space-size),
//                          an integer 128..16384; default 896. Anything else is
//                          logged and 896 is used. Not applied when NODE_OPTIONS
//                          or this process's own flags already set
//                          --max-old-space-size or --max_old_space_size (that
//                          setting wins), and not with WEB_CONCURRENCY=1: the
//                          single process keeps Node's default heap (or
//                          NODE_OPTIONS), as before.
//
// A worker that exits on its own is started again after a back-off (1 s doubling
// to 30 s; back to 1 s once a worker has been up 60 s). More than 10 such exits
// in 60 s is a crash loop: the primary says so, stops the rest and exits 1, so the
// container restarts and its health check fails instead of spinning.
//
// On SIGTERM/SIGINT nothing is restarted any more, every worker gets SIGTERM
// (Next 16's start-server closes the server, finishes in-flight requests and
// exits 143), stragglers are killed after the grace, then the primary exits 0.
// A second signal during shutdown is logged and changes nothing.
//
// Every lifecycle event is one JSON line on stdout: no environment values, no
// request data. The CLUSTER_BACKOFF_*, CLUSTER_STABLE_MS and CLUSTER_CRASH_*
// settings exist for tests (tests/ops/cluster-start.test.mjs); leave them unset.
import cluster from "node:cluster";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 16;

/** WEB_CONCURRENCY as a worker count: an integer 1..16, else the default (and why). */
export function parseConcurrency(raw) {
  if (raw == null || String(raw).trim() === "") return { workers: DEFAULT_CONCURRENCY, invalid: false };
  const text = String(raw).trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENCY) return { workers: n, invalid: false };
  return { workers: DEFAULT_CONCURRENCY, invalid: true };
}

export const DEFAULT_HEAP_MB = 896;
/** WORKER_HEAP_MB as a heap cap in MB: an integer 128..16384, else the default (and why). */
export function parseHeapMb(raw) {
  if (raw == null || String(raw).trim() === "") return { mb: DEFAULT_HEAP_MB, invalid: false };
  const text = String(raw).trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (Number.isInteger(n) && n >= 128 && n <= 16_384) return { mb: n, invalid: false };
  return { mb: DEFAULT_HEAP_MB, invalid: true };
}

/** A positive integer setting, else its default. */
function positive(raw, fallback) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return fallback;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), component: "cluster", event, pid: process.pid, ...fields })}\n`);
}

export async function main(env = process.env) {
  const server = join(HERE, "server.js");
  const { workers, invalid } = parseConcurrency(env.WEB_CONCURRENCY);
  if (invalid) log("invalid-concurrency", { allowed: `1..${MAX_CONCURRENCY}`, using: workers });
  if (!existsSync(server)) {
    log("missing-server", { file: "server.js" });
    process.exit(1);
  }

  if (workers === 1) {
    // Rollback switch: today's single process, nothing in between.
    log("start", { mode: "single", workers: 1 });
    await import(pathToFileURL(server).href);
    return;
  }

  const graceMs = positive(env.CLUSTER_STOP_GRACE_MS, 290_000);
  const backoffMs = positive(env.CLUSTER_BACKOFF_MS, 1_000);
  const backoffMaxMs = positive(env.CLUSTER_BACKOFF_MAX_MS, 30_000);
  const stableMs = positive(env.CLUSTER_STABLE_MS, 60_000);
  const crashLimit = positive(env.CLUSTER_CRASH_LIMIT, 10);
  const crashWindowMs = positive(env.CLUSTER_CRASH_WINDOW_MS, 60_000);

  const heap = parseHeapMb(env.WORKER_HEAP_MB);
  if (heap.invalid) log("invalid-heap", { allowed: "128..16384", using: heap.mb });
  /* A heap size someone already chose (NODE_OPTIONS reaches the workers too, or a flag on this process) wins. */
  /* Node accepts dashes or underscores in V8 flags: --max-old-space-size and --max_old_space_size are one flag. */
  const heapFlag = /--max[-_]old[-_]space[-_]size/;
  const chosen = heapFlag.test(env.NODE_OPTIONS ?? "") || process.execArgv.some((arg) => heapFlag.test(arg));
  cluster.setupPrimary({
    exec: server,
    execArgv: chosen ? process.execArgv : [...process.execArgv, `--max-old-space-size=${heap.mb}`],
  });
  log("start", { mode: "cluster", workers, graceMs, heapMb: chosen ? "inherited" : heap.mb });

  /** slot -> { worker, startedAt, failures, timer } */
  const slots = new Map();
  const crashes = [];
  let stopping = false;
  let exitCode = 0;
  let forceTimer = null;

  const alive = () => [...slots.values()].filter((s) => s.worker);

  function fork(slot) {
    const state = slots.get(slot);
    state.timer = null;
    const worker = cluster.fork();
    state.worker = worker;
    state.startedAt = Date.now();
    log("fork", { slot, worker: worker.process.pid });
    worker.on("error", (error) => log("worker-error", { slot, worker: worker.process.pid, error: error?.code ?? "error" }));
    worker.on("exit", (code, signal) => exited(slot, worker, code, signal));
  }

  function finishIfDone() {
    if (!stopping || alive().length) return;
    if (forceTimer) clearTimeout(forceTimer);
    log("stopped", { exitCode });
    process.exit(exitCode);
  }

  function exited(slot, worker, code, signal) {
    const state = slots.get(slot);
    if (state.worker !== worker) return;
    const upMs = Date.now() - state.startedAt;
    state.worker = null;
    log("exit", { slot, worker: worker.process.pid, code, signal, upMs, expected: stopping });
    if (stopping) return finishIfDone();

    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > crashWindowMs) crashes.shift();
    if (crashes.length > crashLimit) {
      log("crash-loop", { exits: crashes.length, windowMs: crashWindowMs, limit: crashLimit });
      return stop("crash-loop", 1);
    }
    state.failures = upMs >= stableMs ? 1 : state.failures + 1;
    const delayMs = Math.min(backoffMs * 2 ** (state.failures - 1), backoffMaxMs);
    log("restart", { slot, delayMs, attempt: state.failures });
    state.timer = setTimeout(() => { if (!stopping) fork(slot); }, delayMs);
  }

  function stop(reason, code = 0) {
    if (stopping) {
      log("signal-during-shutdown", { signal: reason });
      return;
    }
    stopping = true;
    exitCode = code;
    for (const state of slots.values()) if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    const running = alive();
    log("shutdown", { reason, workers: running.length, graceMs });
    for (const { worker } of running) {
      // The signal itself, not worker.kill(): that disconnects first, and a
      // disconnected worker exits at once without finishing its requests.
      try { worker.process.kill("SIGTERM"); } catch { /* already gone */ }
    }
    forceTimer = setTimeout(() => {
      for (const [slot, { worker }] of slots) {
        if (!worker) continue;
        log("force-kill", { slot, worker: worker.process.pid, afterMs: graceMs });
        try { worker.process.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }, graceMs);
    finishIfDone();
  }

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  for (let slot = 1; slot <= workers; slot++) {
    slots.set(slot, { worker: null, startedAt: 0, failures: 0, timer: null });
    fork(slot);
  }
}

/* Run only as the entry point (`node cluster.mjs`), not when a test imports it. */
const entry = (() => { try { return realpathSync(process.argv[1] ?? ""); } catch { return ""; } })();
if (cluster.isPrimary && entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log("failed", { error: error instanceof Error ? error.name : "Error" });
    process.exit(1);
  });
}
