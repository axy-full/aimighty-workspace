/**
 * Particl's own record of the Soul IDs it built on the connected account.
 * Particl is a standalone platform: what the owner trains on higgsfield.ai
 * stays there. Anything Particl lists or reuses from the account's characters
 * is intersected with this table first, so only Particl-built identities
 * reach the Cast card, Gen's Soul models or anyone else.
 */
import { db, ready } from "@/lib/db";

const initialized = new WeakMap<ReturnType<typeof db>, Promise<void>>();
export async function consumerCharactersReady() {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(
      client,
      client
        .execute(
          `CREATE TABLE IF NOT EXISTS higgsfield_consumer_characters (
 soul_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL)`,
        )
        .then(() => {})
        .catch((e) => {
          initialized.delete(client);
          throw e;
        }),
    );
  await initialized.get(client);
}

export type CharacterRecord = { soulId: string; userId: string; projectId: string | null; name: string; type: string; createdAt: number };

/** Remember a Soul ID Particl asked the account to train. Idempotent on the id. */
export async function recordParticlCharacter(record: Omit<CharacterRecord, "createdAt">): Promise<void> {
  await consumerCharactersReady();
  await db().execute({
    sql: "INSERT OR IGNORE INTO higgsfield_consumer_characters(soul_id,user_id,project_id,name,type,created_at) VALUES(?,?,?,?,?,?)",
    args: [record.soulId, record.userId, record.projectId, record.name, record.type, Date.now()],
  });
}

/** The Soul IDs this workspace built, newest first. */
export async function particlCharacterIds(): Promise<Set<string>> {
  await consumerCharactersReady();
  const rows = (await db().execute("SELECT soul_id FROM higgsfield_consumer_characters ORDER BY created_at DESC LIMIT 500")).rows;
  return new Set(rows.map((row) => String(row.soul_id)));
}

/** Pure: the account's list narrowed to what Particl built — the account still says the status, Particl says which ones count. */
export function onlyParticlCharacters<T extends { soulId: string }>(characters: readonly T[], ours: ReadonlySet<string>): T[] {
  return characters.filter((character) => ours.has(character.soulId));
}
