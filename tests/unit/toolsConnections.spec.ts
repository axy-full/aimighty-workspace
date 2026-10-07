import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { TOOLS } from "../../lib/mcp";
import { shellPage } from "../../lib/shell/ia";
import { isStageId } from "../../lib/shell/stage-redirects";
import {
  CLIENTS, DEFAULT_CEILING, MCP_TOOL_LINES, PARTICL_REACH, STATUS_LABEL, ceilingShare, mcpTools, parseTokens, reachRows,
  readCeiling, setupGuide, tokenBody, tokenFacts, type ApiToken, type ReachOpen,
} from "../../lib/shell/tools-connections";

/**
 * Atomik › Tools & connections (idea 20). Every row is backed by code that
 * runs and opens the page where it runs; since 28 September 2026 every row is
 * Particl's own (Atomik reaches no signed-in account); the assistant side is
 * Particl's own MCP server and tokens, in the workspace's unit.
 */
test("every row is Particl's own and opens a Suites page that exists; none reaches a signed-in account", () => {
  const exists = (open: ReachOpen) => {
    if ("gen" in open || "tab" in open) return true;
    /* A Studio stage id opens the board's region for it (the stage pages are deleted). */
    if (open.suite === "studio" && isStageId(open.page)) return true;
    const page = shellPage(open.suite, open.page);
    return Boolean(page && !page.phoneOnly);
  };
  for (const row of PARTICL_REACH) expect(row.open && exists(row.open), row.id).toBe(true);
  const rows = reachRows();
  expect(rows.map((row) => row.id)).toEqual(PARTICL_REACH.map((row) => row.id));
  expect(rows.every((row) => row.group === "particl" && row.status === "built-in")).toBe(true);
  expect(PARTICL_REACH.find((row) => row.id === "thinking")?.open).toMatchObject({ suite: "atomik", page: "models" });
  expect(STATUS_LABEL["built-in"]).toBe("Built in");
  for (const row of rows) expect(`${row.label} ${row.line}`, row.id).not.toMatch(/connected account|higgsfield|supercomputer|catalogue/i);
});

test("Particl's own MCP tools are all described, and the writing ones need a token that can generate", () => {
  expect(Object.keys(MCP_TOOL_LINES).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  const rows = mcpTools();
  expect(rows.filter((t) => t.token === "generate").map((t) => t.name).sort()).toEqual(["create_project", "render_shot"]);
  expect(PARTICL_REACH.find((row) => row.id === "assistant")?.line).toContain(`${TOOLS.length} tools`);
});

test("setup guides carry this workspace's address and the new token, and a desktop app can start the bridge", () => {
  const origin = "https://studio.example.test";
  expect(CLIENTS.map((c) => c.id)).toEqual(["claude-code", "claude-desktop", "chatgpt", "mcp", "cli"]);
  for (const { id } of CLIENTS) {
    const guide = setupGuide(id, origin, "aw_fresh");
    expect(guide.note.length, id).toBeGreaterThan(20);
    expect(guide.steps.length, id).toBeGreaterThanOrEqual(2);
    expect(guide.steps.some((s) => s.code.includes(origin)), id).toBe(true);
    expect(guide.steps.some((s) => s.code.includes("aw_fresh")), id).toBe(true);
    expect(setupGuide(id, origin, "").steps.some((s) => s.code.includes("YOUR_TOKEN")), id).toBe(true);
  }
  expect(setupGuide("claude-code", origin, "aw_t").steps[1].code).toBe(`claude mcp add particl --env PARTICL_URL=${origin} --env PARTICL_TOKEN=aw_t -- node ~/particl-mcp.mjs`);
  const desktop = JSON.parse(setupGuide("claude-desktop", origin, "aw_t").steps[1].code);
  expect(desktop.mcpServers.particl).toEqual({ command: "sh", args: ["-c", 'exec node "$HOME/particl-mcp.mjs"'], env: { PARTICL_URL: origin, PARTICL_TOKEN: "aw_t" } });
  expect(setupGuide("mcp", origin, "aw_t").steps.map((s) => s.code)).toEqual([`${origin}/api/mcp`, "Authorization: Bearer aw_t"]);
  expect(setupGuide("chatgpt", origin, "aw_t").steps[0].code).toBe(`${origin}/api/openapi`);
  /* The bridge the guides download is the one this app serves, and it says where tokens are made now. */
  for (const file of ["public/particl-mcp.mjs", "mcp/particl-mcp.mjs"]) expect(readFileSync(file, "utf8")).toContain("Atomik › Tools & connections");
});

test("tokens read in the workspace's unit: credits never show a dollar, a blank ceiling is said on purpose", () => {
  const now = Date.UTC(2026, 8, 26, 12);
  const render: ApiToken = { id: "t1", name: "Claude", scope: "render", lastUsed: now - 2 * 3_600_000, createdAt: 0, capCredits: 500, spendThisMonth: 120 };
  expect(tokenFacts(render, "credits", now)).toBe("Can generate · 120 cr of 500 cr this month · used 2h ago");
  expect(ceilingShare(render, "credits")).toBeCloseTo(0.24);
  expect(tokenFacts({ ...render, capCredits: null, legacyCeiling: true }, "credits", now)).toContain("ceiling set before credits");
  expect(tokenFacts({ ...render, capCredits: null }, "credits", now)).toContain("no ceiling");
  expect(tokenFacts({ ...render, capCredits: 500, spendThisMonth: 900 }, "credits", now)).not.toContain("$");
  expect(ceilingShare({ ...render, spendThisMonth: 900 }, "credits")).toBe(1);
  expect(tokenFacts({ id: "t2", name: "Reader", scope: "read", lastUsed: null, createdAt: 0, spendThisMonth: 0 }, "credits", now)).toBe("Read-only · never used");
  expect(ceilingShare({ id: "t2", name: "Reader", scope: "read", lastUsed: null, createdAt: 0, spendThisMonth: 0, capCredits: 5 }, "credits")).toBeNull();
  expect(tokenFacts({ id: "t3", name: "Own keys", scope: "render", lastUsed: null, createdAt: 0, capUsd: 20, spendThisMonth: 4.5 }, "usd", now)).toBe("Can generate · $4.50 of $20.00 this month · never used");

  /* The route's own words (#385): unit "cr", the month in `spendThisMonth`. */
  expect(parseTokens({ unit: "cr", tokens: [{ id: "a", name: "A", scope: "render", capCredits: 10, spendThisMonth: 3, lastUsed: null, createdAt: 1 }] })).toMatchObject({ unit: "credits", tokens: [{ id: "a", capCredits: 10, spendThisMonth: 3 }] });
  expect(parseTokens({ tokens: [] })).toEqual({ unit: "usd", tokens: [] });
  for (const bad of [null, { tokens: "x" }, { tokens: [{ id: 1, name: "x" }] }]) expect(parseTokens(bad)).toBeNull();

  expect(DEFAULT_CEILING).toEqual({ credits: "500", usd: "20" });
  expect(readCeiling("500", "credits")).toEqual({ value: 500, blank: false });
  expect(readCeiling("1,000 cr", "credits")).toEqual({ value: 1000, blank: false });
  expect(readCeiling("", "credits")).toEqual({ value: null, blank: true });
  for (const bad of ["2.5", "0", "-1", "lots", "1000001"]) expect(readCeiling(bad, "credits"), bad).toHaveProperty("error");
  expect(readCeiling("$20", "usd")).toEqual({ value: 20, blank: false });
  expect(readCeiling("twenty", "usd")).toHaveProperty("error");
  expect(tokenBody("Claude", "render", "credits", 500)).toEqual({ name: "Claude", scope: "render", capCredits: 500 });
  expect(tokenBody("Claude", "render", "usd", 20)).toEqual({ name: "Claude", scope: "render", capUsd: 20 });
  expect(tokenBody("Claude", "render", "credits", null)).toEqual({ name: "Claude", scope: "render" });
  expect(tokenBody("Reader", "read", "credits", 500)).toEqual({ name: "Reader", scope: "read" });
});

test("the page lists no skill packs for a signed-in account and no connected-account card", () => {
  const view = readFileSync("components/graphite/atomik/ToolsView.tsx", "utf8");
  expect(view).not.toContain("SKILL_PACKS");
  expect(view).not.toContain('data-testid="skill-row"');
  expect(view).not.toContain('data-testid="reach-connected"');
  expect(view).not.toMatch(/higgsfield-ai\/skills|connected account/i);
  expect(shellPage("atomik", "skills")).toMatchObject({ label: "Tools", title: "Tools & connections", own: true });
});
