/**
 * The connected account's motion presets (`presets_show`, slice A3): read
 * through the toolset guard, reduced to `{id, name}` (previews and links
 * dropped) and cached in memory for one hour per connection. A request that
 * carries a presetId is priced only when that id is in this live listing.
 */
import { createHash } from "node:crypto";
import { requireTenant } from "@/lib/tenant";
import { readConnectedPlannerReads } from "./mcp";
import { summarizePlannerReads } from "./planner-reads";
import { CatalogueError } from "./catalogue";

export const PRESETS_TTL_MS = 3_600_000;
const memory = new Map<string, { presets: { id: string; name: string }[]; expiresAt: number }>();

export async function connectedPresets(userId: string, access: { accessToken: string; generation: string }, options: { refresh?: boolean } = {}) {
  const key = createHash("sha256").update(`${requireTenant().id}:${userId}:${access.generation}`).digest("hex");
  const cached = memory.get(key);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.presets;
  const results = await readConnectedPlannerReads(access.accessToken, [{ name: "presets", tool: "presets_show", args: {} }]);
  if (results[0]?.unavailable) throw new CatalogueError("parameter_invalid", "The connected account does not currently list motion presets.");
  const presets = summarizePlannerReads(results).presets;
  memory.set(key, { presets, expiresAt: Date.now() + PRESETS_TTL_MS });
  while (memory.size > 256) memory.delete(memory.keys().next().value!);
  return presets;
}
/** Refuses a preset the live listing does not contain (read once more on a miss). */
export async function requireConnectedPreset(userId: string, access: { accessToken: string; generation: string }, presetId: string) {
  if ((await connectedPresets(userId, access)).some((preset) => preset.id === presetId)) return;
  if ((await connectedPresets(userId, access, { refresh: true })).some((preset) => preset.id === presetId)) return;
  throw new CatalogueError("parameter_invalid", "That motion preset is not offered by the connected account.");
}
