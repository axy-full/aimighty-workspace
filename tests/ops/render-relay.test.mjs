import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRelay, routesFor, configFromEnv, WORKER_PORT, BASE_PORT } from "../../ops/render-worker/relay.mjs";

// The relay (ops/render-worker/relay.mjs) against fake TCP "workers" on loopback addresses; and a static read of
// compose.yaml and the Dockerfile. No Docker, no network beyond 127.0.0.0/8.

const dir = (name) => fileURLToPath(new URL(`../../ops/render-worker/${name}`, import.meta.url));
const read = (name) => readFileSync(dir(name), "utf8");
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

/** A fake worker: answers every connection with `worker-<n>:` and then echoes what it was sent. */
async function fakeWorker(n, address) {
  const seen = { connections: 0, received: [] };
  const server = net.createServer((socket) => {
    seen.connections++;
    socket.write(`worker-${n}:`);
    socket.on("data", (data) => { seen.received.push(data.toString("latin1")); socket.write(data); });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(WORKER_PORT, address, resolve); });
  return { seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/** Sends `text` to a port and collects everything until the peer closes (or `ms` pass). */
function talk(port, text, ms = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let got = "", refused = false;
    const done = () => { clearTimeout(timer); socket.destroy(); resolve({ got, refused }); };
    const timer = setTimeout(done, ms);
    socket.on("connect", () => { if (text !== null) socket.write(text); });
    socket.on("data", (data) => { got += data.toString("latin1"); });
    socket.on("error", (error) => { refused = error.code === "ECONNREFUSED"; });
    socket.on("close", done);
  });
}

const ADDRESS = { "render-1": "127.0.0.2", "render-2": "127.0.0.3", "render-3": "127.0.0.4" };
function recordingLookup(map = ADDRESS) {
  const asked = [];
  const lookup = (hostname, options, callback) => {
    asked.push(hostname);
    const address = map[hostname];
    if (!address) return callback(Object.assign(new Error("not a worker"), { code: "ENOTFOUND" }));
    return options?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4);
  };
  return { lookup, asked };
}

test("one worker is the default: relay port 8081 to render-1:8790; two or three workers add 8082 and 8083; nothing else", () => {
  assert.deepEqual(routesFor(), [{ listenPort: 8081, host: "render-1", port: 8790 }]);
  assert.deepEqual(configFromEnv({}), [{ listenPort: 8081, host: "render-1", port: 8790 }]);
  assert.deepEqual(configFromEnv({ RELAY_WORKERS: "3" }).map((r) => [r.listenPort, r.host, r.port]), [[8081, "render-1", 8790], [8082, "render-2", 8790], [8083, "render-3", 8790]]);
  assert.equal(BASE_PORT, 8080);
  for (const bad of [0, 4, -1, 1.5, "2x", NaN]) assert.throws(() => routesFor({ workers: bad }), /1 to 3/, String(bad));
  for (const host of ["../x", "a.b", "1.1.1.1", "a_b", "", "UPPER", "x".repeat(64), "-a", "a b"]) assert.throws(() => routesFor({ workers: 1, targets: [host, "render-2", "render-3"] }), /plain container name/, JSON.stringify(host));
  /* Environment other than RELAY_* is not read: a secret in it changes nothing. */
  assert.deepEqual(configFromEnv({ ASTRA_WORKER_SECRET_1: "s".repeat(40), RELAY_WORKERS: "2", ASTRA_WORKER_COUNT: "3" }).map((r) => r.listenPort), [8081, 8082]);
});

test("each relay port reaches only its own worker, and the bytes pass untouched both ways (the workers' bearer check still decides)", async () => {
  const workers = [await fakeWorker(1, "127.0.0.2"), await fakeWorker(2, "127.0.0.3"), await fakeWorker(3, "127.0.0.4")];
  const { lookup, asked } = recordingLookup();
  const relay = await createRelay({ routes: routesFor({ workers: 3 }), listenHost: "127.0.0.1", listenPorts: [0, 0, 0], lookup });
  try {
    const request = "GET /v1/sessions HTTP/1.1\r\nAuthorization: Bearer not-a-real-secret\r\n\r\n";
    for (const [index, port] of relay.ports.entries()) {
      const { got } = await talk(port, request);
      assert.ok(got.startsWith(`worker-${index + 1}:`), `port ${index + 1} answered ${JSON.stringify(got.slice(0, 20))}`);
      assert.ok(got.endsWith(request), "the request came back byte for byte");
    }
    assert.deepEqual(workers.map((w) => w.seen.connections), [1, 1, 1], "each worker was reached once, by its own port");
    assert.deepEqual(workers.map((w) => w.seen.received.join("")), [request, request, request]);
    assert.deepEqual([...new Set(asked)].sort(), ["render-1", "render-2", "render-3"], "only the fixed worker names were resolved");
  } finally { await relay.close(); for (const worker of workers) await worker.close(); }
});

test("with one worker the relay listens on one port and forwards to nothing else; a request that names another place goes to the worker as plain bytes", async () => {
  const worker = await fakeWorker(1, "127.0.0.2");
  const evil = net.createServer((socket) => { evilHits++; socket.destroy(); });
  let evilHits = 0;
  await new Promise((resolve) => evil.listen(0, "127.0.0.1", resolve));
  const { lookup, asked } = recordingLookup({ ...ADDRESS, "evil.example": "127.0.0.1" });
  const relay = await createRelay({ routes: routesFor({ workers: 1 }), listenHost: "127.0.0.1", listenPorts: [0], lookup });
  try {
    assert.equal(relay.ports.length, 1);
    /* No other port: the next port up, and the worker's own port, on the relay's address, are closed. */
    for (const port of [relay.ports[0] + 1, relay.ports[0] - 1]) assert.equal((await talk(port, "x", 500)).refused, true, `port ${port}`);
    /* A proxy-style request, a CONNECT, a Host for another name and a raw name: none is an instruction to the relay. */
    for (const attack of ["CONNECT evil.example:80 HTTP/1.1\r\nHost: evil.example\r\n\r\n", `GET http://127.0.0.1:${evil.address().port}/ HTTP/1.1\r\nHost: evil.example\r\n\r\n`, "\x05\x01\x00", "evil.example:80\n"]) {
      const { got } = await talk(relay.ports[0], attack);
      assert.ok(got.startsWith("worker-1:") && got.endsWith(attack), "it reached the worker as plain bytes");
    }
    assert.equal(evilHits, 0, "nothing else was ever connected to");
    assert.deepEqual([...new Set(asked)], ["render-1"], "no name but the fixed worker's was resolved");
  } finally { await relay.close(); await worker.close(); await new Promise((resolve) => evil.close(resolve)); }
});

test("a route may only go to a plain worker name on port 8790; the relay needs one to three", async () => {
  await assert.rejects(createRelay({ routes: [{ listenPort: 8081, host: "render-1", port: 22 }], listenHost: "127.0.0.1", listenPorts: [0] }), /fixed worker name on port 8790/);
  await assert.rejects(createRelay({ routes: [{ listenPort: 8081, host: "example.com", port: 8790 }], listenHost: "127.0.0.1", listenPorts: [0] }), /fixed worker name on port 8790/);
  await assert.rejects(createRelay({ routes: [], listenHost: "127.0.0.1" }), /1 to 3 routes/);
  await assert.rejects(createRelay({ routes: [1, 2, 3, 4].map((n) => ({ listenPort: 8080 + n, host: `render-${n}`, port: 8790 })), listenHost: "127.0.0.1" }), /1 to 3 routes/);
});

test("a worker that is down is a clean close for that caller; the relay keeps serving and picks the worker up when it returns", async () => {
  const { lookup } = recordingLookup();
  const lines = [];
  const relay = await createRelay({ routes: routesFor({ workers: 2 }), listenHost: "127.0.0.1", listenPorts: [0, 0], lookup, log: (line) => lines.push(line) });
  try {
    const down = await talk(relay.ports[0], "hello");
    assert.equal(down.got, "", "nothing came back");
    assert.equal(down.refused, false, "the relay itself accepted and then closed cleanly");
    assert.ok(lines.some((line) => /worker 1: unreachable/.test(line)), JSON.stringify(lines));
    assert.ok(lines.every((line) => !/hello|127\.0\.0|render-/.test(line)), "the log names a worker by number only");
    const worker = await fakeWorker(1, "127.0.0.2");
    try { assert.ok((await talk(relay.ports[0], "again")).got.startsWith("worker-1:")); } finally { await worker.close(); }
    /* The other port never depended on this worker. */
    const second = await fakeWorker(2, "127.0.0.3");
    try { assert.ok((await talk(relay.ports[1], "two")).got.startsWith("worker-2:")); } finally { await second.close(); }
  } finally { await relay.close(); }
});

test("a port cannot be flooded: past the limit new connections are closed at once", async () => {
  const worker = await fakeWorker(1, "127.0.0.2");
  const { lookup } = recordingLookup();
  const relay = await createRelay({ routes: routesFor({ workers: 1 }), listenHost: "127.0.0.1", listenPorts: [0], lookup, limits: { connectMs: 1000, idleMs: 5000, perPort: 2 } });
  const held = [];
  try {
    for (let i = 0; i < 2; i++) { const s = net.connect({ host: "127.0.0.1", port: relay.ports[0] }); s.on("error", () => {}); held.push(s); await new Promise((r) => s.once("data", r)); }
    const third = await talk(relay.ports[0], "x", 800);
    assert.equal(third.got, "", "the third connection got nothing");
  } finally { for (const s of held) s.destroy(); await relay.close(); await worker.close(); }
});

test("the relay holds no secret and reads none: its code names no secret, token or bearer, reads no environment but its own two settings, and never opens a socket from data it was sent", () => {
  const code = stripComments(read("relay.mjs"));
  assert.doesNotMatch(code, /secret|token|bearer|authorization|password/i);
  assert.deepEqual([...code.matchAll(/process\.env\b[^\n]*/g)].map((m) => m[0].trim().slice(0, 40)), ["process.env) {"], "process.env appears once, as configFromEnv's default argument");
  assert.deepEqual([...new Set([...code.matchAll(/env\.([A-Za-z_]+)|env\[`([A-Za-z_{}$]+)`\]/g)].map((m) => m[1] ?? m[2]))].sort(), ["RELAY_TARGET_${n}", "RELAY_WORKERS"].sort());
  assert.doesNotMatch(code, /\.on\(\s*["']data["']/, "it never reads a connection's bytes");
  assert.doesNotMatch(code, /dns\.|resolve4|resolve6|\.lookup\(/, "it does no lookups of its own");
  assert.equal([...code.matchAll(/net\.connect\(/g)].length, 1, "one place connects, to the fixed route");
  assert.match(code, /net\.connect\(\{ host: route\.host, port: route\.port/);
});

/* ── compose.yaml and the Dockerfile, read as structure ─────────────────────────────────────────────────────────────────────────── */

/** A reader for the small YAML subset compose.yaml uses: nested maps, `- scalar` lists, `[a, b]` flow lists, plain and quoted scalars, comments. */
function parseYaml(text) {
  const rows = [];
  for (const raw of text.split("\n")) {
    let line = raw, quote = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c;
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) { line = line.slice(0, i); break; }
    }
    if (!line.trim()) continue;
    rows.push({ indent: line.length - line.trimStart().length, text: line.trim() });
  }
  const scalar = (value) => {
    const v = value.trim();
    if (v.startsWith("[")) {
      const items = []; let item = "", quote = "";
      for (const c of v.slice(1, -1)) {
        if (quote) { item += c; if (c === quote) quote = ""; } else if (c === '"' || c === "'") { quote = c; item += c; } else if (c === ",") { items.push(item); item = ""; } else item += c;
      }
      items.push(item);
      return items.map((s) => scalar(s)).filter((s) => s !== "");
    }
    if (/^".*"$|^'.*'$/.test(v)) return v.slice(1, -1);
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };
  let at = 0;
  function block(indent) {
    const out = rows[at]?.text.startsWith("- ") ? [] : {};
    while (at < rows.length && rows[at].indent === indent) {
      const { text } = rows[at];
      if (Array.isArray(out)) { assert.ok(text.startsWith("- "), `list item expected: ${text}`); out.push(scalar(text.slice(2))); at++; continue; }
      const match = /^([^:\s][^:]*?):(?:\s+(.*))?$/.exec(text);
      assert.ok(match, `unreadable line: ${text}`);
      at++;
      if (match[2] !== undefined && match[2] !== "") out[match[1]] = scalar(match[2]);
      else if (at < rows.length && rows[at].indent > indent) out[match[1]] = block(rows[at].indent);
      else out[match[1]] = "";
    }
    return out;
  }
  return block(0);
}

const compose = parseYaml(read("compose.yaml"));
const workers = ["render-1", "render-2", "render-3"].map((name) => [name, compose.services[name]]);
const relay = compose.services["render-relay"];
const defaultOf = (expression) => /\$\{[A-Z0-9_]+:-([^}]*)\}/.exec(expression)?.[1];

test("compose.yaml: exactly the three workers and the relay, one network declared, internal, with no gateway", () => {
  assert.deepEqual(Object.keys(compose).sort(), ["networks", "services"], "no anchors, no volumes, nothing else at the top");
  assert.deepEqual(Object.keys(compose.services).sort(), ["render-1", "render-2", "render-3", "render-relay"]);
  assert.deepEqual(compose.networks, { "render-internal": { name: "render-internal", internal: true } });
});

test("compose.yaml: workers are on render-internal only (network_mode), publish nothing, and carry the limits", () => {
  for (const [name, worker] of workers) {
    assert.equal(worker.network_mode, "render-internal", name);
    for (const key of ["networks", "ports", "expose", "extra_hosts", "dns", "privileged", "cap_add", "devices", "volumes", "user", "pid", "ipc", "sysctls"]) assert.equal(worker[key], undefined, `${name} has no ${key}`);
    assert.equal(worker.cpus, 2, name); assert.equal(worker.cpu_shares, 256, name);
    assert.equal(worker.mem_limit, "4g", name); assert.equal(worker.memswap_limit, "4g", name);
    assert.equal(worker.pids_limit, 256, name); assert.equal(worker.read_only, true, name);
    assert.deepEqual(worker.cap_drop, ["ALL"], name); assert.deepEqual(worker.security_opt, ["no-new-privileges:true"], name);
    assert.equal(worker.tmpfs.length, 2, name);
    assert.ok(worker.tmpfs.every((entry) => /uid=10001,gid=10001/.test(entry)), name);
    assert.equal(worker.container_name, name);
    assert.deepEqual(worker.depends_on, ["render-relay"], `${name}: the relay's network creates render-internal first`);
    assert.deepEqual(Object.keys(worker.environment), ["ASTRA_WORKER_SECRET"], `${name}: one variable, its own secret`);
  }
  /* render-1 cannot start without its secret; each worker reads its own variable. */
  assert.match(compose.services["render-1"].environment.ASTRA_WORKER_SECRET, /^\$\{ASTRA_WORKER_SECRET_1:\?/);
  assert.match(compose.services["render-2"].environment.ASTRA_WORKER_SECRET, /^\$\{ASTRA_WORKER_SECRET_2:-\}$/);
  assert.match(compose.services["render-3"].environment.ASTRA_WORKER_SECRET, /^\$\{ASTRA_WORKER_SECRET_3:-\}$/);
});

test("compose.yaml: one worker by default; two and three start only under their profiles", () => {
  assert.equal(compose.services["render-1"].profiles, undefined);
  assert.deepEqual(compose.services["render-2"].profiles, ["workers-2", "workers-3"]);
  assert.deepEqual(compose.services["render-3"].profiles, ["workers-3"]);
  assert.equal(defaultOf(relay.environment.RELAY_WORKERS), "1", "the relay forwards to one worker unless told otherwise");
});

test("compose.yaml: the default worker is pinned to cores 6,7 of the 8-core server; every default core exists there; the cpusets are settings", () => {
  const cpusets = workers.map(([, worker]) => worker.cpuset);
  assert.deepEqual(cpusets.map((c) => /^\$\{(RENDER_CPUSET_[123]):-/.exec(c)?.[1]), ["RENDER_CPUSET_1", "RENDER_CPUSET_2", "RENDER_CPUSET_3"]);
  assert.equal(defaultOf(cpusets[0]), "6,7");
  const cores = cpusets.flatMap((c) => defaultOf(c).split(",").map(Number));
  assert.ok(cores.every((core) => core >= 0 && core <= 7), `every default core is on an 8-core machine: ${cores}`);
  assert.equal(new Set(cores).size, cores.length, "no two workers share a core");
  assert.ok(![0, 1, 2, 3, 4, 5].some((core) => defaultOf(cpusets[0]).split(",").map(Number).includes(core)), "the default worker leaves cores 0-5 to production");
});

test("compose.yaml: the relay is on render-internal only here (the app's network comes from Connect To Predefined Network), publishes nothing, holds no secret, and is locked down", () => {
  assert.deepEqual(relay.networks, ["render-internal"]);
  for (const key of ["network_mode", "ports", "expose", "volumes", "extra_hosts", "dns", "privileged", "cap_add", "devices", "user"]) assert.equal(relay[key], undefined, `the relay has no ${key}`);
  assert.deepEqual(relay.command, ["node", "/app/relay.mjs"]);
  assert.deepEqual(Object.keys(relay.environment).sort(), ["RELAY_TARGET_1", "RELAY_TARGET_2", "RELAY_TARGET_3", "RELAY_WORKERS"]);
  assert.deepEqual([relay.environment.RELAY_TARGET_1, relay.environment.RELAY_TARGET_2, relay.environment.RELAY_TARGET_3], ["render-1", "render-2", "render-3"]);
  assert.ok(Object.keys(relay.environment).every((name) => !/secret|token|key|password|auth/i.test(name)));
  assert.ok(Object.values(relay.environment).every((value) => !/\$\{ASTRA_WORKER_SECRET/.test(String(value))));
  assert.equal(relay.read_only, true); assert.deepEqual(relay.cap_drop, ["ALL"]); assert.deepEqual(relay.security_opt, ["no-new-privileges:true"]);
  assert.ok(relay.mem_limit === "128m" && relay.pids_limit === 64 && relay.cpus === 0.25);
  assert.equal(relay.healthcheck.test.at(-1).includes("8081"), true);
});

test("the Dockerfile: the relay runs from the worker's image as the same non-root user, with its code and the two checks copied in and no secret baked in", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /^USER 10001:10001$/m);
  for (const file of ["server.mjs", "relay.mjs", "check-egress.mjs", "check-relay.mjs"]) assert.match(dockerfile, new RegExp(`^COPY ${file.replace(".", "\\.")} /app/${file.replace(".", "\\.")}$`, "m"), file);
  assert.doesNotMatch(dockerfile, /^(ENV|ARG)\s+\S*(SECRET|TOKEN|PASSWORD)/im);
  assert.doesNotMatch(dockerfile, /EXPOSE\s+(?!8790\b)/);
});
