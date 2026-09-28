import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { runTool, TOOLS, WAIT_MAX_SECONDS, waitSeconds } from "../../lib/mcp";

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
  expect(waitSeconds(600)).toBe(WAIT_MAX_SECONDS);
  expect(waitSeconds(480)).toBe(WAIT_MAX_SECONDS);
  expect(waitSeconds(undefined)).toBe(240);
  expect(waitSeconds(1)).toBe(5);
  expect(waitSeconds("nonsense")).toBe(240);
  const described = JSON.stringify(TOOLS.find((t) => t.name === "wait_for_render"));
  expect(described).toContain(`max ${WAIT_MAX_SECONDS}`);
  expect(described).not.toContain("600");
  for (const file of ["mcp/particl-mcp.mjs", "public/particl-mcp.mjs", "public/aimighty-mcp.mjs"]) {
    const cli = readFileSync(file, "utf8");
    expect(cli).not.toContain("timeout_seconds: 480");
    expect(cli).toContain('reply.startsWith("Still ")');
  }
});

test("a finished render is reported without waiting out the timeout", async () => {
  const { call } = caller([], (path) => path.startsWith("/api/jobs/") ? { generation: { id: "g1", status: "succeeded", prompt: "p", costUsd: 1 } } : undefined);
  const text = await runTool("wait_for_render", { id: "g1", timeout_seconds: 600 }, call as never, "https://example.invalid");
  expect(text).toContain("Done in");
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
