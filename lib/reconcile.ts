import { db, ready, now, id as newId } from "./db";

/**
 * Anchoring the ledger to what the vendor actually says.
 *
 * Every figure in this app is computed: tokens multiplied by a rate held in
 * our own table. That is an estimate, however carefully kept, and it drifts
 * the moment a vendor changes a price, applies a promotion we haven't heard
 * about, or bills something we don't model. lib/models.ts even carries a
 * note about exactly this — a 1080p promotion nobody has confirmed lands on
 * this account.
 *
 * Rather than chase the arithmetic, record what the console says. From a
 * reading onward the ledger reports the VENDOR's number plus whatever has
 * been spent since, so it matches by construction; and the gap between the
 * reading and what we had computed is shown rather than quietly absorbed,
 * because a persistent gap is the signal that a rate is wrong.
 *
 * A balance is the better anchor than a spend figure: it is a fact at a
 * moment, where "spend" depends on whichever period the console had
 * selected.
 */

export type LedgerCheck = {
  id: string;
  provider: string;
  balanceUsd: number | null;
  spendUsd: number | null;
  balanceCredits: number | null;
  spendCredits: number | null;
  note: string;
  checkedAt: number;
  authorName: string | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowTo(r: any): LedgerCheck {
  return {
    id: r.id,
    provider: r.provider,
    balanceUsd: r.balance_usd == null ? null : Number(r.balance_usd),
    spendUsd: r.spend_usd == null ? null : Number(r.spend_usd),
    balanceCredits: r.balance_credits == null ? null : Number(r.balance_credits),
    spendCredits: r.spend_credits == null ? null : Number(r.spend_credits),
    note: r.note ?? "",
    checkedAt: Number(r.checked_at),
    authorName: r.author_name ?? null,
  };
}

const SELECT = `SELECT c.*, u.name AS author_name
                FROM ledger_checks c LEFT JOIN users u ON u.id = c.created_by`;

export async function listChecks(provider?: string): Promise<LedgerCheck[]> {
  await ready();
  const rs = provider
    ? await db().execute({ sql: `${SELECT} WHERE c.provider = ? ORDER BY c.checked_at DESC LIMIT 50`, args: [provider] })
    : await db().execute(`${SELECT} ORDER BY c.checked_at DESC LIMIT 50`);
  return rs.rows.map(rowTo);
}

export async function recordCheck(input: {
  provider: string;
  balanceUsd: number | null; spendUsd: number | null;
  balanceCredits: number | null; spendCredits: number | null;
  note: string; checkedAt?: number; userId: string;
}): Promise<LedgerCheck> {
  await ready();
  if (input.balanceUsd == null && input.spendUsd == null &&
      input.balanceCredits == null && input.spendCredits == null) {
    throw new Error("Record at least one of the figures the console shows.");
  }
  const id = newId("chk");
  const at = input.checkedAt && Number.isFinite(input.checkedAt) ? input.checkedAt : now();
  await db().execute({
    sql: `INSERT INTO ledger_checks
          (id, provider, balance_usd, spend_usd, balance_credits, spend_credits, note, checked_at, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [id, input.provider, input.balanceUsd, input.spendUsd,
           input.balanceCredits, input.spendCredits,
           input.note.slice(0, 200), at, input.userId, now()],
  });
  const rs = await db().execute({ sql: `${SELECT} WHERE c.id = ?`, args: [id] });
  return rowTo(rs.rows[0]);
}

export async function deleteCheck(id: string): Promise<void> {
  await ready();
  await db().execute({ sql: `DELETE FROM ledger_checks WHERE id = ?`, args: [id] });
}

/**
 * What a vendor has cost since a moment, by our own reckoning.
 *
 * Deliberately the same arithmetic the rest of the ledger uses: the point is
 * to extrapolate forward from a known-true number using the only method we
 * have, not to pretend the extrapolation is also authoritative.
 */
/* Both sums below count against the ledger that PAID, not the vendor that
   made the render — see billed_to in lib/db.ts. Anchoring a vendor to its
   own console only works if the rows we add since the reading are the same
   rows that console will bill for. */
export async function spendSince(
  provider: string, since: number
): Promise<{ usd: number; credits: number; renders: number }> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT COALESCE(SUM(COALESCE(cost_usd,0)),0) AS spend,
                 COALESCE(SUM(COALESCE(total_tokens,0)),0) AS credits,
                 COUNT(*) AS n
          FROM generations
          WHERE COALESCE(billed_to, provider) = ? AND cost_usd IS NOT NULL AND created_at > ?`,
    args: [provider, since],
  });
  const r: any = rs.rows[0];
  // For a credits vendor every audio render wrote its credits to
  // total_tokens, so the same column carries both units honestly.
  return { usd: Number(r?.spend ?? 0), credits: Number(r?.credits ?? 0), renders: Number(r?.n ?? 0) };
}

/** What we HAD computed as spent up to that moment, for measuring the drift. */
export async function computedSpendUpTo(
  provider: string, at: number
): Promise<{ usd: number; credits: number }> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT COALESCE(SUM(COALESCE(cost_usd,0)),0) AS spend,
                 COALESCE(SUM(COALESCE(total_tokens,0)),0) AS credits
          FROM generations
          WHERE COALESCE(billed_to, provider) = ? AND cost_usd IS NOT NULL AND created_at <= ?`,
    args: [provider, at],
  });
  const r: any = rs.rows[0];
  return { usd: Number(r?.spend ?? 0), credits: Number(r?.credits ?? 0) };
}
