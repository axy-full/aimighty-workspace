import { randomUUID } from "node:crypto";
import { platformDb, platformReady, getWorkspace } from "./platform";
import { runInTenant } from "./tenant";
import { EVENTS, type WorkerEventName } from "./dispatch";

/**
 * Concurrency for native dispatch, kept in the platform database.
 *
 * Inngest enforced `[{ limit: 4 }, { limit: 2, key: workspaceId }]` on every
 * worker; the same two numbers live here so moving off Inngest changes no
 * capacity promise. A slot is one running invocation of /api/worker. Its TTL
 * outlives Vercel's 300-second function ceiling, so a crashed function frees
 * its slot by expiry rather than leaking it, and a slot is never held longer
 * than the work it fronts could possibly run.
 */
export const WORKER_SLOT_LIMIT = 4;
export const WORKER_SLOT_WORKSPACE_LIMIT = 2;
export const WORKER_SLOT_TTL_MS = 330_000;

export type WorkerSlot = { id: string; kind: string; workspaceId: string; jobId: string };

/* A local libsql client shares one connection, so write transactions are
   serialised here the way lib/billingLedger.ts does; on Turso the transaction
   itself is what makes count-then-insert atomic across function instances. */
let turn: Promise<unknown> = Promise.resolve();

export async function acquireSlot(
  input: { kind: string; workspaceId: string; jobId: string; ttlMs?: number },
  deps: { clock?: () => number } = {},
): Promise<WorkerSlot | null> {
  await platformReady();
  const clock = deps.clock ?? Date.now;
  const ttl = Math.max(1_000, input.ttlMs ?? WORKER_SLOT_TTL_MS);
  const result = turn.then(async () => {
    const tx = await platformDb().transaction("write");
    try {
      const at = clock();
      await tx.execute({ sql: "DELETE FROM worker_slots WHERE expires_at<=?", args: [at] });
      const running = (
        await tx.execute({
          sql: "SELECT id FROM worker_slots WHERE job_id=? AND expires_at>?",
          args: [input.jobId, at],
        })
      ).rows[0];
      if (running) {
        await tx.commit();
        return null;
      }
      const counts = (
        await tx.execute({
          sql: `SELECT COUNT(*) AS total, SUM(CASE WHEN workspace_id=? THEN 1 ELSE 0 END) AS workspace
                FROM worker_slots WHERE kind=? AND expires_at>?`,
          args: [input.workspaceId, input.kind, at],
        })
      ).rows[0];
      if (
        Number(counts?.total ?? 0) >= WORKER_SLOT_LIMIT ||
        Number(counts?.workspace ?? 0) >= WORKER_SLOT_WORKSPACE_LIMIT
      ) {
        await tx.commit();
        return null;
      }
      const slot: WorkerSlot = {
        id: randomUUID(),
        kind: input.kind,
        workspaceId: input.workspaceId,
        jobId: input.jobId,
      };
      await tx.execute({
        sql: "INSERT INTO worker_slots(id,kind,workspace_id,job_id,acquired_at,expires_at) VALUES(?,?,?,?,?,?)",
        args: [slot.id, slot.kind, slot.workspaceId, slot.jobId, at, at + ttl],
      });
      await tx.commit();
      return slot;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
  });
  turn = result.then(() => {}, () => {});
  return result;
}

export async function releaseSlot(id: string): Promise<void> {
  await platformReady();
  await platformDb().execute({ sql: "DELETE FROM worker_slots WHERE id=?", args: [id] });
}

/** Live slots, for diagnostics and tests. */
export async function liveSlots(deps: { clock?: () => number } = {}): Promise<WorkerSlot[]> {
  await platformReady();
  const at = (deps.clock ?? Date.now)();
  const rs = await platformDb().execute({
    sql: "SELECT id,kind,workspace_id,job_id FROM worker_slots WHERE expires_at>? ORDER BY acquired_at,id",
    args: [at],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    workspaceId: String(r.workspace_id),
    jobId: String(r.job_id),
  }));
}

export type ChainDeps = {
  /** The next queued job of this kind in this workspace, or null. Runs inside the tenant. */
  findQueued?: (kind: WorkerEventName) => Promise<string | null>;
  /** Re-enqueue it through the ordinary dispatch path. Runs inside the tenant. */
  enqueue?: (kind: WorkerEventName, jobId: string) => Promise<boolean>;
};

/**
 * After a slot frees, offer it to ONE queued job of the same kind in the
 * same workspace. Best-effort and single-shot: a job this misses is still
 * picked up by the ten-minute cron. Nothing here throws.
 */
export async function chainDispatch(
  input: { kind: WorkerEventName; workspaceId: string },
  deps: ChainDeps = {},
): Promise<boolean> {
  if (input.kind !== EVENTS.render && input.kind !== EVENTS.astraRender) return false;
  try {
    const ws = await getWorkspace(input.workspaceId);
    if (!ws || ws.deletedAt || ws.suspendedAt) return false;
    return await runInTenant(ws, async () => {
      const jobId = await (deps.findQueued ?? defaultFindQueued)(input.kind);
      if (!jobId) return false;
      return (deps.enqueue ?? defaultEnqueue)(input.kind, jobId);
    });
  } catch {
    return false;
  }
}

async function defaultFindQueued(kind: WorkerEventName): Promise<string | null> {
  if (kind === EVENTS.astraRender) {
    const { pendingAstraRenders } = await import("./astra-blender/render-jobs");
    const next = (await pendingAstraRenders(4)).find((job) => job.status === "queued" && job.funded);
    return next ? String(next.id) : null;
  }
  const { db, ready, now } = await import("./db");
  const { renderDispatchReady } = await import("./renderDispatch");
  const { requireTenant } = await import("./tenant");
  await ready();
  await renderDispatchReady();
  const at = now();
  /* Same shape as the cron's reconstruction query: reserved, never claimed,
     no provider handle — but including rows attempted a moment ago, because
     "busy" is exactly the outcome the chain exists to follow up. */
  const rs = await db().execute({
    sql: `SELECT g.id,g.kind FROM generations g JOIN render_dispatches d ON d.id=g.id
      WHERE g.status IN ('queued','running') AND g.deleted=0 AND g.kind IN ('image','audio','video')
        AND g.ark_task_id IS NULL AND json_extract(g.params,'$.paidClaim') IS NULL AND json_extract(g.params,'$.falRequestId') IS NULL
        AND json_extract(g.params,'$.producedOutcome') IS NULL AND json_extract(g.params,'$.identity') IS NULL
        AND d.lease_until<=?
      ORDER BY g.created_at,g.id LIMIT 3`,
    args: [at],
  });
  for (const row of rs.rows) {
    const reservation = (
      await platformDb().execute({
        sql: "SELECT status FROM meter_events WHERE id=? AND workspace_id=?",
        args: [row.id, requireTenant().id],
      })
    ).rows[0];
    if (reservation?.status === "running") return String(row.id);
  }
  return null;
}

async function defaultEnqueue(kind: WorkerEventName, jobId: string): Promise<boolean> {
  if (kind === EVENTS.astraRender) {
    const { enqueueAstraRender } = await import("./astra-blender/render-dispatch");
    return enqueueAstraRender(jobId);
  }
  const { db } = await import("./db");
  const row = (
    await db().execute({ sql: "SELECT kind FROM generations WHERE id=? AND deleted=0", args: [jobId] })
  ).rows[0];
  const renderKind = String(row?.kind ?? "");
  if (renderKind !== "image" && renderKind !== "audio" && renderKind !== "video") return false;
  const { enqueueRender } = await import("./inngest");
  return enqueueRender(jobId, renderKind);
}
