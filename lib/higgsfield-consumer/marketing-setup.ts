import { requireTenant } from "@/lib/tenant";
import { getConsumerAccess, ConsumerOAuthError } from "./oauth";
import { readConnectedPlannerReads } from "./mcp";
import { CONNECTED_LIST_KEYS } from "./video-contract";
import { SETUP_TYPES, type SetupItem, type SetupType } from "@/lib/shell/business";

/** The six item types, for the route's schema. */
export const SETUP_TYPE_IDS = SETUP_TYPES.map((t) => t[0]) as [SetupType, ...SetupType[]];

/**
 * Marketing Studio setup items (FINAL_SPEC §2.3): products, avatars, hooks,
 * settings, ad references, brand kits — read from the connected account's
 * `show_marketing_studio` tool, which its own `marketing_studio_video`
 * schema points at ("get available ids from `show_marketing_studio` with
 * `type='hook'`"). The tool is read only when the account advertises it; the
 * list otherwise reports itself unavailable, never empty-as-if-true.
 *
 * Creating items (products fetch --url, avatars from photos, ad references
 * from a video, brand kits) has no tool on the account's advertised toolset;
 * the page says so and names the CLI command that does it.
 */
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 160) => (typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The list a reply carries, whatever the provider nested it under. */
function listIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!record(value)) return [];
  for (const key of CONNECTED_LIST_KEYS) if (Array.isArray(value[key])) return value[key] as unknown[];
  if (Array.isArray(value.setup_items)) return value.setup_items as unknown[];
  return [];
}

export function parseSetupItems(value: unknown, type: SetupType, limit = 200): SetupItem[] {
  const out: SetupItem[] = [];
  for (const entry of listIn(value).slice(0, limit)) {
    if (!record(entry)) continue;
    const id = text(entry.id ?? entry.uuid, 200);
    if (!id) continue;
    const name = text(entry.name ?? entry.title ?? entry.prompt ?? entry.url ?? id);
    const pieces = [
      type,
      typeof entry.source === "string" ? text(entry.source, 40) : "",
      typeof entry.status === "string" ? text(entry.status, 40) : "",
      typeof entry.type === "string" && entry.type !== type ? text(entry.type, 40) : "",
      type === "hook" && typeof entry.prompt === "string" && entry.prompt !== name ? "prepended to the prompt" : "",
    ].filter(Boolean);
    const preview = [entry.preview_url, entry.image_url, entry.thumbnail_url, entry.url].find((v) => typeof v === "string" && /^https:\/\//i.test(v));
    out.push({ id, type, name: name || id, meta: pieces.join(" · "), previewUrl: typeof preview === "string" ? preview.slice(0, 2048) : null });
  }
  return out;
}

export type SetupRead = { type: SetupType; available: boolean; items: SetupItem[] };

export async function connectedMarketingSetup(userId: string, types: readonly SetupType[] = SETUP_TYPE_IDS): Promise<{ connected: boolean; reads: SetupRead[] }> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, reads: types.map((type) => ({ type, available: false, items: [] })) };
  try {
    const results = await readConnectedPlannerReads(access.accessToken, types.map((type) => ({ name: "setup" as const, tool: "show_marketing_studio", args: { type } })));
    return { connected: true, reads: types.map((type, i) => ({ type, available: !results[i]?.unavailable, items: results[i]?.unavailable ? [] : parseSetupItems(results[i]?.value, type) })) };
  } catch (error) {
    if (error instanceof ConsumerOAuthError) return { connected: false, reads: types.map((type) => ({ type, available: false, items: [] })) };
    throw error;
  }
}
