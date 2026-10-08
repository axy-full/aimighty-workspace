# Astra render worker

CPU Blender 5.2.2 on our own server, in place of the Vercel Sandbox VM for Astra 3D renders. Three identical single-slot containers (`render-1`, `render-2`, `render-3`), each 2 vCPU / 4 GB, on an internal Docker network with no public port and no internet. The app talks to a worker the way it talks to a Sandbox VM today: create, write files, run the fixed launcher, read the outputs, stop.

| File | What |
|---|---|
| `Dockerfile` | Node 22 (Debian bookworm slim, pinned by digest), Blender 5.2.2 from the official archive (SHA256 checked at build), `python3`, non-root user `render` (uid 10001), healthcheck. A tiny offline Cycles render runs at build time. |
| `server.mjs` | The worker API on port 8080 (plain Node, no dependencies). |
| `compose.yaml` | The three workers and the `render-internal` network. |
| `smoke.mjs` | The no-cost smoke render (same text as in "Verify", step 3). |
| `build-check.py` | The build-time Blender check. |

Tests: `node --test tests/ops/render-worker.test.mjs` (a fake Blender; no Docker needed).

## App-facing settings

| Variable | Where | Value |
|---|---|---|
| `ASTRA_WORKER_SECRET` | the worker stack (all three services read it) **and** the production app | One random value, at least 32 characters (`openssl rand -hex 32` on your own machine). Runtime only: never a build variable, never in git or chat. |
| `ASTRA_WORKER_URLS` | the production app only | Comma list of the three worker base URLs, for example `http://<render-1 name>:8080,http://<render-2 name>:8080,http://<render-3 name>:8080`. The names depend on the networking option (below). |

## Networking: owner decision

**What I found (read in Coolify's docs and compose parser; not tried on our server):**
1. Coolify adds its own per-resource network to every compose service that does not set `network_mode`. That network has a gateway, so `internal: true` on `render-internal` alone does **not** stop a worker reaching the internet.
2. Coolify cannot add a second network to a Dockerfile app: Custom Docker Options do not accept `--network`, and a destination is one network per resource.
3. **Connect To Predefined Network** on a compose stack puts its services on the destination network the production app already uses, so the app reaches them by container name. That network has internet.
4. A service with `network_mode` is left alone by Coolify, and Docker Compose passes a network name there straight to Docker. Networks declared in the compose file are kept as written.

`compose.yaml` as shipped (`render-internal` only) is the common starting point; each option says what changes. **Whatever the choice, Verify step 1 (egress) is a hard gate: no real render until it passes, and again after every change to the stack or the firewall.**

**(a) `network_mode` on an internal network the advisor creates.**
- *How:* advisor, on the server, once: `docker network create --internal render-internal`. In `compose.yaml`, each worker gets `network_mode: render-internal` instead of `networks:`, and the top-level `networks:` block goes. Connect To Predefined Network stays off. The app joins with `docker network connect render-internal <production app container>`.
- *For:* Docker itself enforces it (no gateway); no firewall rules; a worker reaches nothing but the other workers and the app on `render-internal`. Ready now (a two-line compose change).
- *Against:* the app join is outside Coolify. Every production redeploy makes a new app container that is not on `render-internal`, so 3D renders fail until the advisor reconnects it: a manual line in the deploy checklist, or a host service that watches for the new container. Workers answer to their container names only.

**(b) Workers on Coolify's network, egress dropped by a host firewall rule.**
- *How:* tick Connect To Predefined Network on the stack, and give each worker a fixed address on that network (`ipv4_address` in `compose.yaml`; Docker only allows it if the network has a configured subnet: check `docker network inspect <predefined network> --format '{{json .IPAM.Config}}'`). The advisor adds to the server's existing DOCKER-USER firewall service (the one in `docs/selfhost-test.md`), for each worker source (its fixed address, and the per-resource network's subnet, which holds only the workers): `iptables -I DOCKER-USER -s <source> -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP`. New connections from a worker are dropped; replies to the app's requests pass.
- *For:* the app reaches the workers natively and keeps reaching them across redeploys; no per-deploy step.
- *Against:* isolation rests on a host rule and fixed addresses, not on the network layout; the rule must be in the boot-time firewall service. The workers share a network with every other resource there: those can reach a worker's port (the secret still guards it). Name lookups go through Docker's resolver, which the daemon forwards outside the rule, so DNS stays a narrow side channel. Traffic inside one bridge only meets the rule while `br_netfilter` is on (Docker's default), which the gate checks. Needs a small compose PR for the fixed addresses.

**(c) A relay inside the stack (the simplest layout the parser allows; not built yet).**
- *How:* workers use `network_mode: render-internal`. A fourth service, `render-relay` (same image, a small TCP forwarder holding no secret), is on `render-internal` (declared in the compose with `internal: true`, so Compose creates it) and, with Connect To Predefined Network on, on the app's network. `ASTRA_WORKER_URLS` = the relay's name on ports 8081, 8082, 8083.
- *For:* Docker enforces the workers' isolation as in (a), yet there is no host command, no firewall rule and nothing to redo after an app redeploy; everything stays in Coolify's UI.
- *Against:* new code to write and review (a follow-up PR); the relay is reachable by every resource on the app's network (the workers still require the secret). Unverified until deployed: that Compose creates `render-internal` before starting the `network_mode` workers, and the worker container names the relay forwards to.

**Recommendation:** (c) if a follow-up PR is acceptable, since it is the only option with Docker-enforced isolation and no host steps; otherwise (a) for a first trial, with the reconnect written into the deploy checklist. (b) only if the owner prefers one firewall rule to new code.

## Setup click list (owner and advisor)

Nothing here costs money.

1. **Pick the networking option** (above). The steps below say where they differ.
2. **Make the secret (owner).** On your own machine: `openssl rand -hex 32`. Keep it in your password manager.
3. **Create the stack (owner, in Coolify).** Project of the production app, **+ New**, **Docker Compose** (from the GitHub repository), branch `release/1` (or `main` once merged).
   - **Base Directory:** `/ops/render-worker`. **Docker Compose Location:** `/compose.yaml`.
   - **Domains:** none on any service. No ports are published.
   - **Connect To Predefined Network:** off for (a); on for (b) and (c).
4. **Secret on the stack (owner).** Environment Variables: `ASTRA_WORKER_SECRET`. Runtime only: leave **Build Variable** ("Available at Buildtime") unticked.
5. **Apply the option's server or compose part (advisor),** as written in its "How".
6. **Deploy (owner).** The first build downloads Blender (about 370 MB) and renders a 32 px test image; a few minutes. Wait until all three services show **healthy**.
7. **Run Verify step 1 (owner).** Stop here if it fails.
8. **Production app (owner).** Set `ASTRA_WORKER_SECRET` (same value) and `ASTRA_WORKER_URLS`, both runtime only. Read the container names in the stack's page (Coolify may add a suffix to `render-1`). Redeploy the app; for (a), the advisor reconnects it to `render-internal` now.
9. **Run Verify steps 2 to 4.**

## Verify

1. **Egress gate (owner, Coolify terminal of `render-1`, then `render-2`, `render-3`).** Run while no render is running (a finished render ends every other process in the worker, including a terminal):
   ```sh
   node -e "for (const u of ['https://example.com', 'http://1.1.1.1', 'http://' + process.argv[1]]) fetch(u, {signal: AbortSignal.timeout(5000)}).then(r => console.log('REACHED', u, r.status), e => console.log('blocked', u, e.cause?.code ?? e.name))" <production app container name>:3000
   ```
   The first two lines (the internet) must say `blocked` in every option. Any `REACHED` there: **stop**, no renders, tell the advisor. The third line (the app, directly) must say `blocked` in (b); in (a) and (c) the app sits on `render-internal` with the workers, so `REACHED` is expected there (the same pages anyone can open, minus the proxy in front).
2. **The app reaches every worker and the secret is required (owner, production app terminal):**
   ```sh
   node -e "for (const u of process.env.ASTRA_WORKER_URLS.split(',')) fetch(u.trim() + '/v1/sessions').then(r => console.log(u, r.status), e => console.log(u, 'unreachable', e.cause?.code ?? e.name))"
   ```
   `401` for each = reachable and locked. `unreachable` = the network option is not applied (for (a): the app is not on `render-internal`).
3. **Smoke render (owner, production app terminal; no money: Blender's own cube, 128 px, nothing billed or stored).** Paste the whole block; with no arguments it tests every `ASTRA_WORKER_URLS` entry:
   ```sh
cat > /tmp/render-smoke.mjs <<'EOF'
// Render worker smoke test. Run in the production app's terminal (it has
// ASTRA_WORKER_SECRET and ASTRA_WORKER_URLS, and can reach the workers).
// Costs nothing: a 128 px render of Blender's own default cube, then the
// session is deleted. Without arguments it smoke-tests every ASTRA_WORKER_URLS entry.
//   node /tmp/render-smoke.mjs [http://<worker>:8080 ...]
import { randomUUID } from "node:crypto";

const secret = process.env.ASTRA_WORKER_SECRET ?? "";
const listed = (process.env.ASTRA_WORKER_URLS ?? "").split(",").map((url) => url.trim()).filter(Boolean);
const workers = process.argv.length > 2 ? process.argv.slice(2) : listed;
if (secret.length < 32 || !workers.length) {
  console.log("Usage: node /tmp/render-smoke.mjs [http://<worker>:8080 ...] (needs ASTRA_WORKER_SECRET; the default list is ASTRA_WORKER_URLS)");
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

async function call(base, method, path, { json, body, auth = true } = {}) {
  const headers = auth ? { authorization: `Bearer ${secret}` } : {};
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(200_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { /* a file */ }
  return { status: res.status, data, bytes };
}

async function smoke(base) {
  const unauthenticated = await call(base, "GET", "/v1/sessions", { auth: false });
  if (unauthenticated.status !== 401) throw new Error(`expected 401 without the secret, got ${unauthenticated.status}`);
  const name = `astra-blender-${randomUUID()}`;
  const created = await call(base, "POST", "/v1/sessions", { json: { name } });
  if (created.status !== 201) throw new Error(`create answered ${created.status} ${JSON.stringify(created.data)}`);
  const session = `/v1/sessions/${name}`;
  try {
    for (const [file, content] of [["scene.py", SCENE], ["run.py", LAUNCHER]]) {
      const put = await call(base, "PUT", `${session}/files?path=${encodeURIComponent(`${ROOT}/${file}`)}`, { body: content });
      if (put.status !== 201) throw new Error(`upload ${file} answered ${put.status}`);
    }
    const started = Date.now();
    const run = await call(base, "POST", `${session}/run`, { json: { cmd: "/usr/bin/python3", args: ["run.py"], cwd: ROOT, timeoutMs: 170_000 } });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (run.status !== 200 || run.data.exitCode !== 0) {
      console.log(run.data?.stderr?.slice(-3000) ?? "");
      throw new Error(`run answered ${run.status}, exit ${run.data?.exitCode} after ${seconds} s`);
    }
    const sizes = {};
    for (const [file, magic] of [["scene.blend", "BLENDER"], ["preview.png", "\x89PNG"], ["scene.glb", "glTF"]]) {
      const got = await call(base, "GET", `${session}/files?path=${encodeURIComponent(`${ROOT}/output/${file}`)}`);
      if (got.status !== 200 || got.bytes.subarray(0, magic.length).toString("latin1") !== magic) throw new Error(`${file}: ${got.status}`);
      sizes[file] = got.bytes.length;
    }
    return { seconds, sizes };
  } finally {
    const stopped = await call(base, "DELETE", session);
    console.log(`  usage: ${JSON.stringify(stopped.data)}`);
  }
}

let failed = 0;
for (const base of workers) {
  try {
    const { seconds, sizes } = await smoke(base.replace(/\/$/, ""));
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
   Expect three `OK` lines (each with seconds and output sizes) and a `usage:` line per worker with `"status":"stopped"`. Read a `FAIL` with Claude; the line never contains the secret.
4. **Limits (advisor, on the server), for each worker container:**
   ```sh
   docker inspect <worker> --format 'cpus={{.HostConfig.NanoCpus}} cpuset={{.HostConfig.CpusetCpus}} shares={{.HostConfig.CpuShares}} mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}} ro={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} ports={{json .HostConfig.PortBindings}} user={{.Config.User}} netmode={{.HostConfig.NetworkMode}} nets={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
   ```
   Expect `cpus=2000000000`, cpusets `12,13` / `14,15` / `16,17`, `shares=256`, `mem=4294967296`, `swap=4294967296`, `pids=256`, `ro=true`, `capdrop=[ALL]`, `secopt=[no-new-privileges:true]`, `ports={}` (or `null`), `user=10001:10001`; networks: `render-internal` only for (a) and (c), the predefined and per-resource networks for (b). In the worker's own terminal, `cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max` prints `200000 100000`, `4294967296`, `256`; `id -u` prints `10001`; `touch /x` fails (read-only). During the smoke render, `docker stats --no-stream` shows each worker at most 200% CPU and 4 GiB.

## Protocol (as implemented in `server.mjs`)

Every request needs `Authorization: Bearer $ASTRA_WORKER_SECRET` (compared in constant time); anything else gets `401`, before routing. Paths in requests are the Sandbox paths (`/vercel/sandbox/astra/...`). Bodies are JSON except file uploads and downloads. Errors are JSON `{"error": "..."}`.

| Request | Answer |
|---|---|
| `POST /v1/sessions` `{"name"}`, name `^astra-blender-[0-9a-f-]{36}$` | `201 {"name","status":"running"}`. Wipes `/vercel/sandbox` (and `/tmp`) first, creates `astra/`, `astra/input/`, `astra/output/`. `409 {"busy":true}` while a session is running (same name or not). `400` bad name. A stopped session is replaced. |
| `PUT /v1/sessions/:name/files?path=<abs>` raw body | `201 {"path","bytes"}`. `path` must normalise to a file strictly inside `/vercel/sandbox/astra/`; any `.`/`..` segment, control character, backslash, or symlink on the way is `400`. Parent directories are created. At most 66 distinct files, 50 MiB each, 110 MiB in total for the session (a replaced file counts at its new size), else `413`. A maximum app job (64 inputs, 100 MiB of inputs, plus `scene.py` and `run.py`) fits. `409` if the session is stopped. |
| `POST /v1/sessions/:name/run` `{"cmd","args","cwd"?,"timeoutMs"}` | Only `cmd: "/usr/bin/python3"`, `args: ["run.py"]`, `cwd` absent or `"/vercel/sandbox/astra"`, `timeoutMs` an integer 1 to 180000, and no other keys; else `400`. Runs synchronously, then `200 {"exitCode","stdout","stderr","timedOut"}`; stdout and stderr are the last 64 KiB each. The environment is exactly `PATH=/usr/bin:/bin` and `HOME=/vercel/sandbox`. The process runs in its own process group; the whole group is killed (SIGKILL) on timeout, on stop, if the caller disconnects, and when the run ends. A killed run answers `exitCode` 137. `409 {"busy":true}` while another run is going; `409` if stopped. |
| `GET /v1/sessions/:name/files?path=<abs>` | `200` with the bytes (`application/octet-stream`, `Content-Length`) of a regular file inside `/vercel/sandbox/astra/output/` (no symlinks). `404` if missing or the session is stopped; `400` outside `output/`; `413` over 320 MiB. |
| `GET /v1/sessions/:name` | `200 {"name","status":"running"|"stopped","activeCpuMs","durationMs","egressBytes":0}`. |
| `DELETE /v1/sessions/:name` | Stops the session (kills any run, waits for uploads to end, wipes files) and answers `200` with the same body as `GET`. Repeating it answers the same. |

- **`activeCpuMs`:** the container cgroup's `cpu.stat` `usage_usec` since the session was created (includes the small server and healthcheck processes). Without a readable cgroup, the CPU time of the run's process group, sampled from `/proc` every 100 ms (Node has no `RUSAGE_CHILDREN`). Frozen at stop.
- **`durationMs`:** wall time from create to stop (or to now while running).
- **After stop** the session answers `GET` and `DELETE` with its final usage until the next `POST /v1/sessions`; then its name is `404`.
- **Reaper:** a session idle for more than 240 s (no request, no run, no upload) or alive for more than 300 s is stopped and wiped.
- **Unknown name:** `404`, `DELETE` included (the app should read `404` on `DELETE` as already gone).
- **Logs:** one line per request, `METHOD route status ms`, with the route pattern only (no names, paths, bodies or headers), plus `reaper stopped session (idle|age)`.
- **Between sessions** (create and stop): every other process of the worker user is killed and `/tmp` is emptied, so nothing from one render reaches the next.

## Known limits and open points

- **Same user for server and render.** A render runs as the same uid as the server, so code that broke out of Blender could read the container's environment (`/proc/1/environ`), including the secret, and use it on the other workers. It could not read their renders without the session name (a random UUID; there is no listing), but it could keep them busy. Fix later: run Blender under a second uid (needs `CAP_SETUID`/`CAP_SETGID` back), or a different secret per worker.
- **Not verified without Docker:** the image build, Blender's library list on Debian bookworm (the build-time render fails the build if one is missing), tmpfs `uid`/`mode` options, Coolify's handling of this compose file (network names, container names, the extra network; see the networking decision), and the cgroup path inside the container.
