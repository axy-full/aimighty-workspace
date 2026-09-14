import { withRecoveryActivity } from './recovery';
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { db, ready } from "./db";
import { runInTenant, type TenantWorkspace } from "./tenant";
import { platformDb, platformReady, now, rowToWorkspace } from "./platform";
import { usingBlob } from "./storage";
import { revokeGatewayKey } from "./vercelKeys";
import { deleteTenantDatabase } from "./provision";

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

/** Access ends atomically. Cleanup is a separate, durable, retryable operation. */
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
      {
        sql: `INSERT INTO workspace_purges(workspace_id,next_attempt_at,updated_at) VALUES(?,?,?) ON CONFLICT(workspace_id) DO NOTHING`,
        args: [id, ts + PURGE_GRACE_MS, ts],
      },
    ],
    "write",
  );

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

/** Each stage is recorded before the next; failures retain every recovery identifier. */
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
