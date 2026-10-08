#!/usr/bin/env node
/**
 * Astra render worker: a CPU Blender host that stands in for one Vercel Sandbox
 * VM. One session at a time; the container (2 vCPU / 4 GB, no internet, no
 * public port) is the limit of each render. Plain Node, no dependencies.
 *
 * Protocol (every request: `Authorization: Bearer $ASTRA_WORKER_SECRET`):
 *   POST   /v1/sessions                       {name}                → 201 {name,status:"running"} | 409 {busy:true}
 *   PUT    /v1/sessions/:name/files?path=/vercel/sandbox/astra/…   raw body → 201 {path,bytes}
 *   POST   /v1/sessions/:name/run             {cmd,args,cwd?,timeoutMs} → 200 {exitCode,stdout,stderr,timedOut}
 *   GET    /v1/sessions/:name/files?path=/vercel/sandbox/astra/output/… → 200 bytes | 404
 *   GET    /v1/sessions/:name                 → 200 {name,status,activeCpuMs,durationMs,egressBytes:0}
 *   DELETE /v1/sessions/:name                 → 200 (same body as GET; idempotent)
 * See ops/render-worker/README.md for the full contract.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rm, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { posix as posixPath, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

/** Paths in the protocol are the Sandbox's paths; `root` maps them onto disk. */
export const SANDBOX_ROOT = "/vercel/sandbox";
export const ASTRA_DIR = `${SANDBOX_ROOT}/astra`;
export const OUTPUT_DIR = `${ASTRA_DIR}/output`;
export const PYTHON = "/usr/bin/python3";
export const SESSION_NAME = /^astra-blender-[0-9a-f-]{36}$/;
const MiB = 1024 * 1024;
export const LIMITS = Object.freeze({
  files: 66,
  fileBytes: 50 * MiB,
  totalBytes: 110 * MiB,
  outputBytes: 320 * MiB,
  streamTailBytes: 64 * 1024,
  maxTimeoutMs: 180_000,
  idleMs: 240_000,
  maxAgeMs: 300_000,
  jsonBytes: 64 * 1024,
  secretChars: 32,
  headersTimeoutMs: 15_000,
  // Receiving any request (the largest is a 50 MiB upload). Node's requestTimeout
  // stops counting once the request is in, so the run route has its own deadline.
  requestTimeoutMs: 190_000,
  keepAliveTimeoutMs: 5_000,
  runDeadlineMs: 190_000,
});
const CHILD_PATH = "/usr/bin:/bin";
const CLOCK_TICKS_PER_SECOND = 100; // Linux USER_HZ; Node has no sysconf().

class HttpError extends Error {
  constructor(status, body) { super(typeof body?.error === "string" ? body.error : String(status)); this.status = status; this.body = body; }
}
const refused = () => new HttpError(400, { error: "path_refused" });
const notFound = () => new HttpError(404, { error: "not_found" });
const tooLarge = (what) => new HttpError(413, { error: "too_large", limit: what });

/** sha256 both sides so the comparison is constant-time whatever the lengths. */
export function secretMatches(header, secret) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = createHash("sha256").update(header.slice(7), "utf8").digest();
  const expected = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(given, expected);
}

/**
 * A protocol path that normalises to a file strictly inside `prefix`
 * (e.g. "/vercel/sandbox/astra/"), as segments below the sandbox root; null
 * for anything else. Any "." or ".." segment is refused outright.
 */
export function protocolSegments(value, prefix) {
  if (typeof value !== "string" || !value.length || value.length > 1024 || !value.startsWith("/")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (value.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const normal = posixPath.normalize(value);
  if (!normal.startsWith(prefix) || normal.length === prefix.length || normal.endsWith("/")) return null;
  const segments = normal.slice(SANDBOX_ROOT.length + 1).split("/");
  return segments.some((segment) => !segment.length || Buffer.byteLength(segment) > 255) ? null : segments;
}

/** The container's cgroup v2 cpu.stat (cgroupns=private shows "0::/"). */
function defaultCpuStatPath() {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((entry) => entry.startsWith("0::"));
    if (line) return posixPath.join("/sys/fs/cgroup", line.slice(3).trim() || "/", "cpu.stat");
  } catch { /* not Linux / no cgroup v2 */ }
  return "/sys/fs/cgroup/cpu.stat";
}

function readCpuUsec(file) {
  try {
    const match = /^usage_usec (\d+)$/m.exec(readFileSync(file, "utf8"));
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

const ticksToMs = (ticks) => Math.round((ticks * 1000) / CLOCK_TICKS_PER_SECOND);

function uptimeTicks() {
  try { return Math.floor(Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * CLOCK_TICKS_PER_SECOND); } catch { return 0; }
}

/**
 * Fallback CPU meter, used only when the cgroup's cpu.stat cannot be read
 * (Node exposes no RUSAGE_CHILDREN). Every 100 ms it reads utime+stime of every
 * process owned by the worker's uid that started after the session did (not
 * the server, not PID 1), whatever its process group or session: a setsid()
 * or double-forked child is billed too. Each process counts at its highest
 * reading, so the time after its last reading (under 100 ms) is missed, and so
 * is a process shorter than one reading. Known processes are re-read every
 * tick; the /proc walk that finds new ones runs one at a time.
 */
export class ProcessMeter {
  constructor({ uid = process.getuid?.(), exclude = [process.pid, 1], intervalMs = 100 } = {}) {
    this.uid = uid;
    this.exclude = new Set(exclude);
    this.since = uptimeTicks() - 1;
    this.seen = new Map(); // "pid:starttime" -> highest utime+stime ticks
    this.known = new Set();
    this.scanning = null;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
    this.tick();
  }

  totalMs() {
    let ticks = 0;
    for (const value of this.seen.values()) ticks += value;
    return ticksToMs(ticks);
  }

  async read(pid) {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    // Fields after "(comm) " start at stat field 3: utime, stime = 14, 15; starttime = 22.
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const started = Number(fields[19]);
    if (started < this.since) return false;
    const key = `${pid}:${started}`;
    this.seen.set(key, Math.max(this.seen.get(key) ?? 0, Number(fields[11]) + Number(fields[12])));
    return true;
  }

  async readKnown() {
    await Promise.all([...this.known].map((pid) => this.read(pid).catch(() => { this.known.delete(pid); })));
  }

  async scan() {
    let entries;
    try { entries = await readdir("/proc"); } catch { return; }
    for (const entry of entries) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || this.exclude.has(pid) || this.known.has(pid)) continue;
      try {
        if ((await stat(`/proc/${pid}`)).uid !== this.uid) continue;
        if (await this.read(pid)) this.known.add(pid);
      } catch { /* exited */ }
    }
  }

  tick() {
    this.readKnown();
    this.scanning ??= this.scan().finally(() => { this.scanning = null; });
  }

  /** A last reading of everything, before the processes are killed. */
  async final() {
    await (this.scanning ?? this.scan());
    await this.readKnown();
  }

  stop() { clearInterval(this.timer); }
}

/** Keeps only the last `limit` bytes written to it. */
class Tail {
  constructor(limit) { this.limit = limit; this.chunks = []; this.bytes = 0; }
  push(chunk) {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes - this.chunks[0].length >= this.limit) this.bytes -= this.chunks.shift().length;
  }
  toString() {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.limit)).toString("utf8");
  }
}

function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

/** Bytes an unread request body may still be drained of so its answer reaches the client. */
const DRAIN_BYTES = 110 * MiB;

/**
 * Feeds every chunk of the body to `onChunk` (awaited, with back-pressure).
 * When `onChunk` throws, the rest of the body is read and discarded so the
 * error can still be answered on the same connection; the error is raised at
 * the end of the body.
 */
function receive(req, onChunk) {
  return new Promise((resolve, reject) => {
    let failure = null;
    let discarded = 0;
    let pending = Promise.resolve();
    req.on("data", (chunk) => {
      if (failure) {
        discarded += chunk.length;
        if (discarded > DRAIN_BYTES) req.destroy();
        return;
      }
      req.pause();
      pending = pending.then(() => onChunk(chunk)).catch((error) => { failure = error; }).finally(() => req.resume());
    });
    req.once("end", () => { pending.then(() => (failure ? reject(failure) : resolve())); });
    req.once("close", () => { if (!req.complete) reject(failure ?? new HttpError(400, { error: "body_incomplete" })); });
    req.once("error", (error) => reject(failure ?? error));
  });
}

/** Reads and discards an unread body (bounded) before an error is answered. */
function drain(req) {
  return receive(req, () => {}).catch(() => {});
}

/**
 * Builds the worker. `root` is the on-disk directory behind /vercel/sandbox
 * (only tests change it); `scratchDirs` are emptied between sessions (/tmp in
 * the container); `sweepStrays` kills every other process of this user after a
 * session (container only: never enable it on a shared machine).
 */
export function createRenderWorker(options) {
  const secret = options?.secret;
  if (typeof secret !== "string" || secret.length < LIMITS.secretChars) throw new Error(`ASTRA_WORKER_SECRET must be set (at least ${LIMITS.secretChars} characters).`);
  const root = options.root ?? SANDBOX_ROOT;
  const scratchDirs = options.scratchDirs ?? [];
  const cpuStatPath = options.cpuStatPath ?? defaultCpuStatPath();
  const idleMs = options.idleMs ?? LIMITS.idleMs;
  const maxAgeMs = options.maxAgeMs ?? LIMITS.maxAgeMs;
  const sweepStrays = options.sweepStrays === true;
  const log = options.log ?? ((line) => console.log(line));
  const timeouts = {
    headersMs: options.headersTimeoutMs ?? LIMITS.headersTimeoutMs,
    requestMs: options.requestTimeoutMs ?? LIMITS.requestTimeoutMs,
    keepAliveMs: options.keepAliveTimeoutMs ?? LIMITS.keepAliveTimeoutMs,
    runDeadlineMs: options.runDeadlineMs ?? LIMITS.runDeadlineMs,
  };
  let realRoot = null;
  let current = null;
  let creating = false;

  const disk = (segments) => join(realRoot, ...segments);
  const rootReady = async () => { realRoot ??= await realpath(root); return realRoot; };

  async function emptyDir(dir) {
    let entries;
    try { entries = await readdir(dir); } catch { return; }
    await Promise.all(entries.map((entry) => rm(join(dir, entry), { recursive: true, force: true }).catch(() => {})));
  }

  async function sweep() {
    if (!sweepStrays) return;
    const uid = process.getuid?.();
    let entries;
    try { entries = await readdir("/proc"); } catch { return; }
    for (const entry of entries) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try {
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        const match = /^Uid:\s+(\d+)/m.exec(status);
        if (match && Number(match[1]) === uid) process.kill(pid, "SIGKILL");
      } catch { /* gone */ }
    }
  }

  async function wipe() {
    await rootReady();
    await emptyDir(realRoot);
    for (const dir of scratchDirs) await emptyDir(dir);
  }

  function liveCpuMs(session) {
    if (session.cpuBase !== null) {
      const now = readCpuUsec(cpuStatPath);
      if (now !== null) return Math.max(0, Math.round((now - session.cpuBase) / 1000));
    }
    return session.meter?.totalMs() ?? 0;
  }

  function usage(session) {
    const stopped = session.status === "stopped";
    return {
      name: session.name,
      status: session.status,
      activeCpuMs: stopped && session.finalCpuMs !== null ? session.finalCpuMs : liveCpuMs(session),
      durationMs: Math.max(0, (stopped ? session.stoppedAt : Date.now()) - session.createdAt),
      egressBytes: 0,
    };
  }

  function stopSession(session) {
    if (session.stopping) return session.stopping;
    session.status = "stopped";
    session.stoppedAt = Date.now();
    session.abort.abort();
    session.stopping = (async () => {
      await session.meter?.final().catch(() => {});
      if (session.run) { session.run.kill(); await session.run.done; }
      await Promise.allSettled([...session.ops]);
      session.meter?.stop();
      await sweep();
      session.finalCpuMs = liveCpuMs(session);
      await wipe().catch(() => log("wipe failed"));
    })();
    return session.stopping;
  }

  /** Track an in-flight operation so stop() waits for it before wiping. */
  function track(session, promise) {
    session.ops.add(promise);
    promise.finally(() => session.ops.delete(promise)).catch(() => {});
    return promise;
  }

  /**
   * Opens a file below the sandbox root without following any symlink: every
   * directory on the way is lstat-ed, the file is opened O_NOFOLLOW, and the
   * opened descriptor's real path must still be inside the root (closes the
   * race with a process swapping a directory for a link).
   */
  async function openInside(segments, mode) {
    await rootReady();
    let dir = realRoot;
    for (const segment of segments.slice(0, -1)) {
      const next = join(dir, segment);
      let info;
      try { info = await lstat(next); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (mode !== "write") throw notFound();
        await mkdir(next, { mode: 0o700 }).catch((mkdirError) => { if (mkdirError.code !== "EEXIST") throw mkdirError; });
        info = await lstat(next);
      }
      if (!info.isDirectory()) throw mode === "write" || info.isSymbolicLink() ? refused() : notFound();
      dir = next;
    }
    const file = join(dir, segments.at(-1));
    const flags = (mode === "write" ? fsConstants.O_WRONLY | fsConstants.O_CREAT : fsConstants.O_RDONLY) | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    let handle;
    try { handle = await open(file, flags, 0o600); }
    catch (error) {
      if (error.code === "ELOOP") throw refused();
      if (error.code === "ENOENT" || error.code === "ENXIO") throw notFound();
      if (error.code === "EISDIR") throw mode === "write" ? refused() : notFound();
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw mode === "write" ? refused() : notFound();
      let real;
      try { real = await readlink(`/proc/self/fd/${handle.fd}`); } catch { real = await realpath(file); }
      if (!real.startsWith(`${realRoot}/`)) throw refused();
      if (mode === "write") await handle.truncate(0);
      return { handle, size: info.size, file };
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent || res.destroyed) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(payload), ...headers });
    res.end(payload);
  }

  async function readJson(req) {
    if (Number(req.headers["content-length"] ?? 0) > LIMITS.jsonBytes) throw tooLarge("json");
    const chunks = [];
    let bytes = 0;
    await receive(req, (chunk) => {
      bytes += chunk.length;
      if (bytes > LIMITS.jsonBytes) throw tooLarge("json");
      chunks.push(chunk);
    });
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* fall through */ }
    throw new HttpError(400, { error: "invalid_json" });
  }

  function onlyPath(url) {
    const values = url.searchParams.getAll("path");
    return values.length === 1 ? values[0] : null;
  }

  function sessionFor(name) {
    if (!current || current.name !== name) throw notFound();
    return current;
  }

  function requireRunning(session) {
    if (session.status !== "running") throw new HttpError(409, { error: "stopped" });
  }

  async function createSession(req, res) {
    const body = await readJson(req);
    if (typeof body.name !== "string" || !SESSION_NAME.test(body.name)) throw new HttpError(400, { error: "invalid_name" });
    if (creating || current?.status === "running") return send(res, 409, { busy: true });
    creating = true;
    try {
      if (current) await stopSession(current);
      await sweep();
      await wipe();
      for (const dir of [["astra"], ["astra", "input"], ["astra", "output"]]) await mkdir(disk(dir), { mode: 0o700 });
      const now = Date.now();
      const cpuBase = readCpuUsec(cpuStatPath);
      current = {
        name: body.name, status: "running", createdAt: now, lastActivity: now, stoppedAt: null,
        cpuBase, meter: cpuBase === null ? new ProcessMeter() : null, finalCpuMs: null,
        files: new Map(), committedBytes: 0, pendingBytes: 0, pendingPaths: new Set(),
        run: null, ops: new Set(), abort: new AbortController(), stopping: null,
      };
    } finally { creating = false; }
    send(res, 201, { name: current.name, status: "running" });
  }

  async function putFile(req, res, session, url) {
    requireRunning(session);
    const protocolPath = onlyPath(url);
    const segments = protocolSegments(protocolPath, `${ASTRA_DIR}/`);
    if (!segments) throw refused();
    const key = segments.join("/");
    const previous = session.files.get(key) ?? 0;
    const isNew = !session.files.has(key) && !session.pendingPaths.has(key);
    if (isNew && session.files.size + session.pendingPaths.size >= LIMITS.files) throw tooLarge("files");
    const declared = req.headers["content-length"] === undefined ? null : Number(req.headers["content-length"]);
    if (declared !== null && declared > LIMITS.fileBytes) throw tooLarge("fileBytes");
    if (declared !== null && session.committedBytes - previous + session.pendingBytes + declared > LIMITS.totalBytes) throw tooLarge("totalBytes");
    if (isNew) session.pendingPaths.add(key);
    let written = 0;
    let opened = null;
    // A stop cuts a stalled upload off instead of waiting for its next chunk.
    const cut = () => req.destroy();
    session.abort.signal.addEventListener("abort", cut, { once: true });
    try {
      opened = await openInside(segments, "write");
      const { handle } = opened;
      await receive(req, async (chunk) => {
        written += chunk.length;
        session.pendingBytes += chunk.length;
        if (written > LIMITS.fileBytes) throw tooLarge("fileBytes");
        if (session.committedBytes - previous + session.pendingBytes > LIMITS.totalBytes) throw tooLarge("totalBytes");
        if (session.abort.signal.aborted) throw new HttpError(409, { error: "stopped" });
        for (let offset = 0; offset < chunk.length;) offset += (await handle.write(chunk, offset)).bytesWritten;
      });
      session.files.set(key, written);
      session.committedBytes += written - previous;
    } catch (error) {
      if (opened) {
        // The old content was truncated: the path no longer holds a file.
        await rm(opened.file, { force: true }).catch(() => {});
        if (session.files.delete(key)) session.committedBytes -= previous;
      }
      throw error;
    } finally {
      session.pendingBytes -= written;
      if (isNew) session.pendingPaths.delete(key);
      session.abort.signal.removeEventListener("abort", cut);
      await opened?.handle.close().catch(() => {});
    }
    send(res, 201, { path: protocolPath, bytes: written });
  }

  async function getFile(res, session, url) {
    const segments = protocolSegments(onlyPath(url), `${OUTPUT_DIR}/`);
    if (!segments) throw refused();
    if (session.status !== "running") throw notFound();
    const { handle, size } = await openInside(segments, "read");
    try {
      if (size > LIMITS.outputBytes) throw tooLarge("outputBytes");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size, "cache-control": "no-store" });
      if (size > 0) await pipeline(handle.createReadStream({ start: 0, end: size - 1, autoClose: false }), res, { signal: session.abort.signal });
      else res.end();
    } finally { await handle.close().catch(() => {}); }
  }

  function validRunBody(body) {
    const keys = Object.keys(body);
    if (keys.some((key) => !["cmd", "args", "cwd", "timeoutMs"].includes(key))) return false;
    if (body.cmd !== PYTHON) return false;
    if (!Array.isArray(body.args) || body.args.length !== 1 || body.args[0] !== "run.py") return false;
    if (body.cwd !== undefined && body.cwd !== ASTRA_DIR) return false;
    return Number.isInteger(body.timeoutMs) && body.timeoutMs > 0 && body.timeoutMs <= LIMITS.maxTimeoutMs;
  }

  async function runCommand(req, res, session) {
    // The whole exchange, from the first byte to the answer, ends by this deadline.
    const deadline = setTimeout(() => { session.run?.kill(); req.socket.destroy(); }, timeouts.runDeadlineMs);
    try { await runOnce(req, res, session); } finally { clearTimeout(deadline); }
  }

  async function runOnce(req, res, session) {
    const body = await readJson(req);
    requireRunning(session);
    if (!validRunBody(body)) throw new HttpError(400, { error: "command_refused" });
    if (session.run) return send(res, 409, { busy: true });
    const cwd = disk(["astra"]);
    const cwdInfo = await lstat(cwd).catch(() => null);
    if (!cwdInfo?.isDirectory()) throw new HttpError(409, { error: "workspace_missing" });
    const stdout = new Tail(LIMITS.streamTailBytes);
    const stderr = new Tail(LIMITS.streamTailBytes);
    // The environment is built from scratch: never process.env, never the secret.
    const child = spawn(PYTHON, ["run.py"], { cwd, env: { PATH: CHILD_PATH, HOME: realRoot }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    let settled = false;
    const run = { kill: () => killGroup(child.pid), done: null };
    session.run = run;
    const timer = setTimeout(() => { timedOut = true; run.kill(); }, body.timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    // The client going away (its own abort) ends the run too.
    res.on("close", () => { if (!settled) run.kill(); });
    run.done = new Promise((resolve) => {
      let exit = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killGroup(child.pid); // nothing of the run outlives it
        child.stdout.destroy();
        child.stderr.destroy();
        resolve(exit ?? { code: null, signal: "SIGKILL" });
      };
      child.on("error", (error) => { stderr.push(Buffer.from(`spawn failed: ${error.code ?? "error"}\n`)); exit = { code: 127, signal: null }; finish(); });
      child.on("exit", (code, signal) => {
        exit = { code, signal };
        // A process that escaped the group may hold the pipes open: give output 250 ms.
        setTimeout(finish, 250).unref();
      });
      child.on("close", finish);
    });
    const { code, signal } = await run.done;
    session.run = null;
    session.lastActivity = Date.now();
    const exitCode = code ?? 128 + (osConstants.signals[signal] ?? 9);
    send(res, 200, { exitCode, stdout: stdout.toString(), stderr: stderr.toString(), timedOut });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://worker");
    const parts = url.pathname.split("/").filter(Boolean);
    let route = "unknown";
    if (parts[0] === "v1" && parts[1] === "sessions") route = ["/v1/sessions", "/v1/sessions/:name", `/v1/sessions/:name/${parts[3]}`][parts.length - 2] ?? "unknown";
    if (!["/v1/sessions", "/v1/sessions/:name", "/v1/sessions/:name/files", "/v1/sessions/:name/run"].includes(route)) route = "unknown";
    const started = performance.now();
    res.on("close", () => log(`${req.method} ${route} ${res.statusCode} ${Math.round(performance.now() - started)}ms`));
    if (!secretMatches(req.headers.authorization, secret)) {
      send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer", connection: "close" });
      if (!req.complete) res.once("finish", () => req.destroy());
      return;
    }
    const method = req.method;
    if (route === "/v1/sessions" && method === "POST") return createSession(req, res);
    if (route === "unknown") throw notFound();
    const session = sessionFor(parts[2]);
    if (session.status === "running") session.lastActivity = Date.now();
    if (route === "/v1/sessions/:name" && method === "GET") return send(res, 200, usage(session));
    if (route === "/v1/sessions/:name" && method === "DELETE") { await stopSession(session); return send(res, 200, usage(session)); }
    if (route === "/v1/sessions/:name/files" && method === "PUT") return track(session, putFile(req, res, session, url));
    if (route === "/v1/sessions/:name/files" && method === "GET") return track(session, getFile(res, session, url));
    if (route === "/v1/sessions/:name/run" && method === "POST") return runCommand(req, res, session);
    throw new HttpError(405, { error: "method_not_allowed" });
  }

  // Timeouts are checked every connectionsCheckingInterval (1 s here, 30 s by default).
  const server = createServer({ connectionsCheckingInterval: options.connectionsCheckingIntervalMs ?? 1_000 }, (req, res) => {
    handle(req, res).catch(async (error) => {
      const known = error instanceof HttpError;
      if (!known) log(`internal error: ${error?.code ?? error?.name ?? "unknown"}`);
      const status = known ? error.status : 500;
      const body = known ? error.body : { error: "internal" };
      // Authenticated callers get their answer even when the body was not
      // read yet (e.g. a 413 on Content-Length); everyone else is cut off.
      if (!req.complete && status !== 401 && Number(req.headers["content-length"] ?? 0) <= DRAIN_BYTES) await drain(req);
      send(res, status, body, { connection: "close" });
      if (!req.complete) res.once("finish", () => req.destroy());
    });
  });
  server.maxConnections = 64;
  server.headersTimeout = timeouts.headersMs;
  server.requestTimeout = timeouts.requestMs;
  server.keepAliveTimeout = timeouts.keepAliveMs;

  const reaper = setInterval(() => {
    const session = current;
    if (!session || session.status !== "running") return;
    const now = Date.now();
    const old = now - session.createdAt > maxAgeMs;
    const idle = !session.run && session.ops.size === 0 && now - session.lastActivity > idleMs;
    if (old || idle) { log(`reaper stopped session (${old ? "age" : "idle"})`); stopSession(session).catch(() => {}); }
  }, options.reapIntervalMs ?? 5_000);
  reaper.unref();

  return {
    server,
    ready: async () => { await rootReady(); await wipe(); },
    current: () => current,
    async close() {
      clearInterval(reaper);
      if (current) await stopSession(current);
      current?.meter?.stop();
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

async function main() {
  // The Dockerfile sets ASTRA_WORKER_CONTAINER=1. ASTRA_WORKER_TEST_ROOT is for
  // tests only: it maps /vercel/sandbox onto a scratch directory and turns off
  // the /tmp wipe and the stray-process sweep.
  const testRoot = process.env.ASTRA_WORKER_TEST_ROOT;
  const secret = process.env.ASTRA_WORKER_SECRET;
  // Only keeps the secret out of process.env for later code in this process. It
  // does NOT clear /proc/<pid>/environ (the kernel's copy of the start-up
  // environment): any process of the worker user can still read it there.
  delete process.env.ASTRA_WORKER_SECRET;
  let worker;
  try {
    worker = createRenderWorker({
      secret,
      root: testRoot || SANDBOX_ROOT,
      scratchDirs: testRoot ? [] : ["/tmp"],
      sweepStrays: !testRoot && process.env.ASTRA_WORKER_CONTAINER === "1",
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  await worker.ready();
  const port = Number(process.env.PORT ?? 8790);
  worker.server.listen(port, "0.0.0.0", () => console.log(`render worker listening on ${worker.server.address().port}`));
  const shutdown = () => { worker.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`render worker failed to start: ${error?.code ?? error?.message ?? "error"}`); process.exit(1); });
}
