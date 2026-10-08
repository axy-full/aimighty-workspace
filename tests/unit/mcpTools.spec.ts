import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { runTool, TOOLS, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS, waitSeconds } from "../../lib/mcp";

/**
 * The workspace's MCP tools (audit, 25 September): a wait answers before the
 * route is cut off, and a paid render is never filed under a project the
 * agent only half-named.
 */
type Reply = Record<string, unknown>;
function caller(projects: { id: string; name: string }[], extra: (path: string, body?: unknown) => Reply | undefined = () => undefined) {
  const calls: { path: string; body?: unknown }[] = [];
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, body: init.body });
    if (path === "/api/projects") return { projects };
    const out = extra(path, init.body);
    if (out) return out;
    throw new Error(`unexpected ${path}`);
  };
  return { call, calls };
}

test("a wait is bounded well inside the route's own limit, and says so", () => {
  const route = readFileSync("app/api/mcp/route.ts", "utf8");
  const maxDuration = Number(/export const maxDuration = (\d+)/.exec(route)?.[1]);
  expect(maxDuration).toBeGreaterThanOrEqual(WAIT_MAX_SECONDS + 20);
  /* No request stays silent for more than 100 s (owner decision, docs/long-flows.md › C5). */
  expect(WAIT_MAX_SECONDS).toBe(85);
  expect(WAIT_DEFAULT_SECONDS).toBe(60);
  expect(waitSeconds(600)).toBe(85);
  expect(waitSeconds(240)).toBe(85);
  expect(waitSeconds(85)).toBe(85);
  expect(waitSeconds(30)).toBe(30);
  expect(waitSeconds(undefined)).toBe(60);
  expect(waitSeconds(1)).toBe(5);
  expect(waitSeconds("nonsense")).toBe(60);
  const described = JSON.stringify(TOOLS.find((t) => t.name === "wait_for_render"));
  expect(described).toContain("max 85");
  expect(described).toContain("at most 85 seconds");
  expect(described).toContain("call wait_for_render again with the same id");
  expect(described).not.toMatch(/600|270|240/);
  for (const file of ["mcp/particl-mcp.mjs", "public/particl-mcp.mjs", "public/aimighty-mcp.mjs"]) {
    const cli = readFileSync(file, "utf8");
    expect(cli).not.toContain("timeout_seconds: 480");
    expect(cli).toContain("timeout_seconds: 85");
    expect(cli).toContain('reply.startsWith("Still ")');
  }
});

test("a finished render is reported without waiting out the timeout", async () => {
  const { call } = caller([], (path) => path.startsWith("/api/jobs/") ? { generation: { id: "g1", status: "succeeded", prompt: "p", costUsd: 1 } } : undefined);
  const text = await runTool("wait_for_render", { id: "g1", timeout_seconds: 600 }, call as never, "https://example.invalid");
  expect(text).toContain("Done in");
});

/**
 * A fake clock: Date.now, setTimeout and clearTimeout are replaced, and time
 * jumps to the next timer whenever the code under test is only waiting.
 */
async function onFakeClock<T>(run: (clock: { now: () => number }) => Promise<T>): Promise<{ value: T; elapsed: number }> {
  const realNow = Date.now, realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  let now = 1_000_000, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  Date.now = () => now;
  globalThis.setTimeout = ((fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const started = now;
  try {
    let settled = false;
    const job = run({ now: () => now }).finally(() => { settled = true; });
    for (let guard = 0; guard < 10_000; guard++) {
      await new Promise((r) => setImmediate(r));
      if (settled) break;
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) continue;
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].fn();
    }
    const value = await job;
    return { value, elapsed: now - started };
  } finally {
    Date.now = realNow; globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
  }
}
/** A poll that answers after `takes` ms of the fake clock, or is cut off by its signal. */
function slowPoll(status: string, takes: (n: number) => number) {
  const calls: { at: number; signalled: boolean }[] = [];
  const call = (path: string, init: { signal?: AbortSignal } = {}) => new Promise((resolve, reject) => {
    if (!path.startsWith("/api/jobs/")) return reject(new Error(`unexpected ${path}`));
    calls.push({ at: Date.now(), signalled: !!init.signal });
    const timer = setTimeout(() => resolve({ generation: { id: "g1", status, prompt: "p" } }), takes(calls.length));
    init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); });
  });
  return { call, calls };
}

test("a render still going when the wait ends is a normal 'call again' reply, sent within 85 s", async () => {
  for (const [asked, budget] of [[600, 85_000], [undefined, 60_000]] as const) {
    const { call, calls } = slowPoll("running", () => 200);
    const { value: text, elapsed } = await onFakeClock(() => runTool("wait_for_render", { id: "g1", timeout_seconds: asked }, call as never, "https://example.invalid"));
    expect(text).toMatch(/^Still running after \d+s/);
    expect(text).toContain("Call wait_for_render again with the same id.");
    expect(elapsed).toBeLessThanOrEqual(budget);
    /* Polls every 5 s; none starts in the last 15 s; every one carries a cut-off. */
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((c) => c.signalled)).toBe(true);
    expect(Math.max(...calls.map((c) => c.at - 1_000_000))).toBeLessThanOrEqual(budget - 15_000);
  }
});

test("a slow poll (storing the video) is cut off at the deadline and still answers 'call again', never an error", async () => {
  /* The poll that would see the take finish stores the video first: longer than the whole wait here. */
  for (const slowFrom of [1, 3]) {
    const { call, calls } = slowPoll("running", (n) => (n >= slowFrom ? 120_000 : 300));
    const { value: text, elapsed } = await onFakeClock(() => runTool("wait_for_render", { id: "g1", timeout_seconds: 85 }, call as never, "https://example.invalid"));
    expect(text).toMatch(/^Still (running|rendering) after \d+s — it hasn't failed/);
    expect(text).toContain("Call wait_for_render again with the same id.");
    expect(elapsed).toBeLessThanOrEqual(85_000);
    expect(calls).toHaveLength(slowFrom);
  }
  /* The shortest wait still lets one poll answer: at least 3 s, within the 5 s asked. */
  const quick = slowPoll("succeeded", () => 2_500);
  const { value: done, elapsed } = await onFakeClock(() => runTool("wait_for_render", { id: "g1", timeout_seconds: 5 }, quick.call as never, "https://example.invalid"));
  expect(done).toContain("Done in");
  expect(elapsed).toBeLessThanOrEqual(5_000);
});

test("a render names its project exactly; a partial name is never guessed for a paid call", async () => {
  const projects = [{ id: "p1", name: "Rainbow Launch" }, { id: "p2", name: "Rain" }, { id: "p3", name: "Monsoon Film" }, { id: "p4", name: "Monsoon film" }];
  const generate = (path: string, body?: unknown) => (path === "/api/generate" ? { id: "gen_1", body } : path === "/api/generate/quote" ? { estimatedCredits: 18, price: 18, unit: "cr", fingerprint: "a".repeat(64) } : undefined);

  const guess = caller(projects.filter((p) => p.id !== "p2"), generate);
  await expect(runTool("render_shot", { prompt: "Rain on glass.", project: "Rain" }, guess.call as never, "")).rejects.toThrow('Did you mean "Rainbow Launch" (p1)');
  expect(guess.calls.map((c) => c.path)).not.toContain("/api/generate");

  const exact = caller(projects, generate);
  const text = await runTool("render_shot", { prompt: "Rain on glass.", project: "rain" }, exact.call as never, "");
  expect(text).toContain("project: Rain");
  expect(exact.calls.find((c) => c.path === "/api/generate")?.body).toMatchObject({ projectId: "p2" });

  const twins = caller(projects, generate);
  await expect(runTool("render_shot", { prompt: "Rain.", project: "monsoon film" }, twins.call as never, "")).rejects.toThrow("Give the project id");
  expect(twins.calls.map((c) => c.path)).not.toContain("/api/generate");
  const byId = caller(projects, generate);
  await runTool("render_shot", { prompt: "Rain.", project: "p4" }, byId.call as never, "");
  expect(byId.calls.find((c) => c.path === "/api/generate")?.body).toMatchObject({ projectId: "p4" });

  // Reading may take a partial name that fits exactly one project.
  const read = caller(projects, (path) => path.startsWith("/api/jobs?") ? { generations: [] } : undefined);
  await runTool("list_renders", { project: "rainbow" }, read.call as never, "");
  expect(read.calls.find((c) => c.path.startsWith("/api/jobs?"))?.path).toContain("projectId=p1");
  await expect(runTool("list_renders", { project: "monsoon" }, read.call as never, "")).rejects.toThrow("Did you mean");
});

test("costs reach the assistant in the unit the workspace pays in, and a missing figure is not read as $0.00", async () => {
  const credits = { id: "g1", status: "succeeded", prompt: "p", costUsd: null, refineCostUsd: null, creditsBilled: 43 };
  const jobs = (generation: Record<string, unknown>) => caller([], (path) => (path.startsWith("/api/jobs/") ? { generation } : undefined)).call;
  const waited = await runTool("wait_for_render", { id: "g1" }, jobs(credits) as never, "https://example.invalid", { credits: true });
  expect(waited).toContain("Cost 43 cr.");
  expect(waited).not.toContain("$");
  expect(await runTool("get_render", { id: "g1" }, jobs(credits) as never, "")).toContain("· 43 cr");
  /* A connected take quoted in the account's own credits carries neither figure: no cost line at all. */
  expect(await runTool("wait_for_render", { id: "g1" }, jobs({ ...credits, creditsBilled: null }) as never, "")).not.toContain("Cost");
  expect(await runTool("wait_for_render", { id: "g1" }, jobs({ ...credits, costUsd: 1.25, creditsBilled: null }) as never, "")).toContain("Cost $1.25.");
  /* A failed take's figure is its receipt: settled, held, or — with none — no figure at all, never a "0 cr" it was not billed. */
  const failed = { ...credits, status: "failed", creditsBilled: 0 };
  expect(await runTool("get_render", { id: "g1" }, jobs({ ...failed, failure: { charge: { credits: 0, settled: true } } }) as never, "")).toContain("· failed · 0 cr");
  expect(await runTool("get_render", { id: "g1" }, jobs({ ...failed, failure: { charge: { credits: 12, settled: false } } }) as never, "")).toContain("· failed · 12 cr held");
  expect(await runTool("get_render", { id: "g1" }, jobs({ ...failed, failure: { charge: { credits: 12, settled: true } } }) as never, "")).toContain("· failed · 12 cr");
  const unconfirmed = await runTool("get_render", { id: "g1" }, jobs({ ...failed, failure: { charge: null } }) as never, "");
  expect(unconfirmed).toContain("g1 · failed");
  expect(unconfirmed).not.toMatch(/\d+ cr|\$/);

  const projects = [{ id: "p1", name: "Coastal light study", genCount: 2, spend: 3.1, credits: 90 }];
  const listed = caller(projects as never);
  expect(await runTool("list_projects", {}, listed.call as never, "", { credits: true })).toBe("Coastal light study — 2 renders · 90 cr");
  expect(await runTool("list_projects", {}, listed.call as never, "")).toBe("Coastal light study — 2 renders · $3.10");
  /* The projects response also carries the unit, including callers that do not pass workspace options. */
  const creditProjects = async () => ({ projects, unit: "cr" });
  expect(await runTool("list_projects", {}, creditProjects as never, "")).toBe("Coastal light study — 2 renders · 90 cr");
  expect(await runTool("list_projects", {}, creditProjects as never, "", { credits: false })).not.toContain("$");
  expect(readFileSync("app/api/mcp/route.ts", "utf8")).toContain("{ credits: creditsApply(currentTenant()?.workspace) }");
});
