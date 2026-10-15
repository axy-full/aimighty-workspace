# Astra render worker

CPU Blender 5.2.2 on our own server, in place of the Vercel Sandbox VM for Astra 3D renders. **One** single-slot container (`render-1`, 2 vCPU / 4 GB) by default, up to three, on an internal Docker network with no public port and no internet, behind a small relay that holds no secret. The app talks to a worker the way it talks to a Sandbox VM today: create, write files, run the fixed launcher, read the outputs, stop.

| File | What |
|---|---|
| `Dockerfile` | Node 22 (Debian bookworm slim, pinned by digest), Blender 5.2.2 from the official archive (SHA256 checked at build), `python3`, non-root user `render` (uid 10001), healthcheck. A tiny offline Cycles render runs at build time. The relay and the two checks run from this same image. |
| `server.mjs` | The worker API on port 8790 (plain Node, no dependencies). Not 8080: the host firewall drops 8080 in DOCKER-USER, which can also catch container-to-container traffic. |
| `relay.mjs` | The relay: a TCP forwarder with no secret. Listens on 8081, 8082, 8083 (one per worker that exists) and forwards each to its worker's 8790, passing the bytes unread. Nothing else. |
| `compose.yaml` | The workers, the relay and the `render-internal` network. |
| `check-egress.mjs` | The egress gate (Verify, step 1). Exits non-zero on anything that gets out. |
| `check-relay.mjs` | The relay check (Verify, step 1b). |
| `smoke.mjs` | The no-cost smoke render (same text as in "Verify", step 3). |
| `build-check.py` | The build-time Blender check. |

Tests: `node --test tests/ops/render-worker.test.mjs tests/ops/render-relay.test.mjs tests/ops/render-egress.test.mjs` (a fake Blender, fake TCP workers, canned outputs; no Docker needed).

## App-facing settings

| Variable | Where | Value |
|---|---|---|
| `ASTRA_WORKER_SECRET_1` (and `_2`, `_3` only for workers you turn on) | the worker stack | A random value of at least 32 characters per worker, all different (`openssl rand -hex 32` on your own machine). `render-N` reads `ASTRA_WORKER_SECRET_N` as its `ASTRA_WORKER_SECRET`. One secret per worker means code that escapes Blender and reads its own worker's environment cannot drive another. Runtime only: never a build variable, never in git or chat. The relay never sees one. |
| `ASTRA_WORKER_URLS` | the production app only | The relay's address, one port per worker: for one worker `http://<relay name>:8081`; for three `http://<relay name>:8081,http://<relay name>:8082,http://<relay name>:8083`. |
| `ASTRA_WORKER_SECRETS` | the production app only | Comma list of the secrets **in the same order** as `ASTRA_WORKER_URLS`. Runtime only. |
| `ASTRA_WORKER_COUNT`, `COMPOSE_PROFILES` | the worker stack | Unset = one worker. Two: `ASTRA_WORKER_COUNT=2`, `COMPOSE_PROFILES=workers-2`. Three: `3` and `workers-3`. Set both together (see "How many workers"). |
| `RENDER_CPUSET_1`, `_2`, `_3` | the worker stack | The cores each worker is pinned to. Defaults `6,7`, `4,5`, `2,3` (see "How many workers" before changing or using the last two). |

## Networking: option (c), the relay (owner's choice)

> Owner, 15 Oct 2026, 19:10: "I choose option (c), the relay, for ops/render-worker. Build it as a PR (NEEDS AKSHAY), Opus-reviewed, with the egress gate (Verify step 1) as a hard test. No setup on the server until I approve."

Why a relay: Coolify adds its own network, which has a gateway, to every compose service without `network_mode`, so `internal: true` alone does not stop a worker reaching the internet; and a Dockerfile app cannot be given a second network. A service with `network_mode` is left alone.

- `render-internal` is declared `internal: true` in `compose.yaml`, so Compose creates it with no gateway.
- Every worker is on it through `network_mode: render-internal` and on nothing else: no internet, no other network, no published port.
- `render-relay` (same image, `node /app/relay.mjs`) is on `render-internal` and, with **Connect To Predefined Network** on, on the app's network. It forwards 8081, 8082, 8083 to each worker's 8790 and nothing else. It holds no secret, never reads a connection's bytes (the worker's own `Authorization: Bearer` check still guards every request), connects only to the fixed names `render-1`, `render-2`, `render-3` on 8790, and resolves nothing else. A worker that is down gets a clean close for that caller.
- The app is **not** on `render-internal`. A worker cannot reach it, the relay is the only way in, and nothing needs redoing after an app redeploy.
- **Not verified until deployed:** that Compose creates `render-internal` (the relay's network) before it starts the `network_mode` workers (`depends_on` asks for it), that Coolify keeps `container_name`, `profiles` and `depends_on` as written, and that it reads `COMPOSE_PROFILES` from the stack's variables. If it adds a suffix to the container names, set `RELAY_TARGET_1..3` on the relay to the real names. **Whatever happens, Verify step 1 (egress) is a hard gate: no real render until it passes, and again after every change to the stack.**
- Options (a) (an internal network the advisor creates and attaches the app to after each deploy) and (b) (Coolify's network plus a host firewall rule; weaker against hostile code, DNS can still leave) were considered and are not used; `check-egress.mjs --option a|b` still judges them.

## How many workers, and which cores

One worker is the default: the server has 8 vCPU (cores 0 to 7) and shares them with production. `render-1` is pinned to cores **6,7**, leaving 0 to 5 to production and the OS. Every worker is 2 vCPU, 4 GB, 256 CPU shares (low weight, so production wins under load), 256 processes.

**Choosing cores from `nproc`:** run `nproc` on the server; it prints the core count N (cores `0` to `N-1`). Give worker 1 the last two cores, `N-2,N-1`; worker 2 the two before them, `N-4,N-3`; worker 3 `N-6,N-5`; leave at least half the cores to production. On 8 cores that is `6,7` for one worker; two workers would take `4,5` too and leave production four cores, which is the owner's call, not a default. Set them as `RENDER_CPUSET_1`, `RENDER_CPUSET_2`, `RENDER_CPUSET_3` in the stack's variables (the defaults `4,5` and `2,3` only suit a larger machine's idea of "spare"; do not rely on them on 8 cores). A core number that does not exist stops the container from starting.

**Going to two or three workers later:** (1) choose the cores (above) and set `RENDER_CPUSET_2` (and `_3`); (2) add `ASTRA_WORKER_SECRET_2` (and `_3`); (3) set `ASTRA_WORKER_COUNT=2` and `COMPOSE_PROFILES=workers-2` (three: `3` and `workers-3`); (4) redeploy the stack; (5) add `http://<relay name>:8082` (and `:8083`) and the matching secret to the app's `ASTRA_WORKER_URLS` and `ASTRA_WORKER_SECRETS`, same order; (6) run Verify again for the new worker. The relay forwards only to workers that exist: the ports of a worker that is not turned on are closed.

## Setup click list (owner and advisor)

Nothing here costs money. **Nothing is set up until the owner approves.**

1. **Make the secret (owner).** On your own machine, `openssl rand -hex 32`. Keep it in your password manager as worker 1 (a second and third only if you turn those workers on).
2. **Create the stack (owner, in Coolify).** Project of the production app, **+ New**, **Docker Compose** (from the GitHub repository), branch `release/1` (or `main` once merged).
   - **Base Directory:** `/ops/render-worker`. **Docker Compose Location:** `/compose.yaml`.
   - **Domains:** none on any service. No ports are published.
   - **Connect To Predefined Network:** **on** (it puts the relay on the app's network).
3. **Variables on the stack (owner).** `ASTRA_WORKER_SECRET_1`. Runtime only: leave **Build Variable** ("Available at Buildtime") unticked. Leave the rest unset for one worker on cores 6,7; set `RENDER_CPUSET_1` only if the cores differ (see "How many workers").
4. **Deploy (owner).** The first build downloads Blender (about 370 MB) and renders a 32 px test image; a few minutes. Wait until the relay and `render-1` show **healthy**.
5. **Run Verify step 1 and 1b (owner).** Stop here if either fails.
6. **Production app (owner).** Set `ASTRA_WORKER_URLS` (`http://<relay name>:8081`) and `ASTRA_WORKER_SECRETS` (the secret), both runtime only. Read the relay's container name on the stack's page (Coolify may add a suffix to `render-relay`). Redeploy the app.
7. **Run Verify steps 2 to 4.**

## Verify

1. **Egress gate (owner, Coolify terminal of `render-1`, then of each other worker you turned on).** **No real render until it passes.** Run while no render is running (a finished render ends every other process in the worker, including a terminal):
   ```sh
   node /app/check-egress.mjs --option c --app <production app container name>:3000
   ```
   It prints one line per probe and ends with `EGRESS GATE: PASS` (exit 0) or `EGRESS GATE: FAIL (...)` (exit 1). A pass is: the DNS line `blocked dns ...`, the two internet lines (`https://example.com`, `http://1.1.1.1`) `blocked ...`, and, for option (c), the app line `blocked ...` too: only the relay is on both networks, so a worker must not reach the app at all. Any `RESOLVED` or `REACHED` where it should say `blocked`, a missing or unrecognised line, or no output is a **FAIL**: stop, no renders, tell the advisor (a name that resolves is a way out, even with no route). Run it again after every change to the stack. The script holds no secret and reads none; `tests/ops/render-egress.test.mjs` pins its logic against canned outputs.
1b. **The relay (owner, Coolify terminal of `render-relay`):** `node /app/check-relay.mjs`. It checks that the relay's environment holds no secret-looking variable, that each worker it forwards to answers its own port with `401` (reachable and locked), and that ports 8790, 8080, 80, 22 and the relay ports of workers that do not exist are closed. It ends with `RELAY CHECK: PASS` or `FAIL`. Then, from the production app's terminal, that the relay listens on nothing else:
   ```sh
   node -e "for (const p of [8790, 8080, 80, 22]) require('net').connect({host: process.argv[1], port: p, timeout: 3000}).on('connect', function () { console.log(p, 'OPEN'); this.destroy() }).on('error', e => console.log(p, 'closed', e.code)).on('timeout', function () { console.log(p, 'closed (no answer)'); this.destroy() })" <relay name>
   ```
   Every line must say `closed`.
2. **The app reaches every worker through the relay and the secret is required (owner, production app terminal):**
   ```sh
   node -e "for (const u of process.env.ASTRA_WORKER_URLS.split(',')) fetch(u.trim() + '/v1/sessions').then(r => console.log(u, r.status), e => console.log(u, 'unreachable', e.cause?.code ?? e.name))"
   ```
   `401` for each = reachable and locked. `unreachable` = the relay is not on the app's network (Connect To Predefined Network is off) or the worker is down.
3. **Smoke render (owner, production app terminal; no money: Blender's own cube, 128 px, nothing billed or stored).** Paste the whole block; it tests every `ASTRA_WORKER_URLS` entry with its `ASTRA_WORKER_SECRETS` entry:
   ```sh
cat > /tmp/render-smoke.mjs <<'EOF'
// Render worker smoke test. Run in the production app's terminal (it has
// ASTRA_WORKER_URLS and ASTRA_WORKER_SECRETS, comma lists in the same order,
// and can reach the workers). Costs nothing: a 128 px render of Blender's own
// default cube on every worker, then each session is deleted.
//   node /tmp/render-smoke.mjs
import { randomUUID } from "node:crypto";

const list = (name) => (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const workers = list("ASTRA_WORKER_URLS");
const secrets = list("ASTRA_WORKER_SECRETS");
if (!workers.length || secrets.length !== workers.length || secrets.some((secret) => secret.length < 32)) {
  console.log("Needs ASTRA_WORKER_URLS and ASTRA_WORKER_SECRETS: comma lists of the same length, each secret at least 32 characters.");
  process.exit(2);
}
const ROOT = "/vercel/sandbox/astra";
const SCENE = `import bpy, pathlib, sys
out = pathlib.Path(sys.argv[sys.argv.index('--') + 1])
out.mkdir(parents=True, exist_ok=True)
assert bpy.app.version == (5, 2, 2), bpy.app.version
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 4
scene.render.resolution_x = 128
scene.render.resolution_y = 128
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(out / 'preview.png')
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'scene.blend'), check_existing=False, compress=False)
bpy.ops.render.render(write_still=True)
bpy.ops.export_scene.gltf(filepath=str(out / 'scene.glb'), export_format='GLB')
print('SMOKE_SCENE_DONE')
`;
// The app's launcher (lib/astra-blender/sandbox.ts): rlimits, then Blender with a fixed environment.
const LAUNCHER = `import os, resource
resource.setrlimit(resource.RLIMIT_AS, (3584 * 1024 * 1024, 3584 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_CPU, (330, 330))
os.execve('/opt/astra-blender/blender', ['/opt/astra-blender/blender', '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--threads', '2', '--python', '${ROOT}/scene.py', '--', '${ROOT}/output'], {'PATH': '/usr/bin:/bin', 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'BLENDER_USER_CONFIG': '/tmp/astra-blender-config'})
`;

async function call(base, secret, method, path, { json, body, auth = true } = {}) {
  const headers = auth ? { authorization: `Bearer ${secret}` } : {};
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(200_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { /* a file */ }
  return { status: res.status, data, bytes };
}

async function smoke(base, secret) {
  const unauthenticated = await call(base, secret, "GET", "/v1/sessions", { auth: false });
  if (unauthenticated.status !== 401) throw new Error(`expected 401 without the secret, got ${unauthenticated.status}`);
  const name = `astra-blender-${randomUUID()}`;
  const created = await call(base, secret, "POST", "/v1/sessions", { json: { name } });
  if (created.status !== 201) throw new Error(`create answered ${created.status} ${JSON.stringify(created.data)}`);
  const session = `/v1/sessions/${name}`;
  try {
    for (const [file, content] of [["scene.py", SCENE], ["run.py", LAUNCHER]]) {
      const put = await call(base, secret, "PUT", `${session}/files?path=${encodeURIComponent(`${ROOT}/${file}`)}`, { body: content });
      if (put.status !== 201) throw new Error(`upload ${file} answered ${put.status}`);
    }
    const started = Date.now();
    const run = await call(base, secret, "POST", `${session}/run`, { json: { cmd: "/usr/bin/python3", args: ["run.py"], cwd: ROOT, timeoutMs: 170_000 } });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (run.status !== 200 || run.data.exitCode !== 0) {
      console.log(run.data?.stderr?.slice(-3000) ?? "");
      throw new Error(`run answered ${run.status}, exit ${run.data?.exitCode} after ${seconds} s`);
    }
    const sizes = {};
    for (const [file, magic] of [["scene.blend", "BLENDER"], ["preview.png", "\x89PNG"], ["scene.glb", "glTF"]]) {
      const got = await call(base, secret, "GET", `${session}/files?path=${encodeURIComponent(`${ROOT}/output/${file}`)}`);
      if (got.status !== 200 || got.bytes.subarray(0, magic.length).toString("latin1") !== magic) throw new Error(`${file}: ${got.status}`);
      sizes[file] = got.bytes.length;
    }
    return { seconds, sizes };
  } finally {
    const stopped = await call(base, secret, "DELETE", session);
    console.log(`  usage: ${JSON.stringify(stopped.data)}`);
  }
}

let failed = 0;
for (const [index, base] of workers.entries()) {
  try {
    const { seconds, sizes } = await smoke(base.replace(/\/$/, ""), secrets[index]);
    console.log(`OK   ${base}: rendered in ${seconds} s, outputs ${JSON.stringify(sizes)}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${base}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
EOF
node /tmp/render-smoke.mjs
   ```
   Expect one `OK` line per worker (with seconds and output sizes) and a `usage:` line each with `"status":"stopped"`. Read a `FAIL` with Claude; the line never contains the secret.
4. **Limits (advisor, on the server), for each worker container (and the relay, with its own limits below):**
   ```sh
   docker inspect <worker> --format 'cpus={{.HostConfig.NanoCpus}} cpuset={{.HostConfig.CpusetCpus}} shares={{.HostConfig.CpuShares}} mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}} ro={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} ports={{json .HostConfig.PortBindings}} user={{.Config.User}} netmode={{.HostConfig.NetworkMode}} nets={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
   ```
   Expect `cpus=2000000000`, cpuset `6,7` for `render-1` (the cores you set for the others), `shares=256`, `mem=4294967296`, `swap=4294967296`, `pids=256`, `ro=true`, `capdrop=[ALL]`, `secopt=[no-new-privileges:true]`, `ports={}` (or `null`), `user=10001:10001`; netmode `render-internal` and no networks listed beyond it. For `render-relay`: `cpus=250000000`, `mem=134217728`, `pids=64`, `ro=true`, `capdrop=[ALL]`, `ports={}`, networks `render-internal` plus the app's network and the stack's own. In the worker's own terminal, `cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max` prints `200000 100000`, `4294967296`, `256`; `id -u` prints `10001`; `touch /x` fails (read-only). During the smoke render, `docker stats --no-stream` shows each worker at most 200% CPU and 4 GiB.

## Protocol (as implemented in `server.mjs`)

Every request needs `Authorization: Bearer $ASTRA_WORKER_SECRET`, the worker's own secret (compared in constant time); anything else gets `401`, before routing. Paths in requests are the Sandbox paths (`/vercel/sandbox/astra/...`). Bodies are JSON except file uploads and downloads. Errors are JSON `{"error": "..."}`.

| Request | Answer |
|---|---|
| `POST /v1/sessions` `{"name"}`, name `^astra-blender-[0-9a-f-]{36}$` | `201 {"name","status":"running"}`. Wipes `/vercel/sandbox` (and `/tmp`) first, creates `astra/`, `astra/input/`, `astra/output/`. `409 {"busy":true}` while a session is running (same name or not). `400` bad name. A stopped session is replaced. |
| `PUT /v1/sessions/:name/files?path=<abs>` raw body | `201 {"path","bytes"}`. `path` must normalise to a file strictly inside `/vercel/sandbox/astra/`; any `.`/`..` segment, control character, backslash, or symlink on the way is `400`. Parent directories are created. At most 66 distinct files, 50 MiB each, 110 MiB in total for the session (a replaced file counts at its new size), else `413`. A maximum app job (64 inputs, 100 MiB of inputs, plus `scene.py` and `run.py`) fits. `409` if the session is stopped. |
| `POST /v1/sessions/:name/run` `{"cmd","args","cwd"?,"timeoutMs"}` | Only `cmd: "/usr/bin/python3"`, `args: ["run.py"]`, `cwd` absent or `"/vercel/sandbox/astra"`, `timeoutMs` an integer 1 to 180000, and no other keys; else `400`. Runs synchronously, then `200 {"exitCode","stdout","stderr","timedOut"}`; stdout and stderr are the last 64 KiB each. The environment is exactly `PATH=/usr/bin:/bin` and `HOME=/vercel/sandbox`. The process runs in its own process group; the whole group is killed (SIGKILL) on timeout, on stop, if the caller disconnects, and when the run ends. A killed run answers `exitCode` 137. `409 {"busy":true}` while another run is going; `409` if stopped. |
| `GET /v1/sessions/:name/files?path=<abs>` | `200` with the bytes (`application/octet-stream`, `Content-Length`) of a regular file inside `/vercel/sandbox/astra/output/` (no symlinks). `404` if missing or the session is stopped; `400` outside `output/`; `413` over 320 MiB. |
| `GET /v1/sessions/:name` | `200 {"name","status":"running"|"stopped","activeCpuMs","durationMs","egressBytes":0}`. |
| `DELETE /v1/sessions/:name` | Stops the session (kills any run, waits for uploads to end, wipes files) and answers `200` with the same body as `GET`. Repeating it answers the same. |

- **`activeCpuMs`:** the container cgroup's `cpu.stat` `usage_usec` since the session was created (includes the small server and healthcheck processes). Without a readable cgroup: every 100 ms, `utime+stime` of every process of the worker user that started after the session (not the server, not PID 1), whatever its process group or session, so a `setsid` child is billed too; each process counts at its highest reading (Node has no `RUSAGE_CHILDREN`). Frozen at stop.
- **Timeouts:** headers 15 s, whole request received 190 s, keep-alive 5 s. A run exchange (request in, answer out) ends at 190 s whatever happens: the run is killed and the connection closed (Node's request timeout stops counting once a request is in).
- **`durationMs`:** wall time from create to stop (or to now while running).
- **After stop** the session answers `GET` and `DELETE` with its final usage until the next `POST /v1/sessions`; then its name is `404`.
- **Reaper:** a session idle for more than 240 s (no request, no run, no upload) or alive for more than 300 s is stopped and wiped.
- **Unknown name:** `404`, `DELETE` included (the app should read `404` on `DELETE` as already gone).
- **Logs:** one line per request, `METHOD route status ms`, with the route pattern only (no names, paths, bodies or headers), plus `reaper stopped session (idle|age)`.
- **Between sessions** (create and stop): every other process of the worker user is killed and `/tmp` is emptied, so nothing from one render reaches the next.

## Known limits and open points

- **Same user for server and render.** A render runs as the same uid as the server, so code that broke out of Blender could read its container's environment (`/proc/1/environ`), including that worker's secret (`delete process.env` in the server does not clear it). With one secret per worker that reaches only its own worker, which it already runs on. Fix later: run Blender under a second uid (needs `CAP_SETUID`/`CAP_SETGID` back).
- **Not verified without Docker:** the image build, Blender's library list on Debian bookworm (the build-time render fails the build if one is missing), tmpfs `uid`/`mode` options, Coolify's handling of this compose file (network names, container names, the extra network; see the networking decision), and the cgroup path inside the container.
