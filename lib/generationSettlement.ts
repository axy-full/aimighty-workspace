import type { Client, InStatement } from "@libsql/client";
import { db, ready, now } from "./db";
import { meter, type MeterEvent } from "./meter";
import { platformDb, platformReady } from "./platform";
import { requireTenant } from "./tenant";

const boot = new WeakMap<Client, Promise<void>>();
export async function generationSettlementReady(): Promise<void> {
  await ready();
  const client = db();
  if (!boot.has(client))
    boot.set(
      client,
      client
        .batch(
          [
            `CREATE TABLE IF NOT EXISTS generation_settlements (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at INTEGER NOT NULL,
      attempted_at INTEGER NOT NULL DEFAULT 0, settled_at INTEGER
    )`,
            `CREATE INDEX IF NOT EXISTS idx_generation_settlements_pending
      ON generation_settlements(attempted_at,created_at) WHERE settled_at IS NULL`,
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

/** The product outcome and its exact bill commit together in the tenant DB.
 * Delivery to the separate platform DB is idempotent and can resume after a crash. */
export async function writeGenerationOutcome(
  write: InStatement,
  event: MeterEvent,
): Promise<boolean> {
  if (event.status === "running")
    throw new Error("An outcome must be terminal.");
  await generationSettlementReady();
  const result = await db().batch(
    [
      write,
      {
        sql: `INSERT INTO generation_settlements(id,event,created_at)
      SELECT id,?,? FROM generations WHERE changes()>0 AND id=? AND
        (status=? OR (?='failed' AND status='cancelled'))
      ON CONFLICT(id) DO UPDATE SET event=excluded.event, settled_at=NULL
      WHERE generation_settlements.event != excluded.event`,
        args: [
          JSON.stringify(event),
          now(),
          event.id,
          event.status,
          event.status,
        ],
      },
    ],
    "write",
  );
  return result[0].rowsAffected > 0;
}

export async function deliverGenerationSettlement(id: string): Promise<void> {
  await generationSettlementReady();
  const row = (
    await db().execute({
      sql: "SELECT event FROM generation_settlements WHERE id=? AND settled_at IS NULL",
      args: [id],
    })
  ).rows[0];
  if (!row) return;
  const serialized = String(row.event);
  const event = JSON.parse(serialized) as MeterEvent;
  // The event lives only in this tenant's private table. Never accept a supplied workspace override.
  event.workspaceId = requireTenant().id;
  await db().execute({
    sql: "UPDATE generation_settlements SET attempted_at=? WHERE id=? AND event=?",
    args: [now(), id, serialized],
  });
  await meter(event, { critical: true });
  await db().execute({
    sql: "UPDATE generation_settlements SET settled_at=? WHERE id=? AND event=?",
    args: [now(), id, serialized],
  });
}

export type ReconcileResult = { attempted: number; failed: number };
export async function flushGenerationSettlements(
  limit = 30,
): Promise<ReconcileResult> {
  await generationSettlementReady();
  const rs = await db().execute({
    sql: `SELECT id FROM generation_settlements WHERE settled_at IS NULL ORDER BY attempted_at,created_at,id LIMIT ?`,
    args: [Math.max(1, Math.min(50, limit))],
  });
  let failed = 0;
  // Ledger delivery is cheap, but serialized writes avoid needless DB contention.
  for (const row of rs.rows)
    try {
      await deliverGenerationSettlement(String(row.id));
    } catch {
      failed++;
    }
  return { attempted: rs.rows.length, failed };
}

/** Repair pre-outbox terminal rows without guessing a refund for an unknown result.
 * This is a bounded bridge for jobs already in flight when this version deploys. */
export async function repairLegacyGenerationSettlements(
  limit = 30,
): Promise<ReconcileResult> {
  await generationSettlementReady();
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT id,kind,engine,model FROM meter_events WHERE workspace_id=? AND status='running'
      AND kind IN ('image','audio','video') ORDER BY created_at,id LIMIT ?`,
    args: [requireTenant().id, Math.max(1, Math.min(50, limit))],
  });
  let attempted = 0,
    failed = 0;
  for (const prior of rs.rows) {
    const row = (
      await db().execute({
        sql: `SELECT status,cost_usd,refine_cost_usd,duration_ms,project_id,shot_id
      FROM generations WHERE id=? AND status IN ('succeeded','failed','cancelled')`,
        args: [prior.id],
      })
    ).rows[0];
    if (!row) continue;
    attempted++;
    try {
      const event: MeterEvent = {
        id: String(prior.id),
        kind: String(prior.kind) as MeterEvent["kind"],
        engine: String(prior.engine),
        model: String(prior.model),
        status: row.status === "succeeded" ? "succeeded" : "failed",
        engineCostUsd:
          row.cost_usd == null
            ? null
            : Number(row.cost_usd) + Number(row.refine_cost_usd ?? 0),
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
        projectId: row.project_id == null ? null : String(row.project_id),
        shotId: row.shot_id == null ? null : String(row.shot_id),
      };
      // A newer exact receipt always wins over this conservative legacy reconstruction.
      await db().execute({
        sql: "INSERT OR IGNORE INTO generation_settlements(id,event,created_at) VALUES(?,?,?)",
        args: [event.id, JSON.stringify(event), now()],
      });
      await deliverGenerationSettlement(event.id);
    } catch {
      failed++;
    }
  }
  return { attempted, failed };
}

/** Private persisted cost, independent of the customer-facing Generation projection. */
export async function generationCosts(
  id: string,
): Promise<{ cost: number | null; refinement: number }> {
  const row = (
    await db().execute({
      sql: "SELECT cost_usd,refine_cost_usd FROM generations WHERE id=?",
      args: [id],
    })
  ).rows[0];
  return {
    cost: row?.cost_usd == null ? null : Number(row.cost_usd),
    refinement: Number(row?.refine_cost_usd ?? 0),
  };
}
