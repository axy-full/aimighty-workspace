import type { Client, Transaction } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { db, now } from "../db";
import { requireTenant } from "../tenant";
import { isPersonApprover, notAPersonSql } from "../workbench/plan-approval";

/*
 * The one-run lift (owner, 7 Oct): "a sample mark stops ALL spending in its workspace. I (admin only) can lift it for
 * one approved run, and it comes back on automatically afterwards. Guests can never lift it."
 *
 * One run is one Atomik run on a board (a `rig_agent_runs` row, `rar_…`): the planning turn, the build, the plan
 * card's one Approve and every render and fix drawn under it all carry that run's id down to the reservation
 * (lib/generationRequests.ts reserveGenerationSpend's `run`). That is the narrowest thing that covers "one approved
 * run": a single generation request would not cover the plan's several renders, and anything wider (a production, a
 * person) would let unrelated spending through.
 *
 *  - A person who owns or administers the workspace lifts it (lib/demo/mark.server.ts liftSampleMark), for their next
 *    ask of Atomik or for a run of their own still going. Their next ask binds the lift to the run it makes, in the
 *    same write (bindSampleLift), and from then on the guard lets through only requests that name that run.
 *  - It ends by itself when the run ends (done, failed, stopped or undone), at its expiry (LIFT_MS), or when the person
 *    puts the mark back. Nothing has to run for that: every check reads the lift and its run afresh, and a lift found
 *    ended is closed on the spot, so a crash mid-run can never leave the mark lifted.
 *  - One row per lift in `sample_lifts` (the workspace's own database, additive): who lifted it and when, which run,
 *    and when and why the mark came back. Rows are never deleted.
 */

/** How long a lift may last at most: the mark is back on after this even if the run is still going. */
export const LIFT_MS = 2 * 60 * 60 * 1000;

/** Why a lift ended. */
export type LiftEnd = "finished" | "failed" | "stopped" | "undone" | "gone" | "expired" | "put_back" | "unmarked";

export type LiftRow = {
  id: string; liftedBy: string; liftedAt: number; expiresAt: number;
  runId: string | null; productionId: string | null; boundAt: number | null;
  endedAt: number | null; endedReason: LiftEnd | null; endedBy: string | null;
};

type Executor = Pick<Client, "execute"> | Transaction;

export const SAMPLE_LIFT_SCHEMA = `CREATE TABLE IF NOT EXISTS sample_lifts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  lifted_by TEXT NOT NULL,
  lifted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  run_id TEXT,
  production_id TEXT,
  bound_at INTEGER,
  ended_at INTEGER,
  ended_reason TEXT,
  ended_by TEXT,
  CHECK (NOT ${notAPersonSql("lifted_by")}),
  CHECK (expires_at > lifted_at AND expires_at - lifted_at <= ${LIFT_MS})
)`;
/** At most one lift open per workspace. */
const ONE_OPEN = "CREATE UNIQUE INDEX IF NOT EXISTS sample_lifts_one_open ON sample_lifts(workspace_id) WHERE ended_at IS NULL";

const readied = new WeakMap<Client, Promise<void>>();
/** Creates the table on first write (a read never does). */
export async function sampleLiftReady(): Promise<void> {
  const client = db();
  let ready = readied.get(client);
  if (!ready) {
    ready = (async () => { await client.execute(SAMPLE_LIFT_SCHEMA); await client.execute(ONE_OPEN); })();
    ready.catch(() => readied.delete(client));
    readied.set(client, ready);
  }
  await ready;
}

async function tableExists(ex: Executor, name: string): Promise<boolean> {
  return (await ex.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [name] })).rows.length > 0;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

function liftOf(r: Record<string, unknown>): LiftRow {
  return {
    id: String(r.id), liftedBy: String(r.lifted_by), liftedAt: Number(r.lifted_at), expiresAt: Number(r.expires_at),
    runId: str(r.run_id), productionId: str(r.production_id), boundAt: num(r.bound_at),
    endedAt: num(r.ended_at), endedReason: str(r.ended_reason) as LiftEnd | null, endedBy: str(r.ended_by),
  };
}

type RunState = { state: string; owner: string; requestId: string; productionId: string; finishedAt: number | null; undoneAt: number | null };

/** The run a lift names, read fresh from the workspace's own runs, or null when it is not there. */
export async function liftRun(ex: Executor, runId: string): Promise<RunState | null> {
  if (!(await tableExists(ex, "rig_agent_runs"))) return null;
  const r = (await ex.execute({ sql: "SELECT state,owner,request_id,production_id,finished_at,undone_at FROM rig_agent_runs WHERE id=?", args: [runId] })).rows[0];
  return r ? { state: String(r.state), owner: String(r.owner), requestId: String(r.request_id), productionId: String(r.production_id), finishedAt: num(r.finished_at), undoneAt: num(r.undone_at) } : null;
}

/** States in which a run has ended: nothing more is sent for it. */
const ENDED: Record<string, LiftEnd> = { done: "finished", failed: "failed", stopped: "stopped" };

/** Whether a run in this state may still be lifted for. */
export function runStillGoing(run: Pick<RunState, "state" | "undoneAt"> | null): boolean {
  return !!run && run.undoneAt == null && !(run.state in ENDED);
}

/** Why, and from when, a lift no longer holds at `at`; null while it does. */
async function endingOf(ex: Executor, lift: LiftRow, at: number): Promise<{ at: number; reason: LiftEnd } | null> {
  if (at >= lift.expiresAt) return { at: lift.expiresAt, reason: "expired" };
  if (!lift.runId) return null;
  const run = await liftRun(ex, lift.runId);
  if (!run) return { at, reason: "gone" };
  if (run.undoneAt != null) return { at: Math.min(at, run.undoneAt), reason: "undone" };
  const ended = ENDED[run.state];
  return ended ? { at: Math.min(at, run.finishedAt ?? at), reason: ended } : null;
}

/** Closes a lift (once): the mark is fully back on. */
export async function endSampleLift(ex: Executor, id: string, reason: LiftEnd, at: number, by: string | null = null): Promise<boolean> {
  const res = await ex.execute({
    sql: "UPDATE sample_lifts SET ended_at=?,ended_reason=?,ended_by=? WHERE id=? AND workspace_id=? AND ended_at IS NULL",
    args: [at, reason, by, id, requireTenant().id],
  });
  return res.rowsAffected > 0;
}

/**
 * The workspace's lift that still holds, or null. A lift whose run has ended or whose time is up is closed here, as
 * it is found, so it is never read as open again (the record then says when the mark came back).
 */
export async function liveSampleLift(ex: Executor = db()): Promise<LiftRow | null> {
  if (!(await tableExists(ex, "sample_lifts"))) return null;
  const rows = (await ex.execute({ sql: "SELECT * FROM sample_lifts WHERE workspace_id=? AND ended_at IS NULL ORDER BY lifted_at DESC", args: [requireTenant().id] })).rows;
  const at = now();
  let live: LiftRow | null = null;
  for (const row of rows) {
    const lift = liftOf(row as unknown as Record<string, unknown>);
    const ending = await endingOf(ex, lift, at);
    if (ending) await endSampleLift(ex, lift.id, ending.reason, ending.at);
    else live ??= lift;
  }
  return live;
}

/**
 * What may pass the mark while it is lifted. `runId`: a paid request of a run (the reservation, admission, a board
 * action on the run); `userId`, when a person pressed it, must be the one who lifted it. `ask`: a person asking Atomik
 * for a board, which passes only for the lifter whose lift still waits for its run (or for the run this same ask made,
 * when its reply was lost and it is asked again).
 */
export type LiftScope = { runId?: string | null; userId?: string | null; ask?: { userId: string; requestId: string } };

export async function liftLetsThrough(scope: LiftScope, ex: Executor = db()): Promise<boolean> {
  if (!scope.ask && !scope.runId) return false;
  const lift = await liveSampleLift(ex);
  if (!lift || !isPersonApprover(lift.liftedBy)) return false;
  if (scope.ask) {
    if (scope.ask.userId !== lift.liftedBy) return false;
    if (!lift.runId) return true;
    const run = await liftRun(ex, lift.runId);
    return !!run && run.owner === scope.ask.userId && run.requestId === scope.ask.requestId;
  }
  if (lift.runId == null || lift.runId !== scope.runId) return false;
  return scope.userId == null || scope.userId === lift.liftedBy;
}

/**
 * Binds the live lift to the run an ask just made, inside the ask's own write: that run is then the only one it
 * covers. False when no lift of this person waits for a run (the ask is then refused, and nothing is written).
 */
export async function bindSampleLift(tx: Transaction, input: { userId: string; runId: string; productionId: string; at: number }): Promise<boolean> {
  const lift = await liveSampleLift(tx);
  if (!lift || lift.liftedBy !== input.userId) return false;
  if (lift.runId) return lift.runId === input.runId;
  const res = await tx.execute({
    sql: "UPDATE sample_lifts SET run_id=?,production_id=?,bound_at=? WHERE id=? AND workspace_id=? AND run_id IS NULL AND ended_at IS NULL",
    args: [input.runId, input.productionId, input.at, lift.id, requireTenant().id],
  });
  return res.rowsAffected === 1;
}

/** Writes a new lift. The caller has checked who may (lib/demo/mark.server.ts) and that none is open. */
export async function insertSampleLift(tx: Transaction, input: { by: string; at: number; run: { id: string; productionId: string } | null }): Promise<LiftRow> {
  if (!isPersonApprover(input.by)) throw new Error("Only a person lifts the sample mark.");
  const id = "slf_" + randomUUID().replaceAll("-", "").slice(0, 24);
  await tx.execute({
    sql: "INSERT INTO sample_lifts(id,workspace_id,lifted_by,lifted_at,expires_at,run_id,production_id,bound_at) VALUES(?,?,?,?,?,?,?,?)",
    args: [id, requireTenant().id, input.by, input.at, input.at + LIFT_MS, input.run?.id ?? null, input.run?.productionId ?? null, input.run ? input.at : null],
  });
  return { id, liftedBy: input.by, liftedAt: input.at, expiresAt: input.at + LIFT_MS, runId: input.run?.id ?? null, productionId: input.run?.productionId ?? null, boundAt: input.run ? input.at : null, endedAt: null, endedReason: null, endedBy: null };
}

/** The workspace's lifts, newest first, any live one settled first. */
export async function sampleLifts(limit = 10): Promise<LiftRow[]> {
  if (!(await tableExists(db(), "sample_lifts"))) return [];
  await liveSampleLift();
  const rows = (await db().execute({ sql: "SELECT * FROM sample_lifts WHERE workspace_id=? ORDER BY lifted_at DESC LIMIT ?", args: [requireTenant().id, limit] })).rows;
  return rows.map((r) => liftOf(r as unknown as Record<string, unknown>));
}
