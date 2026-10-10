import { db, ready } from "../db";
import { platformDb } from "../platform";
import { currentTenant } from "../tenant";
import { POOL_MARK, SHARED_POOL, poolConfig, providerPoolReady, readPoolState } from "../providerPool";
import { poolPosition, slotLinePositions, type SlotWaiter } from "./queuePosition";

/**
 * Where each of this workspace's waiting takes stands in its line (see
 * queuePosition.ts), by take id. Read for the workspace in scope only: its own
 * held takes (its own database), and its own rows in the shared pool's line
 * (`provider_pool`, filtered on workspace_id); the pool's state is read whole
 * only to count, and only numbers come back. For a render card's "In queue ·
 * position N" (P3 adds it to the jobs reply).
 */
export async function workspaceQueuePositions(at = Date.now()): Promise<Map<string, number>> {
  const workspaceId = currentTenant()?.workspace?.id;
  if (!workspaceId) return new Map();
  await ready();
  const rs = await db().execute(`SELECT id, created_at, json_extract(params, '$.held.why') AS why, json_extract(params, '$.held.pool') AS pool
                                 FROM generations WHERE status = 'held' AND deleted = 0 ORDER BY created_at ASC LIMIT 200`);
  const held: SlotWaiter[] = (rs.rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), createdAt: Number(r.created_at), why: r.why == null ? null : String(r.why), pool: r.pool == null ? null : String(r.pool),
  }));
  const out = slotLinePositions(held, POOL_MARK);
  const inPool = new Set(held.filter((h) => h.pool === POOL_MARK).map((h) => h.id));
  if (!inPool.size || !poolConfig()) return out;
  await providerPoolReady();
  const [state, mine] = await Promise.all([
    readPoolState(platformDb(), SHARED_POOL, at),
    platformDb().execute({
      sql: "SELECT id, queued_at FROM provider_pool WHERE pool = ? AND workspace_id = ? AND admitted_at IS NULL AND left_at IS NULL ORDER BY queued_at, id LIMIT 200",
      args: [SHARED_POOL, workspaceId],
    }),
  ]);
  for (const r of mine.rows as unknown as Record<string, unknown>[]) {
    const id = String(r.id);
    if (inPool.has(id)) out.set(id, poolPosition(state, { id, workspaceId, queuedAt: Number(r.queued_at) }));
  }
  return out;
}
