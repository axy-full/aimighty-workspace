/**
 * Particl's own record of the Marketing Studio setup items it made on
 * the connected account — products, avatars, brand kits and ad references —
 * modelled on the Soul ID record (character-records.ts). Particl is a
 * standalone platform: what the owner keeps on the account stays there. Every
 * Setup read is intersected with this table (plus the Soul IDs built in Cast,
 * which serve as avatars), and every quote that names one of these ids is
 * refused unless Particl made it.
 *
 * One database per workspace (lib/db), and every row carries the member whose
 * connection made it: a record never crosses a workspace or a connection.
 */
import { db, ready } from "@/lib/db";
import { OWNED_SETUP_TYPES, type SetupType } from "@/lib/shell/business";
import { particlCharacterIds } from "./character-records";

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

/** What counts as Particl's: its recorded items by type, and the Soul IDs built in Cast (the avatars). */
export type ParticlSetup = { items: Partial<Record<SetupType, ReadonlySet<string>>>; cast: ReadonlySet<string> };
export const NO_PARTICL_SETUP: ParticlSetup = { items: {}, cast: new Set() };

export async function particlSetup(userId: string): Promise<ParticlSetup> {
  await consumerMarketingItemsReady();
  const rows = (await db().execute({ sql: "SELECT type, item_id FROM higgsfield_consumer_marketing_items WHERE user_id=? ORDER BY created_at DESC LIMIT 1000", args: [userId] })).rows;
  const items: Partial<Record<SetupType, Set<string>>> = {};
  for (const row of rows) (items[String(row.type) as SetupType] ??= new Set()).add(String(row.item_id));
  return { items, cast: await particlCharacterIds() };
}

/* ── The quote guard ─────────────────────────────────────────────────── */
/** The library ids a request names, by type. Hooks, settings and styles are the account's catalogue and are not library ids. */
export type SetupIds = Record<"product" | "avatar" | "brand_kit" | "ad_reference", string[]>;
const ids = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** From a catalogue-generation input's parameters (the account's own names). */
export function setupIdsOfParameters(parameters: Record<string, unknown>): SetupIds {
  const avatars = Array.isArray(parameters.avatars) ? parameters.avatars.map((a) => (a && typeof a === "object" ? (a as { id?: unknown }).id : a)) : [];
  return {
    product: [...ids(parameters.product_ids), ...ids(parameters.web_product_ids)],
    avatar: [...ids(parameters.avatar_ids), ...ids(avatars)],
    brand_kit: ids(parameters.brand_kit_id),
    ad_reference: ids(parameters.ad_reference_id),
  };
}

/** From the marketing-video route's input (its camelCase names). */
export function setupIdsOfVideoInput(input: { productIds?: string[]; webProductIds?: string[]; avatars?: { id: string }[]; adReferenceId?: string }): SetupIds {
  return {
    product: [...(input.productIds ?? []), ...(input.webProductIds ?? [])],
    avatar: (input.avatars ?? []).map((a) => a.id),
    brand_kit: [],
    ad_reference: input.adReferenceId ? [input.adReferenceId] : [],
  };
}

/** Pure: the ids a request names that Particl did not make. An avatar may also be a Soul ID built in Cast. */
export function foreignSetupIds(wanted: SetupIds, ours: ParticlSetup): { type: SetupType; id: string }[] {
  const out: { type: SetupType; id: string }[] = [];
  for (const type of OWNED_SETUP_TYPES) {
    for (const id of wanted[type as keyof SetupIds] ?? []) {
      const known = ours.items[type]?.has(id) || (type === "avatar" && ours.cast.has(id));
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

/** Refuse, before anything is quoted, a request that names an account item Particl did not make. No read when it names none. */
export async function refuseForeignSetup(userId: string, wanted: SetupIds): Promise<void> {
  if (!Object.values(wanted).some((list) => list.length)) return;
  if (foreignSetupIds(wanted, await particlSetup(userId)).length) throw new ConsumerSetupError();
}
