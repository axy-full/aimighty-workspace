import { requireTenant } from "@/lib/tenant";
import { getConsumerAccess, ConsumerOAuthError } from "./oauth";
import { readConnectedPlannerReads } from "./mcp";
import { CONNECTED_LIST_KEYS } from "./video-contract";
import { SETUP_TYPES, isOwnedSetup, type SetupItem, type SetupType } from "@/lib/shell/business";
import { parseCharacters, type ConnectedCharacter } from "./soul-build";
import { onlyParticlCharacters } from "./character-records";
import { particlSetup, type ParticlSetup } from "./marketing-records";

/** The seven item types, for the route's schema. */
export const SETUP_TYPE_IDS = SETUP_TYPES.map((t) => t[0]) as [SetupType, ...SetupType[]];

/**
 * Marketing Studio setup items (FINAL_SPEC §2.3): avatars, products, brand
 * kits, ad references, hooks, settings and ad styles — read from the connected
 * account's `show_marketing_studio` tool, which its own
 * `marketing_studio_video` schema points at. The tool is read only when the
 * account advertises it; the list otherwise reports itself unavailable, never
 * empty-as-if-true.
 *
 * Particl is a standalone platform (owner's rule, 23 September): the account
 * is its engine, not its library. The account's own avatars, products, brand
 * kits and ad references are never listed — only the ones Particl made
 * (marketing-records.ts) — and the avatars are the Soul IDs built in Cast.
 * Hooks, settings and ad styles are the account's shared catalogue and are
 * listed, except any the account marks as its user's own.
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

type Keep = (entry: Record<string, unknown>, id: string) => boolean;

export function parseSetupItems(value: unknown, type: SetupType, limit = 200, keep: Keep = () => true): SetupItem[] {
  const out: SetupItem[] = [];
  for (const entry of listIn(value).slice(0, limit)) {
    if (!record(entry)) continue;
    const id = text(entry.id ?? entry.uuid, 200);
    if (!id || !keep(entry, id)) continue;
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

/** The words an account uses for its user's own items, in any of the keys it has used to say so. */
const OWN_WORD = /^(custom|user|own|mine|personal|private|uploaded|created|workspace|account)$/i;
const OWN_KEYS = ["source", "origin", "ownership", "kind", "type", "visibility", "scope"];
const OWNER_IDS = ["owner", "user_id", "owner_id", "created_by", "creator_id", "workspace_id", "account_id"];
/** An owner field naming the provider itself is a preset's, not a user's. */
const SHARED_OWNER = /^(system|platform|preset|default|global|public|higgsfield)$/i;
/**
 * Pure: whether the account marks this entry as its user's own rather than a
 * shared preset. Fails closed: any sign of ownership counts.
 */
export function accountOwnEntry(entry: Record<string, unknown>): boolean {
  if (OWN_KEYS.some((key) => typeof entry[key] === "string" && OWN_WORD.test((entry[key] as string).trim()))) return true;
  if (entry.is_custom === true || entry.custom === true || entry.is_preset === false || entry.preset === false) return true;
  return OWNER_IDS.some((key) => {
    const value = entry[key];
    return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !SHARED_OWNER.test(value.trim()));
  });
}

/**
 * Pure: the account's list for one type, narrowed to what Particl may show.
 * A library type keeps only the ids Particl made; a catalogue type keeps its
 * presets and drops anything the account marks as its user's own.
 */
export function standaloneSetupItems(value: unknown, type: SetupType, ours: ReadonlySet<string>): SetupItem[] {
  return parseSetupItems(value, type, 200, isOwnedSetup(type) ? (_entry, id) => ours.has(id) : (entry, id) => ours.has(id) || !accountOwnEntry(entry));
}

/** Pure: the Soul IDs built in Cast, as avatars — only Particl's, only the usable ones. */
export function castAvatars(characters: readonly ConnectedCharacter[], ours: ReadonlySet<string>): SetupItem[] {
  return onlyParticlCharacters(characters, ours)
    .filter((c) => c.status !== "training" && c.status !== "failed")
    .map((c) => ({ id: c.soulId, type: "avatar" as const, name: c.name, meta: ["Soul ID", c.type === "soul_cinematic" ? "Cinematic" : c.type === "soul_2" ? "Soul 2" : ""].filter(Boolean).join(" · "), previewUrl: c.previewUrl }));
}

export type SetupRead = { type: SetupType; available: boolean; items: SetupItem[] };

/** Pure: the reads the route answers with, from the account's replies and what Particl made. */
export function standaloneReads(
  types: readonly SetupType[],
  results: readonly ({ unavailable?: boolean; value?: unknown } | undefined)[],
  characters: { unavailable?: boolean; value?: unknown } | null,
  ours: ParticlSetup,
): SetupRead[] {
  return types.map((type, i) => {
    const result = results[i];
    const listed = !result || result.unavailable ? null : standaloneSetupItems(result.value, type, ours.items[type] ?? new Set());
    if (type !== "avatar") return { type, available: listed !== null, items: listed ?? [] };
    const cast = !characters || characters.unavailable ? null : castAvatars(parseCharacters(characters.value), ours.cast);
    const seen = new Set<string>();
    const items = [...(cast ?? []), ...(listed ?? [])].filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
    return { type, available: listed !== null || cast !== null, items };
  });
}

export async function connectedMarketingSetup(userId: string, types: readonly SetupType[] = SETUP_TYPE_IDS): Promise<{ connected: boolean; reads: SetupRead[] }> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, reads: types.map((type) => ({ type, available: false, items: [] })) };
  try {
    const avatars = types.includes("avatar");
    const results = await readConnectedPlannerReads(access.accessToken, [
      ...types.map((type) => ({ name: "setup" as const, tool: "show_marketing_studio", args: { type } })),
      ...(avatars ? [{ name: "characters" as const, tool: "show_characters", args: { action: "list", size: 100 } }] : []),
    ]);
    return { connected: true, reads: standaloneReads(types, results.slice(0, types.length), avatars ? results[types.length] ?? null : null, await particlSetup(userId)) };
  } catch (error) {
    if (error instanceof ConsumerOAuthError) return { connected: false, reads: types.map((type) => ({ type, available: false, items: [] })) };
    throw error;
  }
}
