/** One-hour `list_voices` cache per connection fingerprint (memory + tenant
 * table), modelled on the catalogue cache. Never calls a provider itself. */
import type { Client } from "@libsql/client";
import { db, ready } from "@/lib/db";
import { VOICES_LIMITS, VOICES_TTL_MS, VoiceToolError, parseConnectedVoices, type ConnectedVoices } from "./voice-tools";

const memory = new Map<string, ConnectedVoices>();
const tables = new WeakMap<Client, Promise<void>>();
async function voicesReady() {
  await ready();
  const client = db();
  if (!tables.has(client))
    tables.set(
      client,
      client
        .execute(`CREATE TABLE IF NOT EXISTS higgsfield_consumer_voices (fingerprint TEXT PRIMARY KEY, voices_json TEXT NOT NULL, seen_at INTEGER NOT NULL)`)
        .then(() => {})
        .catch((error) => {
          tables.delete(client);
          throw error;
        }),
    );
  await tables.get(client);
}
const FINGERPRINT = /^[a-f0-9]{16,64}$/;
/** Reads through the cache; `refresh` forces one read from the connected account. */
export async function loadConnectedVoices(input: { fingerprint: string; read: () => Promise<unknown>; refresh?: boolean; now?: number }): Promise<ConnectedVoices> {
  if (!FINGERPRINT.test(input.fingerprint)) throw new VoiceToolError("invalid_voices", "Invalid voice list scope.");
  const now = input.now ?? Date.now();
  const fresh = (entry: ConnectedVoices | undefined) => (entry && entry.fetchedAt <= now && entry.fetchedAt > now - VOICES_TTL_MS ? entry : null);
  if (!input.refresh) {
    const cached = fresh(memory.get(input.fingerprint));
    if (cached) return cached;
    await voicesReady();
    const row = (await db().execute({ sql: "SELECT voices_json,seen_at FROM higgsfield_consumer_voices WHERE fingerprint=? AND seen_at>?", args: [input.fingerprint, now - VOICES_TTL_MS] })).rows[0];
    if (row && typeof row.voices_json === "string" && row.voices_json.length <= VOICES_LIMITS.jsonBytes) {
      try {
        const stored = parseConnectedVoices(JSON.parse(row.voices_json), Number(row.seen_at));
        memory.set(input.fingerprint, stored);
        return stored;
      } catch {
        /* A stale or unreadable row is replaced by a fresh read below. */
      }
    }
  }
  const raw = await input.read();
  const voices = parseConnectedVoices(raw, now);
  const serialized = JSON.stringify(raw);
  await voicesReady();
  if (serialized.length <= VOICES_LIMITS.jsonBytes)
    await db().execute({
      sql: `INSERT INTO higgsfield_consumer_voices(fingerprint,voices_json,seen_at) VALUES(?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET voices_json=excluded.voices_json,seen_at=excluded.seen_at`,
      args: [input.fingerprint, serialized, now],
    });
  memory.set(input.fingerprint, voices);
  return voices;
}
export function forgetConnectedVoices(fingerprint?: string) {
  if (fingerprint === undefined) memory.clear();
  else memory.delete(fingerprint);
}
