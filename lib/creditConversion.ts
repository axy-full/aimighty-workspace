import type { Transaction } from "@libsql/client";
import { balanceValueTx, billingReady, billingTransaction, syncBillingLedger } from "./billingLedger";
import { platformDb, platformReady } from "./platform";
import { LEGACY_CREDIT_USD, creditRateUsd, creditsFigure, fromDeci } from "./creditTerms";
import { deciCovering, microOf, valueOf } from "./creditUnits";
import { isHouseWorkspace } from "./houseWorkspace";

/**
 * Restating a workspace's balance at a new price of a credit (owner decision,
 * 28 September 2026: US$0.10 → US$0.80, "convert balances").
 *
 * Nothing is rewritten. Every lot and debit already records the price its
 * credits were recorded at (lib/billingLedger.ts), and the balance is their
 * value stated in today's credits — so the moment CREDIT_USD changes, 7
 * credits at US$0.10 already read as 0.875 at US$0.80, and no workspace gains
 * or loses a cent. What the conversion adds is the part only a decision can:
 *
 *  - the balance is rounded UP to the next tenth (0.875 → 0.9), so nobody
 *    loses a fraction; the difference is ONE ledger entry, a free `manual`
 *    grant recorded in the old unit, where it is a whole number of tenths
 *    (0.2 credits at US$0.10 here);
 *  - one row in billing_unit_conversions with the figures before and after,
 *    so the change is on the record and can be reversed exactly: a reversal
 *    is its own row and its own opposite grant, never an edit.
 *
 * Idempotent: a workspace whose balance is already stated at `toUsd` is left
 * as it is. A dry run computes the same figures inside a transaction that is
 * rolled back, so it writes nothing, not even the ledger's own import.
 * Receipts keep their admitted terms: meter rows and debits are not touched.
 *
 * The house workspace (lib/houseWorkspace.ts) is never billed in credits, so it
 * has no balance to restate: it is reported as `house` and nothing is written
 * for it, neither a rounding grant nor a conversion row.
 */
export type CreditConversion = {
  id: string | null;
  workspaceId: string;
  status: "planned" | "converted" | "already" | "reversed" | "refused" | "house";
  fromUsd: number;
  toUsd: number;
  /** The balance before, in credits at `fromUsd`. */
  balanceBefore: number;
  /** The same value in credits at `toUsd`, unrounded (0.875). */
  balanceExact: number;
  /** What it reads afterwards, in credits at `toUsd`, rounded up to a tenth (0.9). */
  balanceAfter: number;
  /** Credits at `fromUsd` granted to round it up (0.2), and the grant that holds them. */
  roundingCredits: number;
  roundingGrantId: string | null;
  /** Jobs still running when it was recorded; they settle at their admitted terms. */
  inFlight: number;
  reason?: string;
};

class DryRun extends Error {
  constructor(readonly result: CreditConversion) { super("dry run"); }
}

const same = (a: number, b: number) => microOf(a) === microOf(b);

/** The house workspace's line in a conversion or reversal: nothing read, nothing written. */
const houseLine = (workspaceId: string, fromUsd: number, toUsd: number): CreditConversion => ({
  id: null, workspaceId, status: "house", fromUsd, toUsd, balanceBefore: 0, balanceExact: 0, balanceAfter: 0,
  roundingCredits: 0, roundingGrantId: null, inFlight: 0,
  reason: "The house workspace is never billed in credits: it has no balance to restate.",
});
const dollars = (usd: number) => `US$${creditRateUsd(usd) ?? usd}`;

/** The price a workspace's balance is stated at: the last conversion's (or reversal's) target, else the legacy price. */
async function statedUnitTx(tx: Transaction, workspaceId: string): Promise<{ unit: number; last: Record<string, unknown> | null; count: number }> {
  const rows = await tx.execute({
    sql: `SELECT * FROM billing_unit_conversions WHERE workspace_id=? ORDER BY created_at, rowid`,
    args: [workspaceId],
  });
  const last = (rows.rows.at(-1) as Record<string, unknown> | undefined) ?? null;
  return { unit: last ? Number(last.to_usd) : LEGACY_CREDIT_USD, last, count: rows.rows.length };
}

async function inFlightTx(tx: Transaction, workspaceId: string): Promise<number> {
  const rs = await tx.execute({
    sql: `SELECT COUNT(*) AS n FROM meter_events m JOIN billing_debits d ON d.workspace_id=m.workspace_id AND d.event_id=m.id
      WHERE m.workspace_id=? AND m.status='running' AND m.paid_by_platform=1 AND d.credits>0`,
    args: [workspaceId],
  });
  return Number(rs.rows[0]?.n ?? 0);
}

async function convertTx(
  tx: Transaction,
  workspaceId: string,
  o: { fromUsd: number; toUsd: number; by: string | null; at: number },
): Promise<CreditConversion> {
  await syncBillingLedger(tx, workspaceId, o.at);
  const stated = await statedUnitTx(tx, workspaceId);
  const value = await balanceValueTx(tx, workspaceId, o.at);
  const inFlight = await inFlightTx(tx, workspaceId);
  const base = {
    workspaceId, fromUsd: o.fromUsd, toUsd: o.toUsd, inFlight,
    balanceBefore: value / microOf(o.fromUsd) / 10,
    balanceExact: value / microOf(o.toUsd) / 10,
  };
  if (same(stated.unit, o.toUsd))
    return { ...base, id: stated.last ? String(stated.last.id) : null, status: "already", balanceAfter: base.balanceExact, roundingCredits: 0, roundingGrantId: null };
  if (!same(stated.unit, o.fromUsd))
    return { ...base, id: null, status: "refused", balanceAfter: base.balanceExact, roundingCredits: 0, roundingGrantId: null,
      reason: `This balance is stated at ${dollars(stated.unit)} a credit, not ${dollars(o.fromUsd)}.` };
  // Rounded UP to a tenth at the new price (toward zero for a debt): nobody loses a fraction.
  const afterDeci = deciCovering(value, o.toUsd);
  // The difference, as whole tenths at the OLD price, where it is exact; rounded up if a future pair of prices is not.
  const roundingDeci = deciCovering(valueOf(afterDeci, o.toUsd) - value, o.fromUsd);
  const id = `unit:${workspaceId}:${stated.count + 1}`;
  const grantId = roundingDeci > 0 ? `${id}:rounding` : null;
  const result: CreditConversion = {
    ...base, id, status: "converted",
    balanceAfter: fromDeci(afterDeci), roundingCredits: fromDeci(roundingDeci), roundingGrantId: grantId,
  };
  if (grantId)
    await tx.execute({
      sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at,unit_usd) VALUES(?,?,?,?,'manual',?,?,?)`,
      args: [grantId, workspaceId, fromDeci(roundingDeci),
        `Credit price changed to ${dollars(o.toUsd)}: balance rounded up to ${creditsFigure(result.balanceAfter)} credits`,
        o.by, o.at, o.fromUsd],
    });
  await tx.execute({
    sql: `INSERT INTO billing_unit_conversions(id,workspace_id,from_usd,to_usd,balance_value,balance_before,balance_exact,balance_after,
      rounding_credits,rounding_grant_id,in_flight,reverses,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    args: [id, workspaceId, o.fromUsd, o.toUsd, value, result.balanceBefore, result.balanceExact, result.balanceAfter,
      result.roundingCredits, grantId, inFlight, o.by, o.at],
  });
  await syncBillingLedger(tx, workspaceId, o.at);
  return result;
}

async function reverseTx(tx: Transaction, workspaceId: string, o: { by: string | null; at: number }): Promise<CreditConversion> {
  await syncBillingLedger(tx, workspaceId, o.at);
  const stated = await statedUnitTx(tx, workspaceId);
  const value = await balanceValueTx(tx, workspaceId, o.at);
  const inFlight = await inFlightTx(tx, workspaceId);
  const last = stated.last;
  if (!last || last.reverses != null) {
    const unit = stated.unit;
    return { id: null, workspaceId, status: "refused", fromUsd: unit, toUsd: unit, balanceBefore: value / microOf(unit) / 10,
      balanceExact: value / microOf(unit) / 10, balanceAfter: value / microOf(unit) / 10, roundingCredits: 0, roundingGrantId: null, inFlight,
      reason: "There is no conversion to reverse: the last change of price was already reversed, or there was none." };
  }
  const fromUsd = Number(last.to_usd), toUsd = Number(last.from_usd);
  const rounding = Number(last.rounding_credits ?? 0);
  const id = `unit:${workspaceId}:${stated.count + 1}`;
  const grantId = rounding > 0 ? `${id}:unrounding` : null;
  // The rounding grant is taken back by its opposite, in its own unit; everything else is already exact.
  const afterValue = value - valueOf(Math.round(rounding * 10), toUsd);
  const result: CreditConversion = {
    id, workspaceId, status: "reversed", fromUsd, toUsd, inFlight,
    balanceBefore: value / microOf(fromUsd) / 10,
    balanceExact: afterValue / microOf(toUsd) / 10,
    balanceAfter: afterValue / microOf(toUsd) / 10,
    roundingCredits: -rounding, roundingGrantId: grantId,
  };
  if (grantId)
    await tx.execute({
      sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at,unit_usd) VALUES(?,?,?,?,'manual',?,?,?)`,
      args: [grantId, workspaceId, -rounding, `Credit price change reversed: back to ${dollars(toUsd)}`, o.by, o.at, toUsd],
    });
  await tx.execute({
    sql: `INSERT INTO billing_unit_conversions(id,workspace_id,from_usd,to_usd,balance_value,balance_before,balance_exact,balance_after,
      rounding_credits,rounding_grant_id,in_flight,reverses,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id, workspaceId, fromUsd, toUsd, value, result.balanceBefore, result.balanceExact, result.balanceAfter,
      -rounding, grantId, inFlight, String(last.id), o.by, o.at],
  });
  await syncBillingLedger(tx, workspaceId, o.at);
  return result;
}

/** One workspace's balance restated at `toUsd`. With `dryRun`, the same figures and nothing written. */
export async function convertCreditBalance(
  workspaceId: string,
  o: { fromUsd: number; toUsd: number; by?: string | null; dryRun?: boolean; at?: number },
): Promise<CreditConversion> {
  if (!(o.fromUsd > 0) || !(o.toUsd > 0)) throw new Error("A price of a credit must be above zero.");
  if (isHouseWorkspace({ id: workspaceId })) return houseLine(workspaceId, o.fromUsd, o.toUsd);
  await billingReady();
  const at = o.at ?? Date.now();
  try {
    return await billingTransaction(async (tx) => {
      const result = await convertTx(tx, workspaceId, { fromUsd: o.fromUsd, toUsd: o.toUsd, by: o.by ?? null, at });
      if (o.dryRun) throw new DryRun({ ...result, status: result.status === "converted" ? "planned" : result.status });
      return result;
    }, at);
  } catch (error) {
    if (error instanceof DryRun) return error.result;
    throw error;
  }
}

/** Undo a workspace's last conversion: its own row and the rounding grant's opposite. With `dryRun`, nothing written. */
export async function reverseCreditConversion(
  workspaceId: string,
  o: { by?: string | null; dryRun?: boolean; at?: number } = {},
): Promise<CreditConversion> {
  if (isHouseWorkspace({ id: workspaceId })) return houseLine(workspaceId, LEGACY_CREDIT_USD, LEGACY_CREDIT_USD);
  await billingReady();
  const at = o.at ?? Date.now();
  try {
    return await billingTransaction(async (tx) => {
      const result = await reverseTx(tx, workspaceId, { by: o.by ?? null, at });
      if (o.dryRun) throw new DryRun({ ...result, status: result.status === "reversed" ? "planned" : result.status });
      return result;
    }, at);
  } catch (error) {
    if (error instanceof DryRun) return error.result;
    throw error;
  }
}

/** Every workspace on the platform, deleted ones included (a restore must find its balance at the right price). */
export async function convertAllCreditBalances(
  o: { fromUsd: number; toUsd: number; by?: string | null; dryRun?: boolean; at?: number },
): Promise<CreditConversion[]> {
  await platformReady();
  const rows = await platformDb().execute(`SELECT id FROM workspaces ORDER BY created_at, id`);
  const out: CreditConversion[] = [];
  for (const r of rows.rows) out.push(await convertCreditBalance(String(r.id), o));
  return out;
}

export async function reverseAllCreditConversions(o: { by?: string | null; dryRun?: boolean; at?: number } = {}): Promise<CreditConversion[]> {
  await platformReady();
  const rows = await platformDb().execute(`SELECT id FROM workspaces ORDER BY created_at, id`);
  const out: CreditConversion[] = [];
  for (const r of rows.rows) out.push(await reverseCreditConversion(String(r.id), o));
  return out;
}

/** The record, newest first. */
export async function listCreditConversions(workspaceId?: string): Promise<Record<string, unknown>[]> {
  await billingReady();
  const rs = await platformDb().execute(workspaceId
    ? { sql: `SELECT * FROM billing_unit_conversions WHERE workspace_id=? ORDER BY created_at DESC, rowid DESC`, args: [workspaceId] }
    : `SELECT * FROM billing_unit_conversions ORDER BY created_at DESC, rowid DESC LIMIT 500`);
  return rs.rows.map((r) => ({ ...r }));
}
