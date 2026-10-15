// Relay check (README.md, "Verify", step 1b). Run in the render-relay container's terminal:
//
//   node /app/check-relay.mjs
//
// It checks, from the relay's side: its environment holds no secret, every worker it forwards to answers its
// own port with 401 (reachable and locked), and a port the relay must not listen on is closed. It ends with
// `RELAY CHECK: PASS` (exit 0) or `RELAY CHECK: FAIL ...` (exit 1).

import net from "node:net";
import { pathToFileURL } from "node:url";

const SECRETISH = /secret|token|password|passwd|credential|api_?key|auth/i;

/** Names in an environment that look like a secret (names only; never a value). */
export function secretNames(env) { return Object.keys(env).filter((name) => SECRETISH.test(name)); }

/** Judges the facts the checks collected. */
export function judge({ secretNames: names = [], workers = [], closed = [] }) {
  const failures = [];
  if (names.length) failures.push(`the relay's environment holds ${names.join(", ")}`);
  if (!workers.length) failures.push("no worker was checked");
  for (const worker of workers) if (worker.status !== 401) failures.push(`worker ${worker.n}: ${worker.status === null ? "unreachable" : `answered ${worker.status}, expected 401`}`);
  for (const port of closed) if (port.open) failures.push(`port ${port.port} is open on the relay`);
  return { ok: failures.length === 0, failures };
}

const open = (host, port, ms = 2000) => new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: ms });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});

async function main() {
  /* One worker: relay port 8081. */
  let status = null;
  try { status = (await fetch("http://127.0.0.1:8081/v1/sessions", { signal: AbortSignal.timeout(5000) })).status; } catch { /* unreachable */ }
  const workers = [{ n: 1, status }];
  const closed = [];
  /* Not the worker port, not the base port, not the ports of workers that do not exist, nothing else. */
  for (const port of [8790, 8080, 8082, 8083, 80, 22]) closed.push({ port, open: await open("127.0.0.1", port) });
  const verdict = judge({ secretNames: secretNames(process.env), workers, closed });
  for (const worker of workers) console.log(`worker ${worker.n}: ${worker.status ?? "unreachable"}`);
  for (const port of closed) console.log(`port ${port.port}: ${port.open ? "OPEN" : "closed"}`);
  console.log(verdict.ok ? "RELAY CHECK: PASS" : `RELAY CHECK: FAIL (${verdict.failures.join("; ")})`);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
