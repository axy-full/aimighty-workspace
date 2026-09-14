import type { Client, Transaction } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { db, ready } from "./db";
import { deleteVideo } from "./storage";

const initialized = new WeakMap<Client, Promise<void>>();
const LEASE_MS = 10 * 60_000;
export async function mediaDeletionReady() {
  await ready();
  const client = db();
  let pending = initialized.get(client);
  if (!pending) {
    pending = client
      .execute(
        `CREATE TABLE IF NOT EXISTS generation_deletions (
      id TEXT PRIMARY KEY, lease TEXT, lease_until INTEGER, updated_at INTEGER NOT NULL
    )`,
      )
      .then(() => {})
      .catch((error) => {
        initialized.delete(client);
        throw error;
      });
    initialized.set(client, pending);
  }
  await pending;
}
async function transaction<T>(work: (tx: Transaction) => Promise<T>) {
  const tx = await db().transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  } finally {
    tx.close();
  }
}
/** Call after the binding check in the same tenant write transaction. */
export async function markGenerationDeletion(
  tx: Transaction,
  id: string,
  at = Date.now(),
) {
  const changed = await tx.execute({
    sql: "UPDATE generations SET deleted=1,updated_at=? WHERE id=?",
    args: [at, id],
  });
  if (!changed.rowsAffected) return;
  await tx.execute({
    sql: "INSERT INTO generation_deletions(id,updated_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at",
    args: [id, at],
  });
}

/** Quota remains retained on the generation until all original objects were removed. */
export async function cleanupDeletedGenerations(
  limit = 5,
  at = Date.now(),
  onlyId?: string,
) {
  await mediaDeletionReady();
  const candidates = (
    await db().execute({
      sql: `SELECT g.id FROM generations g LEFT JOIN generation_deletions d ON d.id=g.id
    WHERE g.deleted=1 AND g.status NOT IN ('queued','running','held') AND (? IS NULL OR g.id=?)
    AND (COALESCE(g.bytes,0)>0 OR g.stored_url IS NOT NULL OR d.id IS NOT NULL) AND COALESCE(d.lease_until,0)<=?
    ORDER BY COALESCE(d.updated_at,0),g.updated_at,g.id LIMIT ?`,
      args: [
        onlyId ?? null,
        onlyId ?? null,
        at,
        Math.max(1, Math.min(20, limit)),
      ],
    })
  ).rows;
  let cleaned = 0,
    failed = 0;
  for (const candidate of candidates) {
    const id = String(candidate.id),
      lease = randomUUID();
    const snapshot = await transaction(async (tx) => {
      const row = (
        await tx.execute({
          sql: "SELECT stored_url,bytes,updated_at FROM generations WHERE id=? AND deleted=1 AND status NOT IN ('queued','running','held')",
          args: [id],
        })
      ).rows[0];
      if (!row) return null;
      const acquired = await tx.execute({
        sql: `INSERT INTO generation_deletions(id,lease,lease_until,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until,updated_at=excluded.updated_at WHERE COALESCE(generation_deletions.lease_until,0)<=?`,
        args: [id, lease, at + LEASE_MS, at, at],
      });
      return acquired.rowsAffected ? row : null;
    });
    if (!snapshot) continue;
    try {
      await deleteVideo(
        id,
        true,
        snapshot.stored_url == null ? null : String(snapshot.stored_url),
      );
      await transaction(async (tx) => {
        const cleared = await tx.execute({
          sql: `UPDATE generations SET stored_url=NULL,source_url=NULL,bytes=0,updated_at=?
          WHERE id=? AND deleted=1 AND stored_url IS ? AND COALESCE(bytes,0)=? AND updated_at=?
          AND EXISTS(SELECT 1 FROM generation_deletions WHERE id=? AND lease=?)`,
          args: [
            at,
            id,
            snapshot.stored_url,
            Number(snapshot.bytes ?? 0),
            snapshot.updated_at,
            id,
            lease,
          ],
        });
        if (!cleared.rowsAffected)
          throw new Error("Generation changed during media cleanup");
        await tx.execute({
          sql: "DELETE FROM generation_deletions WHERE id=? AND lease=?",
          args: [id, lease],
        });
      });
      cleaned++;
    } catch {
      failed++;
      await db().execute({
        sql: "UPDATE generation_deletions SET lease=NULL,lease_until=NULL WHERE id=? AND lease=?",
        args: [id, lease],
      });
    }
  }
  return { attempted: candidates.length, cleaned, failed };
}
