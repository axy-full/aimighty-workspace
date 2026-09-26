import { withRecoveryActivity } from './recovery';
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { rm } from "node:fs/promises";
import { db, ready } from "./db";
import { runInTenant, type TenantWorkspace } from "./tenant";
import { platformDb, platformReady, now, rowToWorkspace } from "./platform";
import { securityAuditStatement } from "./securityAudit";
import { accountDbReady } from "./accountDb";
import { usingBlob } from "./storage";
import { revokeGatewayKey } from "./vercelKeys";
import { deleteTenantDatabase } from "./provision";
import { purgeSoulIdentities } from "./soulIdentities";
import { consumerOriginalPending, consumerOriginalRetentionQuery } from "./higgsfield-consumer/original-retention";

// Let already-running functions finish; requests and delayed events reject deleted workspaces.
export const PURGE_GRACE_MS = 10 * 60_000;
const LEASE_MS = 10 * 60_000;
async function purgeReady() {
  await platformReady();
  await platformDb().execute(`CREATE TABLE IF NOT EXISTS workspace_purges (
    workspace_id TEXT PRIMARY KEY, files_at INTEGER, key_at INTEGER, database_at INTEGER,
    lease TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL
  )`);
}

/** Access ends atomically. The database and every file stay for good (owner,
 * 2026-09-24); retireDeletedWorkspaces only takes the gateway key away. */
export async function markWorkspaceDeleted(id: string): Promise<void> {
return await withRecoveryActivity('purge', async () => {

  await purgeReady();
  const p = platformDb(),
    ts = now();
  const result = await p.execute({
    sql: `SELECT legacy FROM workspaces WHERE id=?`,
    args: [id],
  });
  if (!result.rows.length || Number(result.rows[0].legacy) === 1)
    throw new Error("This workspace cannot be deleted.");
  await p.batch(
    [
      {
        sql: `UPDATE workspaces SET deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE id=? AND legacy=0`,
        args: [ts, ts, id],
      },
      {
        sql: `UPDATE memberships SET disabled=1 WHERE workspace_id=?`,
        args: [id],
      },
      {
        sql: `UPDATE p_sessions SET workspace_id=NULL WHERE workspace_id=?`,
        args: [id],
      },
      // Review links are access too; once the owner cannot revoke them, they end here.
      {
        sql: `UPDATE p_shares SET revoked_at=? WHERE workspace_id=? AND revoked_at IS NULL`,
        args: [ts, id],
      },
    ],
    "write",
  );

});
}
/** Owned, live workspaces plus requests still being made: the ceiling
 * prepareWorkspace holds every owner to. */
export const OWNED_WORKSPACE_CEILING = 5;
/** The platform owner's undo of a workspace delete. Nothing was erased, so
 * access is all that comes back: the owner's membership returns at once, and
 * the owner turns the rest of the team back on from People. Review links the
 * delete ended stay ended; the owner makes new ones. A restore never takes
 * the owner past their ceiling of workspaces, and leaves a receipt. */
export async function restoreDeletedWorkspace(
  id: string,
  actorId: string | null = null,
): Promise<void> {
return await withRecoveryActivity('purge', async () => {

  await Promise.all([purgeReady(), accountDbReady()]);
  const p = platformDb(),
    ts = now();
  const row = (
    await p.execute({
      sql: `SELECT owner_id,deleted_at,purged_at,legacy FROM workspaces WHERE id=?`,
      args: [id],
    })
  ).rows[0];
  if (!row || Number(row.legacy) === 1)
    throw new Error("This workspace cannot be restored.");
  if (row.deleted_at == null) return;
  if (row.purged_at != null)
    throw new Error("This workspace's database is gone; it cannot be restored.");
  const owner = String(row.owner_id);
  // The count and the restore are one write, so two restores cannot both fit.
  const [restored] = await p.batch(
    [
      {
        sql: `UPDATE workspaces SET deleted_at=NULL,updated_at=? WHERE id=? AND legacy=0 AND purged_at IS NULL AND deleted_at IS NOT NULL
          AND (SELECT COUNT(*) FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.account_id=? AND m.role='owner' AND w.deleted_at IS NULL)
            +(SELECT COUNT(*) FROM workspace_provisioning WHERE owner_id=? AND state<>'ready') < ?`,
        args: [ts, id, owner, owner, OWNED_WORKSPACE_CEILING],
      },
      securityAuditStatement(
        {
          workspaceId: id,
          actorId,
          action: "workspace.restored",
          targetType: "workspace",
          targetId: id,
        },
        true,
      ),
      {
        sql: `UPDATE memberships SET disabled=0 WHERE workspace_id=? AND account_id=? AND role='owner'
          AND EXISTS (SELECT 1 FROM workspaces WHERE id=? AND deleted_at IS NULL)`,
        args: [id, owner, id],
      },
    ],
    "write",
  );
  if (!restored.rowsAffected) {
    const again = (
      await p.execute({ sql: `SELECT deleted_at FROM workspaces WHERE id=?`, args: [id] })
    ).rows[0];
    // Restored by someone else in the meantime: nothing more to do.
    if (again && again.deleted_at == null) return;
    throw new Error(
      `Its owner already has ${OWNED_WORKSPACE_CEILING} workspaces of their own. One of those has to be deleted first.`,
    );
  }

});
}
export type PurgeReport = {
  files: number;
  uploads: number;
  dbDropped: boolean;
  keyRevoked: boolean;
  completed: boolean;
  pending: boolean;
  errors: string[];
};
type PurgeDependencies = {
  files: (
    workspace: TenantWorkspace,
  ) => Promise<{ files: number; uploads: number }>;
  key: (id: string) => Promise<void>;
  database: (workspace: TenantWorkspace) => Promise<void>;
};
async function removeFiles(ws: TenantWorkspace) {
  // Provider identities outlive their source URLs. Retire them before removing
  // either the originals or the database containing their recovery handles.
  await runInTenant(ws, () => purgeSoulIdentities());
  let files = 0,
    uploads = 0;
  if (usingBlob()) {
    const { list, del: rawDel } = await import("@vercel/blob");
    const del = (...args: Parameters<typeof rawDel>) => withRecoveryActivity("blob-delete", () => rawDel(...args), { uncertainOnError: true });
    // Deleted objects leave the prefix. Bound each pass so large cleanups resume on cron.
    for (let page = 0; page < 20; page++) {
      const found = await list({ prefix: `ws/${ws.id}/`, limit: 500 });
      if (!found.blobs.length) return { files, uploads };
      await del(found.blobs.map((blob) => blob.url));
      files += found.blobs.length;
      if (!found.hasMore) return { files, uploads };
    }
    throw new Error("File cleanup is continuing on the next run.");
  }
  await runInTenant(ws, async () => {
    await ready();
    for (const row of (await db().execute("SELECT id FROM generations")).rows) {
      const id = String(row.id);
      if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error("Invalid stored media identifier.");
      for (const ext of ["mp4", "png", "mp3"])
        await rm(
          path.join(process.cwd(), ".data", "generations", `${id}.${ext}`),
          { force: true },
        );
      files++;
    }
    for (const row of (await db().execute("SELECT id FROM identities")).rows) {
      const id = String(row.id);
      if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error("Invalid stored identity identifier.");
      await rm(path.join(process.cwd(), ".data", "generations", `${id}.zip`), {
        force: true,
      });
      files++;
    }
    for (const row of (await db().execute("SELECT id,ext FROM uploads")).rows) {
      const id = String(row.id),
        ext = String(row.ext);
      if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9]+$/.test(ext))
        throw new Error("Invalid stored upload identifier.");
      await rm(path.join(process.cwd(), ".data", "uploads", `${id}.${ext}`), {
        force: true,
      });
      uploads++;
    }
  });
  return { files, uploads };
}
async function removeDatabase(ws: TenantWorkspace) {
  if (!ws.dbUrl.startsWith("file:")) return deleteTenantDatabase(ws);
  const file = ws.dbUrl.slice("file:".length);
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    await rm(path.resolve(file + suffix), { force: true });
}

/** Explicit workspace deletion is the disposition, not provider failure or a
 * refund. Preserve the immutable original receipt until physical purge succeeds.
 * Called only under purge's write transaction and fresh deleted-workspace row. */
async function disposeCollectedConsumerOriginals(tx: Transaction, ws: TenantWorkspace, at: number) {
  if (!await consumerOriginalPending(tx)) return;
  if (ws.deletedAt == null || at < ws.deletedAt + PURGE_GRACE_MS)
    throw new Error("Consumer original disposal is waiting for the deletion grace period.");
  const query = (await consumerOriginalRetentionQuery(tx))!;
  const rows = (await tx.execute(`SELECT j.id,j.user_id,j.draft_id,j.provider_job_id,j.quote_credits,j.poll_lease_until,
    o.generation_id,o.bytes,o.sha256,o.receipt_json FROM consumer_video_originals o
    JOIN higgsfield_consumer_jobs j ON j.id=o.job_id WHERE o.generation_id IN (${query}) LIMIT 101`)).rows;
  if (rows.length > 100) throw new Error("Consumer original disposal exceeds its bounded batch.");
  for (const row of rows) {
    if (Number(row.poll_lease_until ?? 0) > at)
      throw new Error("Consumer original collection still has an active poll lease.");
    let receipt: Record<string, unknown>;
    try {
      if (typeof row.receipt_json !== "string" || row.receipt_json.length > 16_384) throw new Error();
      receipt = JSON.parse(row.receipt_json);
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
        receipt.generationId !== row.generation_id || receipt.providerJobId !== row.provider_job_id ||
        receipt.sha256 !== row.sha256 || !/^[a-f0-9]{64}$/.test(String(receipt.sha256)) ||
        receipt.bytes !== Number(row.bytes) || Number(row.bytes) <= 0 || Number(row.bytes) > 100 * 1024 * 1024 ||
        receipt.creditUnit !== "higgsfield_credits" || receipt.credits !== Number(row.quote_credits)) throw new Error();
    } catch { throw new Error("Consumer original disposal requires its verified immutable receipt."); }
    // Deliberately no top-level original/asset: this is a non-attachable disposal
    // request, and bytes may remain while the independently retryable purge runs.
    const manifest = { disposal: { reason: "workspace_deleted", state: "purge_pending", attachable: false,
      workspaceId: ws.id, requestedAt: ws.deletedAt, recordedAt: at,
      originalReceipt: { generationId: row.generation_id, providerJobId: row.provider_job_id,
        sha256: row.sha256, bytes: Number(row.bytes), credits: Number(row.quote_credits), creditUnit: "higgsfield_credits" } } };
    const changed = await tx.execute({
      sql: `UPDATE higgsfield_consumer_jobs SET status='completed',result_manifest=?,failure_code=NULL,
        poll_lease_hash=NULL,poll_lease_until=NULL,updated_at=?
        WHERE id=? AND user_id=? AND draft_id=? AND provider_job_id=? AND status='accepted' AND COALESCE(poll_lease_until,0)<=?`,
      args: [JSON.stringify(manifest), at, row.id, row.user_id, row.draft_id, row.provider_job_id, at],
    });
    if (changed.rowsAffected !== 1) throw new Error("Consumer original disposal changed; retry required.");
  }
}

/**
 * Each stage is recorded before the next; failures retain every recovery identifier.
 * Not wired to any route or cron: nothing a team makes is ever erased (owner,
 * 2026-09-24). tests/unit/neverDelete.spec.ts holds that line.
 */
export async function purgeWorkspace(
  workspace: TenantWorkspace,
  dependencies: PurgeDependencies = {
    files: removeFiles,
    key: revokeGatewayKey,
    database: removeDatabase,
  },
): Promise<PurgeReport> {
return await withRecoveryActivity('purge', async () => {

  const report: PurgeReport = {
    files: 0,
    uploads: 0,
    dbDropped: false,
    keyRevoked: false,
    completed: false,
    pending: false,
    errors: [],
  };
  await purgeReady();
  const p = platformDb();
  const stored = (
    await p.execute({
      sql: "SELECT * FROM workspaces WHERE id=?",
      args: [workspace.id],
    })
  ).rows[0];
  if (!stored || Number(stored.legacy) === 1 || stored.deleted_at == null) {
    report.errors.push("Only a deleted customer workspace can be purged.");
    return report;
  }
  if (stored.purged_at != null) {
    report.completed = true;
    return report;
  }
  const ws = rowToWorkspace(stored),
    ts = now();
  await p.execute({
    sql: `INSERT INTO workspace_purges(workspace_id,next_attempt_at,updated_at) VALUES(?,?,?) ON CONFLICT(workspace_id) DO NOTHING`,
    args: [ws.id, Number(stored.deleted_at) + PURGE_GRACE_MS, ts],
  });
  const lease = randomUUID();
  const claim = await p.execute({
    sql: `UPDATE workspace_purges SET lease=?,lease_until=?,attempts=attempts+1,updated_at=?
          WHERE workspace_id=? AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<?)`,
    args: [lease, ts + LEASE_MS, ts, ws.id, ts, ts],
  });
  if (!claim.rowsAffected) {
    report.pending = true;
    return report;
  }
  try {
    const state = (
      await p.execute({
        sql: "SELECT * FROM workspace_purges WHERE workspace_id=?",
        args: [ws.id],
      })
    ).rows[0];
    const completeStage = async (
      column: "files_at" | "key_at" | "database_at",
    ) => {
      const saved = await p.execute({
        sql: `UPDATE workspace_purges SET ${column}=?,updated_at=?,lease_until=? WHERE workspace_id=? AND lease=?`,
        args: [now(), now(), now() + LEASE_MS, ws.id, lease],
      });
      if (!saved.rowsAffected)
        throw new Error("Cleanup lease changed; retry required.");
    };
    // A collector can outlive a terminal job update. Its own durable receipt
    // protects ambiguous private writes independently of the provider status.
    if (state.database_at == null) {
      await runInTenant(ws, async () => {
        const tx = await db().transaction("write");
        try {
          // A preparing -> stored transition must not fall between two reads.
          await disposeCollectedConsumerOriginals(tx, ws, now());
          const exists = await tx.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='consumer_video_originals'",
          );
          if (exists.rows.length && (await tx.execute({
            sql: `SELECT 1 FROM consumer_video_originals
                  WHERE COALESCE(state,'preparing')<>'stored'
                    AND (COALESCE(bytes,0)>0 OR COALESCE(lease_until,0)>?) LIMIT 1`,
            args: [now()],
          })).rows.length)
            throw new Error("Consumer original storage is still being reconciled.");
          await tx.commit();
        } catch (error) {
          await tx.rollback().catch(() => {});
          throw error;
        } finally {
          tx.close();
        }
      });
    }
    if (state.files_at == null) {
      Object.assign(report, await dependencies.files(ws));
      await completeStage("files_at");
    }
    if (state.key_at == null) {
      if (ws.gatewayKeyId) await dependencies.key(ws.gatewayKeyId);
      await completeStage("key_at");
    }
    report.keyRevoked = true;
    if (state.database_at == null) {
      await dependencies.database(ws);
      await completeStage("database_at");
    }
    report.dbDropped = true;
    // Consumer OAuth grants live in the platform database, not the tenant DB.
    // Remove every owner's grant and pending authorization before declaring
    // the workspace purged. A late exchange/refresh cannot pass its row CAS.
    const consumerTables = await p.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('higgsfield_consumer_connections','higgsfield_consumer_authorizations')",
    );
    if (consumerTables.rows.length) {
      const names = new Set(consumerTables.rows.map(row => String(row.name)));
      await p.batch(
        ["higgsfield_consumer_connections", "higgsfield_consumer_authorizations"]
          .filter(table => names.has(table))
          .map(table => ({ sql: `DELETE FROM ${table} WHERE workspace_id=?`, args: [ws.id] })),
        "write",
      );
    }
    // Provisioning keeps a sealed access token so failed setup can resume.
    // Once the database is gone that second copy must be removed too.
    const provisioning = await p.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_provisioning'",
    );
    if (provisioning.rows.length) {
      await p.execute({
        sql: `UPDATE workspace_provisioning SET db_token_enc=NULL,updated_at=? WHERE workspace_id=?`,
        args: [now(), ws.id],
      });
    }
    const completed = await p.execute({
      sql: `UPDATE workspaces SET purged_at=?,keys_enc=NULL,db_token_enc=NULL,gateway_key_id=NULL,updated_at=?
            WHERE id=? AND deleted_at IS NOT NULL AND EXISTS (
              SELECT 1 FROM workspace_purges WHERE workspace_id=? AND lease=?
              AND files_at IS NOT NULL AND key_at IS NOT NULL AND database_at IS NOT NULL)`,
      args: [now(), now(), ws.id, ws.id, lease],
    });
    report.completed = completed.rowsAffected === 1;
    if (!report.completed)
      throw new Error("Cleanup completion was not recorded.");
  } catch (error) {
    report.errors.push((error as Error).message.slice(0, 300));
    report.pending = true;
  } finally {
    await p.execute({
      sql: `UPDATE workspace_purges SET lease=NULL,lease_until=NULL,last_error=?,next_attempt_at=?,updated_at=? WHERE workspace_id=? AND lease=?`,
      args: [
        report.errors.join("; ") || null,
        now() + PURGE_GRACE_MS,
        now(),
        ws.id,
        lease,
      ],
    });
  }
  return report;

});
}

/** Retry interrupted cleanup, including deletions made by older releases. */
export async function retryWorkspacePurges(limit = 5) {
return await withRecoveryActivity('purge', async () => {

  await purgeReady();
  const rows = await platformDb().execute({
    sql: `SELECT w.* FROM workspaces w LEFT JOIN workspace_purges p ON p.workspace_id=w.id
          WHERE w.legacy=0 AND w.deleted_at IS NOT NULL AND w.purged_at IS NULL
          AND w.deleted_at<=? AND COALESCE(p.next_attempt_at,0)<=?
          ORDER BY COALESCE(p.next_attempt_at,w.deleted_at) LIMIT ?`,
    args: [now() - PURGE_GRACE_MS, now(), limit],
  });
  let completed = 0;
  let failed = 0;
  for (const row of rows.rows) {
    try {
      if ((await purgeWorkspace(rowToWorkspace(row))).completed) completed++;
    } catch {
      failed++;
      console.error(JSON.stringify({ level: "error", event: "workspace_cleanup.retry_failed" }));
    }
  }
  return { attempted: rows.rows.length, completed, failed };

});
}

/** A deleted workspace keeps its database and files; after the grace period for
 * running functions, its gateway key is revoked so it can no longer spend. */
export async function retireDeletedWorkspaces(limit = 5, revoke: (id: string) => Promise<void> = revokeGatewayKey) {
return await withRecoveryActivity('purge', async () => {

  await platformReady();
  const p = platformDb();
  const rows = await p.execute({
    sql: `SELECT id,gateway_key_id FROM workspaces WHERE legacy=0 AND deleted_at IS NOT NULL
          AND purged_at IS NULL AND gateway_key_id IS NOT NULL AND deleted_at<=? ORDER BY deleted_at LIMIT ?`,
    args: [now() - PURGE_GRACE_MS, limit],
  });
  let failed = 0;
  for (const row of rows.rows) {
    try {
      await revoke(String(row.gateway_key_id));
      await p.execute({
        sql: `UPDATE workspaces SET gateway_key_id=NULL,updated_at=? WHERE id=? AND gateway_key_id=?`,
        args: [now(), row.id, row.gateway_key_id],
      });
    } catch {
      failed++;
      console.error(JSON.stringify({ level: "error", event: "workspace_retire.key_failed" }));
    }
  }
  return { attempted: rows.rows.length, failed };

});
}
