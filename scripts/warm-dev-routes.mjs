// Compiles every app page and API route on a fresh `next dev` server before
// the browser specs run, then checks the routes every spec needs answer.
//
// Why: each route Turbopack compiles holds 0.1-0.6 GB of native memory until
// its cache snapshot, and it snapshots (then frees the memory) only once the
// server has idled for a moment. Specs that open many new pages back to back
// never let it idle, so next-server grew 9-11 GB within a minute on a 16 GB
// runner. Here routes compile one at a time, pausing whenever next-server has
// grown `WARM_BUDGET_MB` since the last pause until a snapshot frees it. On a
// server whose .next cache already holds the routes, the pass only restores.
//
// Requests carry no session. Pages are fetched (a signed-out render or its
// redirect compiles the whole route); API routes get OPTIONS, which Next
// answers itself without running a handler, so a 404 there means the server
// does not know the route. Exits 1 when the sign-up or sign-in routes or the
// proxy do not answer, or the server does not know an API route: a restarted
// server once answered every sign-up with the not-found page.
//
//   node scripts/warm-dev-routes.mjs [base URL] [--check]
//   --check: only those sign-in routes and the proxy, not every route.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const base = (process.argv.find((a) => a.startsWith("http")) || "http://localhost:4551").replace(/\/$/, "");
const checkOnly = process.argv.includes("--check");
const budget = Number(process.env.WARM_BUDGET_MB || 1500);
const cap = Number(process.env.WARM_CAP_MB || 4500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Every page and route under app/ as a URL: groups dropped, dynamic segments
   given a placeholder, optional catch-alls left empty. */
function routes(dir = "app", segments = []) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const { name } = entry;
    if (entry.isDirectory()) {
      if (name.startsWith("_") || name.startsWith("@")) continue;
      const segment = /^\(.*\)$|^\[\[\.\.\..+\]\]$/.test(name) ? null : /^\[.+\]$/.test(name) ? "warm" : name;
      found.push(...routes(`${dir}/${name}`, segment ? [...segments, segment] : segments));
    } else if (/^(page|route)\.[jt]sx?$/.test(name)) {
      found.push({ path: `/${segments.join("/")}`, api: name.startsWith("route") });
    }
  }
  return found;
}

/* next-server's RSS in MB, the figure the CI monitor reports. */
function serverMemory() {
  try {
    let max = 0;
    for (const line of execFileSync("ps", ["-eo", "rss=,comm="], { encoding: "utf8" }).split("\n")) {
      const [rss, comm] = line.trim().split(/\s+/);
      if (comm?.startsWith("next-server")) max = Math.max(max, Number(rss) / 1024);
    }
    return max;
  } catch {
    return 0;
  }
}

/* Wait for a snapshot to free what the compiles held: until memory falls by a
   third, or 10 s pass without it falling. */
async function settle() {
  const start = serverMemory();
  const began = Date.now();
  let now = start;
  while (Date.now() - began < 20_000) {
    await sleep(500);
    now = serverMemory();
    if (now < start * 0.67 || (Date.now() - began > 10_000 && now > start * 0.95)) break;
  }
  return now;
}

async function request(url, method) {
  try {
    const response = await fetch(base + url, {
      method,
      redirect: "manual",
      headers: { accept: method === "GET" ? "text/html" : "*/*" },
      signal: AbortSignal.timeout(120_000),
    });
    await response.arrayBuffer();
    return response.status;
  } catch (error) {
    return error.name;
  }
}

/* What every spec relies on: the sign-up and sign-in routes, and the proxy,
   which shows a visitor the public site at / and sends /site there. */
const essentials = [
  { url: "/api/auth/signup", method: "OPTIONS", ok: [204] },
  { url: "/api/auth/login", method: "OPTIONS", ok: [204] },
  { url: "/login", method: "GET", ok: [200] },
  { url: "/", method: "GET", ok: [200] },
  { url: "/site", method: "GET", ok: [308] },
];

const targets = [...essentials];
if (!checkOnly) {
  for (const { path, api } of routes().sort((a, b) => Number(a.api) - Number(b.api) || a.path.localeCompare(b.path))) {
    /* Only an unknown route answers OPTIONS with anything but 204. A page's
       signed-out answer is its own business, so pages are not judged. */
    if (api) targets.push({ url: path, method: "OPTIONS", ok: [204] });
    else {
      targets.push({ url: path, method: "GET" });
      /* An app parameter asks the proxy for the app's page instead of the site. */
      if (["/", "/atomik", "/workspace", "/pricing"].includes(path)) targets.push({ url: `${path}?project=warm`, method: "GET" });
    }
  }
  targets.push({ url: "/favicon.ico", method: "GET" }, { url: "/warm-not-found", method: "GET" });
}

const started = Date.now();
let floor = serverMemory();
let peak = floor;
let pauses = 0;
const missing = [];
for (const { url, method, ok } of targets) {
  const status = await request(url, method);
  if (ok && !ok.includes(status)) missing.push(`${method} ${url} ${status}`);
  const memory = serverMemory();
  peak = Math.max(peak, memory);
  if (memory > Math.min(floor + budget, cap)) {
    floor = await settle();
    pauses += 1;
  }
}
if (!checkOnly) floor = await settle();
console.log(
  `[warm] ${targets.length} routes in ${Math.round((Date.now() - started) / 1000)} s, ${pauses} pauses, next-server peak ${Math.round(peak)} MB, now ${Math.round(serverMemory())} MB`,
);
if (missing.length) {
  console.log(`[warm] ${missing.length} routes did not answer as expected: ${missing.slice(0, 12).join("; ")}`);
  process.exit(1);
}
