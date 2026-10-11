import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createRenderWorker, LIMITS } from "../../ops/render-worker/server.mjs";

// The worker runs the real /usr/bin/python3 and the same launcher shape the
// app writes (rlimits, then execve of Blender), except that the launcher execs
// a fake Blender script from this test instead of /opt/astra-blender/blender,
// and /vercel/sandbox is mapped onto a scratch directory (the worker's `root`
// option, or ASTRA_WORKER_TEST_ROOT for the CLI). Nothing leaves the machine.

const SERVER = fileURLToPath(new URL("../../ops/render-worker/server.mjs", import.meta.url));
const SECRET = "test-secret-0123456789abcdef0123456789";
const PY = "/usr/bin/python3";
const skip = existsSync(PY) && process.platform === "linux" ? false : "needs Linux and /usr/bin/python3";
const MiB = 1024 * 1024;
const name = () => `astra-blender-${randomUUID()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_BLENDER = `#!/usr/bin/python3
import runpy, sys
args = sys.argv[1:]
script = args[args.index('--python') + 1]
rest = args[args.index('--') + 1:] if '--' in args else []
print('Blender 5.2.2 (fake)', flush=True)
sys.argv = [script] + rest
runpy.run_path(script, run_name='__main__')
`;

/** lib/astra-blender/sandbox.ts LAUNCHER, pointed at the fake binary and the mapped root. */
const launcher = (env) => `import os, resource
resource.setrlimit(resource.RLIMIT_AS, (3584 * 1024 * 1024, 3584 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_CPU, (330, 330))
os.execve('${env.blender}', ['${env.blender}', '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--threads', '2', '--python', '${env.root}/astra/scene.py', '--', '${env.root}/astra/output'], {'PATH': '/usr/bin:/bin', 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'BLENDER_USER_CONFIG': '${env.tmp}/scratch/astra-blender-config'})
`;

const SCENE_OK = `import pathlib, sys
out = pathlib.Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
(out / 'scene.blend').write_bytes(b'BLENDER-v502' + bytes(64))
(out / 'preview.png').write_bytes(bytes([137, 80, 78, 71, 13, 10, 26, 10]) + bytes(32))
print('rendered')
`;

async function setup(options = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "render-worker-"));
  const root = join(tmp, "sandbox");
  await mkdir(root);
  await mkdir(join(tmp, "scratch"));
  await mkdir(join(tmp, "outside"));
  await mkdir(join(tmp, "bin"));
  const blender = join(tmp, "bin", "blender");
  await writeFile(blender, FAKE_BLENDER);
  await chmod(blender, 0o755);
  const lines = [];
  const worker = createRenderWorker({ secret: SECRET, root, scratchDirs: [join(tmp, "scratch")], log: (line) => lines.push(line), cpuStatPath: join(tmp, "cpu.stat"), ...options });
  await worker.ready();
  await new Promise((resolve) => worker.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${worker.server.address().port}`;
  const env = { tmp, root, blender };
  return {
    ...env, worker, lines, base,
    launcher: launcher(env),
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
const run = (t, id, extra = {}) => t.api("POST", `/v1/sessions/${id}/run`, { json: { cmd: PY, args: ["run.py"], cwd: "/vercel/sandbox/astra", timeoutMs: 20_000, ...extra } });
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
  assert.throws(() => createRenderWorker({}), /at least 32/);
  assert.throws(() => createRenderWorker({ secret: "x".repeat(31) }), /at least 32/);
  const start = (env) => spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const outcome = (child) => new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => resolve({ code, out }));
  });
  for (const env of [{}, { ASTRA_WORKER_SECRET: "too-short" }]) {
    const { code, out } = await outcome(start(env));
    assert.equal(code, 1);
    assert.match(out, /ASTRA_WORKER_SECRET must be set/);
  }
  const root = await mkdtemp(join(tmpdir(), "render-worker-cli-"));
  const child = start({ ASTRA_WORKER_SECRET: SECRET, ASTRA_WORKER_TEST_ROOT: root, PORT: "0" });
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
        ["PUT", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/run.py")}`, { body: "x" }],
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
    assert.equal(existsSync(join(t.root, "astra", "run.py")), false);
  } finally { await t.close(); }
});

test("one session at a time; names are validated; unknown names are 404", { skip }, async () => {
  const t = await setup();
  try {
    for (const bad of ["astra-blender-x", `astra-blender-${randomUUID().toUpperCase()}`, `other-${randomUUID()}`, `astra-blender-${randomUUID()}/x`, 42, undefined]) {
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
    for (const [method, path] of [["GET", `/v1/sessions/${other}`], ["DELETE", `/v1/sessions/${other}`], ["GET", `/v1/sessions/${other}/files${file("/vercel/sandbox/astra/output/a")}`]]) {
      assert.equal((await t.api(method, path)).status, 404);
    }
    assert.equal((await put(t, other, "/vercel/sandbox/astra/run.py", "x")).status, 404);
    assert.equal((await run(t, other)).status, 404);
  } finally { await t.close(); }
});

test("a full fake render: files in, fixed command, outputs out, tails capped, quiet logs", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    const scene = `${SCENE_OK}import sys\nsys.stdout.write('o' * 200000 + 'END-OUT')\nsys.stderr.write('e' * 100000 + 'END-ERR')\n`;
    assert.equal((await put(t, id, "/vercel/sandbox/astra/scene.py", scene)).status, 201);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/run.py", t.launcher)).status, 201);
    const input = await put(t, id, "/vercel/sandbox/astra/input/model.glb", Buffer.from("glTF-binary"));
    assert.deepEqual(input.data, { path: "/vercel/sandbox/astra/input/model.glb", bytes: 11 });
    const result = await run(t, id);
    assert.equal(result.status, 200);
    assert.equal(result.data.exitCode, 0, result.data.stderr);
    assert.equal(result.data.timedOut, false);
    assert.ok(Buffer.byteLength(result.data.stdout) <= LIMITS.streamTailBytes);
    assert.ok(Buffer.byteLength(result.data.stderr) <= LIMITS.streamTailBytes);
    assert.ok(result.data.stdout.endsWith("END-OUT"));
    assert.ok(result.data.stderr.endsWith("END-ERR"));
    const blend = await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/output/scene.blend")}`);
    assert.equal(blend.status, 200);
    assert.equal(blend.bytes.subarray(0, 7).toString("ascii"), "BLENDER");
    const preview = await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/output/preview.png")}`);
    assert.equal(preview.bytes[1], 80);
    assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/output/scene.glb")}`)).status, 404);
    const status = await t.api("GET", `/v1/sessions/${id}`);
    assert.equal(status.data.status, "running");
    assert.equal(status.data.egressBytes, 0);
    assert.ok(Number.isFinite(status.data.activeCpuMs) && Number.isFinite(status.data.durationMs));
    // One line per request: method, route, status, ms. No names, paths, bodies or secret.
    assert.ok(t.lines.length >= 8);
    for (const line of t.lines) assert.match(line, /^(GET|PUT|POST|DELETE) (\/v1\/sessions(\/:name(\/files|\/run)?)?|unknown) \d{3} \d+ms$/);
    const all = t.lines.join("\n");
    for (const secret of [SECRET, id, "vercel", "model.glb", "rendered"]) assert.ok(!all.includes(secret));
  } finally { await t.close(); }
});

test("path traversal, paths outside the session and symlinks are refused", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    for (const path of [
      "/vercel/sandbox/astra/../escape", "/vercel/sandbox/astra/input/../../escape", "/vercel/sandbox/astra/./run.py",
      "/vercel/sandbox/astra", "/vercel/sandbox/astra/", "/vercel/sandbox/astra/input/", "/vercel/sandbox/run.py",
      "/vercel/sandbox/astra2/run.py", "/etc/passwd", "astra/run.py", "/vercel/sandbox/astra/a\u0000b", "/vercel/sandbox/astra/input",
      "/vercel/sandbox/astra/a\\..\\b", "",
    ]) {
      assert.equal((await put(t, id, path, "x")).status, 400, path);
    }
    assert.equal((await t.api("PUT", `/v1/sessions/${id}/files?path=%2Fvercel%2Fsandbox%2Fastra%2F%2E%2E%2Fx`, { body: "x" })).status, 400);
    assert.equal((await t.api("PUT", `/v1/sessions/${id}/files`, { body: "x" })).status, 400);
    assert.equal((await t.api("PUT", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/a")}&path=%2Fvercel%2Fsandbox%2Fastra%2Fb`, { body: "x" })).status, 400);
    // Reads come only from output/.
    await put(t, id, "/vercel/sandbox/astra/run.py", "print(1)");
    for (const path of ["/vercel/sandbox/astra/run.py", "/vercel/sandbox/astra/output/../run.py", "/vercel/sandbox/astra/output", "/vercel/sandbox/astra/output/"]) {
      assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file(path)}`)).status, 400, path);
    }
    // A run could plant links; the worker never follows one, for writes or reads.
    const outside = join(t.tmp, "outside");
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(t.root, "astra", "input", "linked"));
    await symlink(join(outside, "secret.txt"), join(t.root, "astra", "output", "scene.blend"));
    await symlink(outside, join(t.root, "astra", "output", "dir"));
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/linked/a.png", "x")).status, 400);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/output/scene.blend", "overwritten")).status, 400);
    assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/output/scene.blend")}`)).status, 400);
    assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/output/dir/secret.txt")}`)).status, 400);
    assert.deepEqual(await readdir(outside), ["secret.txt"]);
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
  } finally { await t.close(); }
});

test("upload caps fit a maximum app job: 66 files, 50 MiB each, 110 MiB in total (413 above)", { skip }, async () => {
  assert.deepEqual([LIMITS.files, LIMITS.fileBytes, LIMITS.totalBytes], [66, 50 * MiB, 110 * MiB]);
  const t = await setup();
  try {
    let id = await session(t);
    const fifty = Buffer.alloc(50 * MiB, 1);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/a.blend", Buffer.alloc(50 * MiB + 1))).status, 413);
    // Without a Content-Length the cap holds while streaming.
    const chunk = Buffer.alloc(MiB);
    let sent = 0;
    const stream = new ReadableStream({ pull(controller) { if (sent++ < 51) controller.enqueue(chunk); else controller.close(); } });
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/b.blend", stream)).status, 413);
    assert.equal(existsSync(join(t.root, "astra", "input", "b.blend")), false);
    // 100 MiB of inputs (the app's maximum) plus the program fits.
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/a.blend", fifty)).status, 201);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/b.blend", fifty)).status, 201);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/scene.py", Buffer.alloc(9 * MiB, 35))).status, 201);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/run.py", Buffer.alloc(MiB, 35))).status, 201);
    // Exactly 110 MiB now: one more byte is refused.
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/c.png", "x")).status, 413);
    // Replacing a file counts its new size only.
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/b.blend", Buffer.alloc(10))).status, 201);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/c.png", "x")).status, 201);
    await t.api("DELETE", `/v1/sessions/${id}`);
    // 64 inputs (the app's maximum) plus scene.py and run.py fit; a 67th file does not.
    id = await session(t);
    for (let index = 0; index < 64; index++) assert.equal((await put(t, id, `/vercel/sandbox/astra/input/f${index}.png`, "x")).status, 201);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/scene.py", "x")).status, 201);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/run.py", "x")).status, 201);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/one-more.png", "x")).status, 413);
    assert.equal((await put(t, id, "/vercel/sandbox/astra/input/f0.png", "again")).status, 201);
  } finally { await t.close(); }
});

test("only /usr/bin/python3 run.py in /vercel/sandbox/astra, timeout at most 180 s", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    await put(t, id, "/vercel/sandbox/astra/run.py", "open('output/ran', 'w').write('1')");
    for (const body of [
      { cmd: "/bin/sh", args: ["-c", "id"] }, { cmd: "python3" }, { cmd: "/usr/bin/python3 " }, { args: ["/vercel/sandbox/astra/run.py"] },
      { args: ["-c", "print(1)"] }, { args: ["run.py", "extra"] }, { args: [] }, { args: "run.py" }, { cwd: "/" }, { cwd: "/vercel/sandbox" },
      { timeoutMs: 180_001 }, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: "1000" }, { timeoutMs: undefined },
      { env: { A: "1" } }, { sudo: true },
    ]) {
      const res = await run(t, id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(existsSync(join(t.root, "astra", "output", "ran")), false);
    const ok = await t.api("POST", `/v1/sessions/${id}/run`, { json: { cmd: PY, args: ["run.py"], timeoutMs: 180_000 } });
    assert.equal(ok.data.exitCode, 0);
    assert.equal(existsSync(join(t.root, "astra", "output", "ran")), true);
  } finally { await t.close(); }
});

test("the child's environment is empty except PATH and HOME", { skip }, async () => {
  const t = await setup();
  process.env.RENDER_WORKER_CANARY = "canary-value";
  process.env.ASTRA_WORKER_SECRET = SECRET;
  try {
    const id = await session(t);
    // /proc/self/environ is what exec received (Python may add LC_CTYPE later).
    await put(t, id, "/vercel/sandbox/astra/run.py", "import json\nraw = open('/proc/self/environ', 'rb').read().split(b'\\0')\nopen('output/env.json', 'w').write(json.dumps(dict(x.decode().split('=', 1) for x in raw if x)))\n");
    assert.equal((await run(t, id)).data.exitCode, 0);
    const env = JSON.parse((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/output/env.json")}`)).bytes.toString());
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.ok(!JSON.stringify(env).includes(SECRET));
  } finally {
    delete process.env.RENDER_WORKER_CANARY;
    delete process.env.ASTRA_WORKER_SECRET;
    await t.close();
  }
});

test("a timeout kills the whole process group, grandchildren included", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    const pids = join(t.tmp, "scratch", "pids");
    await put(t, id, "/vercel/sandbox/astra/scene.py", `import os, subprocess, time\nchild = subprocess.Popen(['/bin/sleep', '60'])\nopen('${pids}', 'w').write(f'{os.getpid()} {child.pid}')\ntime.sleep(60)\n`);
    await put(t, id, "/vercel/sandbox/astra/run.py", t.launcher);
    const started = Date.now();
    const res = await run(t, id, { timeoutMs: 1_500 });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(res.status, 200);
    assert.equal(res.data.timedOut, true);
    assert.equal(res.data.exitCode, 137);
    const [blender, grandchild] = (await readFile(pids, "utf8")).split(" ").map(Number);
    assert.ok(await waitFor(() => !alive(blender) && !alive(grandchild)), "every process of the run is gone");
    // The session is still usable after a timeout.
    assert.equal((await t.api("GET", `/v1/sessions/${id}`)).data.status, "running");
  } finally { await t.close(); }
});

test("a second run while one is running is busy; DELETE ends the run", { skip }, async () => {
  const t = await setup();
  try {
    const id = await session(t);
    const marker = join(t.tmp, "scratch", "started");
    await put(t, id, "/vercel/sandbox/astra/run.py", `import time\nopen('${marker}', 'w').write('1')\ntime.sleep(60)\n`);
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
    assert.equal((await put(t, id, "/vercel/sandbox/astra/run.py", "x")).status, 409);
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
    await put(t, id, "/vercel/sandbox/astra/scene.py", "import time\nend = time.process_time() + 0.8\nwhile time.process_time() < end: pass\n");
    await put(t, id, "/vercel/sandbox/astra/run.py", t.launcher);
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
    await put(t, id, "/vercel/sandbox/astra/run.py", `import subprocess, sys\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(burn)}], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n`);
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
    await put(idle, id, "/vercel/sandbox/astra/run.py", "x");
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
    await put(old, id, "/vercel/sandbox/astra/run.py", "import time\ntime.sleep(30)\n");
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
    await put(t, id, "/vercel/sandbox/astra/input/a.png", "x");
    await writeFile(join(t.tmp, "scratch", "blender-temp"), "x");
    const first = await t.api("DELETE", `/v1/sessions/${id}`);
    assert.equal(first.status, 200);
    assert.equal(first.data.status, "stopped");
    const second = await t.api("DELETE", `/v1/sessions/${id}`);
    assert.equal(second.status, 200);
    assert.deepEqual(second.data, first.data);
    assert.deepEqual(await readdir(t.root), []);
    assert.deepEqual(await readdir(join(t.tmp, "scratch")), []);
    assert.equal((await t.api("GET", `/v1/sessions/${id}/files${file("/vercel/sandbox/astra/output/a")}`)).status, 404);
  } finally { await t.close(); }
});

test("HTTP timeouts are explicit: headers 15 s, request 190 s, keep-alive 5 s, run route 190 s", async () => {
  assert.deepEqual([LIMITS.headersTimeoutMs, LIMITS.requestTimeoutMs, LIMITS.keepAliveTimeoutMs, LIMITS.runDeadlineMs], [15_000, 190_000, 5_000, 190_000]);
  const worker = createRenderWorker({ secret: SECRET, log: () => {} });
  assert.equal(worker.server.headersTimeout, 15_000);
  assert.equal(worker.server.requestTimeout, 190_000);
  assert.equal(worker.server.keepAliveTimeout, 5_000);
  assert.ok(LIMITS.runDeadlineMs > LIMITS.maxTimeoutMs);
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
    await put(t, id, "/vercel/sandbox/astra/run.py", `import os, time\nopen('${pidFile}', 'w').write(str(os.getpid()))\ntime.sleep(30)\n`);
    const started = Date.now();
    await assert.rejects(run(t, id, { timeoutMs: 20_000 }));
    assert.ok(Date.now() - started < 5_000);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(await waitFor(() => !alive(pid)));
    assert.ok(await waitFor(() => t.worker.current().run === null));
    assert.equal((await t.api("GET", `/v1/sessions/${id}`)).data.status, "running");
  } finally { await t.close(); }
});

test("README's smoke script is smoke.mjs, byte for byte", async () => {
  const readme = readFileSync(new URL("../../ops/render-worker/README.md", import.meta.url), "utf8");
  const smoke = readFileSync(new URL("../../ops/render-worker/smoke.mjs", import.meta.url), "utf8");
  const block = /cat > \/tmp\/render-smoke\.mjs <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(readme);
  assert.ok(block, "README has the smoke heredoc");
  assert.equal(`${block[1]}\n`, smoke);
});

test("compose: three identical workers but for their cores, locked down, internal network only", () => {
  const compose = readFileSync(new URL("../../ops/render-worker/compose.yaml", import.meta.url), "utf8");
  const yaml = compose.replace(/^\s*#.*$/gm, "");
  const blocks = yaml.split(/^ {2}(render-[123]):\n/m).slice(1);
  const services = Object.fromEntries(Array.from({ length: blocks.length / 2 }, (_, index) => [blocks[index * 2], blocks[index * 2 + 1].split(/^\S/m)[0].replace(/ +#.*$/gm, "")]));
  assert.deepEqual(Object.keys(services), ["render-1", "render-2", "render-3"]);
  assert.deepEqual(Object.values(services).map((block) => /cpuset: "([\d,]+)"/.exec(block)?.[1]), ["12,13", "14,15", "16,17"]);
  assert.deepEqual(Object.values(services).map((block) => /ASTRA_WORKER_SECRET: \$\{(ASTRA_WORKER_SECRET_\d):\?/.exec(block)?.[1]), ["ASTRA_WORKER_SECRET_1", "ASTRA_WORKER_SECRET_2", "ASTRA_WORKER_SECRET_3"]);
  const [first, ...rest] = Object.values(services).map((block) => block.replace(/^ +cpuset: .*\n/m, "").replace(/ASTRA_WORKER_SECRET_\d/g, "ASTRA_WORKER_SECRET_N"));
  for (const other of rest) assert.equal(other, first);
  for (const line of ["cpus: 2", "cpu_shares: 256", "mem_limit: 4g", "memswap_limit: 4g", "pids_limit: 256", "read_only: true", "cap_drop: [ALL]",
    'security_opt: ["no-new-privileges:true"]', "networks: [render-internal]", "/vercel/sandbox:size=1g,uid=10001,gid=10001,mode=0700", "/tmp:size=256m",
    "ASTRA_WORKER_SECRET: ${ASTRA_WORKER_SECRET_N:?"]) {
    assert.ok(first.includes(line), line);
  }
  assert.ok(!/^\s*ports:/m.test(yaml) && !/^\s*expose:/m.test(yaml));
  assert.match(yaml, /^networks:\n {2}render-internal:\n {4}name: render-internal\n {4}internal: true\n/m);
  const dockerfile = readFileSync(new URL("../../ops/render-worker/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /^USER 10001:10001$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.ok(!/SECRET\s*=/.test(dockerfile.replace(/^#.*$/gm, "")), "no secret in the image");
});
