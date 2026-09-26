/**
 * Atomik › Tools & connections: what Atomik can reach, and how an assistant
 * elsewhere reaches Particl.
 *
 * It replaced a list of skill packs that said "the agent's tool reach is
 * these packs" while nothing in Particl read them. Every row here is backed
 * by code that runs, and opens the place in Suites where it runs:
 *  - Particl's own reach is built in (the agent, Particl's engines, sound,
 *    Astra, and Particl's own MCP tools);
 *  - the connected account's reach is checked live against its tools/list
 *    (lib/higgsfield-consumer/reach.ts, owner only, free);
 *  - the assistant side is Particl's own MCP server (/api/mcp, lib/mcp.ts
 *    TOOLS), the workspace's API tokens (/api/tokens) and, for anyone who
 *    used them from the old page, the public skill packs (lib/shell/skills.ts).
 *
 * Pure (no network, no React) so the unit specs read the same rules the page
 * renders.
 */
import { CONNECTED_REACH, parseReach, type ConnectedReachId, type ReachCheck } from "@/lib/higgsfield-consumer/reach";
import { TOOLS } from "@/lib/mcp";
import { parseCeiling, parseCreditCeiling } from "@/lib/tokenCeiling";
import type { ShellSuiteId } from "./ia";

export type ToolsTab = "reach" | "connect";

/** Where a row opens: a suite page, the Gen view, or this page's other tab. */
export type ReachOpen =
  | { suite: ShellSuiteId; page: string; label: string }
  | { gen: true; label: string }
  | { tab: ToolsTab; label: string };

export type ReachStatus =
  /** Particl's own; nothing to check. */
  | "built-in"
  | "available"
  /** The account does not advertise a tool this needs. */
  | "missing"
  /** The platform has the feature switched off. */
  | "off"
  /** Only the workspace owner holds the connected account, so only they use and check it. */
  | "owner-only"
  /** No connected account, or it needs signing in again. */
  | "connect"
  | "checking"
  | "error";

export type ReachRow = { id: string; label: string; line: string; group: "particl" | "connected"; status: ReachStatus; open?: ReachOpen };

const AGENT: ReachOpen = { suite: "atomik", page: "agent", label: "Agent" };
const GEN: ReachOpen = { gen: true, label: "Gen" };
const SOUND: ReachOpen = { suite: "studio", page: "edit", label: "Edit & Sound" };
const CAST: ReachOpen = { suite: "studio", page: "cast", label: "Cast" };

export const PARTICL_REACH: readonly Omit<ReachRow, "status" | "group">[] = Object.freeze([
  { id: "plan", label: "Plan & price", line: "Plans against the project; every request is priced before it runs", open: AGENT },
  { id: "thinking", label: "Thinking models", line: "The model Atomik plans with, and how hard it thinks", open: { suite: "atomik", page: "models", label: "Models" } },
  { id: "engines", label: "Particl engines", line: "Video, stills and sound on Particl’s own engines", open: GEN },
  { id: "sound", label: "Voice, sound & music", line: "Narration, effects and score for the cut", open: SOUND },
  { id: "astra", label: "Astra 3D", line: "Block a scene in 3D before anything renders", open: { suite: "studio", page: "astra", label: "Astra" } },
  { id: "assistant", label: "Your own assistant", line: `Particl’s ${TOOLS.length} tools in Claude or ChatGPT, with a token you control`, open: { tab: "connect", label: "Claude & ChatGPT" } },
]);

/** Where each connected capability runs in Suites (lib/higgsfield-consumer/reach.ts lists what each needs). */
export const CONNECTED_OPEN: Readonly<Record<ConnectedReachId, ReachOpen>> = Object.freeze({
  models: GEN, image: GEN, video: GEN, audio: GEN, files: GEN, analysis: GEN,
  follow: { suite: "studio", page: "takes", label: "Takes" },
  characters: CAST, elements: CAST,
  voice: SOUND, dub: SOUND,
  reframe: { suite: "studio", page: "deliver", label: "Deliver" },
  templates: { suite: "business", page: "dtc", label: "Image ads" },
  motion: { suite: "viral", page: "motion", label: "Motion Transfer" },
});

/** What the page knows about the connected account right now. */
export type ReachState =
  | { kind: "owner-only" }
  | { kind: "checking" }
  | { kind: "connect"; reconnect?: boolean }
  | { kind: "error"; message: string }
  | { kind: "checked"; checks: ReachCheck[]; checkedAt: number };

/** Every row with its status: Particl's own first, then the connected account's. */
export function reachRows(state: ReachState): ReachRow[] {
  const checks = state.kind === "checked" ? new Map(state.checks.map((c) => [c.id, c])) : null;
  const connectedStatus = (id: ConnectedReachId): ReachStatus => {
    if (state.kind !== "checked") return state.kind;
    const check = checks?.get(id);
    return check?.off ? "off" : check?.available ? "available" : "missing";
  };
  return [
    ...PARTICL_REACH.map((row): ReachRow => ({ ...row, group: "particl", status: "built-in" })),
    ...CONNECTED_REACH.map((row): ReachRow => ({ id: row.id, label: row.label, line: row.line, group: "connected", status: connectedStatus(row.id), open: CONNECTED_OPEN[row.id] })),
  ];
}

/** A row's Open button shows only where the capability can be used now. */
export const usable = (status: ReachStatus) => status === "built-in" || status === "available";

export const STATUS_LABEL: Record<ReachStatus, string> = {
  "built-in": "Built in",
  available: "Available",
  missing: "Not offered",
  off: "Switched off",
  "owner-only": "Owner only",
  connect: "Connect first",
  checking: "Checking…",
  error: "Not checked",
};

/** "9 of 14 available", or what stands in the way and what to do. */
export function reachSummary(state: ReachState): string {
  if (state.kind === "checked") {
    const on = state.checks.filter((c) => c.available).length;
    return `${on} of ${CONNECTED_REACH.length} available`;
  }
  if (state.kind === "owner-only") return "Only the workspace owner uses the connected account";
  if (state.kind === "connect") return state.reconnect ? "Sign the account in again in Workspace › Engines" : "Connect the account in Workspace › Engines";
  if (state.kind === "checking") return "Checking the connected account…";
  return state.message;
}

/** Reads the capabilities route's reply (view "reach") into what the page shows. */
export function reachStateFrom(status: number, json: unknown, now = Date.now()): ReachState {
  const body = (json && typeof json === "object" ? json : {}) as { reach?: unknown; checkedAt?: unknown; code?: unknown; error?: unknown };
  if (status >= 200 && status < 300) {
    const checks = parseReach(body.reach);
    if (checks && checks.length === CONNECTED_REACH.length)
      return { kind: "checked", checks, checkedAt: typeof body.checkedAt === "number" && Number.isFinite(body.checkedAt) ? body.checkedAt : now };
    return { kind: "error", message: "The account’s answer could not be read. Try again." };
  }
  if (body.code === "not_connected") return { kind: "connect" };
  if (body.code === "reconnect_required") return { kind: "connect", reconnect: true };
  if (status === 403) return { kind: "owner-only" };
  if (status === 429) return { kind: "error", message: "Checked too often. Try again in a minute." };
  return { kind: "error", message: "The connected account could not be checked. Try again, or open Workspace › Engines." };
}

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
