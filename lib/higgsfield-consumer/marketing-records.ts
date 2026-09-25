/**
 * Particl's own record of the Marketing Studio setup items it made on the
 * connected account — products, avatars, brand kits and ad references —
 * modelled on the Soul ID record (character-records.ts). Particl is a
 * standalone platform: what the owner keeps on the account stays there.
 * Setup lists only these plus the engine's shared presets, and every quote
 * that names a setup item is checked here first. The guard runs inside the
 * quote services (generation-service.ts, video-service.ts), so the Business
 * composers, Atomik's planner and any crafted request all meet it.
 *
 * One database per workspace (lib/db), and every row carries the member whose
 * connection made it: a record never crosses a workspace or a connection.
 */
import { db, ready } from "@/lib/db";
import { ADS_MODEL, DTC_ADS_MODEL, IMAGE_ADS_MODEL, SETUP_TYPES, type SetupType } from "@/lib/shell/business";

const initialized = new WeakMap<ReturnType<typeof db>, Promise<void>>();
export async function consumerMarketingItemsReady() {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(
      client,
      client
        .execute(
          `CREATE TABLE IF NOT EXISTS higgsfield_consumer_marketing_items (
 user_id TEXT NOT NULL, type TEXT NOT NULL, item_id TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id, type, item_id))`,
        )
        .then(() => {})
        .catch((e) => {
          initialized.delete(client);
          throw e;
        }),
    );
  await initialized.get(client);
}

/** How Particl came by it: `created` when Particl asked the account to make it (from a still or a page in this workspace). */
export type SetupOrigin = "created";
export type SetupRecord = { userId: string; type: SetupType; itemId: string; projectId: string | null; name: string; origin: SetupOrigin };
const ITEM_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Remember a setup item Particl made. Idempotent on (member, type, id). */
export async function recordParticlSetupItem(record: SetupRecord): Promise<void> {
  if (!ITEM_ID.test(record.itemId)) return;
  await consumerMarketingItemsReady();
  await db().execute({
    sql: "INSERT OR IGNORE INTO higgsfield_consumer_marketing_items(user_id,type,item_id,project_id,name,origin,created_at) VALUES(?,?,?,?,?,?,?)",
    args: [record.userId, record.type, record.itemId, record.projectId, record.name.slice(0, 160), record.origin, Date.now()],
  });
}

/** What counts as Particl's: its recorded items, by type. */
export type ParticlSetup = { items: Partial<Record<SetupType, ReadonlySet<string>>> };
export const NO_PARTICL_SETUP: ParticlSetup = { items: {} };

export async function particlSetup(userId: string): Promise<ParticlSetup> {
  await consumerMarketingItemsReady();
  const rows = (await db().execute({ sql: "SELECT type, item_id FROM higgsfield_consumer_marketing_items WHERE user_id=? ORDER BY created_at DESC LIMIT 1000", args: [userId] })).rows;
  const items: Partial<Record<SetupType, Set<string>>> = {};
  for (const row of rows) (items[String(row.type) as SetupType] ??= new Set()).add(String(row.item_id));
  return { items };
}

/* ── The quote guard ─────────────────────────────────────────────────── */
/**
 * The types that may also be one of the engine's shared presets — the
 * account's catalogue, listed by Setup unless it marks an entry as its user's
 * own. Products, brand kits and ad references are only ever Particl's.
 */
export const PRESET_SETUP_TYPES: readonly SetupType[] = ["avatar", "hook", "setting", "image_style"];
/** The Marketing Studio models, whose hook, setting and style ids are setup ids (another model's `style_id` is not). */
const MARKETING_MODELS: readonly string[] = [ADS_MODEL, IMAGE_ADS_MODEL, DTC_ADS_MODEL];

/** Every setup id a request names, by type, plus any backend asset ids (Particl never sends those; its stills ride as media). */
export type SetupIds = Record<SetupType, string[]> & { assets: string[] };
const NONE = (): SetupIds => ({ avatar: [], product: [], brand_kit: [], ad_reference: [], hook: [], setting: [], image_style: [], assets: [] });
const ids = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** From a catalogue-generation input's parameters (the account's own names). */
export function setupIdsOfParameters(parameters: Record<string, unknown>, model?: string): SetupIds {
  const marketing = model !== undefined && MARKETING_MODELS.includes(model);
  const avatars = Array.isArray(parameters.avatars) ? parameters.avatars.map((a) => (a && typeof a === "object" ? (a as { id?: unknown }).id : a)) : [];
  return {
    ...NONE(),
    product: [...ids(parameters.product_ids), ...ids(parameters.web_product_ids)],
    avatar: [...ids(parameters.avatar_ids), ...ids(avatars)],
    brand_kit: ids(parameters.brand_kit_id),
    ad_reference: ids(parameters.ad_reference_id),
    hook: marketing ? ids(parameters.hook_id) : [],
    setting: marketing ? ids(parameters.setting_id) : [],
    image_style: marketing ? ids(parameters.style_id) : [],
    assets: ids(parameters.assets),
  };
}

/** From the marketing-video route's input (its camelCase names). */
export function setupIdsOfVideoInput(input: { productIds?: string[]; webProductIds?: string[]; avatars?: { id: string }[]; adReferenceId?: string; hookId?: string; settingId?: string }): SetupIds {
  return {
    ...NONE(),
    product: [...(input.productIds ?? []), ...(input.webProductIds ?? [])],
    avatar: (input.avatars ?? []).map((a) => a.id),
    ad_reference: input.adReferenceId ? [input.adReferenceId] : [],
    hook: input.hookId ? [input.hookId] : [],
    setting: input.settingId ? [input.settingId] : [],
  };
}

export type ForeignId = { type: SetupType | "assets"; id: string };
/**
 * Pure: the ids a request names that Particl may not send — not recorded as
 * Particl's and, for a preset type, not among the engine's shared presets the
 * account lists (`presets`, once read). Backend asset ids are always foreign.
 */
export function foreignSetupIds(wanted: SetupIds, ours: ParticlSetup, presets: Partial<Record<SetupType, ReadonlySet<string>>> = {}): ForeignId[] {
  const out: ForeignId[] = wanted.assets.map((id) => ({ type: "assets" as const, id }));
  for (const [type] of SETUP_TYPES) {
    for (const id of wanted[type]) {
      const known = ours.items[type]?.has(id) || (PRESET_SETUP_TYPES.includes(type) && presets[type]?.has(id));
      if (!known) out.push({ type, id });
    }
  }
  return out;
}

export class ConsumerSetupError extends Error {
  readonly code = "setup_not_particl";
  readonly status = 409;
  readonly paidAttempted = false;
  constructor() {
    super("This setup item was not made in Particl. Pick from Setup, or use a still from this project.");
    this.name = "ConsumerSetupError";
  }
}

/** Reads the engine's shared presets the account lists for these types (marketing-setup.ts › connectedSetupPresets). */
export type ReadSetupPresets = (types: SetupType[]) => Promise<Partial<Record<SetupType, ReadonlySet<string>>>>;

/**
 * Refuse, before anything is quoted, a request naming a setup item Particl
 * may not send. Naming nothing reads nothing. The record is read first; the
 * account is read only for preset types the record does not cover, and never
 * when a product, brand kit, ad reference or asset has already refused.
 */
export async function refuseForeignSetup(userId: string, wanted: SetupIds, readPresets: ReadSetupPresets): Promise<void> {
  if (!Object.values(wanted).some((list) => list.length)) return;
  if (wanted.assets.length) throw new ConsumerSetupError();
  const ours = await particlSetup(userId);
  const foreign = foreignSetupIds(wanted, ours);
  if (!foreign.length) return;
  if (foreign.some((f) => f.type === "assets" || !PRESET_SETUP_TYPES.includes(f.type))) throw new ConsumerSetupError();
  const presets = await readPresets([...new Set(foreign.map((f) => f.type as SetupType))]);
  if (foreignSetupIds(wanted, ours, presets).length) throw new ConsumerSetupError();
}
