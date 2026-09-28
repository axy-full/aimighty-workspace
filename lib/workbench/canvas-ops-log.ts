import type { Client, InStatement, Transaction } from "@libsql/client";
import { db, now } from "@/lib/db";
import type { Asset } from "./studio";
import type { NodeChange, OpOutcome } from "./canvas-ops-model";

/*
 * rig_canvas_ops: every server-made change to a production's team canvas, in
 * the workspace's own database. Additive: the table is created the first time
 * the server changes a canvas, and a row is never rewritten except for its
 * push state. It is
 *
 *  - the record: what was asked, by whom (a person's user id, or
 *    `agent:<runId>`), for which run, and each card's fields before and after;
 *  - the idempotency key: one row per (production, op id), so an operation
 *    that arrives twice is applied once and answers the same both times;
 *  - the outbox: a change the live room has not taken yet stays `pending`
 *    and is pushed again, in order, until it lands (lib/workbench/canvas-push.ts);
 *  - what open windows poll when there is no live room: the newest change
 *    (its `seq`), so a window folds the canvas in only when the server
 *    changed it.
 */

type Executor = Pick<Client, "execute"> | Transaction;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rig_canvas_ops (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     production_id TEXT NOT NULL,
     op_id TEXT NOT NULL,
     what TEXT NOT NULL,
     author TEXT NOT NULL,
     run_id TEXT,
     ops TEXT NOT NULL,
     outcomes TEXT NOT NULL,
     changes TEXT NOT NULL,
     assets TEXT NOT NULL,
     focus TEXT,
     changed INTEGER NOT NULL,
     revision INTEGER NOT NULL,
     push TEXT NOT NULL,
     push_attempts INTEGER NOT NULL DEFAULT 0,
     push_error TEXT,
     push_after INTEGER NOT NULL,
     push_lease INTEGER,
     pushed_at INTEGER,
     at INTEGER NOT NULL,
     UNIQUE(production_id, op_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rig_canvas_ops_production ON rig_canvas_ops(production_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_rig_canvas_ops_push ON rig_canvas_ops(push, production_id, seq)`,
];

const created = new WeakMap<object, Promise<void>>();
/** Creates the log on first use (idempotent). Inside a transaction the caller holds, it is created there. */
export async function canvasOpsReady(tx?: Transaction) {
  if (tx) { for (const sql of SCHEMA) await tx.execute(sql); return; }
  const client = db();
  let pending = created.get(client);
  if (!pending) {
    pending = client.batch(SCHEMA, "write").then(() => {}).catch((error) => { created.delete(client); throw error; });
    created.set(client, pending);
  }
  await pending;
}

/* Once the log exists it always does: remembered per database client, so the check windows make every few seconds stays one read. */
const existing = new WeakSet<object>();
/** Whether this workspace has ever had a server-made canvas change (reads never create the table). */
export async function canvasOpsExist(executor: Executor = db()): Promise<boolean> {
  const client = db();
  if (existing.has(client)) return true;
  const found = (await executor.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rig_canvas_ops'")).rows.length > 0;
  if (found) existing.add(client);
  return found;
}

export type PushState = "pending" | "done" | "none";

export type CanvasOpRow = {
  seq: number; productionId: string; opId: string; what: string; author: string; runId: string | null;
  outcomes: OpOutcome[]; changes: NodeChange[]; assets: Asset[]; focus: string | null;
  changed: number; revision: number; push: PushState; pushAttempts: number; at: number;
};

const parse = <T,>(text: unknown, fallback: T): T => { try { return JSON.parse(String(text)) as T; } catch { return fallback; } };

export function rowOf(row: Record<string, unknown>): CanvasOpRow {
  return {
    seq: Number(row.seq), productionId: String(row.production_id), opId: String(row.op_id), what: String(row.what),
    author: String(row.author), runId: row.run_id == null ? null : String(row.run_id),
    outcomes: parse(row.outcomes, []), changes: parse(row.changes, []), assets: parse(row.assets, []),
    focus: row.focus == null ? null : String(row.focus), changed: Number(row.changed), revision: Number(row.revision),
    push: String(row.push) as PushState, pushAttempts: Number(row.push_attempts ?? 0), at: Number(row.at),
  };
}

export async function findCanvasOp(tx: Executor, productionId: string, opId: string): Promise<CanvasOpRow | null> {
  const row = (await tx.execute({ sql: "SELECT * FROM rig_canvas_ops WHERE production_id=? AND op_id=?", args: [productionId, opId] })).rows[0];
  return row ? rowOf(row as unknown as Record<string, unknown>) : null;
}

export type NewCanvasOp = {
  productionId: string; opId: string; what: string; author: string; runId?: string | null;
  ops: unknown; outcomes: OpOutcome[]; changes: NodeChange[]; assets: Asset[]; focus: string | null;
  revision: number;
  /** Whether a live room should take it: pending when rooms are on and it changed something. */
  push: PushState;
};

export function insertCanvasOp(op: NewCanvasOp): InStatement {
  const at = now();
  return {
    sql: `INSERT INTO rig_canvas_ops(production_id,op_id,what,author,run_id,ops,outcomes,changes,assets,focus,changed,revision,push,push_attempts,push_after,at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    args: [op.productionId, op.opId, op.what, op.author, op.runId ?? null, JSON.stringify(op.ops ?? []), JSON.stringify(op.outcomes),
      JSON.stringify(op.changes), JSON.stringify(op.assets), op.focus, op.changes.length, op.revision, op.push, at, at],
  };
}

/** The newest server change to a production's canvas that windows should fold in, or null. */
export async function latestServerChange(productionId: string, executor: Executor = db()): Promise<{ seq: number; at: number; what: string; agent: boolean } | null> {
  if (!(await canvasOpsExist(executor))) return null;
  const row = (await executor.execute({ sql: "SELECT seq,at,what,author FROM rig_canvas_ops WHERE production_id=? AND changed>0 ORDER BY seq DESC LIMIT 1", args: [productionId] })).rows[0];
  return row ? { seq: Number(row.seq), at: Number(row.at), what: String(row.what), agent: String(row.author).startsWith("agent:") } : null;
}
