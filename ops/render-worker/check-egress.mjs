// Egress gate (README.md, "Verify", step 1). Run in a worker's terminal while no render is running:
//
//   node /app/check-egress.mjs --option c --app <production app container name>:3000
//
// It tries to resolve a public name and to open connections out, prints one line per probe, and ends with
// `EGRESS GATE: PASS` (exit 0) or `EGRESS GATE: FAIL ...` (exit 1). NO REAL RENDER until it passes on every worker,
// and again after every change to the stack or the firewall.
//
// Expectations, by networking option:
//   dns line          : `blocked dns <code>`            in every option (a name that resolves is a way out, even with no route)
//   the two internet  : `blocked <url> <code>`          in every option
//   the app line      : (a) `REACHED` (the app is on render-internal), (b) `blocked`, (c) `blocked`:
//                       in (c) only the relay is on both networks, so a worker must not reach the app at all
// Anything else, a line that is missing, or output that cannot be read, is a FAIL. `--from-stdin` judges pasted
// lines instead of probing (how tests/ops/render-egress.test.mjs checks this logic against canned outputs).

import dns from "node:dns";
import { pathToFileURL } from "node:url";

export const OPTIONS = { a: { app: "REACHED" }, b: { app: "blocked" }, c: { app: "blocked" } };
export const INTERNET = ["https://example.com", "http://1.1.1.1"];

/** The probes, as printed lines: `blocked dns CODE` | `RESOLVED example.com ADDR`, then `blocked URL CODE` | `REACHED URL STATUS`. */
export async function probe({ app, lookup = (name) => dns.promises.lookup(name), fetcher = fetch, timeoutMs = 5000 } = {}) {
  const lines = [];
  try { const found = await lookup("example.com"); lines.push(`RESOLVED example.com ${found?.address ?? found}`); }
  catch (error) { lines.push(`blocked dns ${error?.code ?? error?.name ?? "error"}`); }
  for (const url of [...INTERNET, `http://${app}`]) {
    try { const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) }); lines.push(`REACHED ${url} ${res.status}`); }
    catch (error) { lines.push(`blocked ${url} ${error?.cause?.code ?? error?.name ?? "error"}`); }
  }
  return lines;
}

/** Judges printed lines for an option. Never throws; unknown or missing lines are failures. */
export function judge(lines, option, app) {
  const failures = [];
  const expected = OPTIONS[option];
  if (!expected) return { ok: false, failures: [`unknown option ${JSON.stringify(option)} (a, b or c)`] };
  const clean = (Array.isArray(lines) ? lines : []).map((line) => String(line).trim()).filter(Boolean);
  const find = (re) => clean.filter((line) => re.test(line));
  const dnsLines = find(/^(blocked dns\b|RESOLVED example\.com\b)/);
  if (dnsLines.length !== 1) failures.push("the DNS line is missing or repeated");
  else if (!/^blocked dns \S+$/.test(dnsLines[0])) failures.push(`DNS: ${dnsLines[0]}`);
  for (const url of INTERNET) {
    const got = find(new RegExp(`^(blocked|REACHED) ${url.replace(/[.]/g, "\\.")}\\b`));
    if (got.length !== 1) failures.push(`the ${url} line is missing or repeated`);
    else if (!/^blocked \S+ \S+$/.test(got[0])) failures.push(`internet: ${got[0]}`);
  }
  const appLines = find(/^(blocked|REACHED) http:\/\/(?!1\.1\.1\.1)/).filter((line) => !INTERNET.some((url) => line.includes(url)));
  if (appLines.length !== 1) failures.push("the app line is missing or repeated");
  else if (expected.app === "REACHED" ? !/^REACHED \S+ \d{3}$/.test(appLines[0]) : !/^blocked \S+ \S+$/.test(appLines[0]))
    failures.push(`app: ${appLines[0]} (option ${option} expects ${expected.app})`);
  /* A line this check does not know is not read as fine. */
  for (const line of clean) if (!/^(blocked|REACHED|RESOLVED)\b/.test(line)) failures.push(`unrecognised line: ${line.slice(0, 80)}`);
  if (app && !appLines.some((line) => line.includes(app)) && appLines.length === 1) failures.push("the app line is not for the app that was named");
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
  if (verdict.ok) { console.log("EGRESS GATE: PASS"); process.exit(0); }
  console.log(`EGRESS GATE: FAIL (${verdict.failures.join("; ")}). No render until this passes.`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
