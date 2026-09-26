import { discoverConsumerTools, type DiscoveredConsumerTool } from "./mcp";
import { CONNECTED_REACH, reachFromTools, type ConnectedReachId } from "./reach";

/** Lexical hints help inspect a catalogue; they do not verify usable features. */
export function summarizeConsumerTools(tools: DiscoveredConsumerTool[]) {
  const categories = {
    marketingVideo:
      /marketing[\s_-]*(?:studio[\s_-]*)?video|consumer[\s_-]*marketing/,
    brandExtraction:
      /brand[\s_-]*(?:kit|fetch|extract)|(?:fetch|extract)[\s_-]*brand/,
    adReference: /ad[\s_-]*reference|reference[\s_-]*ad/,
    virality: /viral|brain[\s_-]*activity/,
    workspace: /workspace/,
    uploads: /upload|media[\s_-]*(?:create|confirm)/,
    jobs: /job|generation[\s_-]*(?:get|list|status)/,
    pricing: /cost|pric|estimate|credit/,
  };
  return Object.fromEntries(
    Object.entries(categories).map(([category, pattern]) => [
      category,
      tools
        .filter((tool) =>
          pattern.test(`${tool.name} ${tool.description ?? ""}`.toLowerCase()),
        )
        .map((tool) => tool.name),
    ]),
  ) as Record<keyof typeof categories, string[]>;
}

export async function discoverConsumerCapabilities(
  accessToken: string,
  signal?: AbortSignal,
) {
  const catalogue = await discoverConsumerTools(accessToken, { signal });
  return {
    status: "discovered" as const,
    discoveryOnly: true as const,
    capabilitiesVerified: false as const,
    ...catalogue,
    summary: summarizeConsumerTools(catalogue.tools),
  };
}

/**
 * Atomik › Tools & connections: the same free tools/list read, reduced to one
 * flag per capability row. Tool names, descriptions and schemas stay on the
 * server; only row ids, flags and counts are returned. `off` names rows the
 * platform has switched off, which read as off whatever the account offers.
 */
export async function discoverAtomikReach(
  accessToken: string,
  options: { signal?: AbortSignal; off?: readonly ConnectedReachId[]; now?: number } = {},
) {
  const catalogue = await discoverConsumerTools(accessToken, { signal: options.signal });
  const reach = reachFromTools(catalogue.tools.map((tool) => tool.name), { off: options.off });
  return {
    status: "checked" as const,
    checkedAt: options.now ?? Date.now(),
    reach,
    available: reach.filter((row) => row.available).length,
    total: CONNECTED_REACH.length,
  };
}
