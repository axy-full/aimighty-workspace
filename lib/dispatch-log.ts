import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { platformDb, platformReady } from "./platform";

/**
 * A durable, short memory of what native dispatch did.
 *
 * `dispatchEvent` and the worker route already log fixed-shape lines, but
 * those live in Vercel's log viewer and are gone in an hour. This table in
 * the platform database keeps the same facts — one row when a sender hands
 * an event to /api/worker ("send": sent, refused, failed, unconfigured) and
 * one when the worker answers it ("run": busy, finished-ok, finished-error)
 * — so an owner can read the last few from /api/health and know whether a
 * render was taken and whether it ran.
 *
 * Identifiers and outcomes only: the event id, its name, the workspace and
 * an HTTP status. Never a prompt, a URL, a credential or an error message.
 *
 * Everything here is best-effort. Recording never throws — a log that could
 * fail a render would be worse than no log — and is a no-op when the
 * platform database is unavailable. Rows older than the retention window are
 * pruned on write, a bounded batch at a time.
 */

export type DispatchPhase = "send" | "run";

export type DispatchLogInput = {
  eventId: string;
  name: string;
  phase: DispatchPhase;
  outcome: string;
  status?: number;
  durationMs?: number;
  workspaceId?: string;
};

export type DispatchLogRow = {
  id: string;
  eventId: string;
  name: string;
  phase: DispatchPhase;
  outcome: string;
  status: number | null;
  durationMs: number | null;
  workspaceId: string | null;
  createdAt: number;
};

export const DISPATCH_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Old rows removed per write: enough to keep up, small enough never to stall a hand-off. */
export const DISPATCH_LOG_PRUNE_BATCH = 200;
export const DISPATCH_LOG_RECENT_LIMIT = 10;

type Deps = {
  clock?: () => number;
  /** The platform client, ready; tests inject a throwing one to prove the no-op. */
  platform?: () => Promise<Client>;
};

const defaultPlatform = async (): Promise<Client> => {
  await platformReady();
  return platformDb();
};

const integer = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

/** Write one outcome row and prune a bounded batch of expired ones. Never throws. */
export async function recordDispatch(input: DispatchLogInput, deps: Deps = {}): Promise<boolean> {
  try {
    const db = await (deps.platform ?? defaultPlatform)();
    const at = (deps.clock ?? Date.now)();
    await db.batch(
      [
        {
          sql: `INSERT INTO dispatch_log(id,event_id,name,phase,outcome,status,duration_ms,workspace_id,created_at)
                VALUES(?,?,?,?,?,?,?,?,?)`,
          args: [
            randomUUID(),
            String(input.eventId).slice(0, 200),
            String(input.name).slice(0, 120),
            input.phase,
            String(input.outcome).slice(0, 40),
            integer(input.status),
            integer(input.durationMs),
            input.workspaceId ? String(input.workspaceId).slice(0, 120) : null,
            at,
          ],
        },
        {
          sql: `DELETE FROM dispatch_log WHERE id IN (
                  SELECT id FROM dispatch_log WHERE created_at<? ORDER BY created_at LIMIT ?)`,
          args: [at - DISPATCH_LOG_RETENTION_MS, DISPATCH_LOG_PRUNE_BATCH],
        },
      ],
      "write",
    );
    return true;
  } catch {
    return false;
  }
}

/** The newest rows first; throws when the platform database cannot answer. */
export async function recentDispatches(limit = DISPATCH_LOG_RECENT_LIMIT, deps: Deps = {}): Promise<DispatchLogRow[]> {
  const db = await (deps.platform ?? defaultPlatform)();
  const rs = await db.execute({
    sql: `SELECT id,event_id,name,phase,outcome,status,duration_ms,workspace_id,created_at
          FROM dispatch_log ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args: [Math.max(1, Math.min(100, Math.floor(limit)))],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    eventId: String(r.event_id),
    name: String(r.name),
    phase: r.phase === "send" ? "send" : "run",
    outcome: String(r.outcome),
    status: r.status == null ? null : Number(r.status),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    workspaceId: r.workspace_id == null ? null : String(r.workspace_id),
    createdAt: Number(r.created_at),
  }));
}
