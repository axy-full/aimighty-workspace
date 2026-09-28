import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setCreditUsd } from "../helpers/creditRate";

/**
 * The ledger in tenths, across a change of the price of a credit.
 *
 * Every lot and debit records the price its credits were recorded at; the
 * balance is their exact value in today's credits (lib/billingLedger.ts). The
 * conversion (lib/creditConversion.ts) only rounds each balance up to a tenth,
 * as one ledger entry, and records what it did so it can be reversed exactly.
 * Nothing here is rewritten: receipts keep their admitted terms.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-credit-conversion-"));
process.env.PLATFORM_DATABASE_URL ??= `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL ??= `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const t0 = Date.UTC(2027, 2, 1, 12);
let before: string | undefined;
test.beforeAll(() => { before = process.env.CREDIT_USD; });
test.afterAll(() => setCreditUsd(before));
test.beforeEach(() => setCreditUsd("0.80"));

const ws = () => `ws_units_${randomUUID().slice(0, 8)}`;

async function db() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { billingReady } = await import("../../lib/billingLedger");
  await platformReady();
  await billingReady();
  return platformDb();
}

/** A grant as the app writes one: credits, and the price of a credit they were given at (null: before units existed). */
async function grant(w: string, id: string, credits: number, unit: number | null, kind = "purchase", at = t0) {
  await (await db()).execute({
    sql: `INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at,unit_usd) VALUES(?,?,?,?,?,?)`,
    args: [id, w, credits, kind, at, unit],
  });
}

/** A job's reservation or settlement: its charge in the unit its terms were admitted at. */
async function charge(w: string, id: string, credits: number, unit: number, at = t0, allowDebt = false) {
  const { billingTransaction, syncBillingLedger, setCreditDebitTx } = await import("../../lib/billingLedger");
  await billingTransaction(async (tx) => {
    await syncBillingLedger(tx, w, at);
    await setCreditDebitTx(tx, w, id, credits, at, allowDebt, unit);
  }, at);
}

/** The job's receipt, as meter() writes it: billed credits at its admitted price. */
async function receipt(w: string, id: string, credits: number, unit: number, status = "running", at = t0) {
  await (await db()).execute({
    sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at,credit_usd)
      VALUES(?,?,'video','byteplus','mock',?,1,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,billed_credits=excluded.billed_credits`,
    args: [id, w, status, credits, at, at, unit],
  });
}

async function balance(w: string, at = t0) {
  const { billingStateFor } = await import("../../lib/billingLedger");
  return (await billingStateFor(w, at)).credits.balance;
}

/** Every stored credit figure for a workspace is a whole number of tenths: nothing drifted on the way in. */
async function onTheGrid(w: string) {
  const d = await db();
  for (const [table, column] of [["billing_lots", "credits"], ["billing_lots", "drawn"], ["billing_debits", "credits"], ["billing_allocations", "credits"], ["credit_grants", "credits"]] as const) {
    const rows = await d.execute({ sql: `SELECT ${column} AS v FROM ${table} WHERE workspace_id=?`, args: [w] });
    for (const r of rows.rows) {
      const v = Number(r.v);
      expect(Math.abs(v * 10 - Math.round(v * 10)), `${table}.${column} = ${v}`).toBeLessThan(1e-9);
      expect(v, `${table}.${column} is the canonical double for its tenth`).toBe(Math.round(v * 10) / 10);
    }
  }
}

async function rowCounts(w: string) {
  const d = await db();
  const out: Record<string, number> = {};
  for (const table of ["credit_grants", "billing_lots", "billing_debits", "billing_allocations", "billing_unit_conversions", "billing_ledgers"])
    out[table] = Number((await d.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=?`, args: [w] })).rows[0].n);
  return out;
}

test("reservation and settlement move whole tenths; a settle/refund cycle returns exactly what it took", async () => {
  const w = ws();
  await grant(w, `${w}_pack`, 10, 0.80);
  expect(await balance(w)).toBe(10);
  await charge(w, `${w}_job`, 3.7, 0.80);          // reserved at the quote
  expect(await balance(w)).toBe(6.3);
  await charge(w, `${w}_job`, 3.2, 0.80, t0, true); // settled below it: 0.5 comes back
  expect(await balance(w)).toBe(6.8);
  await charge(w, `${w}_job`, 3.2, 0.80, t0, true); // the same settlement again changes nothing
  expect(await balance(w)).toBe(6.8);
  await charge(w, `${w}_job`, 0, 0.80, t0, true);   // refunded in full
  expect(await balance(w)).toBe(10);
  await onTheGrid(w);
});

test("hundreds of charges, settlements and refunds never drift", async () => {
  const w = ws();
  await grant(w, `${w}_pack`, 250, 0.80);
  await grant(w, `${w}_bonus`, 25, 0.80, "bonus");
  let spentDeci = 0;
  for (let i = 0; i < 400; i++) {
    const quoted = (i % 9) + 1;                     // 0.1 … 0.9, in tenths
    await charge(w, `${w}_j${i}`, quoted / 10, 0.80);
    if (i % 3 === 0) await charge(w, `${w}_j${i}`, 0, 0.80, t0, true);                          // failed: refunded
    else if (i % 3 === 1) { await charge(w, `${w}_j${i}`, 0.1, 0.80, t0, true); spentDeci += 1; } // settled at the minimum
    else spentDeci += quoted;                                                                 // settled as quoted
  }
  const { billingStateFor } = await import("../../lib/billingLedger");
  const s = await billingStateFor(w, t0);
  expect(s.credits.balance).toBe((2750 - spentDeci) / 10);
  expect(s.credits.used).toBe(spentDeci / 10);
  await onTheGrid(w);
});

test("the minimum charge is a tenth, and a job costing nothing draws nothing", async () => {
  const w = ws();
  const { billCredits } = await import("../../lib/creditTerms");
  await grant(w, `${w}_pack`, 1, 0.80);
  const tiny = billCredits(0.0001, "mock");
  expect(tiny).toBe(0.1);
  await charge(w, `${w}_tiny`, tiny, 0.80);
  expect(await balance(w)).toBe(0.9);
  await charge(w, `${w}_free`, 0, 0.80);
  expect(await balance(w)).toBe(0.9);
});

test("a balance recorded at US$0.10 reads at today's price by value, and funds new charges exactly", async () => {
  const w = ws();
  await grant(w, `${w}_old`, 80, null);            // before units: US$0.10 a credit, worth $8
  expect(await balance(w)).toBe(10);                // $8 at US$0.80 a credit
  await charge(w, `${w}_new`, 3.7, 0.80);           // takes 29.6 of the old credits
  expect(await balance(w)).toBe(6.3);
  const lot = (await (await db()).execute({ sql: `SELECT drawn,unit_usd FROM billing_lots WHERE id=?`, args: [`${w}_old`] })).rows[0];
  expect(Number(lot.drawn)).toBe(29.6);
  expect(lot.unit_usd).toBeNull();
  await onTheGrid(w);
});

test("an overdraw is refused in today's credits, with the figures to a tenth", async () => {
  const w = ws();
  await grant(w, `${w}_old`, 7, null);              // 0.875 today
  const { CreditBalanceError } = await import("../../lib/billingLedger");
  await expect(charge(w, `${w}_big`, 0.9, 0.80)).rejects.toThrow(CreditBalanceError);
  await expect(charge(w, `${w}_big`, 0.9, 0.80)).rejects.toThrow("This job needs 0.9 credits; 0.8 are available after reserved jobs.");
  await charge(w, `${w}_fits`, 0.8, 0.80);          // 6.4 old credits
  expect(await balance(w)).toBe(0);                 // 0.075 left: less than a tenth
});

test("conversion: 7 credits at US$0.10 become 0.875, rounded up to 0.9, recorded as one ledger entry", async () => {
  const w = ws();
  await grant(w, `${w}_old`, 7, null);
  const { convertCreditBalance } = await import("../../lib/creditConversion");
  const done = await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, by: "desk", at: t0 });
  expect(done).toMatchObject({ status: "converted", balanceBefore: 7, balanceExact: 0.875, balanceAfter: 0.9, roundingCredits: 0.2 });
  expect(await balance(w)).toBe(0.9);
  const rounding = (await (await db()).execute({ sql: `SELECT credits,unit_usd,kind FROM credit_grants WHERE id=?`, args: [done.roundingGrantId] })).rows[0];
  expect({ credits: Number(rounding.credits), unit: Number(rounding.unit_usd), kind: rounding.kind }).toEqual({ credits: 0.2, unit: 0.10, kind: "manual" });
  const record = (await (await db()).execute({ sql: `SELECT * FROM billing_unit_conversions WHERE workspace_id=?`, args: [w] })).rows;
  expect(record).toHaveLength(1);
  expect(record[0]).toMatchObject({ from_usd: 0.1, to_usd: 0.8, balance_before: 7, balance_exact: 0.875, balance_after: 0.9, rounding_credits: 0.2, created_by: "desk" });
  await onTheGrid(w);
});

test("conversion is idempotent: running it twice converts once", async () => {
  const w = ws();
  await grant(w, `${w}_old`, 250, null);
  const { convertCreditBalance } = await import("../../lib/creditConversion");
  const first = await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, at: t0 });
  const counts = await rowCounts(w);
  const second = await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, at: t0 + 1000 });
  expect(first.status).toBe("converted");
  expect(second.status).toBe("already");
  expect(await rowCounts(w)).toEqual(counts);
  expect(await balance(w)).toBe(31.3);              // 31.25, rounded up
});

test("a dry run reports the change and writes nothing — not even the ledger's own import", async () => {
  const w = ws();
  await grant(w, `${w}_old`, 99, null);
  const counts = await rowCounts(w);
  const { convertCreditBalance } = await import("../../lib/creditConversion");
  const plan = await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, dryRun: true, at: t0 });
  expect(plan).toMatchObject({ status: "planned", balanceBefore: 99, balanceExact: 12.375, balanceAfter: 12.4, roundingCredits: 0.2 });
  expect(await rowCounts(w)).toEqual(counts);
});

test("reversal restores the exact balance, append-only, and the pre-conversion figures are on the record", async () => {
  const w = ws();
  await grant(w, `${w}_old`, 7, null);
  const { convertCreditBalance, reverseCreditConversion } = await import("../../lib/creditConversion");
  await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, at: t0 });
  const afterConversion = await rowCounts(w);
  const reversed = await reverseCreditConversion(w, { by: "desk", at: t0 + 1000 });
  expect(reversed).toMatchObject({ status: "reversed", fromUsd: 0.8, toUsd: 0.1, roundingCredits: -0.2, balanceAfter: 7 });
  setCreditUsd("0.10");
  expect(await balance(w, t0 + 2000)).toBe(7);      // exactly what it was
  const now = await rowCounts(w);
  // Only additions: the reversal's row and the rounding grant's opposite (and its lot).
  expect(now.billing_unit_conversions).toBe(afterConversion.billing_unit_conversions + 1);
  expect(now.credit_grants).toBe(afterConversion.credit_grants + 1);
  expect(now.billing_lots).toBe(afterConversion.billing_lots + 1);
  // A reversal cannot be reversed twice, and a new conversion is its own row.
  expect((await reverseCreditConversion(w, { at: t0 + 3000 })).status).toBe("refused");
  const again = await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, at: t0 + 4000 });
  expect(again.status).toBe("converted");
  expect(again.id).not.toBe((await (await db()).execute({ sql: `SELECT id FROM billing_unit_conversions WHERE workspace_id=? ORDER BY rowid LIMIT 1`, args: [w] })).rows[0].id);
});

test("a debt converts toward zero: nobody owes more for a change of price", async () => {
  const w = ws();
  await grant(w, `${w}_old`, 10, null);
  await charge(w, `${w}_over`, 13, 0.10, t0, true); // provider billed above the balance: 3 old credits of debt
  setCreditUsd("0.10");
  expect(await balance(w)).toBe(-3);
  setCreditUsd("0.80");
  const { convertCreditBalance } = await import("../../lib/creditConversion");
  const done = await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, at: t0 });
  expect(done).toMatchObject({ balanceBefore: -3, balanceExact: -0.375, balanceAfter: -0.3, roundingCredits: 0.6 });
  expect(await balance(w)).toBe(-0.3);
});

test("a reservation in flight across the change settles at its admitted terms, exactly, and receipts are untouched", async () => {
  const w = ws();
  setCreditUsd("0.10");
  await grant(w, `${w}_old`, 100, null);
  await receipt(w, `${w}_run`, 29, 0.10);            // admitted at US$0.10: 29 credits
  await charge(w, `${w}_run`, 29, 0.10);
  expect(await balance(w)).toBe(71);
  const receiptBefore = (await (await db()).execute({ sql: `SELECT billed_credits,credit_usd,status FROM meter_events WHERE id=?`, args: [`${w}_run`] })).rows[0];
  setCreditUsd("0.80");
  const { convertCreditBalance } = await import("../../lib/creditConversion");
  const done = await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, at: t0 });
  expect(done).toMatchObject({ inFlight: 1, balanceExact: 8.875, balanceAfter: 8.9 });
  // The ledger's own reconciliation leaves the old-unit debit alone: it matches its receipt in its own unit.
  expect(await balance(w)).toBe(8.9);
  // It settles below its reservation, at its admitted terms: 25 credits at US$0.10 = 3.125 today.
  await receipt(w, `${w}_run`, 25, 0.10, "succeeded");
  await charge(w, `${w}_run`, 25, 0.10, t0, true);
  expect(await balance(w)).toBe(9.4);               // 8.9 + 4 old credits (0.5)
  const receiptAfter = (await (await db()).execute({ sql: `SELECT billed_credits,credit_usd FROM meter_events WHERE id=?`, args: [`${w}_run`] })).rows[0];
  expect(Number(receiptAfter.credit_usd)).toBe(Number(receiptBefore.credit_usd));
  expect(Number(receiptAfter.billed_credits)).toBe(25);
  const debit = (await (await db()).execute({ sql: `SELECT credits,unit_usd FROM billing_debits WHERE event_id=?`, args: [`${w}_run`] })).rows[0];
  expect({ credits: Number(debit.credits), unit: Number(debit.unit_usd) }).toEqual({ credits: 25, unit: 0.1 });
  await onTheGrid(w);
});

test("a finished job's receipt is never repriced by the conversion", async () => {
  const w = ws();
  setCreditUsd("0.10");
  await grant(w, `${w}_old`, 50, null);
  await receipt(w, `${w}_done`, 12, 0.10, "succeeded");
  await charge(w, `${w}_done`, 12, 0.10, t0, true);
  const snapshot = async () => (await (await db()).execute({ sql: `SELECT * FROM meter_events WHERE workspace_id=?`, args: [w] })).rows.map((r) => ({ ...r }));
  const debits = async () => (await (await db()).execute({ sql: `SELECT event_id,credits,unit_usd FROM billing_debits WHERE workspace_id=?`, args: [w] })).rows.map((r) => ({ ...r }));
  const [m0, d0] = [await snapshot(), await debits()];
  setCreditUsd("0.80");
  const { convertCreditBalance } = await import("../../lib/creditConversion");
  await convertCreditBalance(w, { fromUsd: 0.10, toUsd: 0.80, at: t0 });
  await balance(w);
  expect(await snapshot()).toEqual(m0);
  expect(await debits()).toEqual(d0);
});

test("a pack asked for at US$0.10 and approved after the change is granted at the value it was sold at", async () => {
  const w = ws();
  const d = await db();
  await d.execute({
    sql: `INSERT INTO topup_requests(id,workspace_id,pack_id,label,credits,bonus_credits,usd,status,requested_by,created_at,unit_usd) VALUES(?,?,'team','Team',2000,200,200,'requested','u',?,0.1)`,
    args: [`${w}_req`, w, t0],
  });
  const { decideTopupCredits } = await import("../../lib/topups");
  await decideTopupCredits({ id: `${w}_req`, action: "approve", by: "desk" });
  expect(await balance(w)).toBe(275);               // 2,200 credits at US$0.10 = $220 = 275 at US$0.80
  const grants = (await d.execute({ sql: `SELECT credits,unit_usd FROM credit_grants WHERE workspace_id=? ORDER BY id`, args: [w] })).rows.map((r) => [Number(r.credits), Number(r.unit_usd)]);
  expect(grants).toEqual([[200, 0.1], [2000, 0.1]]);
});
