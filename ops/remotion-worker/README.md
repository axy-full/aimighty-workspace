# Remotion export worker

CPU-only headless Chromium + FFmpeg on our own server, rendering **our own export templates** (`remotion/`: captions on a cut, title and end cards, 16:9 and 9:16 versions, 6/15/30 s cutdowns, final MP4). One single-slot container (`remotion-1`), 3 vCPU / 8 GB, no GPU, on an internal Docker network with no public port and no internet. The app talks to it the way it talks to an Astra render worker: create a session, write files, run the fixed export command, read the outputs, stop.

Plan and decisions: `docs/plans/remotion.md`. Licence: Remotion Free License, confirmed in writing 13 Oct 2026; rendering is self-hosted only (no Lambda, no AWS); only our templates are rendered, users never upload a project. **Exports are free to customers (0 cr): nothing here knows about prices.** The whole feature stays behind a switch, off in production, until the screens exist (PR 3).

| File | What |
|---|---|
| `Dockerfile` | Node 22 (Debian bookworm slim, pinned by digest), the compositions bundle and the export command built in at image build, Remotion's pinned Chrome Headless Shell (version follows `remotion/package-lock.json`), FFmpeg and ffprobe from `@remotion/compositor`, non-root user `remotion` (uid 10001), healthcheck. A tiny offline render (2 s, 192x108) runs at build time as that user, through the command the worker runs; a missing library fails the build. |
| `Dockerfile.dockerignore` | The build context is the repository root (the compositions are in `/remotion`); this keeps it to `remotion/`, this folder and the three shared files of `ops/render-worker/`. |
| `/app/check-egress.mjs`, `/app/relay.mjs`, `/app/check-relay.mjs` | Copied from `ops/render-worker/`: the egress check (run by the worker before it listens, and by hand), the relay (the `relay` build stage) and the relay check. Shared with the Astra worker; `--own REMOTION_WORKER_SECRET` tells the check which secret is the worker's own. |
| `server.mjs` | The worker API on port 8790 (plain Node, no dependencies; the Astra worker's protocol). Not 8080: the host firewall drops 8080 in DOCKER-USER. **Fail-closed start:** before it listens it runs the egress check in its own network and environment; if that is not a pass it logs the failing lines (names only), waits 30 s, exits non-zero and never binds. `REMOTION_WORKER_TEST_ROOT` (tests only) is ignored inside the image. |
| `compose.yaml` | The worker, its relay and the `remotion-internal` network. The worker is on that network only (`network_mode`); the relay is the one service on it and on the app's network. |
| `smoke.mjs` | The no-cost smoke export (same text as in "Verify", step 3). |
| `measure.mjs` | The 30 s 1080p measurement (same text as in "Limits"). |

Tests: `node --test tests/ops/remotion-worker.test.mjs` (a stand-in for the export command, no Docker; one extra test runs the real built command through the worker when `remotion/` has been built). Compositions and the export command: `remotion/README.md`.

## App-facing settings

| Variable | Where | Value |
|---|---|---|
| `REMOTION_WORKER_SECRET` | the worker stack | A random value of at least 32 characters (`openssl rand -hex 32`, on your own machine). One secret per worker. Runtime only: never a build variable, never in git or chat. The relay never sees one. |
| `REMOTION_WORKER_URLS` | the production app only | The relay's address, one entry per worker: `http://<remotion-relay name>:8081`. Nothing reads it until `REMOTION_EXPORTS` is on. |
| `REMOTION_WORKER_SECRETS` | the production app only | Comma list of secrets **in the same order** as `REMOTION_WORKER_URLS`. Runtime only. |
| `REMOTION_EXPORTS` | the production app only | The switch. **Leave it unset or off** until the screens exist and the owner has tested it. Off: `/api/exports` answers 404, the export tools are not offered over MCP, nothing is admitted, written or dispatched. |
| `REMOTION_EXPORT_MAX_RUNNING` | the production app (platform setting) | Exports one workspace may have rendering at once. Default 1, 1 to 4. Not a price. |
| `REMOTION_EXPORT_MAX_PER_HOUR` | the production app (platform setting) | Exports one workspace may start in a rolling hour. Default 6, 1 to 120. Not a price. |
| `REMOTION_EXPORT_RUN_TIMEOUT_MS` | the production app (platform setting) | How long the app waits for one run. Default 200000: uploads, the run and saving are one invocation of the native worker route, which lives 300 s, so the run gets 200 s and the rest 100 s. Up to 900000 on a deployment without that ceiling. |

Tuning of the export command (`REMOTION_CONCURRENCY`, `REMOTION_MAX_SECONDS`) is set in `compose.yaml`, from the measurement below, and never comes from a request.

## Networking: option (c), the relay (the owner's choice for the Astra workers, adopted here)

The reasoning and the Verify step are in `ops/render-worker/README.md`, "Networking: option (c), the relay". Here, in `compose.yaml`:

- `remotion-internal` is declared `internal: true`, so Compose creates it with no gateway: no internet.
- `remotion-1` is on it through `network_mode: remotion-internal` and on nothing else: no other network, no published port. (Coolify adds its own network, which has a gateway, to a service without `network_mode`.)
- `remotion-relay` (the `relay` stage of the same Dockerfile, `node /app/relay.mjs`) is on `remotion-internal` and, with **Connect To Predefined Network** on, on the app's network. It forwards 8081 to the worker's 8790 and nothing else, holds no secret, never reads a connection's bytes (the worker's own `Authorization: Bearer` check still guards every request), connects only to the fixed name `remotion-1` (with the platform's suffix if it adds one; set `RELAY_TARGET_1` on the relay to the real name then) and refuses any address that is not private.
- The app is **not** on `remotion-internal`. A worker cannot reach it, the relay is the only way in, and nothing needs redoing after an app redeploy.
- **Fail-closed:** the worker runs the egress check itself before it listens. **The check run by hand (Verify step 1) is still a hard gate: no real export until it passes, and again after every change to the stack, a firewall change, a Docker Engine upgrade or a reboot.**
- **Not verified until deployed:** that Compose creates `remotion-internal` (the relay's network) before it starts the `network_mode` worker (`depends_on` asks for it), and that Coolify keeps `container_name` and `depends_on` as written. Options (a) and (b) of the Astra README are not used.

## Setup click list (owner and advisor)

Nothing here costs money.

1. **Networking** (above): option (c). **Connect To Predefined Network: on** in step 3.
2. **Make the secret (owner).** On your own machine, run `openssl rand -hex 32` once. Keep it in your password manager as "remotion worker 1".
3. **Create the stack (owner, in Coolify).** Project of the production app, **+ New**, **Docker Compose** (from the GitHub repository), branch `release/1` (or `main` once merged).
   - **Base Directory:** `/ops/remotion-worker`. **Docker Compose Location:** `/compose.yaml`.
   - **Domains:** none. No ports are published.
   - **Connect To Predefined Network:** on (it puts the relay on the app's network).
   - The image builds from the repository root (`context: ../..` in `compose.yaml`), so Coolify must have cloned the whole repository. If the first build stops with "remotion/package.json not found", tell the advisor (see "Not verified without Docker").
4. **Secret on the stack (owner).** Environment Variables: `REMOTION_WORKER_SECRET` = the secret. Runtime only: leave **Build Variable** ("Available at Buildtime") unticked.
5. **Apply the option's server or compose part (advisor),** as written above.
6. **Deploy (owner).** The first build installs the npm packages (about 250 MB), downloads Chrome Headless Shell (about 90 MB) and renders a 2-second test clip as the runtime user; a few minutes. Wait until the service shows **healthy**. A red build with a Chrome library error means the apt list in the `Dockerfile` needs a package: send the last 40 lines of the build log.
7. **Run Verify step 1 (owner).** Stop here if it fails.
8. **Production app (owner).** Set `REMOTION_WORKER_URLS` (`http://<remotion-relay name>:8081`, read from the stack's page; if Coolify adds a suffix to `remotion-1`, set `RELAY_TARGET_1` on the relay to the real name) and `REMOTION_WORKER_SECRETS` (the same secret), both runtime only. Leave `REMOTION_EXPORTS` unset. Redeploy the app.
9. **Run Verify steps 2 to 4, then the measurement under "Limits" and send the numbers to the lead.**

## Verify

1. **Egress gate (owner, Coolify terminal of `remotion-1`).** **No real export until it passes.** Run while no export is running (a finished export ends every other process in the worker, including a terminal):
   ```sh
   node /app/check-egress.mjs --option c --own REMOTION_WORKER_SECRET --app <production app container name>:3000
   ```
   It prints one line per probe and ends with `EGRESS GATE: PASS` (exit 0) or `EGRESS GATE: FAIL (...)` (exit 1). Every line must be `blocked` (or `clean env`, `clean ipv6`): the DNS line, the two internet lines, `host.docker.internal`, the host itself (`host:IP:PORT`, eight ports on the gateway of every network the worker is on; a refused connection counts as `REACHED`), the environment (no worker-secret name beyond its own `REMOTION_WORKER_SECRET`: no `ASTRA_WORKER_SECRET*`, no `REMOTION_WORKER_SECRET_<N>` or `REMOTION_WORKER_SECRETS`), IPv6, and, for option (c), the app line `blocked ...` too: only the relay is on both networks. Any `REACHED`, `RESOLVED` or `LEAK`, or a missing, repeated or unrecognised line: **FAIL**, stop, tell the advisor. The worker runs this same check itself before it listens (without the app line).
1b. **The relay (owner, Coolify terminal of `remotion-relay`):** `node /app/check-relay.mjs`. It checks that the relay's environment holds no secret-looking variable, that the worker answers port 8081 with `401`, and that 8790, 8080, 8082, 8083, 80 and 22 are closed. It ends with `RELAY CHECK: PASS` or `FAIL`.
2. **The app reaches the worker and the secret is required (owner, production app terminal):**
   ```sh
   node -e "for (const u of process.env.REMOTION_WORKER_URLS.split(',')) fetch(u.trim() + '/v1/sessions').then(r => console.log(u, r.status), e => console.log(u, 'unreachable', e.cause?.code ?? e.name))"
   ```
   `401` = reachable and locked. `unreachable` = the relay is not reachable from the app (Connect To Predefined Network is off, or the relay is down).
3. **Smoke export (owner, production app terminal; no money: our own 2-second sample picture, nothing billed or stored).** Paste the whole block:
   ```sh
cat > /tmp/remotion-smoke.mjs <<'EOF'
// Remotion worker smoke test. Run in the production app's terminal (it has
// REMOTION_WORKER_URLS and REMOTION_WORKER_SECRETS, comma lists in the same order,
// and can reach the workers). Costs nothing: a 2-second sample picture of our own
// (no media, no engine) rendered on every worker, a refusal check, then each session
// is deleted. Nothing is stored or billed.
//   node /tmp/remotion-smoke.mjs
import { randomUUID } from "node:crypto";

const list = (name) => (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const workers = list("REMOTION_WORKER_URLS");
const secrets = list("REMOTION_WORKER_SECRETS");
if (!workers.length || secrets.length !== workers.length || secrets.some((secret) => secret.length < 32)) {
  console.log("Needs REMOTION_WORKER_URLS and REMOTION_WORKER_SECRETS: comma lists of the same length, each secret at least 32 characters.");
  process.exit(2);
}
const ROOT = "/vercel/sandbox/remotion";
const COMMAND = { cmd: "/usr/local/bin/node", args: ["/opt/remotion/cli.mjs"] };
const GOOD = { version: 1, composition: "fixture-clip", props: { aspect: "16:9", fps: 30, scale: 0.25, durationSeconds: 2, label: "SMOKE" }, output: { video: true, stills: [30] } };
const BAD = { version: 1, composition: "not-ours", props: {} };

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
  const name = `remotion-export-${randomUUID()}`;
  const created = await call(base, secret, "POST", "/v1/sessions", { json: { name } });
  if (created.status !== 201) throw new Error(`create answered ${created.status} ${JSON.stringify(created.data)}`);
  const session = `/v1/sessions/${name}`;
  const put = async (file, content) => {
    const res = await call(base, secret, "PUT", `${session}/files?path=${encodeURIComponent(`${ROOT}/${file}`)}`, { body: content });
    if (res.status !== 201) throw new Error(`upload ${file} answered ${res.status}`);
  };
  const run = (timeoutMs) => call(base, secret, "POST", `${session}/run`, { json: { ...COMMAND, timeoutMs } });
  try {
    // 1. A good export.
    await put("spec.json", JSON.stringify(GOOD));
    const started = Date.now();
    const done = await run(170_000);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (done.status !== 200 || done.data.exitCode !== 0) {
      console.log(done.data?.stderr?.slice(-3000) ?? "");
      throw new Error(`run answered ${done.status}, exit ${done.data?.exitCode} after ${seconds} s`);
    }
    const sizes = {};
    for (const [file, magic, offset] of [["export.mp4", "ftyp", 4], ["still-30.png", "\x89PNG", 0], ["result.json", "{", 0]]) {
      const got = await call(base, secret, "GET", `${session}/files?path=${encodeURIComponent(`${ROOT}/output/${file}`)}`);
      if (got.status !== 200 || got.bytes.subarray(offset, offset + magic.length).toString("latin1") !== magic) throw new Error(`${file}: ${got.status}`);
      sizes[file] = got.bytes.length;
    }
    // 2. The command refuses what it should: a spec for a template that is not ours exits 2.
    await put("spec.json", JSON.stringify(BAD));
    const refused = await run(60_000);
    if (refused.data?.exitCode !== 2) throw new Error(`a bad spec should exit 2, got ${refused.data?.exitCode}`);
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
    console.log(`OK   ${base}: exported in ${seconds} s, outputs ${JSON.stringify(sizes)}, a bad spec was refused`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${base}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
EOF
node /tmp/remotion-smoke.mjs
   ```
   Expect one `OK` line (seconds, output sizes, and that a bad spec was refused) and a `usage:` line with `"status":"stopped"`. Read a `FAIL` with Claude; the line never contains the secret.
4. **Limits (advisor, on the server):**
   ```sh
   docker inspect <worker> --format 'cpus={{.HostConfig.NanoCpus}} shares={{.HostConfig.CpuShares}} mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}} ro={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} ports={{json .HostConfig.PortBindings}} user={{.Config.User}} netmode={{.HostConfig.NetworkMode}} nets={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
   ```
   Expect `cpus=3000000000`, `shares=256`, `mem=8589934592`, `swap=8589934592`, `pids=1024`, `ro=true`, `capdrop=[ALL]`, `secopt=[no-new-privileges:true]`, `ports={}` (or `null`), `user=10001:10001`; netmode `remotion-internal` and no networks listed beyond it. For `remotion-relay`: `cpus=250000000`, `mem=134217728`, `pids=64`, `ro=true`, `capdrop=[ALL]`, `ports={}`, networks `remotion-internal` plus the app's network and the stack's own. In the worker's own terminal, `cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max` prints `300000 100000`, `8589934592`, `1024`; `id -u` prints `10001`; `touch /x` fails (read-only).

## Limits

### Measured on our server (13 Oct 2026), outside Docker

The export: **30 s at 1920x1080, 30 fps** (900 frames): a 28 s source clip with AAC audio (1080p H.264, our own sample picture plus a tone, no engine call), 14 karaoke captions, and a 2 s end card (`final`, the same spec `measure.mjs` sends). Run through `~/ops/heavy.sh nice -n 10` (so at nice 19, idle I/O) with `/usr/bin/time -v`, `node remotion/build/cli.mjs`, Node 24, Chrome Headless Shell 149, Remotion 4.0.530. **The machine was busy: load average 6 to 11 on 8 cores (other lanes and production), and at nice 19 the render got about one core whatever its concurrency**, so wall time here only says "what one core under load does"; the CPU time is the figure that carries over. Output: 7.3 MB, identical bytes at every concurrency.

| Remotion concurrency | Wall | CPU time (user + system) | Cores it actually got | Peak memory, all processes summed |
|---|---|---|---|---|
| 1 | 305.9 s | 176.9 s | 0.57 | 2.6 GB |
| 2 | 163.8 s | 158.4 s | 0.96 | 3.0 GB |
| 3 | 169.8 s | 177.7 s | 1.04 | 3.4 GB |

- **Cost of one export: about 160 to 180 CPU-seconds per 30 s of 1080p**, about 0.19 CPU-seconds per frame, whatever the concurrency. Output length scales it linearly: a 120 s export is about 650 CPU-seconds.
- **Memory:** about 2.2 GB for the first frame worker and 0.4 GB for each further one. The figure sums every process's resident memory (Node, Chrome tabs, the compositor, ffmpeg) every second and counts shared pages once per process, so it is an upper bound; `/usr/bin/time -v` alone reports only the largest single process (0.73 GB). The container's other memory use is the two tmpfs mounts (at most 2 GB when both are full).
- **Wall time on 3 dedicated vCPUs is a projection, not a measurement** (CPU time divided by the cores Chrome, the compositor and the encoder can keep busy): about 135 s at concurrency 1, about 80 s at 2, about 65 s at 3, for a 30 s export. The real figures come from `measure.mjs` on the deployed worker (below). The owner's rule "abort over 8 GB" was never near: the highest sampled total was 3.4 GB.
- This measurement used a clip with audio; `measure.mjs` makes a silent source on the worker itself (the worker can only run the export command), which is the same picture work without the audio track.

### Starting limits (proposed; changed only through a PR to `compose.yaml`, `server.mjs` and the settings below)

| Limit | Value | Why |
|---|---|---|
| CPU | `cpus: 3`, `cpu_shares: 256` | Production keeps priority when the machine is busy; an idle machine lets the worker use all 3. |
| Memory | `mem_limit: 8g`, no swap | 3.4 GB measured at concurrency 3 plus up to 2 GB of tmpfs leaves more than 2.5 GB spare. May be lowered to 6g after the first deployed measurement. |
| Parallel frames | `REMOTION_CONCURRENCY=2` | Concurrency 3 costs 0.4 GB more and, on 3 vCPUs shared with the encoder, gains little over 2 (the measurement cannot show it on a busy machine). Raise to 3 only if the deployed measurement shows a clear gain. |
| Longest export | `REMOTION_MAX_SECONDS=120` | The cutdowns are 6, 15 and 30 s; a 2-minute final is the longest we need. |
| Per-run deadline | 900 s (`LIMITS.maxTimeoutMs`) | A 120 s export is about 650 CPU-seconds, so about 11 minutes if the container is given one core; 15 minutes covers that, and a stuck render is killed. 30 s exports finish in 1 to 3 minutes. |
| Request deadline | 930 s (`LIMITS.runDeadlineMs`) | The run plus 30 s to answer. |
| Exports at once | 1 per worker | One session at a time; the app queues the rest (PR 3). |
| Per workspace (PR 3) | 1 running, 6 per hour | At 1 to 3 minutes per 30 s export one worker finishes 20 to 60 an hour, so six per workspace per hour leaves room for several workspaces. Platform settings, not prices. |
| Upload | 80 files, 200 MiB each, 600 MiB in all; output up to 2000 MiB | A 120 s 1080p MP4 is about 100 MB. A 60 s ProRes 422 HQ file (the longest allowed) is about 1.4 GB, so the sandbox tmpfs is 3072 MB: it holds a maximum upload and one such output. |

### Measure again on the deployed worker (advisor and owner)

Nothing here costs money (no engine, nothing stored). From the production app's terminal, paste the block below; it prints wall time and CPU time per worker. While it runs, the advisor runs on the server `docker stats --no-stream <worker>` every 5 seconds for the duration and notes the highest `MEM USAGE` and `CPU %`. Send the output and the two peaks to the lead, who sets the limits above in a small PR. Run it three times: once with `REMOTION_CONCURRENCY` as shipped (2), then, as a one-off compose PR each, with 1 and 3.

   ```sh
cat > /tmp/remotion-measure.mjs <<'EOF'
// Remotion worker measurement. Run in the production app's terminal (REMOTION_WORKER_URLS and
// REMOTION_WORKER_SECRETS, as for the smoke test). Costs nothing: no engine, no money, nothing stored.
// It makes its own 28 s 1080p source on the worker, then times the real export on it: that source
// with captions plus a 2 s end card = 30 s of 1080p. Prints wall time and CPU time per worker; the
// advisor reads peak memory from `docker stats` while it runs (README, Limits).
//   node /tmp/remotion-measure.mjs
import { randomUUID } from "node:crypto";

const list = (name) => (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const workers = list("REMOTION_WORKER_URLS");
const secrets = list("REMOTION_WORKER_SECRETS");
if (!workers.length || secrets.length !== workers.length || secrets.some((secret) => secret.length < 32)) {
  console.log("Needs REMOTION_WORKER_URLS and REMOTION_WORKER_SECRETS: comma lists of the same length, each secret at least 32 characters.");
  process.exit(2);
}
const ROOT = "/vercel/sandbox/remotion";
const COMMAND = { cmd: "/usr/local/bin/node", args: ["/opt/remotion/cli.mjs"] };
const SOURCE = { aspect: "16:9", fps: 30, scale: 1, durationSeconds: 28, label: "MEASURE" };
const CUES = Array.from({ length: 14 }, (_, i) => ({ startMs: i * 2000 + 200, endMs: i * 2000 + 1800, text: `Caption number ${i + 1} on the measurement cut` }));

async function call(base, secret, method, path, { json, body } = {}) {
  const headers = { authorization: `Bearer ${secret}` };
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(960_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { /* a file */ }
  return { status: res.status, data, bytes };
}

async function session(base, secret, work) {
  const name = `remotion-export-${randomUUID()}`;
  const created = await call(base, secret, "POST", "/v1/sessions", { json: { name } });
  if (created.status !== 201) throw new Error(`create answered ${created.status} ${JSON.stringify(created.data)}`);
  const path = `/v1/sessions/${name}`;
  try { return await work(path); } finally {
    const stopped = await call(base, secret, "DELETE", path);
    console.log(`  usage: ${JSON.stringify(stopped.data)}`);
  }
}
const put = async (base, secret, path, file, content) => {
  const res = await call(base, secret, "PUT", `${path}/files?path=${encodeURIComponent(`${ROOT}/${file}`)}`, { body: content });
  if (res.status !== 201) throw new Error(`upload ${file} answered ${res.status}`);
};
const run = (base, secret, path) => call(base, secret, "POST", `${path}/run`, { json: { ...COMMAND, timeoutMs: 900_000 } });

async function measure(base, secret) {
  // 1. The source: our own sample picture, 28 s at 1920x1080.
  const source = await session(base, secret, async (path) => {
    await put(base, secret, path, "spec.json", JSON.stringify({ version: 1, composition: "fixture-clip", props: SOURCE }));
    const made = await run(base, secret, path);
    if (made.data?.exitCode !== 0) throw new Error(`making the source failed (exit ${made.data?.exitCode}): ${made.data?.stderr?.slice(-1500)}`);
    const got = await call(base, secret, "GET", `${path}/files?path=${encodeURIComponent(`${ROOT}/output/export.mp4`)}`);
    if (got.status !== 200) throw new Error(`reading the source answered ${got.status}`);
    return got.bytes;
  });
  // 2. The measurement: that source, captioned, plus an end card.
  const spec = {
    version: 1,
    composition: "final",
    props: {
      aspect: "16:9",
      fps: 30,
      scale: 1,
      clips: [{ source: { file: "source.mp4", durationSeconds: 28, width: 1920, height: 1080, hasAudio: false }, cues: CUES, reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } }],
      captionStyle: "karaoke",
      end: { headline: "Measurement", callToAction: "Done", line: "30 s at 1080p", durationSeconds: 2 },
    },
  };
  return session(base, secret, async (path) => {
    await put(base, secret, path, "input/source.mp4", source);
    await put(base, secret, path, "spec.json", JSON.stringify(spec));
    const started = Date.now();
    const done = await run(base, secret, path);
    const seconds = (Date.now() - started) / 1000;
    if (done.data?.exitCode !== 0) throw new Error(`the export failed (exit ${done.data?.exitCode}) after ${seconds.toFixed(1)} s: ${done.data?.stderr?.slice(-1500)}`);
    const out = await call(base, secret, "GET", `${path}/files?path=${encodeURIComponent(`${ROOT}/output/export.mp4`)}`);
    return { seconds, bytes: out.bytes.length };
  });
}

let failed = 0;
for (const [index, base] of workers.entries()) {
  try {
    const { seconds, bytes } = await measure(base.replace(/\/$/, ""), secrets[index]);
    console.log(`OK   ${base}: 30 s 1080p export took ${seconds.toFixed(1)} s wall, output ${(bytes / 1048576).toFixed(1)} MiB (read activeCpuMs above; peak memory from docker stats)`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${base}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
EOF
node /tmp/remotion-measure.mjs
   ```


## Protocol (as implemented in `server.mjs`)

The Astra worker's session protocol (`ops/render-worker/README.md`, "Protocol"), with these differences. Every request needs `Authorization: Bearer $REMOTION_WORKER_SECRET` (constant-time compare; anything else gets `401` before routing). Bodies are JSON except file uploads and downloads. Errors are JSON `{"error": "..."}`.

| Request | Answer |
|---|---|
| `POST /v1/sessions` `{"name"}`, name `^remotion-export-[0-9a-f-]{36}$` | `201 {"name","status":"running"}`. Wipes `/vercel/sandbox` and `/tmp` first, creates `remotion/`, `remotion/input/`, `remotion/output/`. `409 {"busy":true}` while a session is running: **one export at a time**. `400` bad name. |
| `PUT /v1/sessions/:name/files?path=<abs>` raw body | `201 {"path","bytes"}`. `path` must normalise to a file strictly inside `/vercel/sandbox/remotion/` (no `.`/`..`, control character, backslash or symlink). At most 80 files, 200 MiB each, 600 MiB in total (a replaced file counts at its new size), else `413`. The app writes `spec.json` and `input/<relative path>` for every file the spec names. |
| `POST /v1/sessions/:name/run` `{"cmd","args","cwd"?,"timeoutMs"}` | Only `cmd: "/usr/local/bin/node"`, `args: ["/opt/remotion/cli.mjs"]`, `cwd` absent or `"/vercel/sandbox/remotion"`, `timeoutMs` an integer 1 to 900000, and no other keys; else `400`. Runs synchronously, then `200 {"exitCode","stdout","stderr","timedOut"}` (last 64 KiB of each). The environment is `PATH`, `HOME`, `TMPDIR=/tmp` and the worker's own tuning (`REMOTION_CONCURRENCY`, `REMOTION_MAX_SECONDS`, `REMOTION_BUNDLE_DIR`, `REMOTION_RUNTIME_DIR`): never a request's, never the secret. The whole process group is killed on timeout, on stop, if the caller disconnects, and when the run ends. A killed run answers `exitCode` 137. `409 {"busy":true}` while another run is going. |
| `GET /v1/sessions/:name/files?path=<abs>` | `200` with the bytes of a regular file inside `/vercel/sandbox/remotion/output/` (no symlinks). `404` if missing or the session is stopped; `400` outside `output/`; `413` over 2000 MiB. |
| `GET /v1/sessions/:name`, `DELETE /v1/sessions/:name` | As for Astra: `{"name","status","activeCpuMs","durationMs","egressBytes":0}`; DELETE stops, wipes, and is idempotent. |

**The export command** (`remotion/node/cli.ts`, built to `/opt/remotion/cli.mjs`): reads `spec.json` and `input/` in the session folder, writes `output/export.mp4` (H.264) or `output/export.mov` (ProRes, `spec.output.format`), `output/still-<frame>.png`, `output/subtitles.srt` and `output/subtitles.vtt` (when asked) and `output/result.json`. Exit codes: `0` done; `2` spec invalid or too long (a template that is not ours, unknown keys, a URL or `..` in a path); `3` an input file is missing, unreadable, or **not what the spec says it is**; `4` the render failed; `5` `silence_failed` (the silence detector could not read the file). Before it renders, `ffprobe` reads every video clip and music file in `input/`: a declared length that differs by more than 0.1 s, a different width or height (a 90 or 270 degree rotation tag is applied), a clip the request says has sound but has none (a clip the request does not use the sound of is simply muted), or a file that is not media is refused with exit 3 and a reason such as `input/clip.mp4: is 1280x720, the request says 1920x1080`. `result.json` carries the code and the reasons. Nothing is rendered from a declared value the file contradicts.

- **Timeouts:** headers 15 s, whole request received 300 s, keep-alive 5 s. The run exchange (request in, answer out) ends at 930 s whatever happens: the run is killed and the connection closed. A render may ask for at most 900 s.
- **Reaper:** a session idle for more than 240 s (no request, no run, no upload) or alive for more than 1,800 s is stopped and wiped.
- **Logs:** one line per request, `METHOD route status ms`, with the route pattern only (no names, paths, bodies or headers), plus `reaper stopped session (idle|age)`.
- **Between sessions** (create and stop): every other process of the worker user is killed and `/tmp` is emptied, so nothing from one export reaches the next.

## Known limits and open points

- **Same user for server and export.** The export runs as the same uid as the server, so code that broke out of Chrome could read its container's environment (`/proc/1/environ`), including this worker's secret. Only our own templates are rendered (no user code, props are validated and escaped by React), and the secret reaches only this worker. Fix later: a second uid (needs `CAP_SETUID`/`CAP_SETGID` back).
- **No licence key, no events to Remotion** (owner decision, 14 Oct 2026). The renderer is started with no `licenseKey`: server-side with no key it sends nothing, which the Free License allows, and the worker stays sealed (no internet). `tests/unit/remotionLicense.spec.ts` fails if a key, the licensing package or the usage endpoint appears in the code, or if a render call carries a key. Remotion is pinned to 4.x (the same test fails on any other major). Upgrading to Remotion 5.x needs the owner's approval first (NEEDS AKSHAY): 5.0 may require a licence key.
- **Fonts.** The typeface is bundled (Outfit, Latin and Latin Extended, SIL OFL). Other scripts fall back to Noto from the image (`fonts-noto-core`); CJK is not installed.
- **Not verified without Docker:** the image build, Chrome's library list on Debian bookworm (the build-time render fails the build if one is missing), tmpfs `uid`/`mode` options, that Coolify keeps `context: ../..` for a compose build, Coolify's handling of this compose file (network names, container names, the extra network; see the networking decision), and the cgroup path inside the container.
