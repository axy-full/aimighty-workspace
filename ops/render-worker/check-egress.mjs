// Egress gate (README.md, "Verify", step 1). Run in a worker's terminal while no render is running:
//
//   node /app/check-egress.mjs --option c --app <production app container name>:3000
//
// It tries to resolve a public name, to open connections out, and to reach the HOST (the render-internal network's gateway
// and host.docker.internal), prints one line per probe, and ends with `EGRESS GATE: PASS` (exit 0) or
// `EGRESS GATE: FAIL ...` (exit 1). NO REAL RENDER until it passes on every worker, and again after every change to the
// stack, a firewall change, a Docker Engine upgrade or a reboot.
//
// Lines, each exactly once:
//   blocked dns CODE | RESOLVED example.com ADDR                      a name that resolves is a way out, even with no route
//   blocked URL CODE | REACHED URL STATUS                             https://example.com, http://1.1.1.1 (and the app)
//   blocked host.docker.internal CODE | RESOLVED host.docker.internal ADDR
//   blocked host:IP:PORT CODE | REACHED host:IP:PORT CODE             IP = the gateway of each network this container is on
//   clean env | LEAK env NAME                                         no ASTRA_WORKER_SECRET_<N> name in the worker's own environment
// Expectations: everything `blocked`/`clean`, except the app line: (a) `REACHED` (the app is on render-internal), (b) and (c)
// `blocked` (in (c) only the relay is on both networks). A connection the HOST refuses (ECONNREFUSED) counts as REACHED: the
// host answered, so a route to it exists. Any other `REACHED`/`RESOLVED`/`LEAK`, any missing, repeated, extra or unreadable
// line, or no output at all, is a FAIL. `--from-stdin` only judges pasted lines (how tests/ops/render-egress.test.mjs checks
// this logic against canned outputs) and says `JUDGED (not probed)`; it is never a pass of the gate.

import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import { pathToFileURL } from "node:url";

export const OPTIONS = { a: { app: "REACHED" }, b: { app: "blocked" }, c: { app: "blocked" } };
export const INTERNET = ["https://example.com", "http://1.1.1.1"];
export const HOST_PORTS = [22, 80, 443, 3000, 8000, 6001, 6002, 8080];
const HOST_NAME = "host.docker.internal";

const toInt = (ip) => ip.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** The gateway (network address + 1) of every IPv4 network the container is on, from its interfaces. */
export function gatewaysOf(interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const entries of Object.values(interfaces ?? {})) for (const entry of entries ?? []) {
    if ((entry.family !== "IPv4" && entry.family !== 4) || entry.internal || !entry.address || !entry.netmask) continue;
    const network = (toInt(entry.address) & toInt(entry.netmask)) >>> 0;
    out.add(toIp((network + 1) >>> 0));
  }
  return [...out];
}

/** A TCP connect: `REACHED` on a connection or on a refusal (the host answered), `blocked` on silence or no route. */
export function tcpProbe(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port, timeout: timeoutMs });
    socket.once("connect", () => { socket.destroy(); resolve(`REACHED host:${ip}:${port} CONNECTED`); });
    socket.once("timeout", () => { socket.destroy(); resolve(`blocked host:${ip}:${port} ETIMEDOUT`); });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED" ? `REACHED host:${ip}:${port} ECONNREFUSED` : `blocked host:${ip}:${port} ${error.code ?? "error"}`));
  });
}

/** The probes, as printed lines. Every dependency is injectable so tests run with none of the network. */
export async function probe({ app, lookup = (name) => dns.promises.lookup(name), fetcher = fetch, timeoutMs = 5000, interfaces, tcp = tcpProbe, env = process.env } = {}) {
  const lines = [];
  try { const found = await lookup("example.com"); lines.push(`RESOLVED example.com ${found?.address ?? found}`); }
  catch (error) { lines.push(`blocked dns ${error?.code ?? error?.name ?? "error"}`); }
  for (const url of [...INTERNET, `http://${app}`]) {
    try { const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) }); lines.push(`REACHED ${url} ${res.status}`); }
    catch (error) { lines.push(`blocked ${url} ${error?.cause?.code ?? error?.name ?? "error"}`); }
  }
  try { const found = await lookup(HOST_NAME); lines.push(`RESOLVED ${HOST_NAME} ${found?.address ?? found}`); }
  catch (error) { lines.push(`blocked ${HOST_NAME} ${error?.code ?? error?.name ?? "error"}`); }
  for (const ip of gatewaysOf(interfaces)) for (const port of HOST_PORTS) lines.push(await tcp(ip, port));
  const named = Object.keys(env).filter((name) => /^ASTRA_WORKER_SECRET/i.test(name));
  lines.push(named.length ? named.map((name) => `LEAK env ${name}`).join("\n") : "clean env");
  return lines.flatMap((line) => line.split("\n"));
}

const escape = (text) => text.replace(/[.]/g, "\\.");

/** Judges printed lines for an option. Never throws; anything not expected, missing, repeated or unreadable is a failure. */
export function judge(lines, option, app) {
  const failures = [];
  const expected = OPTIONS[option];
  if (!expected) return { ok: false, failures: [`unknown option ${JSON.stringify(option)} (a, b or c)`] };
  const clean = (Array.isArray(lines) ? lines : []).map((line) => String(line).trim()).filter(Boolean);
  const seen = new Map();
  const take = (key, line) => { (seen.get(key) ?? seen.set(key, []).get(key)).push(line); };
  let appUrl = null;
  for (const line of clean) {
    let m;
    if ((m = /^(blocked dns \S+|RESOLVED example\.com \S+)$/.exec(line))) take("dns", line);
    else if ((m = new RegExp(`^(blocked|REACHED) (${INTERNET.map(escape).join("|")}) \\S+$`).exec(line))) take(`url ${m[2]}`, line);
    else if ((m = new RegExp(`^(blocked|RESOLVED) ${escape(HOST_NAME)} \\S+$`).exec(line))) take("hostname", line);
    else if ((m = /^(blocked|REACHED) host:(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5}) \S+$/.exec(line))) take(`host ${m[2]}:${m[3]}`, line);
    else if (/^(clean env|LEAK env \S+)$/.test(line)) take("env", line);
    else if ((m = /^(blocked|REACHED) (http:\/\/[A-Za-z0-9.-]+:\d{2,5}) \S+$/.exec(line))) { take(`app ${m[2]}`, line); appUrl = appUrl ?? m[2]; }
    else failures.push(`unrecognised or unexpected line: ${line.slice(0, 80)}`);
  }
  const once = (key, label) => {
    const got = seen.get(key) ?? [];
    if (got.length !== 1) failures.push(`the ${label} line is missing or repeated`);
    return got[0];
  };
  const dnsLine = once("dns", "DNS");
  if (dnsLine && !/^blocked dns \S+$/.test(dnsLine)) failures.push(`DNS: ${dnsLine}`);
  for (const url of INTERNET) { const line = once(`url ${url}`, url); if (line && !line.startsWith("blocked ")) failures.push(`internet: ${line}`); }
  const hostName = once("hostname", HOST_NAME);
  if (hostName && !hostName.startsWith("blocked ")) failures.push(`host name: ${hostName}`);
  const envLine = once("env", "environment");
  if (envLine && envLine !== "clean env") failures.push(`environment: ${envLine} (a worker holds no ASTRA_WORKER_SECRET_<N> name beyond its own variable, which the server clears)`);
  /* The host: every gateway that was probed has all of its ports, each blocked; at least one gateway must have been probed. */
  const gateways = new Map();
  for (const key of seen.keys()) if (key.startsWith("host ")) { const [ip, port] = key.slice(5).split(":"); (gateways.get(ip) ?? gateways.set(ip, []).get(ip)).push(Number(port)); }
  if (!gateways.size) failures.push("no host (gateway) probe was made: the container has no network interface to derive it from");
  for (const [ip, ports] of gateways) {
    for (const port of HOST_PORTS) if (!ports.includes(port)) failures.push(`host ${ip}: port ${port} was not probed`);
    for (const port of ports) {
      if (!HOST_PORTS.includes(port)) failures.push(`host ${ip}: unexpected port ${port}`);
      const line = (seen.get(`host ${ip}:${port}`) ?? [])[0];
      if (line && !line.startsWith("blocked ")) failures.push(`host: ${line}${/ECONNREFUSED$/.test(line) ? " (a refusal means the host answered)" : ""}`);
      if ((seen.get(`host ${ip}:${port}`) ?? []).length > 1) failures.push(`host ${ip}:${port} is repeated`);
    }
  }
  /* The app: exactly one, and only (a) may reach it. Any other REACHED or RESOLVED was already a failure above or is not an expected line. */
  const appKeys = [...seen.keys()].filter((key) => key.startsWith("app "));
  if (appKeys.length !== 1 || seen.get(appKeys[0]).length !== 1) failures.push("the app line is missing or repeated");
  else {
    const line = seen.get(appKeys[0])[0];
    if (expected.app === "REACHED" ? !/^REACHED \S+ \d{3}$/.test(line) : !line.startsWith("blocked "))
      failures.push(`app: ${line} (option ${option} expects ${expected.app})`);
    if (app && appKeys[0] !== `app http://${app}`) failures.push("the app line is not for the app that was named");
  }
  return { ok: failures.length === 0, failures };
}

const parse = (argv) => {
  const out = { option: "", app: "", stdin: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--option") out.option = argv[++i] ?? "";
    else if (argv[i] === "--app") out.app = argv[++i] ?? "";
    else if (argv[i] === "--from-stdin") out.stdin = true;
  }
  return out;
};

async function main() {
  const args = parse(process.argv.slice(2));
  if (!OPTIONS[args.option]) { console.log("EGRESS GATE: FAIL (give --option a, b or c)"); process.exit(1); }
  let lines;
  if (args.stdin) {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    lines = Buffer.concat(chunks).toString("utf8").split("\n");
  } else {
    if (!/^[a-z0-9][a-z0-9.-]*:\d{2,5}$/i.test(args.app)) { console.log("EGRESS GATE: FAIL (give --app <production app container name>:3000)"); process.exit(1); }
    lines = await probe({ app: args.app });
    for (const line of lines) console.log(line);
  }
  const verdict = judge(lines, args.option, args.stdin ? "" : args.app);
  const label = args.stdin ? "JUDGED (not probed)" : "EGRESS GATE";
  if (verdict.ok) { console.log(args.stdin ? "JUDGED (not probed): lines are acceptable; this is not a pass of the gate" : "EGRESS GATE: PASS"); process.exit(0); }
  console.log(`${label}: FAIL (${verdict.failures.join("; ")}). No render until this passes.`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
