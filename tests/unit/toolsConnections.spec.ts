import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CONNECTED_REACH, parseReach, reachFromTools, type ConnectedReachId } from "../../lib/higgsfield-consumer/reach";
import { GENERATION_TOOLS } from "../../lib/higgsfield-consumer/generation-contract";
import { STATUS_TOOLS } from "../../lib/higgsfield-consumer/toolset";
import { MARKETING_TEMPLATE_TOOLS } from "../../lib/higgsfield-consumer/marketing-templates";
import { VOICE_TOOLS } from "../../lib/higgsfield-consumer/voice-tools";
import { TOOLS } from "../../lib/mcp";
import { shellPage } from "../../lib/shell/ia";
import { SKILL_PACKS } from "../../lib/shell/skills";
import {
  CLIENTS, CONNECTED_OPEN, DEFAULT_CEILING, MCP_TOOL_LINES, PARTICL_REACH, STATUS_LABEL, ceilingShare, mcpTools, parseTokens, reachRows, reachStateFrom, reachSummary,
  readCeiling, setupGuide, tokenBody, tokenFacts, usable, type ApiToken, type ReachOpen, type ReachStatus,
} from "../../lib/shell/tools-connections";

/**
 * Atomik › Tools & connections (idea 20). Every row is backed by code that
 * runs and opens the page where it runs; the connected rows are checked
 * against the names Particl's own workflows call; the assistant side is
 * Particl's own MCP server and tokens, in the workspace's unit.
 */
const fixture = (file: string) => (JSON.parse(readFileSync(`tests/fixtures/${file}`, "utf8")) as { tools: { name: string }[] }).tools.map((t) => t.name);
const need = (id: ConnectedReachId) => CONNECTED_REACH.find((row) => row.id === id)!.needs.map((group) => [...group]);
const voice = (name: string) => VOICE_TOOLS.find((tool) => tool.name === name)!;

test("every connected row names the tools Particl's own code calls for it", () => {
  const mcp = readFileSync("lib/higgsfield-consumer/mcp.ts", "utf8");
  const status = [...STATUS_TOOLS];
  expect(need("image")).toEqual([[GENERATION_TOOLS.image]]);
  expect(need("video")).toEqual([[GENERATION_TOOLS.video]]);
  expect(need("audio")).toEqual([[GENERATION_TOOLS.audio]]);
  expect(need("motion")).toEqual([[GENERATION_TOOLS.video]]);
  expect(need("follow")).toEqual([status]);
  expect(need("voice")).toEqual([[voice("voice_change").create], status]);
  expect(need("dub")).toEqual([[voice("dubbing").create], status]);
  expect(need("reframe")).toEqual([[voice("reframe").create], status]);
  expect(need("analysis")).toEqual([[voice("video_analysis").create], [voice("video_analysis").status]]);
  expect(need("templates")).toEqual([[MARKETING_TEMPLATE_TOOLS.presets], [MARKETING_TEMPLATE_TOOLS.costs], [MARKETING_TEMPLATE_TOOLS.create], [MARKETING_TEMPLATE_TOOLS.status]]);
  expect(mcp).toContain('const CHARACTERS_TOOL = "show_characters"');
  expect(mcp).toContain('const ELEMENTS_TOOL = "show_reference_elements"');
  expect(need("characters")).toEqual([["show_characters"], ["media_import_url"]]);
  expect(need("elements")).toEqual([["show_reference_elements"], ["media_import_url"]]);
  expect(mcp).toContain('name: "models_explore"');
  expect(mcp).toContain('name:"media_import_url"');
  expect(need("models")).toEqual([["models_explore"]]);
  expect(need("files")).toEqual([["media_import_url"]]);
  expect(new Set(CONNECTED_REACH.map((row) => row.id)).size).toBe(CONNECTED_REACH.length);
});

test("every row opens a Suites page that exists, and only where it can be used now", () => {
  const exists = (open: ReachOpen) => {
    if ("gen" in open || "tab" in open) return true;
    const page = shellPage(open.suite, open.page);
    return Boolean(page && !page.phoneOnly);
  };
  for (const row of PARTICL_REACH) expect(row.open && exists(row.open), row.id).toBe(true);
  for (const row of CONNECTED_REACH) expect(exists(CONNECTED_OPEN[row.id]), row.id).toBe(true);
  /* Where the WIP pointed wrong: 3D and batches have no Suites page; follow-ups land in Takes, not Runs;
     Social cuts live in Deliver; the connected catalogue is Gen's, not Atomik › Models (thinking models). */
  expect(CONNECTED_OPEN.follow).toMatchObject({ suite: "studio", page: "takes" });
  expect(CONNECTED_OPEN.reframe).toMatchObject({ suite: "studio", page: "deliver" });
  expect(CONNECTED_OPEN.templates).toMatchObject({ suite: "business", page: "dtc" });
  expect(CONNECTED_OPEN.models).toMatchObject({ gen: true });
  expect(PARTICL_REACH.find((row) => row.id === "thinking")?.open).toMatchObject({ suite: "atomik", page: "models" });
  const statuses: ReachStatus[] = ["built-in", "available", "missing", "off", "owner-only", "connect", "checking", "error"];
  expect(statuses.filter(usable)).toEqual(["built-in", "available"]);
  for (const status of statuses) expect(STATUS_LABEL[status].length).toBeGreaterThan(3);
});

test("the live check reads the account's own tools: our client, another client, and a platform switch", () => {
  const ours = reachFromTools(fixture("connected-tools-98.json"));
  expect(ours.every((row) => row.available)).toBe(true);
  const other = reachFromTools(fixture("connected-tools-91.json"));
  /* The other client advertises no job_status and no marketing_studio_v2_*: follow-ups still run on jobs_wait/job_display. */
  expect(other.filter((row) => !row.available).map((row) => row.id)).toEqual(["templates"]);
  const off = reachFromTools(fixture("connected-tools-98.json"), { off: ["analysis"] });
  expect(off.find((row) => row.id === "analysis")).toEqual({ id: "analysis", available: false, off: true });
  expect(reachFromTools([]).every((row) => !row.available)).toBe(true);
  /* Only ids and flags: nothing from the account's catalogue rides along. */
  for (const row of off) expect(Object.keys(row).sort()).toEqual(row.off ? ["available", "id", "off"] : ["available", "id"]);
});

test("the reach check reads the same video-analysis switch as the voice tools, without loading that paid service", async () => {
  expect(readFileSync("lib/higgsfield-consumer/voice-tool-service.ts", "utf8")).toContain('VIDEO_ANALYSIS_ENABLED = process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED === "1"');
  const { analysisSwitchedOn } = await import("../../lib/higgsfield-consumer/discovery");
  const before = process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED;
  try {
    delete process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED;
    expect(analysisSwitchedOn()).toBe(false);
    process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED = "1";
    expect(analysisSwitchedOn()).toBe(true);
  } finally {
    if (before === undefined) delete process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED; else process.env.HF_CONSUMER_VIDEO_ANALYSIS_ENABLED = before;
  }
  const route = readFileSync("app/api/higgsfield/consumer/capabilities/route.ts", "utf8");
  expect(route).not.toContain("voice-tool-service");
});

test("a reach reply is read defensively and becomes one state, each with a next step", () => {
  const full = reachFromTools(fixture("connected-tools-91.json"));
  expect(parseReach(full)).toEqual(full);
  for (const bad of [null, {}, [{ id: "websites", available: true }], [{ id: "image", available: "yes" }], [{ id: "image", available: true }, { id: "image", available: false }], [{ id: "image", available: false, off: false }], [...full, full[0]]])
    expect(parseReach(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
  expect(reachStateFrom(200, { reach: full, checkedAt: 5 })).toEqual({ kind: "checked", checks: full, checkedAt: 5 });
  expect(reachStateFrom(200, { reach: full.slice(1) }).kind).toBe("error");
  expect(reachStateFrom(409, { code: "not_connected" })).toEqual({ kind: "connect" });
  expect(reachStateFrom(401, { code: "reconnect_required" })).toEqual({ kind: "connect", reconnect: true });
  expect(reachStateFrom(403, { error: "Only the owner" })).toEqual({ kind: "owner-only" });
  expect(reachStateFrom(429, null)).toMatchObject({ kind: "error", message: expect.stringContaining("Try again in a minute") });
  expect(reachStateFrom(503, "<html>")).toMatchObject({ kind: "error", message: expect.stringContaining("Workspace › Engines") });

  const checked = reachRows({ kind: "checked", checks: reachFromTools(fixture("connected-tools-91.json"), { off: ["analysis"] }), checkedAt: 1 });
  expect(checked.filter((r) => r.group === "particl").every((r) => r.status === "built-in")).toBe(true);
  expect(checked.find((r) => r.id === "templates")?.status).toBe("missing");
  expect(checked.find((r) => r.id === "analysis")?.status).toBe("off");
  expect(reachSummary({ kind: "checked", checks: reachFromTools(fixture("connected-tools-91.json"), { off: ["analysis"] }), checkedAt: 1 })).toBe(`12 of ${CONNECTED_REACH.length} available`);
  for (const kind of ["owner-only", "checking"] as const)
    expect(reachRows({ kind }).filter((r) => r.group === "connected").every((r) => r.status === kind)).toBe(true);
  expect(reachSummary({ kind: "owner-only" })).toBe("Only the workspace owner uses the connected account");
  expect(reachSummary({ kind: "connect" })).toContain("Workspace › Engines");
  expect(reachSummary({ kind: "connect", reconnect: true })).toContain("Sign the account in again");
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

test("the old Skills page's packs are kept, with the page's own copy, beside the new tabs", () => {
  expect(SKILL_PACKS).toHaveLength(8);
  const view = readFileSync("components/graphite/atomik/ToolsView.tsx", "utf8");
  expect(view).toContain("SKILL_PACKS.map");
  expect(view).toContain('data-testid="skill-row"');
  expect(shellPage("atomik", "skills")).toMatchObject({ label: "Tools", title: "Tools & connections", own: true });
});
