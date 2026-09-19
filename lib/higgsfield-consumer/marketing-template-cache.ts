/** One-hour cache per connection fingerprint for the Marketing Studio v2
 * template catalogue and its cost table (memory + tenant table), modelled on
 * the generation catalogue cache. Never calls a provider itself. */
import type { Client } from "@libsql/client";
import { db, ready } from "@/lib/db";
import {
  MARKETING_TEMPLATE_LIMITS,
  MARKETING_TEMPLATE_TTL_MS,
  MarketingTemplateError,
  parseMarketingTemplateCatalogue,
  parseMarketingTemplateCosts,
  type MarketingTemplateCatalogue,
  type MarketingTemplateCosts,
} from "./marketing-templates";

type Kind = "catalogue" | "costs";
const memory = new Map<string, { catalogue?: MarketingTemplateCatalogue; costs?: MarketingTemplateCosts }>();
const tables = new WeakMap<Client, Promise<void>>();
async function cacheReady() {
  await ready();
  const client = db();
  if (!tables.has(client))
    tables.set(
      client,
      client
        .execute(
          `CREATE TABLE IF NOT EXISTS higgsfield_marketing_templates (
            fingerprint TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(fingerprint, kind))`,
        )
        .then(() => {})
        .catch((error) => {
          tables.delete(client);
          throw error;
        }),
    );
  await tables.get(client);
}
const FINGERPRINT = /^[a-f0-9]{16,64}$/;
async function load<T extends MarketingTemplateCatalogue | MarketingTemplateCosts>(
  kind: Kind,
  input: { fingerprint: string; read: () => Promise<unknown>; refresh?: boolean; now?: number },
  parse: (raw: unknown, seenAt: number) => T,
): Promise<T> {
  if (!FINGERPRINT.test(input.fingerprint)) throw new MarketingTemplateError("invalid_catalogue", "Invalid template catalogue scope.");
  const now = input.now ?? Date.now();
  const fresh = (entry: T | undefined) => (entry && entry.fetchedAt <= now && entry.fetchedAt > now - MARKETING_TEMPLATE_TTL_MS ? entry : null);
  const slot = memory.get(input.fingerprint) ?? {};
  if (!input.refresh) {
    const cached = fresh(slot[kind] as T | undefined);
    if (cached) return cached;
    await cacheReady();
    const row = (
      await db().execute({
        sql: "SELECT json,seen_at FROM higgsfield_marketing_templates WHERE fingerprint=? AND kind=? AND seen_at>?",
        args: [input.fingerprint, kind, now - MARKETING_TEMPLATE_TTL_MS],
      })
    ).rows[0];
    if (row && typeof row.json === "string" && row.json.length <= MARKETING_TEMPLATE_LIMITS.jsonBytes) {
      try {
        const stored = parse(JSON.parse(row.json), Number(row.seen_at));
        memory.set(input.fingerprint, { ...slot, [kind]: stored });
        return stored;
      } catch {
        /* A stale or unreadable row is replaced by a fresh read below. */
      }
    }
  }
  const raw = await input.read();
  const parsed = parse(raw, now);
  const serialized = JSON.stringify(raw);
  await cacheReady();
  if (serialized.length <= MARKETING_TEMPLATE_LIMITS.jsonBytes)
    await db().execute({
      sql: `INSERT INTO higgsfield_marketing_templates(fingerprint,kind,json,seen_at) VALUES(?,?,?,?)
        ON CONFLICT(fingerprint,kind) DO UPDATE SET json=excluded.json,seen_at=excluded.seen_at`,
      args: [input.fingerprint, kind, serialized, now],
    });
  memory.set(input.fingerprint, { ...(memory.get(input.fingerprint) ?? {}), [kind]: parsed });
  return parsed;
}
/** Reads the template catalogue through the cache; `refresh` forces one read. */
export const loadMarketingTemplateCatalogue = (input: { fingerprint: string; read: () => Promise<unknown>; refresh?: boolean; now?: number }) =>
  load("catalogue", input, parseMarketingTemplateCatalogue);
/** Reads the versioned cost table through the cache; `refresh` forces one read. */
export const loadMarketingTemplateCosts = (input: { fingerprint: string; read: () => Promise<unknown>; refresh?: boolean; now?: number }) =>
  load("costs", input, parseMarketingTemplateCosts);
export function forgetMarketingTemplates(fingerprint?: string) {
  if (fingerprint === undefined) memory.clear();
  else memory.delete(fingerprint);
}
