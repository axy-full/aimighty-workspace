import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createRemotionWorker, exportEnv, EXPORT_COMMAND, LIMITS, SESSION_NAME, EGRESS_RETRY_DELAY_MS, main as startWorker } from "../../ops/remotion-worker/server.mjs";

// The worker runs a real /usr/bin/python3 as a stand-in for the fixed export command (the `command`
// option; the real one is `node /opt/remotion/cli.mjs`), and /vercel/sandbox is mapped onto a scratch
// directory (the worker's `root` option, or REMOTION_WORKER_TEST_ROOT for the CLI). One extra test
// runs the real built export command through the worker, when remotion/ has been built.
// Nothing leaves the machine.

const SERVER = fileURLToPath(new URL("../../ops/remotion-worker/server.mjs", import.meta.url));
const SECRET = "test-secret-0123456789abcdef0123456789";
const PY = "/usr/bin/python3";
const skip = existsSync(PY) && process.platform === "linux" ? false : "needs Linux and /usr/bin/python3";
const MiB = 1024 * 1024;
const DIR = "/vercel/sandbox/remotion";
const name = () => `remotion-export-${randomUUID()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_EXPORT_OK = `import pathlib
out = pathlib.Path('output')
out.mkdir(parents=True, exist_ok=True)
(out / 'export.mp4').write_bytes(bytes(4) + b'ftypisom' + bytes(32))
(out / 'result.json').write_text('{"ok": true}')
print('exported')
`;

async function setup(options = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "remotion-worker-"));
  const root = join(tmp, "sandbox");
  await mkdir(root);
  await mkdir(join(tmp, "scratch"));
  await mkdir(join(tmp, "outside"));
  await mkdir(join(tmp, "bin"));
  const lines = [];
  const worker = createRemotionWorker({ secret: SECRET, command: { cmd: PY, args: ["run.py"] }, root, scratchDirs: [join(tmp, "scratch")], log: (line) => lines.push(line), cpuStatPath: join(tmp, "cpu.stat"), ...options });
  await worker.ready();
  await new Promise((resolve) => worker.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${worker.server.address().port}`;
  const env = { tmp, root };
  return {
    ...env, worker, lines, base,
    async api(method, path, { body, json, auth = `Bearer ${SECRET}`, headers = {} } = {}) {
      const init = { method, headers: { ...headers } };
      if (auth !== null) init.headers.authorization = auth;
      if (json !== undefined) { init.body = JSON.stringify(json); init.headers["content-type"] = "application/json"; }
      else if (body !== undefined) { init.body = body; if (body instanceof ReadableStream) init.duplex = "half"; }
      const res = await fetch(base + path, init);
      const bytes = Buffer.from(await res.arrayBuffer());
      let data = null;
      try { data = JSON.parse(bytes.toString("utf8")); } catch { /* raw file */ }
      return { status: res.status, data, bytes };
    },
    async close() { await worker.close(); await rm(tmp, { recursive: true, force: true }); },
  };
}

const file = (path) => `?path=${encodeURIComponent(path)}`;
async function session(t, sessionName = name()) {
  const res = await t.api("POST", "/v1/sessions", { json: { name: sessionName } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data, { name: sessionName, status: "running" });
  return sessionName;
}
const put = (t, id, path, body) => t.api("PUT", `/v1/sessions/${id}/files${file(path)}`, { body });
const run = (t, id, extra = {}) => t.api("POST", `/v1/sessions/${id}/run`, { json: { cmd: PY, args: ["run.py"], cwd: "/vercel/sandbox/remotion", timeoutMs: 20_000, ...extra } });
async function waitFor(check, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(25); }
  return false;
}
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"; } catch { return false; }
}

test("refuses to start without a secret of at least 32 characters; starts and answers with one", { skip }, async () => {
  assert.throws(() => createRemotionWorker({}), /at least 32/);
  assert.throws(() => createRemotionWorker({ secret: "x".repeat(31) }), /at least 32/);
  const start = (env) => spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const outcome = (child) => new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => resolve({ code, out }));
  });
  for (const env of [{}, { REMOTION_WORKER_SECRET: "too-short" }]) {
    const { code, out } = await outcome(start(env));
    assert.equal(code, 1);
    assert.match(out, /REMOTION_WORKER_SECRET must be set/);
  }
  const root = await mkdtemp(join(tmpdir(), "remotion-worker-cli-"));
  const child = start({ REMOTION_WORKER_SECRET: SECRET, REMOTION_WORKER_TEST_ROOT: root, PORT: "0" });
  const done = outcome(child);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  assert.ok(await waitFor(() => /listening on (\d+)/.test(out)));
  const port = /listening on (\d+)/.exec(out)[1];
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${name()}`, { headers: { authorization: `Bearer ${SECRET}` } });
  assert.equal(res.status, 404);
  child.kill("SIGTERM");
  const { code, out: all } = await done;
  assert.equal(code, 0);
  assert.ok(!all.includes(SECRET));
  await rm(root, { recursive: true, force: true });
});

test("every request needs the bearer secret", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    for (const auth of [null, "", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, "Bearer wrong", `Basic ${SECRET}`, `bearer ${SECRET}`, SECRET]) {
      for (const [method, path, extra] of [
        ["POST", "/v1/sessions", { json: { name: name() } }],
        ["GET", `/v1/sessions/${id}`, {}],
        ["GET", `/v1/sessions/${name()}`, {}],
        ["PUT", `/v1/sessions/${id}/files${file("/vercel/sandbox/remotion/run.py")}`, { body: "x" }],
        ["POST", `/v1/sessions/${id}/run`, { json: { cmd: PY, args: ["run.py"], timeoutMs: 1000 } }],
        ["DELETE", `/v1/sessions/${id}`, {}],
        ["GET", "/nothing", {}],
      ]) {
        const res = await t.api(method, path, { ...extra, auth });
        assert.equal(res.status, 401, `${method} ${path} with ${JSON.stringify(auth)}`);
      }
    }
    // Nothing above reached the session.
    assert.equal((await t.api("GET", `/v1/sessions/${id}`)).data.status, "running");
    assert.equal(existsSync(join(t.root, "remotion", "run.py")), false);
  } finally { await t.close(); }
});

test("one session at a time; names are validated; unknown names are 404", { skip }, async () => {
  const t = await setup();
  try {
    for (const bad of ["remotion-export-x", `remotion-export-${randomUUID().toUpperCase()}`, `other-${randomUUID()}`, `remotion-export-${randomUUID()}/x`, 42, undefined]) {
      assert.equal((await t.api("POST", "/v1/sessions", { json: { name: bad } })).status, 400);
    }
    assert.equal((await t.api("POST", "/v1/sessions", { body: "not json" })).status, 400);
    // A leftover from before is wiped on create.
    await writeFile(join(t.root, "leftover"), "x");
    const id = await session(t);
    assert.equal(existsSync(join(t.root, "leftover")), false);
    const busy = await t.api("POST", "/v1/sessions", { json: { name: name() } });
    assert.equal(busy.status, 409);
    assert.deepEqual(busy.data, { busy: true });
    assert.equal((await t.api("POST", "/v1/sessions", { json: { name: id } })).status, 409);
    const other = name();
    for (const [method, path] of [["GET", `/v1/sessions/${other}`], ["DELETE", `/v1/sessions/${other}`], ["GET", `/v1/sessions/${other}/files${file("/vercel/sandbox/remotion/output/a")}`]]) {
      assert.equal((await t.api(method, path)).status, 404);
    }
    assert.equal((await put(t, other, "/vercel/sandbox/remotion/run.py", "x")).status, 404);
    assert.equal((await run(t, other)).status, 404);
  } finally { await t.close(); }
});

test("a full fake export: files in, fixed command, outputs out, tails capped, quiet logs", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    const program = `${FAKE_EXPORT_OK}import sys\nsys.stdout.write('o' * 200000 + 'END-OUT')\nsys.stderr.write('e' * 100000 + 'END-ERR')\n`;
    assert.equal((await put(t, id, `${DIR}/run.py`, program)).status, 201);
    assert.equal((await put(t, id, `${DIR}/spec.json`, '{"version":1}')).status, 201);
    const input = await put(t, id, `${DIR}/input/clips/a.mp4`, Buffer.from("video-bytes"));
    assert.deepEqual(input.data, { path: `${DIR}/input/clips/a.mp4`, bytes: 11 });
    const result = await run(t, id);
    assert.equal(result.status, 200);
    assert.equal(result.data.exitCode, 0, result.data.stderr);
    assert.equal(result.data.timedOut, false);
    assert.ok(Buffer.byteLength(result.data.stdout) <= LIMITS.streamTailBytes);
    assert.ok(Buffer.byteLength(result.data.stderr) <= LIMITS.streamTailBytes);
    assert.ok(result.data.stdout.endsWith("END-OUT"));
    assert.ok(result.data.stderr.endsWith("END-ERR"));
    const mp4 = await t.api("GET", `/v1/sessions/${id}/files${file(`${DIR}/output/export.mp4`)}`);
    assert.equal(mp4.status, 200);
    assert.equal(mp4.bytes.subarray(4, 8).toString("ascii"), "ftyp");
    assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file(`${DIR}/output/still-0.png`)}`)).status, 404);
    const status = await t.api("GET", `/v1/sessions/${id}`);
    assert.equal(status.data.status, "running");
    assert.equal(status.data.egressBytes, 0);
    assert.ok(Number.isFinite(status.data.activeCpuMs) && Number.isFinite(status.data.durationMs));
    // One line per request: method, route, status, ms. No names, paths, bodies or secret.
    assert.ok(t.lines.length >= 7);
    for (const line of t.lines) assert.match(line, /^(GET|PUT|POST|DELETE) (\/v1\/sessions(\/:name(\/files|\/run)?)?|unknown) \d{3} \d+ms$/);
    const all = t.lines.join("\n");
    for (const secret of [SECRET, id, "vercel", "a.mp4", "exported"]) assert.ok(!all.includes(secret));
  } finally { await t.close(); }
});

test("path traversal, paths outside the session and symlinks are refused", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    for (const path of [
      "/vercel/sandbox/remotion/../escape", "/vercel/sandbox/remotion/input/../../escape", "/vercel/sandbox/remotion/./run.py",
      "/vercel/sandbox/remotion", "/vercel/sandbox/remotion/", "/vercel/sandbox/remotion/input/", "/vercel/sandbox/run.py",
      "/vercel/sandbox/remotion2/run.py", "/etc/passwd", "remotion/run.py", "/vercel/sandbox/remotion/a\u0000b", "/vercel/sandbox/remotion/input",
      "/vercel/sandbox/remotion/a\\..\\b", "",
    ]) {
      assert.equal((await put(t, id, path, "x")).status, 400, path);
    }
    assert.equal((await t.api("PUT", `/v1/sessions/${id}/files?path=%2Fvercel%2Fsandbox%2Fremotion%2F%2E%2E%2Fx`, { body: "x" })).status, 400);
    assert.equal((await t.api("PUT", `/v1/sessions/${id}/files`, { body: "x" })).status, 400);
    assert.equal((await t.api("PUT", `/v1/sessions/${id}/files${file("/vercel/sandbox/remotion/a")}&path=%2Fvercel%2Fsandbox%2Fremotion%2Fb`, { body: "x" })).status, 400);
    // Reads come only from output/.
    await put(t, id, "/vercel/sandbox/remotion/run.py", "print(1)");
    for (const path of ["/vercel/sandbox/remotion/run.py", "/vercel/sandbox/remotion/output/../run.py", "/vercel/sandbox/remotion/output", "/vercel/sandbox/remotion/output/"]) {
      assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file(path)}`)).status, 400, path);
    }
    // A run could plant links; the worker never follows one, for writes or reads.
    const outside = join(t.tmp, "outside");
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(t.root, "remotion", "input", "linked"));
    await symlink(join(outside, "secret.txt"), join(t.root, "remotion", "output", "export.mp4"));
    await symlink(outside, join(t.root, "remotion", "output", "dir"));
    assert.equal((await put(t, id, "/vercel/sandbox/remotion/input/linked/a.png", "x")).status, 400);
    assert.equal((await put(t, id, "/vercel/sandbox/remotion/output/export.mp4", "overwritten")).status, 400);
    assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/remotion/output/export.mp4")}`)).status, 400);
    assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/remotion/output/dir/secret.txt")}`)).status, 400);
    assert.deepEqual(await readdir(outside), ["secret.txt"]);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
  } finally { await t.close(); }
});

test("upload caps fit a maximum export: 80 files, 200 MiB each, 600 MiB in total (413 above)", { skip }, async () => {
  assert.deepEqual([LIMITS.files, LIMITS.fileBytes, LIMITS.totalBytes], [80, 200 * MiB, 600 * MiB]);
  const t = await setup();
  try {
    let id = await session(t);
    const big = Buffer.alloc(200 * MiB, 1);
    assert.equal((await put(t, id, `${DIR}/input/a.mp4`, Buffer.alloc(200 * MiB + 1))).status, 413);
    // Without a Content-Length the cap holds while streaming.
    const chunk = Buffer.alloc(MiB);
    let sent = 0;
    const stream = new ReadableStream({ pull(controller) { if (sent++ < 201) controller.enqueue(chunk); else controller.close(); } });
    assert.equal((await put(t, id, `${DIR}/input/b.mp4`, stream)).status, 413);
    assert.equal(existsSync(join(t.root, "remotion", "input", "b.mp4")), false);
    // 600 MiB in all: three 200 MiB files fit, one more byte does not.
    for (const name of ["a", "b"]) assert.equal((await put(t, id, `${DIR}/input/${name}.mp4`, big)).status, 201);
    assert.equal((await put(t, id, `${DIR}/input/c.mp4`, Buffer.alloc(200 * MiB - 1, 2))).status, 201);
    assert.equal((await put(t, id, `${DIR}/spec.json`, "x")).status, 201);
    assert.equal((await put(t, id, `${DIR}/input/d.png`, "x")).status, 413);
    // Replacing a file counts its new size only.
    assert.equal((await put(t, id, `${DIR}/input/c.mp4`, Buffer.alloc(10))).status, 201);
    assert.equal((await put(t, id, `${DIR}/input/d.png`, "x")).status, 201);
    await t.api("DELETE", `/v1/sessions/${id}`);
    // 79 inputs plus spec.json fit; an 81st file does not.
    id = await session(t);
    for (let index = 0; index < 79; index++) assert.equal((await put(t, id, `${DIR}/input/f${index}.png`, "x")).status, 201);
    assert.equal((await put(t, id, `${DIR}/spec.json`, "x")).status, 201);
    assert.equal((await put(t, id, `${DIR}/input/one-more.png`, "x")).status, 413);
    assert.equal((await put(t, id, `${DIR}/input/f0.png`, "again")).status, 201);
  } finally { await t.close(); }
});

test("only the fixed export command, in the session folder, timeout within the maximum", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    await put(t, id, `${DIR}/run.py`, "open('output/ran', 'w').write('1')");
    for (const body of [
      { cmd: "/bin/sh", args: ["-c", "id"] }, { cmd: "python3" }, { cmd: "/usr/bin/python3 " }, { args: ["/vercel/sandbox/remotion/run.py"] },
      { args: ["-c", "print(1)"] }, { args: ["run.py", "extra"] }, { args: [] }, { args: "run.py" }, { cwd: "/" }, { cwd: "/vercel/sandbox" },
      { cmd: process.execPath, args: ["-e", "1"] },
      { timeoutMs: LIMITS.maxTimeoutMs + 1 }, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: "1000" }, { timeoutMs: undefined },
      { env: { A: "1" } }, { sudo: true },
    ]) {
      const res = await run(t, id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(existsSync(join(t.root, "remotion", "output", "ran")), false);
    const ok = await t.api("POST", `/v1/sessions/${id}/run`, { json: { cmd: PY, args: ["run.py"], timeoutMs: LIMITS.maxTimeoutMs } });
    assert.equal(ok.data.exitCode, 0);
    assert.equal(existsSync(join(t.root, "remotion", "output", "ran")), true);
  } finally { await t.close(); }
});

test("the real worker's command is node /opt/remotion/cli.mjs and nothing else", () => {
  assert.deepEqual({ cmd: EXPORT_COMMAND.cmd, args: [...EXPORT_COMMAND.args] }, { cmd: "/usr/local/bin/node", args: ["/opt/remotion/cli.mjs"] });
  assert.equal(SESSION_NAME.test(`remotion-export-${randomUUID()}`), true);
  assert.equal(SESSION_NAME.test(`astra-blender-${randomUUID()}`), false);
});

test("the child's environment is PATH, HOME, TMPDIR and the worker's own tuning, never the secret", { skip }, async () => {
  const t = await setup({ childEnv: { REMOTION_CONCURRENCY: "2", REMOTION_MAX_SECONDS: "120" } });
  process.env.REMOTION_WORKER_CANARY = "canary-value";
  process.env.REMOTION_WORKER_SECRET = SECRET;
  try {
    const id = await session(t);
    // /proc/self/environ is what exec received (Python may add LC_CTYPE later).
    await put(t, id, "/vercel/sandbox/remotion/run.py", "import json\nraw = open('/proc/self/environ', 'rb').read().split(b'\\0')\nopen('output/env.json', 'w').write(json.dumps(dict(x.decode().split('=', 1) for x in raw if x)))\n");
    assert.equal((await run(t, id)).data.exitCode, 0);
    const env = JSON.parse((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/remotion/output/env.json")}`)).bytes.toString());
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "REMOTION_CONCURRENCY", "REMOTION_MAX_SECONDS", "TMPDIR"]);
    assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin");
    assert.equal(env.TMPDIR, "/tmp");
    assert.equal(env.REMOTION_CONCURRENCY, "2");
    assert.ok(!JSON.stringify(env).includes(SECRET));
  } finally {
    delete process.env.REMOTION_WORKER_CANARY;
    delete process.env.REMOTION_WORKER_SECRET;
    await t.close();
  }
});

test("a timeout kills the whole process group, grandchildren included", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    const pids = join(t.tmp, "scratch", "pids");
    await put(t, id, `${DIR}/run.py`, `import os, subprocess, time\nchild = subprocess.Popen(['/bin/sleep', '60'])\nopen('${pids}', 'w').write(f'{os.getpid()} {child.pid}')\ntime.sleep(60)\n`);
    const started = Date.now();
    const res = await run(t, id, { timeoutMs: 1_500 });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(res.status, 200);
    assert.equal(res.data.timedOut, true);
    assert.equal(res.data.exitCode, 137);
    const [parent, grandchild] = (await readFile(pids, "utf8")).split(" ").map(Number);
    assert.ok(await waitFor(() => !alive(parent) && !alive(grandchild)), "every process of the run is gone");
    // The session is still usable after a timeout.
    assert.equal((await t.api("GET", `/v1/sessions/${id}`)).data.status, "running");
  } finally { await t.close(); }
});

test("a second run while one is running is busy; DELETE ends the run", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    const marker = join(t.tmp, "scratch", "started");
    await put(t, id, "/vercel/sandbox/remotion/run.py", `import time\nopen('${marker}', 'w').write('1')\ntime.sleep(60)\n`);
    const first = run(t, id, { timeoutMs: 30_000 });
    assert.ok(await waitFor(() => existsSync(marker)));
    const second = await run(t, id);
    assert.equal(second.status, 409);
    assert.deepEqual(second.data, { busy: true });
    const stopped = await t.api("DELETE", `/v1/sessions/${id}`);
    assert.equal(stopped.data.status, "stopped");
    const result = await first;
    assert.equal(result.data.exitCode, 137);
    assert.equal(result.data.timedOut, false);
  } finally { await t.close(); }
});

test("usage: cgroup cpu.stat delta, frozen at stop and readable until the next create", { skip }, async () => {
  const t = await setup();
  try {
    const cpu = join(t.tmp, "cpu.stat");
    await writeFile(cpu, "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n");
    const id = await session(t);
    await writeFile(cpu, "usage_usec 6000000\n");
    const live = await t.api("GET", `/v1/sessions/${id}`);
    assert.equal(live.data.activeCpuMs, 1000);
    await sleep(120);
    await writeFile(cpu, "usage_usec 7500000\n");
    const stopped = await t.api("DELETE", `/v1/sessions/${id}`);
    assert.equal(stopped.status, 200);
    assert.deepEqual(Object.keys(stopped.data).sort(), ["activeCpuMs", "durationMs", "egressBytes", "name", "status"]);
    assert.equal(stopped.data.status, "stopped");
    assert.equal(stopped.data.activeCpuMs, 2500);
    assert.ok(stopped.data.durationMs >= 100);
    assert.equal(stopped.data.egressBytes, 0);
    await writeFile(cpu, "usage_usec 9999999\n");
    await sleep(60);
    const later = await t.api("GET", `/v1/sessions/${id}`);
    assert.deepEqual(later.data, stopped.data);
    // A stopped session takes no files or commands, and its files are gone.
    assert.equal((await put(t, id, "/vercel/sandbox/remotion/run.py", "x")).status, 409);
    assert.equal((await run(t, id)).status, 409);
    assert.deepEqual(await readdir(t.root), []);
    // The next create replaces it.
    await session(t);
    assert.equal((await t.api("GET", `/v1/sessions/${id}`)).status, 404);
  } finally { await t.close(); }
});

test("usage without a readable cgroup falls back to the run's own CPU time", { skip }, async () => {
  const t = await setup({ cpuStatPath: "/nonexistent/cpu.stat" });
  try {
    const id = await session(t);
    await put(t, id, `${DIR}/run.py`, "import time\nend = time.process_time() + 0.8\nwhile time.process_time() < end: pass\n");
    assert.equal((await run(t, id)).data.exitCode, 0);
    const stopped = await t.api("DELETE", `/v1/sessions/${id}`);
    // Lower bound only: on a shared test machine other processes of this user
    // that start during the session are counted too (in the container there are none).
    assert.ok(stopped.data.activeCpuMs >= 300, String(stopped.data.activeCpuMs));
  } finally { await t.close(); }
});

test("usage without a cgroup still bills a child that left the process group (setsid)", { skip }, async () => {
  const t = await setup({ cpuStatPath: "/nonexistent/cpu.stat" });
  try {
    const id = await session(t);
    const pidFile = join(t.tmp, "scratch", "escaped");
    const burn = `import os, time\nopen('${pidFile}', 'w').write(str(os.getpid()))\nend = time.process_time() + 0.8\nwhile time.process_time() < end: pass\n`;
    // run.py starts the burner in a new session and returns at once: the run's
    // process group is gone before the burner has used any CPU.
    await put(t, id, "/vercel/sandbox/remotion/run.py", `import subprocess, sys\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(burn)}], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n`);
    assert.equal((await run(t, id)).data.exitCode, 0);
    assert.ok(await waitFor(() => existsSync(pidFile)));
    const escaped = Number(await readFile(pidFile, "utf8"));
    assert.ok(await waitFor(() => !alive(escaped), 10_000), "the burner finishes");
    const stopped = await t.api("DELETE", `/v1/sessions/${id}`);
    assert.ok(stopped.data.activeCpuMs >= 500, String(stopped.data.activeCpuMs));
  } finally { await t.close(); }
});

test("reaper: an idle session and an over-age session are stopped and wiped", { skip }, async () => {
  const idle = await setup({ idleMs: 300, maxAgeMs: 60_000, reapIntervalMs: 50 });
  try {
    const id = await session(idle);
    await put(idle, id, "/vercel/sandbox/remotion/run.py", "x");
    await sleep(150);
    assert.equal((await idle.api("GET", `/v1/sessions/${id}`)).data.status, "running"); // activity resets idle time
    assert.ok(await waitFor(() => idle.worker.current()?.status === "stopped", 3_000));
    assert.ok(await waitFor(async () => (await readdir(idle.root)).length === 0));
    assert.ok(idle.lines.some((line) => line === "reaper stopped session (idle)"));
    assert.equal((await idle.api("GET", `/v1/sessions/${id}`)).data.status, "stopped");
  } finally { await idle.close(); }
  const old = await setup({ idleMs: 60_000, maxAgeMs: 600, reapIntervalMs: 50 });
  try {
    const id = await session(old);
    await put(old, id, "/vercel/sandbox/remotion/run.py", "import time\ntime.sleep(30)\n");
    const started = Date.now();
    const res = await run(old, id, { timeoutMs: 20_000 });
    assert.ok(Date.now() - started < 5_000);
    assert.equal(res.data.exitCode, 137);
    const status = await old.api("GET", `/v1/sessions/${id}`);
    assert.equal(status.data.status, "stopped");
    assert.ok(old.lines.some((line) => line === "reaper stopped session (age)"));
  } finally { await old.close(); }
});

test("DELETE is idempotent and wipes the session", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    await put(t, id, "/vercel/sandbox/remotion/input/a.png", "x");
    await writeFile(join(t.tmp, "scratch", "chrome-temp"), "x");
    const first = await t.api("DELETE", `/v1/sessions/${id}`);
    assert.equal(first.status, 200);
    assert.equal(first.data.status, "stopped");
    const second = await t.api("DELETE", `/v1/sessions/${id}`);
    assert.equal(second.status, 200);
    assert.deepEqual(second.data, first.data);
    assert.deepEqual(await readdir(t.root), []);
    assert.deepEqual(await readdir(join(t.tmp, "scratch")), []);
    assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/remotion/output/a")}`)).status, 404);
  } finally { await t.close(); }
});

test("HTTP timeouts are explicit: headers 15 s, request 300 s, keep-alive 5 s, run route longer than the longest run", async () => {
  assert.deepEqual([LIMITS.headersTimeoutMs, LIMITS.requestTimeoutMs, LIMITS.keepAliveTimeoutMs, LIMITS.maxTimeoutMs, LIMITS.runDeadlineMs], [15_000, 300_000, 5_000, 900_000, 930_000]);
  const worker = createRemotionWorker({ secret: SECRET, log: () => {} });
  assert.equal(worker.server.headersTimeout, 15_000);
  assert.equal(worker.server.requestTimeout, 300_000);
  assert.equal(worker.server.keepAliveTimeout, 5_000);
  assert.ok(LIMITS.runDeadlineMs > LIMITS.maxTimeoutMs);
  assert.ok(LIMITS.maxAgeMs > LIMITS.runDeadlineMs, "a session may live as long as its longest run and the exchange around it");
  await worker.close();
});

test("timeouts end slow headers, slow bodies and an overlong run exchange", { skip }, async () => {
  const t = await setup({ headersTimeoutMs: 300, requestTimeoutMs: 600, keepAliveTimeoutMs: 200, runDeadlineMs: 800, connectionsCheckingIntervalMs: 50 });
  const raw = (text) => new Promise((resolve) => {
    const socket = createConnection(t.worker.server.address().port, "127.0.0.1");
    let answer = "";
    const started = Date.now();
    socket.on("data", (chunk) => { answer += chunk; });
    socket.on("error", () => {});
    socket.on("close", () => resolve({ answer, ms: Date.now() - started }));
    socket.write(text);
  });
  try {
    const headers = await raw("POST /v1/sessions HTTP/1.1\r\nHost: worker\r\n");
    assert.match(headers.answer, /^HTTP\/1\.1 408/);
    assert.ok(headers.ms < 3_000);
    const body = await raw(`POST /v1/sessions HTTP/1.1\r\nHost: worker\r\nAuthorization: Bearer ${SECRET}\r\nContent-Length: 100\r\n\r\n{`);
    assert.match(body.answer, /^HTTP\/1\.1 408/);
    assert.ok(body.ms < 3_000);
    // The run route: a run allowed 20 s still ends at the 0.8 s exchange deadline, process killed.
    const id = await session(t);
    const pidFile = join(t.tmp, "scratch", "run-pid");
    await put(t, id, "/vercel/sandbox/remotion/run.py", `import os, time\nopen('${pidFile}', 'w').write(str(os.getpid()))\ntime.sleep(30)\n`);
    const started = Date.now();
    await assert.rejects(run(t, id, { timeoutMs: 20_000 }));
    assert.ok(Date.now() - started < 5_000);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(await waitFor(() => !alive(pid)));
    assert.ok(await waitFor(() => t.worker.current().run === null));
    assert.equal((await t.api("GET", `/v1/sessions/${id}`)).data.status, "running");
  } finally { await t.close(); }
});

test("export tuning from the environment: whole numbers in range or a plain path, else the worker will not start", () => {
  assert.deepEqual(exportEnv({}), {});
  assert.deepEqual(exportEnv({ REMOTION_CONCURRENCY: "3", REMOTION_MAX_SECONDS: "120", REMOTION_BUNDLE_DIR: "/opt/remotion/bundle", REMOTION_RUNTIME_DIR: "/opt/remotion", UNRELATED: "x" }), { REMOTION_CONCURRENCY: "3", REMOTION_MAX_SECONDS: "120", REMOTION_BUNDLE_DIR: "/opt/remotion/bundle", REMOTION_RUNTIME_DIR: "/opt/remotion" });
  for (const env of [{ REMOTION_CONCURRENCY: "0" }, { REMOTION_CONCURRENCY: "9" }, { REMOTION_CONCURRENCY: "2.5" }, { REMOTION_CONCURRENCY: "x" }, { REMOTION_MAX_SECONDS: "601" }, { REMOTION_BUNDLE_DIR: "relative" }, { REMOTION_BUNDLE_DIR: "/a/../b" }, { REMOTION_RUNTIME_DIR: "../x" }, { REMOTION_BROWSER_EXECUTABLE: "/x y" }]) {
    assert.throws(() => exportEnv(env), /must be/, JSON.stringify(env));
  }
});

test("README's smoke script is smoke.mjs, byte for byte", async () => {
  const readme = readFileSync(new URL("../../ops/remotion-worker/README.md", import.meta.url), "utf8");
  const smoke = readFileSync(new URL("../../ops/remotion-worker/smoke.mjs", import.meta.url), "utf8");
  const block = /cat > \/tmp\/remotion-smoke\.mjs <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(readme);
  assert.ok(block, "README has the smoke heredoc");
  assert.equal(`${block[1]}\n`, smoke);
});

test("README's measurement script is measure.mjs, byte for byte", async () => {
  const readme = readFileSync(new URL("../../ops/remotion-worker/README.md", import.meta.url), "utf8");
  const measure = readFileSync(new URL("../../ops/remotion-worker/measure.mjs", import.meta.url), "utf8");
  const block = /cat > \/tmp\/remotion-measure\.mjs <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(readme);
  assert.ok(block, "README has the measurement heredoc");
  assert.equal(`${block[1]}\n`, measure);
});

test("compose: one single-slot worker, 3 vCPU / 8 GB, locked down, on remotion-internal by network_mode only, behind a secret-free relay, no secret in git", () => {
  const compose = readFileSync(new URL("../../ops/remotion-worker/compose.yaml", import.meta.url), "utf8");
  const yaml = compose.replace(/^\s*#.*$/gm, "").replace(/ +#.*$/gm, "");
  assert.deepEqual([...yaml.matchAll(/^ {2}([\w-]+):\n {4}build:/gm)].map((m) => m[1]), ["remotion-1", "remotion-relay"]);
  const worker = yaml.slice(yaml.indexOf("  remotion-1:"), yaml.indexOf("  remotion-relay:"));
  const relay = yaml.slice(yaml.indexOf("  remotion-relay:"), yaml.indexOf("\nnetworks:"));
  for (const line of ["context: ../..", "dockerfile: ops/remotion-worker/Dockerfile", "cpus: 3", "cpu_shares: 256", "mem_limit: 8g", "memswap_limit: 8g", "pids_limit: 1024", "read_only: true", "cap_drop: [ALL]",
    'security_opt: ["no-new-privileges:true"]', "network_mode: remotion-internal", "depends_on: [remotion-relay]", "container_name: remotion-1", "/vercel/sandbox:size=1280m,uid=10001,gid=10001,mode=0700", "/tmp:size=768m,uid=10001,gid=10001,mode=1777",
    "REMOTION_WORKER_SECRET: ${REMOTION_WORKER_SECRET:?", 'REMOTION_CONCURRENCY: "2"', 'REMOTION_MAX_SECONDS: "120"', "restart: unless-stopped"]) {
    assert.ok(worker.includes(line), line);
  }
  assert.ok(!/^\s*networks:/m.test(worker) && !/^\s*ports:/m.test(yaml) && !/^\s*expose:/m.test(yaml) && !/privileged/.test(yaml), "the worker is on no network but its own, and nothing is published");
  assert.match(yaml, /^networks:\n {2}remotion-internal:\n {4}name: remotion-internal\n {4}internal: true\n/m);
  /* The relay: the same image's relay stage, on the internal network only here (the app's comes from Connect To Predefined Network), no secret, locked down. */
  for (const line of ["target: relay", "networks: [remotion-internal]", "RELAY_TARGET_1: ${RELAY_TARGET_1:-remotion-1}", "read_only: true", "cap_drop: [ALL]", 'security_opt: ["no-new-privileges:true"]', "mem_limit: 128m", "pids_limit: 64", "cpus: 0.25", "8081"]) assert.ok(relay.includes(line), line);
  assert.ok(!/secret|token|password/i.test(relay) && !/network_mode|ports:|expose:|volumes:|privileged/.test(relay), "the relay holds no secret and publishes nothing");
  // The tmpfs mounts and the limits add up: both tmpfs full plus the browser still fit in memory.
  const sizes = [...worker.matchAll(/:size=(\d+)m/g)].map((m) => Number(m[1]));
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 2048);
  // The sandbox tmpfs holds a maximum export's inputs and its output.
  assert.ok((LIMITS.totalBytes + LIMITS.outputBytes) / MiB <= sizes[0]);
});

test("Dockerfile: base pinned by digest, Chrome pinned by the lockfile, build-time render, non-root, healthcheck, no secret", () => {
  const dockerfile = readFileSync(new URL("../../ops/remotion-worker/Dockerfile", import.meta.url), "utf8");
  const code = dockerfile.replace(/^#.*$/gm, "");
  const froms = [...code.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 5, "build, runtime-deps, print-browser, relay, run");
  for (const from of froms) assert.match(from, /^node:22\.[\d.]+-bookworm-slim@sha256:[0-9a-f]{64}$/);
  assert.equal(new Set(froms).size, 1, "one pinned base for every stage");
  assert.match(code, /npm ci --no-audit/);
  assert.match(code, /npm ci --omit=dev/);
  assert.match(code, /ensureBrowser\(\{ chromeMode: 'headless-shell' \}\)/);
  assert.match(code, /^COPY remotion\/package\.json remotion\/package-lock\.json/m);
  assert.match(code, /npm run bundle/);
  /* The browser is named, never looked for: the exact file, checked at build, set for the worker; package.json is copied beside node_modules. */
  const browser = "/opt/remotion/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell";
  assert.ok(code.includes(`REMOTION_BROWSER_EXECUTABLE=${browser}`), "the worker's browser is the exact installed file");
  assert.ok(code.includes("test -x node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell"), "the build fails if it is not there");
  assert.ok(code.includes('RUN test -x "$REMOTION_BROWSER_EXECUTABLE"'));
  assert.match(code, /^COPY --from=runtime-deps \/opt\/remotion\/package\.json \/opt\/remotion\/package\.json$/m);
  /* The egress check ships in the image; the relay is its own small stage. */
  assert.match(code, /^COPY ops\/render-worker\/check-egress\.mjs \/app\/check-egress\.mjs$/m);
  assert.match(code, /AS relay\n(?:.*\n)*?COPY ops\/render-worker\/relay\.mjs \/app\/relay\.mjs\n(?:.*\n)*?CMD \["node", "\/app\/relay\.mjs"\]/);
  assert.match(code, /^USER 10001:10001$/m);
  assert.match(code, /^HEALTHCHECK /m);
  assert.match(code, /REMOTION_RUNTIME_DIR=\/opt\/remotion/, "Chrome is looked up where the build put it, not under the session folder");
  assert.match(code, /grep -q '\^h264,192,108\$'/, "the build-time render is checked");
  assert.match(code, /composition":"fixture-clip"/);
  assert.ok(!/SECRET\s*=/.test(code), "no secret in the image");
  // The build-time render and the worker run the same command.
  assert.ok(code.includes("/usr/local/bin/node /opt/remotion/cli.mjs"));
  const ignore = readFileSync(new URL("../../ops/remotion-worker/Dockerfile.dockerignore", import.meta.url), "utf8");
  assert.match(ignore, /^\*$/m);
  assert.match(ignore, /^!remotion$/m);
  assert.match(ignore, /^remotion\/node_modules$/m);
  for (const file of ["check-egress.mjs", "relay.mjs", "check-relay.mjs"]) assert.ok(ignore.includes(`!ops/render-worker/${file}`), file);
});

// The real built export command, driven through the worker over HTTP. Skipped until `npm run bundle` has run in remotion/.
const CLI = fileURLToPath(new URL("../../remotion/build/cli.mjs", import.meta.url));
const RUNTIME = fileURLToPath(new URL("../../remotion", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../../remotion/build/bundle", import.meta.url));
test("through the worker: the real export command renders a sample and refuses a bad spec", { skip: skip || (existsSync(CLI) ? false : "run `npm run bundle` in remotion/ first") }, async () => {
  const t = await setup({ command: { cmd: process.execPath, args: [CLI] }, childEnv: { REMOTION_BUNDLE_DIR: BUNDLE, REMOTION_RUNTIME_DIR: RUNTIME, REMOTION_CONCURRENCY: "1", REMOTION_MAX_SECONDS: "120" } });
  try {
    const id = await session(t);
    const spec = { version: 1, composition: "fixture-clip", props: { aspect: "16:9", fps: 30, scale: 0.1, durationSeconds: 1, label: "WORKER" }, output: { video: true, stills: [15] } };
    assert.equal((await put(t, id, `${DIR}/spec.json`, JSON.stringify(spec))).status, 201);
    const done = await t.api("POST", `/v1/sessions/${id}/run`, { json: { cmd: process.execPath, args: [CLI], timeoutMs: 170_000 } });
    assert.equal(done.status, 200);
    assert.equal(done.data.exitCode, 0, done.data.stderr);
    const mp4 = await t.api("GET", `/v1/sessions/${id}/files${file(`${DIR}/output/export.mp4`)}`);
    assert.equal(mp4.bytes.subarray(4, 8).toString("ascii"), "ftyp");
    const still = await t.api("GET", `/v1/sessions/${id}/files${file(`${DIR}/output/still-15.png`)}`);
    assert.equal(still.bytes.subarray(1, 4).toString("ascii"), "PNG");
    const result = JSON.parse((await t.api("GET", `/v1/sessions/${id}/files${file(`${DIR}/output/result.json`)}`)).bytes.toString());
    assert.equal(result.durationInFrames, 30);
    // A spec for a template that is not ours exits 2 and says why.
    assert.equal((await put(t, id, `${DIR}/spec.json`, JSON.stringify({ version: 1, composition: "not-ours", props: {} }))).status, 201);
    const refused = await t.api("POST", `/v1/sessions/${id}/run`, { json: { cmd: process.execPath, args: [CLI], timeoutMs: 60_000 } });
    assert.equal(refused.data.exitCode, 2);
    assert.match(refused.data.stderr, /spec_invalid/);
  } finally { await t.close(); }
});

/* ── Fail-closed start, the test root, a run in progress (Opus review of #699) ───────────────────────────────────────── */

test("fail-closed start: the egress check runs before the worker listens; anything but a pass logs the lines, waits, exits non-zero and never binds; a pass listens", async () => {
  const root = await mkdtemp(join(tmpdir(), "remotion-worker-gate-"));
  const env = () => ({ REMOTION_WORKER_SECRET: SECRET, REMOTION_WORKER_TEST_ROOT: root, PORT: "0" });
  const run = async (gate, overrides = {}) => {
    const events = [];
    const worker = await startWorker({ env: overrides.env ?? env(), gate, signals: false, exit: (code) => events.push(`exit ${code}`), sleep: async (ms) => { events.push(`sleep ${ms}`); }, log: (line) => events.push(`log ${line}`), error: (line) => events.push(`error ${line}`) });
    return { events, worker };
  };
  try {
    for (const [label, gate] of [["a failing verdict", async () => ({ ok: false, failures: ["REACHED host:172.20.0.1:22 ECONNREFUSED", "LEAK env ASTRA_WORKER_SECRET"] })], ["no verdict", async () => undefined], ["a gate that throws", async () => { throw new Error("boom"); }]]) {
      const { events, worker } = await run(gate);
      assert.equal(worker, null, label);
      assert.deepEqual(events.map((e) => e.split(" ").slice(0, 2).join(" ")).filter((e) => /^(sleep|exit)/.test(e)), [`sleep ${EGRESS_RETRY_DELAY_MS}`, "exit 1"], `${label}: waits, then exits non-zero`);
      assert.ok(!events.some((e) => /listening/.test(e)), `${label}: never listens`);
    }
    const failing = await run(async () => ({ ok: false, failures: ["REACHED host:172.20.0.1:22 ECONNREFUSED", "LEAK env ASTRA_WORKER_SECRET"] }));
    const message = failing.events.find((e) => e.startsWith("error ")) ?? "";
    assert.match(message, /egress check failed/); assert.match(message, /LEAK env ASTRA_WORKER_SECRET/);
    assert.ok(!message.includes(SECRET), "never the secret's value");
    const passed = await run(async () => ({ ok: true, failures: [] }));
    try {
      assert.ok(passed.worker, "the worker was returned");
      assert.ok(await waitFor(() => passed.worker.server.listening), "and it is listening");
      assert.equal(passed.worker.server.address().address, "127.0.0.1", "a test root binds loopback only");
      assert.ok(passed.events.some((e) => /^log remotion worker listening on \d+$/.test(e)));
    } finally { await passed.worker.close(); }
    let asked = 0;
    const refused = await run(async () => { asked++; return { ok: true, failures: [] }; }, { env: { REMOTION_WORKER_SECRET: "short", REMOTION_WORKER_TEST_ROOT: root } });
    assert.equal(asked, 0); assert.equal(refused.worker, null); assert.ok(refused.events.includes("exit 1"), "a bad secret is refused before the check is asked");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("REMOTION_WORKER_TEST_ROOT is ignored inside the image (REMOTION_WORKER_CONTAINER=1): the real egress check runs; outside it the test root skips the check", async () => {
  const root = await mkdtemp(join(tmpdir(), "remotion-worker-testroot-"));
  try {
    for (const container of ["1", undefined]) {
      const label = container ? "in the image" : "outside it";
      const events = [];
      let asked = 0;
      const env = { REMOTION_WORKER_SECRET: SECRET, REMOTION_WORKER_TEST_ROOT: root, PORT: "0", ...(container ? { REMOTION_WORKER_CONTAINER: container } : {}) };
      const realGate = async () => { asked++; return { ok: false, failures: ["REACHED example.com"] }; };
      const worker = await startWorker({ env, realGate, signals: false, exit: (code) => events.push(`exit ${code}`), sleep: async () => {}, log: (line) => events.push(`log ${line}`), error: (line) => events.push(`error ${line}`) });
      if (container) {
        assert.equal(asked, 1, `${label}: the real check ran although a test root was set`);
        assert.equal(worker, null, label);
        assert.ok(events.includes("exit 1") && !events.some((e) => /listening/.test(e)), `${label}: ${JSON.stringify(events)}`);
      } else {
        assert.equal(asked, 0, `${label}: the test root skips the check`);
        assert.ok(worker, label);
        try { assert.ok(await waitFor(() => worker.server.listening), label); } finally { await worker.close(); }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("server.mjs: the gate is asked before the worker can listen, the real gate is the shared check with the worker's own secret named, and the test root is read once behind the container guard", () => {
  const code = readFileSync(SERVER, "utf8");
  const mainAt = code.indexOf("export async function main");
  const gateAt = code.indexOf("await runGate()", mainAt), readyAt = code.indexOf("await worker.ready()", mainAt), listenAt = code.indexOf(".listen(port", mainAt);
  assert.ok(mainAt > 0 && gateAt > mainAt && gateAt < readyAt && readyAt < listenAt, "gate, then ready, then listen");
  assert.equal(code.split(".listen(").length - 1, 1, "one place binds a port");
  assert.match(code, /import\("\.\/check-egress\.mjs"\)/);
  assert.match(code, /startupGate\(\{ own: "REMOTION_WORKER_SECRET" \}\)/);
  assert.match(code, /testRoot \? null : realGate/, "only the test root (tests only, never inside the image) skips the real check");
  assert.equal([...code.matchAll(/REMOTION_WORKER_TEST_ROOT/g)].length, 2, "one comment mention and one read");
  assert.match(code, /const testRoot = inContainer \? undefined : env\.REMOTION_WORKER_TEST_ROOT;/);
  assert.match(code, /sweepStrays: inContainer,/);
  assert.ok(EGRESS_RETRY_DELAY_MS >= 30_000, "the wait before exiting");
});

test("a file may not be written while a run is going (409 run_in_progress); before and after the run it may", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    const marker = join(t.tmp, "scratch", "started");
    await put(t, id, "/vercel/sandbox/remotion/run.py", `import time\nopen('${marker}', 'w').write('1')\ntime.sleep(60)\n`);
    const first = run(t, id, { timeoutMs: 30_000 });
    assert.ok(await waitFor(() => existsSync(marker)));
    const during = await put(t, id, "/vercel/sandbox/remotion/input/late.mp4", "x");
    assert.equal(during.status, 409);
    assert.deepEqual(during.data, { error: "run_in_progress" });
    await t.api("DELETE", `/v1/sessions/${id}`);
    await first;
  } finally { await t.close(); }
});

test("a run is refused while an upload is in flight (409 run_in_progress), and starts once the upload is done", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    await put(t, id, "/vercel/sandbox/remotion/run.py", "print('ran')\n");
    let hold;
    const body = new ReadableStream({ start(controller) { hold = controller; controller.enqueue(new TextEncoder().encode("first part")); } });
    const upload = put(t, id, "/vercel/sandbox/remotion/input/slow.mp4", body);
    /* Give the worker a moment to accept the first bytes; the upload then stays in flight until the stream is closed. */
    await sleep(250);
    const refused = await run(t, id);
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.data, { error: "run_in_progress" });
    hold.close();
    assert.equal((await upload).status, 201);
    const done = await run(t, id);
    assert.equal(done.status, 200);
    assert.equal(done.data.exitCode, 0);
    assert.match(done.data.stdout, /ran/);
  } finally { await t.close(); }
});
