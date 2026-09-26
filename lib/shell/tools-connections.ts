/**
 * Atomik › Tools & connections: what the agent can reach, and how an
 * assistant elsewhere reaches Particl.
 *
 * Replaces the pack list this page used to show (install commands for packs
 * nothing in Particl reads). Every row here is backed by code that runs:
 *  - Particl's own reach is built in (the planner, Particl's engines, voice);
 *  - the connected account's reach is checked live against its tools/list
 *    (lib/higgsfield-consumer/reach.ts, owner only, free);
 *  - the assistant side is Particl's own MCP server (/api/mcp, lib/mcp.ts
 *    TOOLS) and the workspace's API tokens (/api/tokens).
 *
 * Pure (no network, no React) so the unit specs read the same rules the page
 * renders.
 */
import { CONNECTED_REACH, type ConnectedReachId, type ReachCheck } from "@/lib/higgsfield-consumer/reach";
import { TOOLS } from "@/lib/mcp";
import type { ShellSuiteId } from "./ia";

/** Where a row opens: a suite page, or the Gen view. */
export type ReachOpen = { suite: ShellSuiteId; page: string; label: string } | { gen: true; label: string };

export type ReachStatus =
  /** Particl's own; nothing to check. */
  | "built-in"
  | "available"
  | "missing"
  /** Only the workspace owner holds the connected account, so only they can check it. */
  | "owner-only"
  /** No connected account (or it needs signing in again). */
  | "connect"
  | "checking"
  | "error";

export type ReachRow = { id: string; label: string; line: string; group: "particl" | "connected"; status: ReachStatus; open?: ReachOpen };

const AGENT: ReachOpen = { suite: "atomik", page: "agent", label: "Agent" };
const GEN: ReachOpen = { gen: true, label: "Generate" };

export const PARTICL_REACH: readonly Omit<ReachRow, "status" | "group">[] = Object.freeze([
  { id: "plan", label: "Plan & price", line: "A brief becomes takes, each priced, none run before Approve", open: AGENT },
  { id: "engines", label: "Particl engines", line: "Video and stills on Particl’s own models", open: GEN },
  { id: "sound", label: "Voice, sound & music", line: "Narration, effects and score for the cut", open: { suite: "studio", page: "edit", label: "Edit & Sound" } },
]);

const CONNECTED_OPEN: Partial<Record<ConnectedReachId, ReachOpen>> = {
  models: { suite: "atomik", page: "models", label: "Models" },
  image: GEN, video: GEN, audio: GEN, "3d": GEN,
  batch: AGENT, presets: AGENT, files: AGENT, recipes: AGENT,
  follow: { suite: "atomik", page: "runs", label: "Runs" },
  voice: { suite: "studio", page: "edit", label: "Edit & Sound" },
  marketing: { suite: "business", page: "ads", label: "Ads" },
};

/** What the page knows about the connected account right now. */
export type ReachState =
  | { kind: "owner-only" }
  | { kind: "checking" }
  | { kind: "connect"; reconnect?: boolean }
  | { kind: "error"; message: string }
  | { kind: "checked"; checks: ReachCheck[]; checkedAt: number };

/** Every row with its status: Particl's own first, then the connected account's. */
export function reachRows(state: ReachState): ReachRow[] {
  const flags = state.kind === "checked" ? new Map(state.checks.map((c) => [c.id, c.available])) : null;
  const connectedStatus = (id: ConnectedReachId): ReachStatus => {
    if (state.kind === "checked") return flags?.get(id) ? "available" : "missing";
    return state.kind;
  };
  return [
    ...PARTICL_REACH.map((row): ReachRow => ({ ...row, group: "particl", status: "built-in" })),
    ...CONNECTED_REACH.map((row): ReachRow => ({ id: row.id, label: row.label, line: row.line, group: "connected", status: connectedStatus(row.id), open: CONNECTED_OPEN[row.id] })),
  ];
}

export const STATUS_LABEL: Record<ReachStatus, string> = {
  "built-in": "Built in",
  available: "Available",
  missing: "Not offered",
  "owner-only": "Owner checks",
  connect: "Connect first",
  checking: "Checking…",
  error: "Not checked",
};

/** "9 of 13 available", or what stands in the way. */
export function reachSummary(state: ReachState): string {
  if (state.kind === "checked") {
    const on = state.checks.filter((c) => c.available).length;
    return `${on} of ${CONNECTED_REACH.length} available`;
  }
  if (state.kind === "owner-only") return "The workspace owner checks these";
  if (state.kind === "connect") return state.reconnect ? "Reconnect the account in Workspace › Engines" : "Connect the account in Workspace › Engines";
  if (state.kind === "checking") return "Checking the connected account…";
  return state.message;
}

/* ── Particl as an MCP server ─────────────────────────────────────────── */

/** Tools that write: a read-only token is refused them (lib/auth withTenant). */
const WRITES = new Set(["render_shot", "create_project"]);
/** One line per tool; tests/unit/toolsConnections.spec.ts fails when lib/mcp.ts gains a tool this page does not describe. */
export const MCP_TOOL_LINES: Readonly<Record<string, string>> = Object.freeze({
  render_shot: "Starts a video take and returns its id",
  wait_for_render: "Waits for a take, then reports what it cost",
  list_renders: "Recent takes, by project, status or prompt",
  get_render: "One take, with a link to watch or save it",
  list_projects: "Projects with their counts and spend",
  create_project: "Makes a project to file takes under",
  usage_summary: "Spent, remaining, running now",
});

export type McpToolRow = { name: string; line: string; token: "any" | "generate" };
export function mcpTools(): McpToolRow[] {
  return TOOLS.map((tool) => ({ name: tool.name, line: MCP_TOOL_LINES[tool.name] ?? tool.description.split(". ")[0], token: WRITES.has(tool.name) ? "generate" : "any" }));
}

export const TOKEN_PLACEHOLDER = "aw_your_token_here";
export const mcpEndpoint = (origin: string) => `${origin}/api/mcp`;
export const bridgeUrl = (origin: string) => `${origin}/particl-mcp.mjs`;
export const openapiUrl = (origin: string) => `${origin}/api/openapi`;

export type ClientId = "claude-code" | "claude-desktop" | "chatgpt" | "other";
export const CLIENTS: readonly { id: ClientId; label: string }[] = Object.freeze([
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "other", label: "Any MCP client" },
]);
export type SetupStep = { label: string; code: string };

/**
 * The copyable steps for one client, with the workspace's own address and
 * (once one is made) the new token filled in. The desktop config starts the
 * bridge through `sh` so `$HOME` expands — a desktop app launches `node`
 * without a shell, and a literal `~` would not resolve.
 */
export function setupSteps(client: ClientId, origin: string, token: string): SetupStep[] {
  const key = token || TOKEN_PLACEHOLDER;
  const download = { label: "Download the bridge once", code: `curl -o ~/particl-mcp.mjs ${bridgeUrl(origin)}` };
  const check = { label: "Check it", code: `PARTICL_URL=${origin} PARTICL_TOKEN=${key} node ~/particl-mcp.mjs --check` };
  if (client === "claude-code")
    return [download, { label: "Add it", code: `claude mcp add particl --env PARTICL_URL=${origin} --env PARTICL_TOKEN=${key} -- node ~/particl-mcp.mjs` }, check];
  if (client === "claude-desktop")
    return [download, {
      label: "Add to claude_desktop_config.json, then restart",
      code: JSON.stringify({
        mcpServers: {
          particl: {
            command: "sh",
            args: ["-c", "exec node \"$HOME/particl-mcp.mjs\""],
            env: { PARTICL_URL: origin, PARTICL_TOKEN: key },
          },
        },
      }, null, 2),
    }, check];
  if (client === "chatgpt")
    return [
      { label: "GPT › Configure › Actions › Import from URL", code: openapiUrl(origin) },
      { label: "Authentication › API key › Bearer", code: key },
    ];
  return [
    { label: "Server URL (streamable HTTP)", code: mcpEndpoint(origin) },
    { label: "Header", code: `Authorization: Bearer ${key}` },
  ];
}

/* ── Tokens ───────────────────────────────────────────────────────────── */

export type ApiToken = {
  id: string; name: string; scope: "read" | "render";
  lastUsed: number | null; createdAt: number;
  /** Credits workspaces. */
  capCredits?: number | null; spendCredits?: number; legacyCeiling?: boolean;
  /** Workspaces on their own keys. */
  capUsd?: number | null; spendThisMonth?: number;
};
export type TokenUnit = "credits" | "usd";

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
      const spent = token.spendCredits ?? 0;
      if (token.capCredits != null) parts.push(`${cr(spent)} of ${cr(token.capCredits)} this month`);
      else if (spent > 0) parts.push(`${cr(spent)} this month`);
      if (token.legacyCeiling) parts.push("older ceiling applies");
    } else {
      const spent = token.spendThisMonth ?? 0;
      if (token.capUsd != null) parts.push(`${usd(spent)} of ${usd(token.capUsd)} this month`);
      else if (spent > 0) parts.push(`${usd(spent)} this month`);
    }
  }
  parts.push(token.lastUsed ? `used ${ago(token.lastUsed, now)}` : "never used");
  return parts.join(" · ");
}

/** Share of the ceiling spent, 0–1, or null when there is no ceiling to measure against. */
export function ceilingShare(token: ApiToken, unit: TokenUnit): number | null {
  const cap = unit === "credits" ? token.capCredits : token.capUsd;
  const spent = unit === "credits" ? token.spendCredits ?? 0 : token.spendThisMonth ?? 0;
  if (token.scope !== "render" || cap == null || cap <= 0) return null;
  return Math.min(1, Math.max(0, spent / cap));
}

/** Reads a GET /api/tokens reply defensively. */
export function parseTokens(value: unknown): { unit: TokenUnit; tokens: ApiToken[] } | null {
  if (!value || typeof value !== "object") return null;
  const { tokens, unit } = value as { tokens?: unknown; unit?: unknown };
  if (!Array.isArray(tokens)) return null;
  const out: ApiToken[] = [];
  for (const t of tokens) {
    if (!t || typeof t !== "object") return null;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string") return null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out.push({
      id: r.id, name: r.name, scope: r.scope === "read" ? "read" : "render",
      lastUsed: num(r.lastUsed), createdAt: num(r.createdAt) ?? 0,
      capCredits: num(r.capCredits), spendCredits: num(r.spendCredits) ?? 0, legacyCeiling: r.legacyCeiling === true,
      capUsd: num(r.capUsd), spendThisMonth: num(r.spendThisMonth) ?? 0,
    });
  }
  return { unit: unit === "credits" ? "credits" : "usd", tokens: out };
}

/** The ceiling field's value, or an error in the page's words. Blank is "no ceiling". */
export function readCeiling(raw: string, unit: TokenUnit): { value: number | null } | { error: string } {
  const text = raw.trim().replace(/,/g, "");
  if (!text) return { value: null };
  const n = Number(text);
  if (unit === "credits") {
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return { error: "A ceiling is a whole number of credits." };
    return { value: n };
  }
  if (!Number.isFinite(n) || n <= 0) return { error: "A ceiling is an amount above zero." };
  return { value: Math.round(n * 100) / 100 };
}
