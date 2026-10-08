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

## Setup click list (owner and advisor)

Nothing here costs money. **Run the egress check (Verify, step 1) before the app sends any real render.**

1. **Make the secret (owner).** On your own machine: `openssl rand -hex 32`. Keep it in your password manager. It must be at least 32 characters. Never paste it into chat, git or a ticket.
2. **Create the stack (owner, in Coolify).** Project of the production app, **+ New**, **Docker Compose** (from the GitHub repository), branch `release/1` (or `main` once merged).
   - **Base Directory:** `/ops/render-worker`. **Docker Compose Location:** `/compose.yaml`.
   - **Domains:** leave every service without a domain. No ports are published.
   - **Connect to Predefined Network:** leave **off**. On, it would put the workers on a network that has internet.
3. **Secret on the stack (owner).** Environment Variables: `ASTRA_WORKER_SECRET` = the value from step 1. Runtime only: leave **Build Variable** ("Available at Buildtime") unticked. All three services read this one variable.
4. **Deploy (owner).** The first build downloads Blender (about 370 MB) and renders a 32 px test image; a few minutes. Wait until all three services show **healthy**.
5. **Secret on the production app (owner).** Same name, same value, runtime only. Also set the worker addresses variable that the app-side PR names (the three `http://<container name>:8080` addresses from step 6). Redeploy the app.
6. **Attach the production app to `render-internal` (advisor, on the server, once).** Coolify has no field that adds a network to a Dockerfile app (its Custom Docker Options do not accept `--network`), and a redeploy makes a new app container. So a small host service keeps the app attached:
   - Find the app's label: `docker inspect <production app container> --format '{{json .Config.Labels}}'`; pick the label that names this app only (for example its application id label) as `KEY=VALUE`.
   - Save as `/usr/local/sbin/render-net-attach.sh` (root, mode 755), with `APP_LABEL` filled in:
     ```sh
     #!/bin/sh
     # Keeps the production app container on render-internal across redeploys.
     APP_LABEL='KEY=VALUE'
     while true; do
       for id in $(docker ps -q --filter "label=$APP_LABEL"); do
         docker network connect render-internal "$id" 2>/dev/null || true
       done
       sleep 30
     done
     ```
   - Save as `/etc/systemd/system/render-net-attach.service`:
     ```ini
     [Unit]
     Description=Attach the production app to render-internal
     After=docker.service
     Requires=docker.service

     [Service]
     ExecStart=/usr/local/sbin/render-net-attach.sh
     Restart=always

     [Install]
     WantedBy=multi-user.target
     ```
   - `systemctl daemon-reload && systemctl enable --now render-net-attach.service`.
   - Check: `docker network inspect render-internal --format '{{.Internal}} {{range .Containers}}{{.Name}} {{end}}'` prints `true` and four names: the three workers and the app.
   - The worker container names in that list are the addresses for step 5 (Coolify may add a suffix to `render-1`).

## Verify

1. **A worker cannot reach the internet (owner, Coolify terminal of `render-1`, then `render-2`, `render-3`).** Run while no render is running (a finished render ends every other process in the worker, including a terminal):
   ```sh
   node -e "for (const u of ['https://example.com', 'http://1.1.1.1']) fetch(u, {signal: AbortSignal.timeout(5000)}).then(r => console.log('REACHED THE INTERNET', u, r.status), e => console.log('blocked', u, e.cause?.code ?? e.name))"
   ```
   Both lines must say `blocked`. **If either says `REACHED THE INTERNET`, stop:** do not send renders. Coolify adds its own per-resource network to every compose service that has no `network_mode` (read in its compose parser), and that network has a gateway. Use "If the egress check fails" below.
2. **The app reaches a worker and the secret is required (owner, production app terminal):**
   ```sh
   node -e "fetch('http://<render-1 container name>:8080/v1/sessions').then(r => console.log(r.status), e => console.log('unreachable', e.cause?.code ?? e.name))"
   ```
   `401` = reachable and locked. `unreachable` = step 6 of the setup is not done.
3. **Smoke render (owner, production app terminal; no money: Blender's own cube, 128 px, nothing billed or stored).** Paste the whole block, then run it with the three addresses:
   ```sh
cat > /tmp/render-smoke.mjs <<'EOF'
// Render worker smoke test. Run in the production app's terminal (it has
// ASTRA_WORKER_SECRET and is on render-internal). Costs nothing: a 128 px
// render of Blender's own default cube, then the session is deleted.
//   node /tmp/render-smoke.mjs http://<render-1 name>:8080 [http://<render-2 name>:8080 ...]
import { randomUUID } from "node:crypto";

const secret = process.env.ASTRA_WORKER_SECRET ?? "";
const workers = process.argv.slice(2);
if (secret.length < 32 || !workers.length) {
  console.log("Usage: node /tmp/render-smoke.mjs http://<worker>:8080 [...] (needs ASTRA_WORKER_SECRET in the environment)");
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
node /tmp/render-smoke.mjs http://<render-1 name>:8080 http://<render-2 name>:8080 http://<render-3 name>:8080
   ```
   Expect three `OK` lines (each with seconds and output sizes) and a `usage:` line per worker with `"status":"stopped"`. Read a `FAIL` with Claude; the line never contains the secret.
4. **Limits (advisor, on the server), for each worker container:**
   ```sh
   docker inspect <worker> --format 'cpus={{.HostConfig.NanoCpus}} cpuset={{.HostConfig.CpusetCpus}} shares={{.HostConfig.CpuShares}} mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}} ro={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} ports={{json .HostConfig.PortBindings}} user={{.Config.User}} nets={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
   ```
   Expect `cpus=2000000000`, cpusets `12,13` / `14,15` / `16,17`, `shares=256`, `mem=4294967296`, `swap=4294967296`, `pids=256`, `ro=true`, `capdrop=[ALL]`, `secopt=[no-new-privileges:true]`, `ports={}` (or `null`), `user=10001:10001`, and `nets=render-internal` only. In the worker's own terminal, `cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max` prints `200000 100000`, `4294967296`, `256`; `id -u` prints `10001`; `touch /x` fails (read-only). During the smoke render, `docker stats --no-stream` shows each worker at most 200% CPU and 4 GiB.

## If the egress check fails

The `network_mode` variant takes the workers out of Coolify's extra network (Coolify leaves a service with `network_mode` alone; Docker Compose passes a network name there straight to Docker).

1. Advisor, on the server, once: `docker network create --internal render-internal` (skip if `docker network inspect render-internal --format '{{.Internal}}'` already prints `true`).
2. In `compose.yaml`, for each of the three services, replace `networks: [render-internal]` with `network_mode: render-internal`, and delete the top-level `networks:` block. (A small PR; the advisor or lead makes it.)
3. Redeploy, then repeat Verify 1 to 4. With `network_mode` the workers answer only to their container names, not to `render-1`.

## Protocol (as implemented in `server.mjs`)

Every request needs `Authorization: Bearer $ASTRA_WORKER_SECRET` (compared in constant time); anything else gets `401`, before routing. Paths in requests are the Sandbox paths (`/vercel/sandbox/astra/...`). Bodies are JSON except file uploads and downloads. Errors are JSON `{"error": "..."}`.

| Request | Answer |
|---|---|
| `POST /v1/sessions` `{"name"}`, name `^astra-blender-[0-9a-f-]{36}$` | `201 {"name","status":"running"}`. Wipes `/vercel/sandbox` (and `/tmp`) first, creates `astra/`, `astra/input/`, `astra/output/`. `409 {"busy":true}` while a session is running (same name or not). `400` bad name. A stopped session is replaced. |
| `PUT /v1/sessions/:name/files?path=<abs>` raw body | `201 {"path","bytes"}`. `path` must normalise to a file strictly inside `/vercel/sandbox/astra/`; any `.`/`..` segment, control character, backslash, or symlink on the way is `400`. Parent directories are created. At most 64 distinct files, 50 MiB each, 100 MiB in total for the session (a replaced file counts at its new size), else `413`. `409` if the session is stopped. |
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
- **Upload caps include the program.** The app allows 64 inputs and 100 MiB of inputs; `scene.py` and `run.py` are uploaded too, so a maximum-size job (66 files, or 100 MiB of inputs plus the program) is refused with `413` here. The app must keep inputs to 62 files and leave room for `scene.py`, or the caps change together.
- **Not verified without Docker:** the image build, Blender's library list on Debian bookworm (the build-time render fails the build if one is missing), tmpfs `uid`/`mode` options, Coolify's handling of this compose file (network names, container names, the extra network), and the cgroup path inside the container.
