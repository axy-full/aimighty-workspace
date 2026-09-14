import { withRecoveryJob, withRecoveryActivity } from './recovery';
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { db, now, ready } from "./db";
import { requireTenant } from "./tenant";
import { platformDb, platformReady } from "./platform";

const boot = new WeakMap<Client, Promise<void>>();
export async function renderDispatchReady(): Promise<void> {
  await ready();
  const client = db();
  if (!boot.has(client))
    boot.set(
      client,
      client
        .batch(
          [
            `CREATE TABLE IF NOT EXISTS render_dispatches (
      id TEXT PRIMARY KEY,kind TEXT NOT NULL,created_at INTEGER NOT NULL,
      attempted_at INTEGER NOT NULL DEFAULT 0,accepted_at INTEGER,
      lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0
    )`,
            `CREATE INDEX IF NOT EXISTS idx_render_dispatch_pending ON render_dispatches(attempted_at,created_at)`,
          ],
          "write",
        )
        .then(() => undefined)
        .catch((error) => {
          boot.delete(client);
          throw error;
        }),
    );
  await boot.get(client);
}

export type RenderDispatchEvent = {
  id: string;
  name: "render/requested";
  data: { genId: string; kind: "image" | "audio"; workspaceId: string };
};

/** Lease only the cheap event delivery. The permanent paid claim is never reset. */
export async function dispatchRender(
  genId: string,
  kind: "image" | "audio",
  send: (event: RenderDispatchEvent) => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<boolean> {
return await withRecoveryJob(requireTenant().id, genId, async () => {

  await renderDispatchReady();
  const workspaceId = requireTenant().id;
  await db().execute({
    sql: `INSERT OR IGNORE INTO render_dispatches(id,kind,created_at)
    SELECT id,kind,created_at FROM generations WHERE id=? AND kind=? AND status IN ('queued','running') AND deleted=0`,
    args: [genId, kind],
  });
  const token = randomUUID(),
    ts = now();
  const claim = await db().execute({
    sql: `UPDATE render_dispatches SET lease_token=?,lease_until=?,attempted_at=?
      WHERE id=? AND lease_until<=? AND EXISTS(SELECT 1 FROM generations g WHERE g.id=render_dispatches.id
        AND g.deleted=0 AND g.status IN ('queued','running') AND json_extract(g.params,'$.paidClaim') IS NULL)`,
    args: [token, ts + Math.max(15_000, timeoutMs * 2), ts, genId, ts],
  });
  if (!claim.rowsAffected) return true; // Another delivery/paid owner owns this exact intent.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      withRecoveryActivity("queue-send", () => send({
        id: `render-${workspaceId}-${genId}`,
        name: "render/requested",
        data: { genId, kind, workspaceId },
      }), { uncertainOnError: true }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Render dispatch acknowledgment timed out.")),
          timeoutMs,
        );
      }),
    ]);
    await db().batch(
      [
        {
          sql: "UPDATE render_dispatches SET accepted_at=?,lease_until=0,lease_token=NULL WHERE id=? AND lease_token=?",
          args: [now(), genId, token],
        },
        {
          sql: `UPDATE generations SET params=json_set(params,'$.worker','inngest','$.workerDispatchedAt',COALESCE(json_extract(params,'$.workerDispatchedAt'),?)) WHERE id=? AND status IN ('queued','running')`,
          args: [now(), genId],
        },
      ],
      "write",
    );
    return true;
  } catch {
    // A timed-out send may still arrive. Inline execution and later deliveries share paidClaim.
    await db()
      .execute({
        sql: "UPDATE render_dispatches SET lease_until=0,lease_token=NULL WHERE id=? AND lease_token=?",
        args: [genId, token],
      })
      .catch(() => {});
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }

});
}

/** Reconstruct missing intents only for reserved synchronous jobs that never entered the paid step. */
export async function recoverRenderDispatches(
  send: (event: RenderDispatchEvent) => Promise<unknown>,
  options: { limit?: number; deadlineAt?: number } = {},
): Promise<{ attempted: number; failed: number; deferred: number }> {
  await renderDispatchReady();
  await platformReady();
  const rs = await db().execute({
    sql: `SELECT g.id,g.kind FROM generations g LEFT JOIN render_dispatches d ON d.id=g.id
    WHERE g.status IN ('queued','running') AND g.deleted=0 AND g.kind IN ('image','audio')
      AND json_extract(g.params,'$.paidClaim') IS NULL AND json_extract(g.params,'$.falRequestId') IS NULL
      AND json_extract(g.params,'$.identity') IS NULL AND (d.attempted_at IS NULL OR d.attempted_at<?)
    ORDER BY COALESCE(d.attempted_at,0),g.created_at,g.id LIMIT ?`,
    args: [now() - 60_000, Math.max(1, Math.min(10, options.limit ?? 4))],
  });
  const result = { attempted: 0, failed: 0, deferred: 0 };
  for (const row of rs.rows) {
    if (options.deadlineAt != null && now() >= options.deadlineAt) {
      result.deferred++;
      continue;
    }
    const reservation = (
      await platformDb().execute({
        sql: "SELECT status FROM meter_events WHERE id=? AND workspace_id=?",
        args: [row.id, requireTenant().id],
      })
    ).rows[0];
    if (reservation?.status !== "running") continue;
    result.attempted++;
    if (
      !(await dispatchRender(
        String(row.id),
        String(row.kind) as "image" | "audio",
        send,
      ))
    )
      result.failed++;
  }
  return result;
}
