import { db, ready } from "./db";
import { requireTenant } from "./tenant";
import { platformDb, platformReady } from "./platform";
import { syncCreditReceipts } from "./creditReceipts";
import { billedCreditsExpr } from "./creditSql";

/** Include every token-funded operation; an authoritative receipt replaces its older take row. */
export async function tokenCreditUsage(since: number): Promise<Map<string, number>> {
  await ready(); await platformReady(); await syncCreditReceipts();
  await platformDb().execute("CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)");
  const baseline = await db().execute({ sql: `SELECT g.id,g.token_id,${billedCreditsExpr("g")} AS credits FROM generations g WHERE g.token_id IS NOT NULL AND g.created_at>=?`, args: [since] });
  const events = new Map(baseline.rows.map(row => [String(row.id), { token: String(row.token_id), credits: Number(row.credits) }]));
  const receipts = await platformDb().execute({
    sql: "SELECT m.id,r.token_id,m.billed_credits FROM meter_events m JOIN generation_reservations r ON r.id=m.id AND r.workspace_id=m.workspace_id WHERE m.workspace_id=? AND m.created_at>=? AND r.token_id IS NOT NULL",
    args: [requireTenant().id, since],
  });
  for (const row of receipts.rows) events.set(String(row.id), { token: String(row.token_id), credits: Number(row.billed_credits ?? 0) });
  const totals = new Map<string, number>();
  for (const { token, credits } of events.values()) totals.set(token, (totals.get(token) ?? 0) + credits);
  return totals;
}
