/**
 * The website-only tools a managed workspace may run through the platform's
 * designated website account, and how each one is priced for a client.
 *
 * Pure (no database, no network, no prices) so the platform desk can label
 * them. What a tool costs is private server configuration
 * (lib/vendorRates.ts); whether it is on is the platform desk's allowlist
 * (lib/higgsfield-consumer/platform-account.ts). A tool is available to
 * clients only when both say so, and until then every quote refuses exactly
 * as a managed workspace always has (`particl_quote_unavailable`).
 *
 * `get_cost` tools are priced by the account's own non-submitting cost form;
 * `fixed` tools have no such form, so each needs a private per-operation
 * price before it can be switched on (owner decision, 27 September).
 */
import type { ConsumerWorkflow } from "./jobs";

export const WEBSITE_TOOL_IDS = [
  "marketing-video",
  "shorts",
  "reframe",
  "marketing-template",
  "generation",
  "voice-change",
  "dubbing",
  "video-analysis",
  "virality",
  "soul-build",
  "element-build",
] as const;
export type WebsiteToolId = (typeof WEBSITE_TOOL_IDS)[number];
export type WebsiteToolPricing = "get_cost" | "fixed";
export type WebsiteTool = {
  id: WebsiteToolId;
  /** The platform desk's name for it. Never shown to clients with a provider name. */
  label: string;
  pricing: WebsiteToolPricing;
};

export const WEBSITE_TOOLS: readonly WebsiteTool[] = Object.freeze([
  { id: "marketing-video", label: "Marketing video", pricing: "get_cost" },
  { id: "shorts", label: "Shorts", pricing: "get_cost" },
  { id: "reframe", label: "Reframe", pricing: "get_cost" },
  { id: "marketing-template", label: "Ad templates", pricing: "get_cost" },
  { id: "generation", label: "Account models", pricing: "get_cost" },
  { id: "voice-change", label: "Change voice", pricing: "fixed" },
  { id: "dubbing", label: "Dub", pricing: "fixed" },
  { id: "video-analysis", label: "Analyse video", pricing: "fixed" },
  { id: "virality", label: "Virality score", pricing: "fixed" },
  { id: "soul-build", label: "Identity build", pricing: "fixed" },
  { id: "element-build", label: "Element build", pricing: "fixed" },
] satisfies WebsiteTool[]);

export const isWebsiteToolId = (value: unknown): value is WebsiteToolId =>
  typeof value === "string" && (WEBSITE_TOOL_IDS as readonly string[]).includes(value);
export const websiteTool = (id: WebsiteToolId): WebsiteTool => WEBSITE_TOOLS.find((tool) => tool.id === id)!;

/** The voice-tool pipeline's tool names, as lib/higgsfield-consumer/voice-tools.ts names them. */
const VOICE_TOOL_IDS: Record<string, WebsiteToolId> = {
  reframe: "reframe",
  voice_change: "voice-change",
  dubbing: "dubbing",
  video_analysis: "video-analysis",
};

/**
 * Which website tool a consumer workflow request is, or null when the
 * workflow is not a website tool for clients at all: Genjutsu runs on the
 * platform's commercial API through the Studio engines, and reference
 * matching needs a grant the website account cannot give.
 */
export function websiteToolFor(workflow: ConsumerWorkflow, voiceTool?: string | null): WebsiteToolId | null {
  switch (workflow) {
    case "marketing-video":
    case "shorts":
    case "marketing-template":
    case "generation":
    case "virality":
      return workflow;
    case "voice-tool":
      return voiceTool ? (VOICE_TOOL_IDS[voiceTool] ?? null) : null;
    default:
      return null;
  }
}

/**
 * Where a tool runs for a managed workspace — ONE seam for every website
 * tool. The platform's commercial API key is always preferred: a feature the
 * key can serve never goes through the website account (owner, 27
 * September), and it is priced by that API's own dollar estimate through the
 * existing retail credit policy, with no website-credit conversion. The map
 * names the existing Particl route that serves a feature with the key; a tool
 * with no entry has no key-served equivalent yet and may fall back to the
 * designated website account, whose website credits are converted with the
 * private rate (lib/vendorRates.ts › websiteAccountCreditUsd).
 */
export const COMMERCIAL_API_ROUTES: Readonly<Partial<Record<ConsumerWorkflow | WebsiteToolId, string>>> = Object.freeze({
  // Motion Transfer and Object Swap run on the commercial API in the Studio
  // engines (lib/genjutsu.ts), with its own estimate, reservation and receipt.
  genjutsu: "studio-engines",
  // New identities are trained on the commercial API (custom references) from
  // Cast › Build identity (lib/soulIdentities.ts), never on the website account.
  "soul-build": "studio-identities",
});
/** Whether the commercial API serves this tool, so the website account never does. */
export const servedByCommercialApi = (tool: WebsiteToolId) => COMMERCIAL_API_ROUTES[tool] !== undefined;
export type WebsiteToolTransport =
  | { kind: "commercial_api"; route: string }
  | { kind: "website_account"; tool: WebsiteToolId }
  | { kind: "none" };
export function websiteToolTransport(target: { workflow: ConsumerWorkflow; voiceTool?: string | null } | { tool: WebsiteToolId }): WebsiteToolTransport {
  const tool = "tool" in target ? target.tool : websiteToolFor(target.workflow, target.voiceTool);
  const route = ("workflow" in target ? COMMERCIAL_API_ROUTES[target.workflow] : undefined) ?? (tool ? COMMERCIAL_API_ROUTES[tool] : undefined);
  if (route) return { kind: "commercial_api", route };
  return tool ? { kind: "website_account", tool } : { kind: "none" };
}

/**
 * Website tools whose client quote, reservation and settlement are built
 * (step W3 onwards adds them one at a time). Until a tool is listed here it
 * refuses for every managed workspace, whatever the platform desk says.
 */
export const WEBSITE_BILLING_READY: ReadonlySet<WebsiteToolId> = new Set<WebsiteToolId>([]);
