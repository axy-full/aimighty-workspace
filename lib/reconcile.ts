import { db, ready, now, id as newId } from "./db";
import { archiveAndDelete } from "./archive";

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
  await archiveAndDelete(db(), "ledger_checks", `id = ?`, [id]);
}

/**
 * Whose balance the prompt writer's text came out of. Every gateway model is
 * named vendor/model and is paid for in gateway credit, whoever built it;
 * ByteDance's own text models are bare ids and are paid for on the ModelArk
 * key. The Usage ledger and the reading-anchored figures below both use this,
 * so the two cannot attribute the same prompt to different balances.
 */
export const PROMPT_LEDGER = `CASE WHEN refine_model LIKE '%/%' THEN 'vercel' ELSE 'byteplus' END`;
/** Renders are charged where the money actually left — see billed_to in lib/db.ts. */
export const PAID_BY = `COALESCE(billed_to, provider)`;
/** Atomik's conversations and write-ups are gateway text, on the gateway's line. */
export const ATOMIK_LEDGER = "vercel";

/**
 * Every render's spend, by the balance that paid for it. Hidden takes are
 * counted: deleting a take hides it, and the vendor has still charged for it.
 */
export async function renderSpendByPayer(): Promise<{ provider: string; attempts: number; succeeded: number; usd: number; tokens: number }[]> {
  await ready();
  const rs = await db().execute(`
    SELECT ${PAID_BY} AS provider, COUNT(*) AS n_all, SUM(status='succeeded') AS n,
           COALESCE(SUM(COALESCE(cost_usd,0)),0) AS render_spend,
           COALESCE(SUM(total_tokens),0) AS tokens
    FROM generations GROUP BY ${PAID_BY}`);
  return rs.rows.map((r: any) => ({
    provider: String(r.provider ?? "byteplus"), attempts: Number(r.n_all ?? 0), succeeded: Number(r.n ?? 0),
    usd: Number(r.render_spend ?? 0), tokens: Number(r.tokens ?? 0),
  }));
}

/**
 * Atomik's thinking, all time: every turn and every write-up, summed the same
 * way the reading-anchored figure sums them (textSpend, below). A hidden
 * conversation was still paid for; only visible ones are counted as chats.
 */
export async function atomikTextSpend(): Promise<{ usd: number; chats: number }> {
  await ready();
  const rs = await db().execute(`SELECT (SELECT COALESCE(SUM(COALESCE(cost_usd,0)),0) FROM atomik_messages)
                                      + (SELECT COALESCE(SUM(COALESCE(cost_usd,0)),0) FROM atomik_spend) AS spend,
                                        (SELECT COUNT(*) FROM atomik_chats WHERE deleted = 0) AS chats`);
  const r: any = rs.rows[0];
  return { usd: Number(r?.spend ?? 0), chats: Number(r?.chats ?? 0) };
}

/**
 * Text a ledger paid for in a window: the prompt writer on renders, and for
 * the gateway every Atomik turn and write-up. Atomik is summed per message
 * and per write-up here, not per conversation, because a reading lands
 * between two turns of the same conversation.
 */
async function textSpend(provider: string, op: ">" | "<=", at: number): Promise<number> {
  const prompt = await db().execute({
    sql: `SELECT COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS spend
          FROM generations WHERE refine_model IS NOT NULL AND ${PROMPT_LEDGER} = ? AND created_at ${op} ?`,
    args: [provider, at],
  });
  let atomik = 0;
  if (provider === ATOMIK_LEDGER) {
    const rs = await db().execute({
      sql: `SELECT (SELECT COALESCE(SUM(COALESCE(cost_usd,0)),0) FROM atomik_messages WHERE created_at ${op} ?)
                 + (SELECT COALESCE(SUM(COALESCE(cost_usd,0)),0) FROM atomik_spend WHERE created_at ${op} ?) AS spend`,
      args: [at, at],
    });
    atomik = Number((rs.rows[0] as any)?.spend ?? 0);
  }
  return Number((prompt.rows[0] as any)?.spend ?? 0) + atomik;
}

/**
 * What a vendor has cost since a moment, by our own reckoning.
 *
 * Deliberately the same arithmetic the rest of the ledger uses: the point is
 * to extrapolate forward from a known-true number using the only method we
 * have, not to pretend the extrapolation is also authoritative. That means
 * the same spend, too: renders AND the text the vendor's balance paid for.
 * Renders alone used to be counted here, so once a reading was recorded every
 * prompt the writer drafted and every Atomik turn afterwards was never taken
 * off the balance, and the drift compared a render-only figure against a
 * console total that includes text.
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
          WHERE ${PAID_BY} = ? AND cost_usd IS NOT NULL AND created_at > ?`,
    args: [provider, since],
  });
  const r: any = rs.rows[0];
  // For a credits vendor every audio render wrote its credits to
  // total_tokens, so the same column carries both units honestly.
  return { usd: Number(r?.spend ?? 0) + await textSpend(provider, ">", since), credits: Number(r?.credits ?? 0), renders: Number(r?.n ?? 0) };
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
          WHERE ${PAID_BY} = ? AND cost_usd IS NOT NULL AND created_at <= ?`,
    args: [provider, at],
  });
  const r: any = rs.rows[0];
  return { usd: Number(r?.spend ?? 0) + await textSpend(provider, "<=", at), credits: Number(r?.credits ?? 0) };
}
