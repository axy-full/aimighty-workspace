import type { Transaction } from "@libsql/client";
import { creditUsd } from "./creditTerms";

/**
 * The price of a credit the ledger's figures are stated in.
 *
 * CREDIT_USD says what a credit costs from now on; the balances, reservations
 * and caps on record are counted in whatever it said when they were written.
 * The two must agree before anything new is charged. Between a deployment
 * that changes CREDIT_USD and the conversion that restates the record in the
 * new unit (lib/creditConversion.ts), they do not, and a job admitted then
 * would be charged in credits the balance does not count in.
 *
 * So the ledger keeps its unit, in one row of the platform database
 * (`billing_unit`), and admission refuses new paid jobs whenever
 * `creditUsd()` is not that unit, or not the unit the workspace's own record
 * counts in (its last conversion's target, lib/creditConversion.ts). Nobody
 * flips a switch: changing CREDIT_USD pauses paid work, and the conversion,
 * which writes the new unit in the same write as the restated figures,
 * resumes it. A reversal puts a workspace back in the old unit, which pauses
 * paid work there until it is converted again or CREDIT_USD is put back too.
 *
 * The row is seeded once, the first time the billing tables are made
 * (lib/billingLedger.ts billingReady): at `creditUsd()`, unless the price has
 * come down since the last job was approved (seedLedgerUnit). A deployment of
 * this code therefore starts open at the price it runs at; it is the CHANGE of
 * price after that which pauses. The house workspace is never billed in
 * credits and is never paused by this.
 */
export const LEDGER_UNIT_PAUSED =
  "Paid work is paused for a few minutes while we update pricing. Nothing has been charged.";

/** A paid job refused because the record does not yet count in today's price of a credit. */
export class LedgerUnitPausedError extends Error {
  readonly status = 503;
  constructor() { super(LEDGER_UNIT_PAUSED); this.name = "LedgerUnitPausedError"; }
}

/** Same price to a millionth of a dollar. */
export const samePrice = (a: number, b: number) => Math.round(a * 1e6) === Math.round(b * 1e6);

export const LEDGER_UNIT_SCHEMA = `CREATE TABLE IF NOT EXISTS billing_unit(id INTEGER PRIMARY KEY CHECK(id=1), unit_usd REAL NOT NULL,
  updated_at INTEGER NOT NULL, updated_by TEXT, paused_since INTEGER)`;

/**
 * Seed and watch the row, once per server instance (lib/billingLedger.ts billingReady).
 *
 * Seeded at CREDIT_USD, unless the last job was approved at a HIGHER price: a deployment whose
 * first boot of this code is already at a lower price (US$0.10 over a record last written at
 * US$0.80) still counts its record in the old one, and pauses. A first boot at a higher price
 * than the last job (the merge at US$0.80 when nothing was metered since the price moved there)
 * seeds at CREDIT_USD, the price its newest rows were written at, and stays open.
 *
 * When an instance boots at a price the record does not count in, the moment is kept
 * (`paused_since`): the end of the old price's window, which the conversion converts up to and
 * never past (lib/creditConversion.ts).
 */
export async function seedLedgerUnit(c: Pick<Transaction, "execute">, at: number): Promise<void> {
  let seed = creditUsd();
  try {
    const last = Number((await c.execute(`SELECT credit_usd FROM meter_events WHERE credit_usd IS NOT NULL ORDER BY created_at DESC LIMIT 1`)).rows[0]?.credit_usd);
    if (last > seed && !samePrice(last, seed)) seed = last;
  } catch { /* no meter yet */ }
  await c.execute({ sql: `INSERT OR IGNORE INTO billing_unit(id,unit_usd,updated_at,updated_by) VALUES(1,?,?,'boot')`, args: [seed, at] });
  const unit = await ledgerUnitTx(c);
  if (unit != null && !samePrice(unit, creditUsd()))
    await c.execute({ sql: `UPDATE billing_unit SET paused_since=? WHERE id=1 AND paused_since IS NULL`, args: [at] });
}

/** When an instance first ran at a price the record does not count in; null while they agree. */
export async function pausedSinceTx(tx: Pick<Transaction, "execute">): Promise<number | null> {
  const rs = await tx.execute(`SELECT paused_since FROM billing_unit WHERE id=1`);
  const n = Number(rs.rows[0]?.paused_since);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What a job's credits, counted at the price it was approved at, are in the unit its workspace
 * counts in: 8 for a US$0.80 job settling in a US$0.10 record, 1 when the two agree. Only an exact
 * whole factor restates, and only UP. A job approved at a lower price than its record counts in
 * (a US$0.10 job from before 3 October settling after the merge, while the record still counts in
 * US$0.80) keeps its own credits: the conversion follows the job's own price and keeps it ×1, so
 * a workspace holding only pre-cutover credits keeps its count. No job can be approved after a
 * conversion and settle after its reversal: a reversal is refused while any job runs or was made
 * since, and a reversed workspace admits nothing new (ledgerOpenTx).
 */
export function restateFactor(approvedUsd: number, ledgerUsd: number | null): number {
  if (ledgerUsd == null || !(approvedUsd > 0) || !(ledgerUsd > 0) || samePrice(approvedUsd, ledgerUsd)) return 1;
  const k = Math.round(approvedUsd / ledgerUsd);
  return k >= 2 && Math.round(approvedUsd * 1e6) === k * Math.round(ledgerUsd * 1e6) ? k : 1;
}

/** The platform ledger's unit; null only on a database whose billing tables were never made. */
export async function ledgerUnitTx(tx: Pick<Transaction, "execute">): Promise<number | null> {
  const rs = await tx.execute(`SELECT unit_usd FROM billing_unit WHERE id=1`);
  const n = Number(rs.rows[0]?.unit_usd);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The unit ONE workspace's record counts in: its last conversion's target, or the platform's.
 * A workspace converted in a run that has not finished everywhere already counts in the new
 * price; settlement and new charges follow it, not the platform row.
 */
export async function workspaceUnitTx(tx: Pick<Transaction, "execute">, workspaceId: string): Promise<number | null> {
  try {
    const rs = await tx.execute({
      sql: `SELECT to_usd FROM billing_unit_conversions WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, args: [workspaceId],
    });
    const n = Number(rs.rows[0]?.to_usd);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* no conversions on this deployment */ }
  return ledgerUnitTx(tx);
}

/**
 * Whether a paid job may be admitted now: the platform ledger counts in today's price of a credit,
 * and so does the workspace's own record. A workspace a reversal put back in the old price (one on
 * its own, or the first ones of a reversal that stopped half-way) stays paused while the rest of
 * the platform runs, until it is converted again: a job admitted there would be charged in credits
 * its balance does not count in.
 */
export async function ledgerOpenTx(tx: Pick<Transaction, "execute">, workspaceId?: string | null): Promise<boolean> {
  const unit = await ledgerUnitTx(tx);
  if (unit != null && !samePrice(unit, creditUsd())) return false;
  if (!workspaceId) return true;
  const own = await workspaceUnitTx(tx, workspaceId);
  return own == null || samePrice(own, creditUsd());
}

export async function setLedgerUnitTx(tx: Pick<Transaction, "execute">, unitUsd: number, by: string | null, at: number): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO billing_unit(id,unit_usd,updated_at,updated_by) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET unit_usd=excluded.unit_usd, updated_at=excluded.updated_at, updated_by=excluded.updated_by, paused_since=NULL`,
    args: [unitUsd, at, by],
  });
}
