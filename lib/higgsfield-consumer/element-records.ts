/**
 * Particl's own record of the reference elements it made on the connected
 * account (as character-records.ts is for Soul IDs). Anything Particl lists or
 * lets a request name is intersected with this table first, so only elements
 * this workspace made reach Cast, a prompt token or anyone else.
 */
import { db, ready } from "@/lib/db";

const initialized = new WeakMap<ReturnType<typeof db>, Promise<void>>();
export async function consumerElementsReady() {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(client, client.execute(`CREATE TABLE IF NOT EXISTS higgsfield_consumer_elements (
 element_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL)`).then(() => {}).catch((e) => { initialized.delete(client); throw e; }));
  await initialized.get(client);
}
/** The element ids this workspace made, newest first. */
export async function particlElementIds(): Promise<Set<string>> {
  await consumerElementsReady();
  return new Set((await db().execute("SELECT element_id FROM higgsfield_consumer_elements ORDER BY created_at DESC LIMIT 500")).rows.map((row) => String(row.element_id)));
}
/** Remember an element Particl made. Idempotent on the id. */
export async function recordParticlElement(element: { elementId: string }, input: { userId: string; projectId: string | null; name: string; category: string }) {
  await consumerElementsReady();
  await db().execute({ sql: "INSERT OR IGNORE INTO higgsfield_consumer_elements(element_id,user_id,project_id,name,category,created_at) VALUES(?,?,?,?,?,?)", args: [element.elementId, input.userId, input.projectId, input.name.trim(), input.category, Date.now()] });
}
