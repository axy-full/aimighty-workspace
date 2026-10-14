import { db, ready } from "./db";
import { platformDb, platformReady } from "./platform";
import { requireTenant } from "./tenant";
import { freezeEstimatesSql } from "./creditSql";

/**
 * Takes made before metering have no receipt, so their figure was once computed at read time from the cost and TODAY's margin table, and a change to the table repriced history
 * on statements, usage and caps. This freezes it (owner, 14 Oct 2026: "freeze estimated figures in their own table"; docs/plans/step-0-data.md item 4, M2):
 * once per workspace, one batch writes each such take's figure, at today's terms so every figure a customer sees now is kept exactly, into `estimated_credits`, plus the marker
 * that says it ran. It covers only takes that are certainly from before metering: no receipt (after a full receipt sync), and older than this workspace's first meter event (read
 * from the platform database before the fill). A take newer than that is never frozen, so a take whose receipt has not synced yet cannot be frozen by mistake. After the fill every
 * reader reads the frozen figure: `billedCreditsExpr` (lib/creditSql.ts), and the statement, the cap baseline and the cap reader through `estimated_credits` directly. Nothing is
 * written to the meter, a receipt or a balance.
 *
 * Called by `syncCreditReceipts` (lib/creditReceipts.ts) once the receipts are all in, which every reader of a take's credits already does first.
 */
export async function ensureEstimatedCredits(): Promise<void> {
  const ws = requireTenant();
  await ready();
  const tenant = db();
  if ((await tenant.execute("SELECT 1 FROM estimated_credits_fill WHERE id=1")).rows.length) return;
  await platformReady();
  const first = (await platformDb().execute({ sql: "SELECT MIN(created_at) AS first FROM meter_events WHERE workspace_id = ?", args: [ws.id] })).rows[0]?.first;
  const firstMeterAt = first == null ? null : Number(first);
  const at = Date.now();
  await tenant.batch([
    {
      sql: `INSERT OR IGNORE INTO estimated_credits(gen_id, credits, frozen_at)
            SELECT g.id, CAST(${freezeEstimatesSql("g")} AS INTEGER), ? FROM generations g
            WHERE NOT EXISTS (SELECT 1 FROM credit_receipts r WHERE r.event_id = g.id) AND (? IS NULL OR g.created_at < ?)`,
      args: [at, firstMeterAt, firstMeterAt],
    },
    { sql: "INSERT OR IGNORE INTO estimated_credits_fill(id, filled_at, first_meter_at) VALUES(1, ?, ?)", args: [at, firstMeterAt] },
  ], "write");
}
