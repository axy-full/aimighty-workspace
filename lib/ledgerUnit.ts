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
 * `creditUsd()` is not that unit. Nobody flips a switch: changing CREDIT_USD
 * pauses paid work, and the conversion, which writes the new unit in the same
 * write as the restated figures, resumes it. A reversal writes the old unit
 * back, which pauses paid work again until CREDIT_USD is put back too.
 *
 * The row is seeded once, from `creditUsd()`, the first time the billing
 * tables are made (lib/billingLedger.ts billingReady). A deployment of this
 * code therefore starts open at whatever price it runs at; it is the CHANGE
 * of price after that which pauses. The house workspace is never billed in
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
  updated_at INTEGER NOT NULL, updated_by TEXT)`;

/**
 * What a job's credits, counted at the price it was approved at, are in the ledger's unit:
 * 8 for a US$0.80 job settling after the record moved to US$0.10, 1 when the two agree.
 * Only an exact whole factor restates; anything else is left as it was (×1).
 */
export function restateFactor(approvedUsd: number, ledgerUsd: number | null): number {
  if (ledgerUsd == null || !(approvedUsd > 0) || !(ledgerUsd > 0) || samePrice(approvedUsd, ledgerUsd)) return 1;
  const k = Math.round(approvedUsd / ledgerUsd);
  return k >= 2 && Math.round(approvedUsd * 1e6) === k * Math.round(ledgerUsd * 1e6) ? k : 1;
}

/** The ledger's unit; null only on a database whose billing tables were never made. */
export async function ledgerUnitTx(tx: Pick<Transaction, "execute">): Promise<number | null> {
  const rs = await tx.execute(`SELECT unit_usd FROM billing_unit WHERE id=1`);
  const n = Number(rs.rows[0]?.unit_usd);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Whether a paid job may be admitted now: the ledger counts in today's price of a credit. */
export async function ledgerOpenTx(tx: Pick<Transaction, "execute">): Promise<boolean> {
  const unit = await ledgerUnitTx(tx);
  return unit == null || samePrice(unit, creditUsd());
}

export async function setLedgerUnitTx(tx: Transaction, unitUsd: number, by: string | null, at: number): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO billing_unit(id,unit_usd,updated_at,updated_by) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET unit_usd=excluded.unit_usd, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    args: [unitUsd, at, by],
  });
}
