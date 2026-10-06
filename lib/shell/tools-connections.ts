/**
 * Atomik › Tools & connections: what Atomik can reach, and how an assistant
 * elsewhere reaches Particl.
 *
 * Every row here is backed by code that runs, and opens the place in Suites
 * where it runs:
 *  - Particl's own reach is built in (the agent, Particl's engines, sound,
 *    Astra, and Particl's own MCP tools). Atomik works with API-key and direct
 *    engines only: nothing here reaches a signed-in account;
 *  - the assistant side is Particl's own MCP server (/api/mcp, lib/mcp.ts
 *    TOOLS) and the workspace's API tokens (/api/tokens).
 *
 * Pure (no network, no React) so the unit specs read the same rules the page
 * renders.
 */
import { TOOLS } from "@/lib/mcp";
import { parseCeiling, parseCreditCeiling } from "@/lib/tokenCeiling";
import type { ShellSuiteId } from "./ia";

export type ToolsTab = "reach" | "connect";

/** Where a row opens: a suite page, the Gen view, or this page's other tab. */
export type ReachOpen =
  | { suite: ShellSuiteId; page: string; label: string }
  | { gen: true; label: string }
  | { tab: ToolsTab; label: string };

/** Particl's own; nothing to check. */
export type ReachStatus = "built-in";

export type ReachRow = { id: string; label: string; line: string; group: "particl"; status: ReachStatus; open?: ReachOpen };

const AGENT: ReachOpen = { suite: "atomik", page: "agent", label: "Agent" };
const GEN: ReachOpen = { gen: true, label: "Make" };
const SOUND: ReachOpen = { suite: "studio", page: "edit", label: "Edit & Sound" };

export const PARTICL_REACH: readonly Omit<ReachRow, "status" | "group">[] = Object.freeze([
  { id: "plan", label: "Plan & price", line: "Plans against the project; every request is priced before it runs", open: AGENT },
  { id: "thinking", label: "Thinking models", line: "The model Atomik plans with, and how hard it thinks", open: { suite: "atomik", page: "models", label: "Models" } },
  { id: "engines", label: "Particl engines", line: "Video, stills and sound on Particl’s own engines", open: GEN },
  { id: "sound", label: "Voice, sound & music", line: "Narration, effects and score for the cut", open: SOUND },
  { id: "astra", label: "3D blocking", line: "Block a scene in 3D before anything renders", open: { suite: "studio", page: "astra", label: "3D blocking" } },
  { id: "assistant", label: "Your own assistant", line: `Particl’s ${TOOLS.length} tools in Claude or ChatGPT, with a token you control`, open: { tab: "connect", label: "Claude & ChatGPT" } },
]);

/** Every row, all of them Particl's own. */
export function reachRows(): ReachRow[] {
  return PARTICL_REACH.map((row): ReachRow => ({ ...row, group: "particl", status: "built-in" }));
}

export const STATUS_LABEL: Record<ReachStatus, string> = {
  "built-in": "Built in",
};

/* ── Particl as an MCP server ─────────────────────────────────────────── */

/** Tools that write: a read-only token is refused them (lib/auth withTenant refuses its non-GET calls). */
const WRITES = new Set(["render_shot", "create_project"]);
/** One line per tool; tests/unit/toolsConnections.spec.ts fails when lib/mcp.ts gains a tool this page does not describe. */
export const MCP_TOOL_LINES: Readonly<Record<string, string>> = Object.freeze({
  render_shot: "Starts a video take and returns its id",
  wait_for_render: "Waits for a take, then reports what it cost",
  list_renders: "Recent takes, by project, status or prompt",
  get_render: "One take, with a link to watch or save it",
  list_projects: "Projects with their counts and spend",
  create_project: "Makes a project to file takes under",
  usage_summary: "Spent, remaining, and what is running now",
});

export type McpToolRow = { name: string; line: string; token: "any" | "generate" };
export function mcpTools(): McpToolRow[] {
  return TOOLS.map((tool) => ({ name: tool.name, line: MCP_TOOL_LINES[tool.name] ?? tool.description.split(". ")[0], token: WRITES.has(tool.name) ? "generate" : "any" }));
}

/** Stands in for the token until one is made; tokens read `pk_<workspace>_…` (or `aw_…` in the original workspace). */
export const TOKEN_PLACEHOLDER = "YOUR_TOKEN";
export const mcpEndpoint = (origin: string) => `${origin}/api/mcp`;
export const bridgeUrl = (origin: string) => `${origin}/particl-mcp.mjs`;
export const openapiUrl = (origin: string) => `${origin}/api/openapi`;

export type ClientId = "claude-code" | "claude-desktop" | "chatgpt" | "mcp" | "cli";
export const CLIENTS: readonly { id: ClientId; label: string }[] = Object.freeze([
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "mcp", label: "Any MCP client" },
  { id: "cli", label: "Command line" },
]);
export type SetupStep = { label: string; code: string };
export type SetupGuide = { note: string; steps: SetupStep[] };

/**
 * The copyable steps for one client, with the workspace's own address and
 * (once one is made) the new token filled in. The desktop config starts the
 * bridge through `sh` so `$HOME` expands: a desktop app launches `node`
 * without a shell, and a literal `$HOME` or `~` in its arguments does not
 * resolve.
 */
export function setupGuide(client: ClientId, origin: string, token: string): SetupGuide {
  const key = token || TOKEN_PLACEHOLDER;
  const download = { label: "Download the bridge once", code: `curl -o ~/particl-mcp.mjs ${bridgeUrl(origin)}` };
  const check = { label: "Check it", code: `PARTICL_URL=${origin} PARTICL_TOKEN=${key} node ~/particl-mcp.mjs --check` };
  if (client === "claude-code")
    return {
      note: "The bridge is one file with no dependencies; it needs Node 18 or later.",
      steps: [download, { label: "Add it to Claude Code", code: `claude mcp add particl --env PARTICL_URL=${origin} --env PARTICL_TOKEN=${key} -- node ~/particl-mcp.mjs` }, check],
    };
  if (client === "claude-desktop")
    return {
      note: "Settings › Developer › Edit Config, add the server, then restart the app. macOS and Linux.",
      steps: [download, {
        label: "Add to claude_desktop_config.json",
        code: JSON.stringify({
          mcpServers: {
            particl: {
              command: "sh",
              args: ["-c", "exec node \"$HOME/particl-mcp.mjs\""],
              env: { PARTICL_URL: origin, PARTICL_TOKEN: key },
            },
          },
        }, null, 2),
      }, check],
    };
  if (client === "chatgpt")
    return {
      note: "A custom GPT reaches Particl through its OpenAPI schema: Configure › Actions › Create new action. Where ChatGPT offers MCP connectors instead, use Any MCP client.",
      steps: [
        { label: "Import from URL", code: openapiUrl(origin) },
        { label: "Authentication › API key › Bearer", code: key },
      ],
    };
  if (client === "mcp")
    return {
      note: "Nothing to install: Particl is itself an MCP server over HTTP, for any client that can send a header.",
      steps: [
        { label: "Server URL", code: mcpEndpoint(origin) },
        { label: "Header", code: `Authorization: Bearer ${key}` },
      ],
    };
  return {
    note: "The same bridge works by hand, for batching a shot list from a terminal.",
    steps: [
      { label: "Download it once and keep the two variables in your shell", code: `curl -o ~/particl-mcp.mjs ${bridgeUrl(origin)}\nexport PARTICL_URL=${origin}\nexport PARTICL_TOKEN=${key}` },
      { label: "Then", code: "node ~/particl-mcp.mjs --check\nnode ~/particl-mcp.mjs projects\nnode ~/particl-mcp.mjs usage\nnode ~/particl-mcp.mjs render \"slow dolly through rain\" --wait\nnode ~/particl-mcp.mjs get <id> --save ./take.mp4" },
    ],
  };
}

/* ── Tokens ───────────────────────────────────────────────────────────── */

export type ApiToken = {
  id: string; name: string; scope: "read" | "render";
  lastUsed: number | null; createdAt: number;
  /** This month's spend, in the list's unit: credits billed, or the engine's dollars on a workspace's own keys. */
  spendThisMonth: number;
  /** Credits workspaces: the ceiling in credits, or a dollar one set before credits (never sent as a figure). */
  capCredits?: number | null; legacyCeiling?: boolean;
  /** Workspaces on their own keys. */
  capUsd?: number | null;
};
export type TokenUnit = "credits" | "usd";

/** What a new generating token's ceiling field starts at: a stop has to be removed on purpose. */
export const DEFAULT_CEILING: Record<TokenUnit, string> = { credits: "500", usd: "20" };

const cr = (n: number) => `${Math.round(n).toLocaleString("en-US")} cr`;
const usd = (n: number) => `$${n.toFixed(2)}`;
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The facts under a token's name: what it can do, this month's spend against its ceiling, when it was last used. */
export function tokenFacts(token: ApiToken, unit: TokenUnit, now = Date.now()): string {
  const parts = [token.scope === "read" ? "Read-only" : "Can generate"];
  if (token.scope === "render") {
    if (unit === "credits") {
      const spent = token.spendThisMonth;
      if (token.capCredits != null) parts.push(`${cr(spent)} of ${cr(token.capCredits)} this month`);
      else if (token.legacyCeiling) parts.push(`${cr(spent)} this month · ceiling set before credits`);
      else parts.push(`${cr(spent)} this month · no ceiling`);
    } else {
      const spent = token.spendThisMonth;
      if (token.capUsd != null) parts.push(`${usd(spent)} of ${usd(token.capUsd)} this month`);
      else parts.push(`${usd(spent)} this month · no ceiling`);
    }
  }
  parts.push(token.lastUsed ? `used ${ago(token.lastUsed, now)}` : "never used");
  return parts.join(" · ");
}

/** Share of the ceiling spent, 0–1, or null when there is no ceiling to measure against. */
export function ceilingShare(token: ApiToken, unit: TokenUnit): number | null {
  const cap = unit === "credits" ? token.capCredits : token.capUsd;
  const spent = token.spendThisMonth;
  if (token.scope !== "render" || cap == null || cap <= 0) return null;
  return Math.min(1, Math.max(0, spent / cap));
}

/** Reads a GET /api/tokens reply defensively. The route says `unit: "cr"` for a credit workspace. */
export function parseTokens(value: unknown): { unit: TokenUnit; tokens: ApiToken[] } | null {
  if (!value || typeof value !== "object") return null;
  const { tokens, unit } = value as { tokens?: unknown; unit?: unknown };
  if (!Array.isArray(tokens)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out: ApiToken[] = [];
  for (const t of tokens) {
    if (!t || typeof t !== "object") return null;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string") return null;
    out.push({
      id: r.id, name: r.name, scope: r.scope === "read" ? "read" : "render",
      lastUsed: num(r.lastUsed), createdAt: num(r.createdAt) ?? 0,
      spendThisMonth: num(r.spendThisMonth) ?? 0,
      capCredits: num(r.capCredits), legacyCeiling: r.legacyCeiling === true,
      capUsd: num(r.capUsd),
    });
  }
  return { unit: unit === "cr" || unit === "credits" ? "credits" : "usd", tokens: out };
}

/**
 * The ceiling field, read the way POST /api/tokens reads it (lib/tokenCeiling.ts).
 * Blank is "no ceiling" and has to be said on purpose (`blank`), so the page
 * can make the person confirm it rather than mint an unbounded token by
 * leaving a field empty.
 */
export function readCeiling(raw: string, unit: TokenUnit): { value: number | null; blank: boolean } | { error: string } {
  if (unit === "credits") {
    const read = parseCreditCeiling(raw);
    return "error" in read ? read : { value: read.capCredits, blank: read.capCredits == null };
  }
  const read = parseCeiling(raw);
  return "error" in read ? read : { value: read.capUsd, blank: read.capUsd == null };
}

/** The body a POST /api/tokens sends: the ceiling in the workspace's unit, and none on a read-only token. */
export function tokenBody(name: string, scope: "read" | "render", unit: TokenUnit, ceiling: number | null) {
  if (scope === "read" || ceiling == null) return { name, scope };
  return unit === "credits" ? { name, scope, capCredits: ceiling } : { name, scope, capUsd: ceiling };
}
