/** One-hour catalogue cache per connection fingerprint (memory + tenant table),
 * modelled on the Marketing Studio preset cache. Never calls a provider itself. */
import type { Client } from "@libsql/client";
import { db, ready } from "@/lib/db";
import { CATALOGUE_LIMITS, CATALOGUE_TTL_MS, CatalogueError, parseConnectedCatalogue, type ConnectedCatalogue } from "./catalogue";

/* ── One-hour cache per connection fingerprint ───────────────────────── */
const memory = new Map<string, ConnectedCatalogue>();
const tables = new WeakMap<Client, Promise<void>>();
async function catalogueReady() {
  await ready();
  const client = db();
  if (!tables.has(client))
    tables.set(
      client,
      client
        .execute(
          `CREATE TABLE IF NOT EXISTS higgsfield_consumer_catalogue (
            fingerprint TEXT PRIMARY KEY, catalogue_json TEXT NOT NULL, seen_at INTEGER NOT NULL)`,
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
export type CatalogueSource = () => Promise<unknown>;
/** Reads through the cache; `refresh` forces one read from the connected account. */
export async function loadConnectedCatalogue(input: {
  fingerprint: string;
  read: CatalogueSource;
  refresh?: boolean;
  now?: number;
}): Promise<ConnectedCatalogue> {
  if (!FINGERPRINT.test(input.fingerprint)) throw new CatalogueError("invalid_catalogue", "Invalid catalogue scope.");
  const now = input.now ?? Date.now();
  const fresh = (entry: ConnectedCatalogue | undefined) =>
    entry && entry.fetchedAt <= now && entry.fetchedAt > now - CATALOGUE_TTL_MS ? entry : null;
  if (!input.refresh) {
    const cached = fresh(memory.get(input.fingerprint));
    if (cached) return cached;
    await catalogueReady();
    const row = (
      await db().execute({
        sql: "SELECT catalogue_json,seen_at FROM higgsfield_consumer_catalogue WHERE fingerprint=? AND seen_at>?",
        args: [input.fingerprint, now - CATALOGUE_TTL_MS],
      })
    ).rows[0];
    if (row && typeof row.catalogue_json === "string" && row.catalogue_json.length <= CATALOGUE_LIMITS.jsonBytes) {
      try {
        const stored = parseConnectedCatalogue(JSON.parse(row.catalogue_json), Number(row.seen_at));
        memory.set(input.fingerprint, stored);
        return stored;
      } catch {
        /* A stale or unreadable row is replaced by a fresh read below. */
      }
    }
  }
  const raw = await input.read();
  const catalogue = parseConnectedCatalogue(raw, now);
  const serialized = JSON.stringify(raw);
  await catalogueReady();
  if (serialized.length <= CATALOGUE_LIMITS.jsonBytes)
    await db().execute({
      sql: `INSERT INTO higgsfield_consumer_catalogue(fingerprint,catalogue_json,seen_at) VALUES(?,?,?)
        ON CONFLICT(fingerprint) DO UPDATE SET catalogue_json=excluded.catalogue_json,seen_at=excluded.seen_at`,
      args: [input.fingerprint, serialized, now],
    });
  memory.set(input.fingerprint, catalogue);
  return catalogue;
}
export function forgetConnectedCatalogue(fingerprint?: string) {
  if (fingerprint === undefined) memory.clear();
  else memory.delete(fingerprint);
}
