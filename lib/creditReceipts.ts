import { db, ready } from "./db";
import { platformDb, platformReady } from "./platform";
import { requireTenant } from "./tenant";

/** Replicate only customer receipts into the tenant DB. The meter remains authoritative.
 * Revisions are allocated by the database, not a server clock. A missed write is
 * replayed on the next read; an older replica cannot overwrite a newer receipt. */
export async function syncCreditReceipts(): Promise<void> {
  const ws = requireTenant();
  await ready();
  await platformReady();
  const tenant = db();
  let revision = Number((await tenant.execute("SELECT revision FROM credit_receipt_cursor WHERE id=1")).rows[0]?.revision ?? 0);
  for (;;) {
    const page = await platformDb().execute({
      sql: "SELECT revision,event_id,credits FROM meter_credit_receipts WHERE workspace_id=? AND revision>? ORDER BY revision LIMIT 400",
      args: [ws.id, revision],
    });
    if (!page.rows.length) return;
    revision = Number(page.rows[page.rows.length - 1].revision);
    await tenant.batch([
      ...page.rows.map(r => ({
        sql: "INSERT INTO credit_receipts(event_id,credits,revision) VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET credits=excluded.credits,revision=excluded.revision WHERE excluded.revision>credit_receipts.revision",
        args: [String(r.event_id), Number(r.credits), Number(r.revision)],
      })),
      { sql: "INSERT INTO credit_receipt_cursor(id,revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=MAX(credit_receipt_cursor.revision,excluded.revision)", args: [revision] },
    ], "write");
    if (page.rows.length < 400) return;
  }
}
