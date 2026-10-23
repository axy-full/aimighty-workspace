import { db, ready } from "./db";
import { freezeEstimatesSql } from "./creditSql";

/**
 * A take with a cost and no receipt has its figure FROZEN here, the first time anything reads it, and the figure is never computed again (owner, 14 Oct 2026: "freeze estimated
 * figures in their own table"; 15 Oct: "freeze the figure the first time it's read, then never again; it never reads 0"; docs/plans/step-0-data.md item 4, M2). Takes made before
 * metering were once priced at read time from the cost and TODAY's margin table, so a change to the table repriced history on statements, usage and caps; now each is written once, at
 * the terms of the day it is first read, into `estimated_credits`, and every reader reads it through `billedCreditsExpr` (lib/creditSql.ts): the take's receipt,
 * then this frozen figure, then 0 (the statement, the cap baseline and the cap reader all use it). A take with a receipt is untouched (the receipt is read first, and is never frozen over); a take with no cost has nothing to freeze and
 * reads 0 (it may still be in flight: a row written now would pin 0 for a take that later gets a cost). Nothing is written to the meter, a receipt or a balance.
 *
 * It is one idempotent INSERT OR IGNORE keyed by the take's id, so two readers that arrive together freeze once and the later one changes nothing. It needs only this workspace's own
 * database (the margin table is configuration, not the platform database), so it also runs when the platform cannot answer: a take that has a receipt upstream but not yet here is frozen
 * at its estimate for the moment (a cap then counts it, never under-counts it) and reads its receipt as soon as the receipt syncs.
 *
 * Called by `syncCreditReceipts` (lib/creditReceipts.ts) after the receipts are copied, which every reader of a take's credits already does first.
 */
export async function ensureEstimatedCredits(): Promise<void> {
  await ready();
  await db().execute({
    sql: `INSERT OR IGNORE INTO estimated_credits(gen_id, credits, frozen_at)
          SELECT g.id, CAST(${freezeEstimatesSql("g")} AS INTEGER), ? FROM generations g
          WHERE COALESCE(g.cost_usd,0) + COALESCE(g.refine_cost_usd,0) > 0
            AND NOT EXISTS (SELECT 1 FROM credit_receipts r WHERE r.event_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM estimated_credits e WHERE e.gen_id = g.id)`,
    args: [Date.now()],
  });
}
