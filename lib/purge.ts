import path from "node:path";
import { db, ready } from "./db";
import { runInTenant, type TenantWorkspace } from "./tenant";
import { platformDb, platformReady, now } from "./platform";
import { usingBlob, deleteVideo, deleteUpload } from "./storage";
import { revokeGatewayKey } from "./vercelKeys";
import { deleteTenantDatabase } from "./provision";

/**
 * Deleting a workspace, for real.
 *
 * The record goes first — the workspace is marked deleted, its memberships
 * end, and any session pointing at it is let go — so nothing can be started
 * against it while the purge runs. Then the purge: every master, upload and
 * identity file it stored, the gateway key minted for it, and its database.
 * The platform's own books — grants, top-ups, meter rows — stay, because
 * money that moved is a record the platform keeps. Best-effort throughout,
 * and idempotent: a purge that dies halfway can be run again.
 */
export async function markWorkspaceDeleted(id: string): Promise<void> {
  await platformReady();
  const p = platformDb();
  const ts = now();
  await p.execute({ sql: `UPDATE workspaces SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?`, args: [ts, ts, id] });
  await p.execute({ sql: `UPDATE memberships SET disabled = 1 WHERE workspace_id = ?`, args: [id] });
  await p.execute({ sql: `UPDATE p_sessions SET workspace_id = NULL WHERE workspace_id = ?`, args: [id] });
}

export type PurgeReport = { files: number; uploads: number; dbDropped: boolean; keyRevoked: boolean; errors: string[] };

export async function purgeWorkspace(ws: TenantWorkspace): Promise<PurgeReport> {
  const report: PurgeReport = { files: 0, uploads: 0, dbDropped: false, keyRevoked: false, errors: [] };
  if (ws.legacy) { report.errors.push("the studio's own workspace is never purged"); return report; }

  /* Files. On Blob everything of this workspace sits under one prefix, so the
     listing is the inventory; locally the rows are. */
  try {
    if (usingBlob()) {
      const { list, del } = await import("@vercel/blob");
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: `ws/${ws.id}/`, cursor, limit: 500 });
        if (page.blobs.length) { await del(page.blobs.map((b) => b.url)); report.files += page.blobs.length; }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    } else {
      await runInTenant(ws, async () => {
        await ready();
        const gens = await db().execute(`SELECT id FROM generations`);
        for (const r of gens.rows as unknown as { id: string }[]) { await deleteVideo(String(r.id)); report.files += 1; }
        const ups = await db().execute(`SELECT id, ext, stored_url FROM uploads`);
        for (const r of ups.rows as unknown as { id: string; ext: string; stored_url: string }[]) { await deleteUpload(String(r.id), String(r.ext), String(r.stored_url ?? "")); report.uploads += 1; }
      });
    }
  } catch (e) { report.errors.push(`files: ${(e as Error).message}`); }

  /* The key minted for it. */
  if (ws.gatewayKeyId) {
    try { await revokeGatewayKey(ws.gatewayKeyId); report.keyRevoked = true; }
    catch (e) { report.errors.push(`gateway key: ${(e as Error).message}`); }
  }

  /* Its database. */
  try {
    if (ws.dbUrl.startsWith("file:")) {
      const { rm } = await import("node:fs/promises");
      const file = ws.dbUrl.slice("file:".length);
      for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(path.resolve(file + suffix), { force: true });
      report.dbDropped = true;
    } else {
      await deleteTenantDatabase(ws);
      report.dbDropped = true;
    }
  } catch (e) { report.errors.push(`database: ${(e as Error).message}`); }

  try {
    await platformReady();
    await platformDb().execute({
      sql: `UPDATE workspaces SET purged_at = ?, keys_enc = NULL, db_token_enc = NULL, gateway_key_id = NULL, updated_at = ? WHERE id = ?`,
      args: [now(), now(), ws.id],
    });
  } catch (e) { report.errors.push(`record: ${(e as Error).message}`); }
  if (report.errors.length) console.error(`purge ${ws.slug}:`, report.errors.join(" · "));
  return report;
}
