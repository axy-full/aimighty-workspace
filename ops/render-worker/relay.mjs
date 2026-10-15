// Astra render relay: a TCP forwarder with no secret and no brains.
//
// The render workers sit on an internal Docker network with no route out (compose.yaml). The production app lives
// on the platform's network, which does have one. The relay is the only service on both: it listens on one port per
// worker and passes each connection's bytes, unread, to that worker's port 8790 on the internal network, and back.
//
// What it does NOT do, by construction (tests/ops/render-relay.test.mjs pins each line):
//  - it holds no secret and reads no environment variable other than RELAY_WORKERS and RELAY_TARGET_1..3 (host names);
//  - it never looks inside a connection, so the workers' own `Authorization: Bearer` check still guards every request;
//  - it listens on exactly 8081..8080+N and connects to exactly the N fixed worker names, always on port 8790; no
//    other port, no other destination; a name that is asked for is never taken from a connection, only from the fixed list;
//  - it resolves nothing but those fixed names (the `lookup` function is called with no other name), and refuses to connect
//    to any address that is not private (RFC 1918, loopback): a missing worker looked up upstream is never connected to;
//  - a worker that is down or slow gets the client's connection closed, nothing else, and the relay keeps serving.

import { lookup as systemLookup } from "node:dns";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const WORKER_PORT = 8790;
export const BASE_PORT = 8080; // relay port for worker N is BASE_PORT + N: 8081, 8082, 8083
export const MAX_WORKERS = 3;
export const DEFAULT_WORKERS = 1;
export const DEFAULT_TARGETS = ["render-1", "render-2", "render-3"];
export const LIMITS = { connectMs: 5_000, idleMs: 200_000, perPort: 16 };
/* A worker is called render-1, render-2 or render-3, optionally with the platform's own suffix (render-1-abc123). Nothing else: not a number (16843009 and 0x1010101 are 1.1.1.1), not a dotted name. */
const NAME = /^render-[1-3](?:-[a-z0-9]+)?$/;

/** Only private (RFC 1918, loopback, IPv6 unique-local) addresses are ever connected to: a name that resolves anywhere else (a missing worker looked up upstream) is refused. */
export function privateAddress(address) {
  if (typeof address !== "string") return false;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(address)) return address === "::1" || /^f[cd][0-9a-f]{2}:/i.test(address);
  return false;
}
export const guardedLookup = (inner) => (hostname, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options;
  inner(hostname, opts, (error, address, family) => {
    if (error) return done(error);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!list.length || !list.every((entry) => privateAddress(entry.address))) return done(Object.assign(new Error("not a private address"), { code: "ERELAY_ADDR" }));
    return Array.isArray(address) ? done(null, address) : done(null, address, family);
  });
};

/** The routes for `workers` workers (1 to 3) and the fixed names to forward to. Throws on anything else. */
export function routesFor({ workers = DEFAULT_WORKERS, targets = DEFAULT_TARGETS } = {}) {
  if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) throw new Error(`RELAY_WORKERS must be a whole number from 1 to ${MAX_WORKERS}.`);
  if (!Array.isArray(targets) || targets.length < workers) throw new Error("A target name is needed for every worker.");
  return targets.slice(0, workers).map((host, index) => {
    if (typeof host !== "string" || !NAME.test(host)) throw new Error(`Target ${index + 1} is not a worker container name (render-1 to render-3, with the platform's suffix if it adds one).`);
    return { listenPort: BASE_PORT + index + 1, host, port: WORKER_PORT };
  });
}

/**
 * Listens on every route's port (on `listenHost`; `listenPorts` lets a test use free ports) and forwards to its worker.
 * `lookup` is Node's `net` lookup hook: only the fixed names go through it. Returns the bound ports and a `close`.
 */
export async function createRelay({ routes, listenHost = "0.0.0.0", listenPorts, lookup, log = () => {}, limits = LIMITS } = {}) {
  if (!Array.isArray(routes) || !routes.length || routes.length > MAX_WORKERS) throw new Error("The relay needs 1 to 3 routes.");
  const servers = [];
  const sockets = new Set();
  for (const [index, route] of routes.entries()) {
    if (route.port !== WORKER_PORT || !NAME.test(route.host)) throw new Error("A route may only go to a fixed worker name on port 8790.");
    let open = 0;
    const server = net.createServer({ pauseOnConnect: true }, (client) => {
      if (open >= limits.perPort) { client.destroy(); log(`worker ${index + 1}: busy, connection refused`); return; }
      open++;
      sockets.add(client);
      const upstream = net.connect({ host: route.host, port: route.port, lookup: guardedLookup(lookup ?? systemLookup), timeout: limits.connectMs });
      sockets.add(upstream);
      let connected = false;
      const end = () => { client.destroy(); upstream.destroy(); };
      upstream.once("connect", () => {
        connected = true;
        upstream.setTimeout(limits.idleMs); client.setTimeout(limits.idleMs);
        client.pipe(upstream); upstream.pipe(client);
        client.resume();
      });
      /* Down, slow or refused: a clean close for the client, one log line with the worker's number only. */
      upstream.once("timeout", () => { if (!connected) log(`worker ${index + 1}: did not answer`); end(); });
      upstream.once("error", (error) => { if (!connected) log(`worker ${index + 1}: unreachable (${error.code ?? "error"})`); end(); });
      client.once("error", end);
      upstream.once("close", end);
      client.once("close", () => { open--; sockets.delete(client); sockets.delete(upstream); end(); });
      client.on("timeout", end); upstream.on("timeout", () => { if (connected) end(); });
    });
    server.on("error", (error) => log(`relay port ${route.listenPort}: ${error.code ?? "error"}`));
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(listenPorts?.[index] ?? route.listenPort, listenHost, () => { server.off("error", reject); resolve(); }); });
    servers.push(server);
  }
  return {
    ports: servers.map((server) => server.address().port),
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
    },
  };
}

/** What the container reads: the worker count and, optionally, the names of the workers (never a secret). */
export function configFromEnv(env = process.env) {
  const workers = env.RELAY_WORKERS === undefined || env.RELAY_WORKERS === "" ? DEFAULT_WORKERS : Number(env.RELAY_WORKERS);
  const targets = [1, 2, 3].map((n) => env[`RELAY_TARGET_${n}`] || DEFAULT_TARGETS[n - 1]);
  return routesFor({ workers, targets });
}

async function main() {
  const routes = configFromEnv();
  const relay = await createRelay({ routes, log: (line) => console.log(line) });
  console.log(`render relay: ${routes.map((route, index) => `${relay.ports[index]} -> worker ${index + 1}`).join(", ")}`);
  const stop = () => { relay.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`render relay failed to start: ${error?.code ?? error?.message ?? "error"}`); process.exit(1); });
}
