import { requireTenant } from "@/lib/tenant";
import { getConsumerAccess, ConsumerOAuthError } from "./oauth";
import { readConnectedPlannerReads } from "./mcp";
import { CONNECTED_LIST_KEYS } from "./video-contract";
import { SETUP_TYPES, isOwnedSetup, type SetupItem, type SetupType } from "@/lib/shell/business";
import { PRESET_SETUP_TYPES, particlSetup, refuseForeignSetup, type ParticlSetup, type SetupIds } from "./marketing-records";

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
 * (marketing-records.ts). Avatars are Marketing Studio avatars (`avatar_ids`:
 * "the server resolves preset vs custom"), so the engine's preset avatars are
 * listed like its hooks, settings and ad styles; a custom one only when
 * Particl made it. A Soul ID built in Cast is a different object and is not
 * offered as an avatar until the engine is shown to accept one.
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
const PRESET_WORD = /^(preset|curated|system|default|stock|public|shared|global)$/i;
/**
 * Pure: whether the account marks this entry as one of the engine's presets.
 * Avatars need this positive mark (an account's avatar list mixes presets
 * with its user's custom ones); nothing marked its user's own ever passes.
 */
export function accountPresetEntry(entry: Record<string, unknown>): boolean {
  if (accountOwnEntry(entry)) return false;
  return entry.is_preset === true || entry.preset === true || OWN_KEYS.some((key) => typeof entry[key] === "string" && PRESET_WORD.test((entry[key] as string).trim()));
}
/** Pure: whether an entry of this type is the engine's shared catalogue rather than the account's library. */
function sharedEntry(type: SetupType): (entry: Record<string, unknown>) => boolean {
  if (type === "avatar") return accountPresetEntry;
  if (isOwnedSetup(type)) return () => false;
  return (entry) => !accountOwnEntry(entry);
}

/**
 * Pure: the account's list for one type, narrowed to what Particl may show:
 * what Particl made, plus the engine's shared presets (never a product, brand
 * kit or ad reference the account keeps for its user).
 */
export function standaloneSetupItems(value: unknown, type: SetupType, ours: ReadonlySet<string>): SetupItem[] {
  const shared = sharedEntry(type);
  return parseSetupItems(value, type, 200, (entry, id) => ours.has(id) || shared(entry));
}
/** Pure: the ids of the engine's shared presets in one list — what the quote guard accepts beside Particl's own. */
export function sharedSetupIds(value: unknown, type: SetupType): ReadonlySet<string> {
  const shared = sharedEntry(type);
  return new Set(parseSetupItems(value, type, 200, (entry) => shared(entry)).map((item) => item.id));
}

export type SetupRead = { type: SetupType; available: boolean; items: SetupItem[] };
type ReadResult = { unavailable?: boolean; value?: unknown } | undefined;

/** Pure: the reads the route answers with, from the account's replies and what Particl made. */
export function standaloneReads(types: readonly SetupType[], results: readonly ReadResult[], ours: ParticlSetup): SetupRead[] {
  return types.map((type, i) => {
    const result = results[i];
    if (!result || result.unavailable) return { type, available: false, items: [] };
    return { type, available: true, items: standaloneSetupItems(result.value, type, ours.items[type] ?? new Set()) };
  });
}

/* ── The engine's shared presets, for the quote guard ─────────────────── */
/**
 * Kept briefly per workspace, member, connection and type, so the quotes a
 * composer asks for right after Setup's read reuse it instead of reading the
 * account again. A stale entry only ever narrows what passes.
 */
const PRESETS_TTL_MS = 60_000;
const presetCache = new Map<string, { ids: ReadonlySet<string>; at: number }>();
const presetKey = (userId: string, generation: string, type: SetupType) => `${requireTenant().id}:${userId}:${generation}:${type}`;
function rememberPresets(userId: string, generation: string, type: SetupType, ids: ReadonlySet<string>) {
  presetCache.set(presetKey(userId, generation, type), { ids, at: Date.now() });
  while (presetCache.size > 512) presetCache.delete(presetCache.keys().next().value!);
}
const setupRead = (type: SetupType) => ({ name: "setup" as const, tool: "show_marketing_studio", args: { type } });

/** The engine's shared presets the account lists for these types; a type it does not list has none. */
export async function connectedSetupPresets(userId: string, types: readonly SetupType[]): Promise<Partial<Record<SetupType, ReadonlySet<string>>>> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  const out: Partial<Record<SetupType, ReadonlySet<string>>> = {};
  const missing: SetupType[] = [];
  for (const type of types) {
    if (!PRESET_SETUP_TYPES.includes(type)) { out[type] = new Set(); continue; }
    const hit = presetCache.get(presetKey(userId, access.generation, type));
    if (hit && Date.now() - hit.at < PRESETS_TTL_MS) out[type] = hit.ids;
    else missing.push(type);
  }
  if (missing.length) {
    const results = await readConnectedPlannerReads(access.accessToken, missing.map(setupRead));
    missing.forEach((type, i) => {
      const result = results[i];
      if (!result || result.unavailable) { out[type] = new Set(); return; }
      out[type] = sharedSetupIds(result.value, type);
      rememberPresets(userId, access.generation, type, out[type]!);
    });
  }
  return out;
}

/** The quote guard as the quote services run it: Particl's record, then the account's presets when needed. */
export function refuseForeignMarketingSetup(userId: string, wanted: SetupIds): Promise<void> {
  return refuseForeignSetup(userId, wanted, (types) => connectedSetupPresets(userId, types));
}

export async function connectedMarketingSetup(userId: string, types: readonly SetupType[] = SETUP_TYPE_IDS): Promise<{ connected: boolean; reads: SetupRead[] }> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, reads: types.map((type) => ({ type, available: false, items: [] })) };
  try {
    const results = await readConnectedPlannerReads(access.accessToken, types.map(setupRead));
    types.forEach((type, i) => {
      const result = results[i];
      if (PRESET_SETUP_TYPES.includes(type) && result && !result.unavailable) rememberPresets(userId, access.generation, type, sharedSetupIds(result.value, type));
    });
    return { connected: true, reads: standaloneReads(types, results, await particlSetup(userId)) };
  } catch (error) {
    if (error instanceof ConsumerOAuthError) return { connected: false, reads: types.map((type) => ({ type, available: false, items: [] })) };
    throw error;
  }
}
