/**
 * Unit files share one platform database per worker. A file that sets its own
 * CREDIT_USD also moves the ledger's unit to it (lib/ledgerUnit.ts): a price
 * change without the record following pauses new paid jobs, which is the point
 * of the gate and not what these files test.
 */
export async function alignLedgerUnit(): Promise<void> {
  const { billingTransaction } = await import("../../lib/billingLedger");
  const { setLedgerUnitTx } = await import("../../lib/ledgerUnit");
  const { creditUsd } = await import("../../lib/creditTerms");
  await billingTransaction((tx) => setLedgerUnitTx(tx, creditUsd(), "test", Date.now()));
}
