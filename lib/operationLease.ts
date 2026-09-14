import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";

const initialized = new WeakMap<Client, Promise<void>>();
async function ready(client: Client) {
  let pending = initialized.get(client);
  if (!pending) {
    pending = client.execute(`CREATE TABLE IF NOT EXISTS operation_leases (
      name TEXT PRIMARY KEY, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      cursor TEXT NOT NULL DEFAULT '', started_at INTEGER, finished_at INTEGER,
      last_success_at INTEGER, last_cycle_at INTEGER, cycle_failed INTEGER NOT NULL DEFAULT 0,
      cycle_deferred INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'never', result_json TEXT
    )`).then(async () => {
      const columns = await client.execute("PRAGMA table_info(operation_leases)");
      if (!columns.rows.some((row) => row.name === "cycle_deferred")) {
        try { await client.execute("ALTER TABLE operation_leases ADD COLUMN cycle_deferred INTEGER NOT NULL DEFAULT 0"); }
        catch (error) {
          const refreshed = await client.execute("PRAGMA table_info(operation_leases)");
          if (!refreshed.rows.some((row) => row.name === "cycle_deferred")) throw error;
        }
      }
    }).catch((error) => {
      initialized.delete(client);
      throw error;
    });
    initialized.set(client, pending);
  }
  await pending;
}

export type OperationLease = { name: string; owner: string; cursor: string };
export type OperationResult = {
  attempted: number;
  failed: number;
  completed: number;
  deferred: boolean;
};

/** The lease outlives the function's hard execution ceiling. A late owner
 * cannot checkpoint or replace the status written by its successor. */
export async function acquireOperationLease(
  client: Client, name: string, leaseMs: number, at = Date.now(),
): Promise<OperationLease | null> {
  await ready(client);
  const owner = randomUUID();
  const result = await client.execute({
    sql: `INSERT INTO operation_leases(name,owner,lease_until,started_at,status)
      VALUES(?,?,?,?,'running') ON CONFLICT(name) DO UPDATE SET
      owner=excluded.owner, lease_until=excluded.lease_until, started_at=excluded.started_at,
      cycle_failed=CASE WHEN operation_leases.owner IS NOT NULL THEN 1 ELSE operation_leases.cycle_failed END,
      status='running' WHERE operation_leases.lease_until<=? RETURNING cursor`,
    args: [name, owner, at + leaseMs, at, at],
  });
  return result.rows.length ? { name, owner, cursor: String(result.rows[0].cursor) } : null;
}

export async function checkpointOperation(
  client: Client, lease: OperationLease, cursor: string, failed: boolean, at = Date.now(), deferred = false,
) {
  const result = await client.execute({
    sql: `UPDATE operation_leases SET cursor=?,cycle_failed=MAX(cycle_failed,?),cycle_deferred=MAX(cycle_deferred,?)
      WHERE name=? AND owner=? AND lease_until>?`,
    args: [cursor, failed ? 1 : 0, deferred ? 1 : 0, lease.name, lease.owner, at],
  });
  if (!result.rowsAffected) throw new Error("OPERATION_LEASE_LOST");
  lease.cursor = cursor;
}

export async function finishOperation(
  client: Client, lease: OperationLease, result: OperationResult,
  cycleComplete: boolean, at = Date.now(),
) {
  const updated = await client.execute({
    sql: `UPDATE operation_leases SET owner=NULL,lease_until=0,finished_at=?,
      last_success_at=CASE WHEN ?=0 AND ?=0 THEN ? ELSE last_success_at END,
      last_cycle_at=CASE WHEN ?=1 AND cycle_failed=0 AND cycle_deferred=0 AND ?=0 AND ?=0 THEN ? ELSE last_cycle_at END,
      status=CASE WHEN ?>0 OR cycle_failed=1 THEN 'failed' WHEN ?=1 OR cycle_deferred=1 THEN 'partial' ELSE 'succeeded' END,
      cursor=CASE WHEN ?=1 THEN '' ELSE cursor END,
      cycle_failed=CASE WHEN ?=1 THEN 0 ELSE MAX(cycle_failed,?) END,
      cycle_deferred=CASE WHEN ?=1 THEN 0 ELSE cycle_deferred END,result_json=?
      WHERE name=? AND owner=? AND lease_until>?`,
    args: [at, result.failed, result.deferred ? 1 : 0, at, cycleComplete ? 1 : 0, result.failed, result.deferred ? 1 : 0, at,
      result.failed, result.deferred ? 1 : 0, cycleComplete ? 1 : 0,
      cycleComplete ? 1 : 0, result.failed > 0 ? 1 : 0, cycleComplete ? 1 : 0, JSON.stringify(result),
      lease.name, lease.owner, at],
  });
  if (!updated.rowsAffected) throw new Error("OPERATION_LEASE_LOST");
}

export async function operationStatus(client: Client, name: string, at = Date.now()) {
  await ready(client);
  const row = (await client.execute({
    sql: "SELECT * FROM operation_leases WHERE name=?", args: [name],
  })).rows[0];
  if (!row) return { healthy: false, status: "never", lastRunAt: null, lastCycleAt: null };
  const expired = row.owner !== null && Number(row.lease_until) <= at;
  const lastCycleAt = row.last_cycle_at === null ? null : Number(row.last_cycle_at);
  return {
    healthy: !expired && row.status !== "failed" && row.status !== "partial" &&
      Number(row.cycle_failed) === 0 && Number(row.cycle_deferred) === 0 &&
      lastCycleAt !== null && at - lastCycleAt <= 30 * 60_000,
    status: expired ? "interrupted" : String(row.status),
    lastRunAt: row.started_at === null ? null : Number(row.started_at),
    lastFinishedAt: row.finished_at === null ? null : Number(row.finished_at),
    lastSuccessAt: row.last_success_at === null ? null : Number(row.last_success_at),
    lastCycleAt,
    // No tenant identifiers, keys, errors or user-supplied values enter this payload.
    result: row.result_json ? JSON.parse(String(row.result_json)) as OperationResult : null,
  };
}
