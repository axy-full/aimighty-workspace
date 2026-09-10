import { creditUsd } from "./creditTerms";

/**
 * Credit packs: what a workspace buys (SOW §7A).
 *
 *   Starter   $50     500
 *   Team      $200  2,000 + 200
 *   Studio    $500  5,000 + 750
 *   Agency  $2,000 20,000 + 4,000
 *
 * **The unit never moves.** §7A: "Unit stays $0.10. Discount only through
 * bonus credits, capped at 20%." So a pack's price is its bought credits at
 * `creditUsd()` and nothing else — $50, $200, $500, $2,000 fall straight out
 * of the table — and the discount is credits given on top rather than a
 * cheaper credit. Both halves matter: a credit is the platform's unit of
 * account, every job is billed against it, and the per-engine margins in
 * `creditTerms.ts` are set against it. A rate that moved with the pack would
 * make the same shot cost different credits for different customers.
 *
 * Bonus credits are FREE — decided 10 September 2026. No money arrives for
 * them, so they are granted as their own `bonus` row and never counted as
 * revenue. See `GrantKind` in `creditTerms.ts`.
 *
 * `CREDIT_PACKS` (JSON, `[{id, label, credits, bonus?}]`) overrides the table.
 * Everything is derived from `creditUsd()` rather than written out, so a
 * change to the unit rate carries the whole table with it.
 */
export type Pack = {
  id: string;
  label: string;
  /** Bought. This is what the price is charged for. */
  credits: number;
  /** Given on top. Free — no money arrives for these. */
  bonus: number;
  /** What actually lands in the balance. */
  total: number;
  usd: number;
  /** `usd / total` — §7A's "Effective" column. */
  perCredit: number;
};

export type Size = { id: string; label: string; credits: number; bonus?: number };

const DEFAULT_PACKS: Size[] = [
  { id: "starter", label: "Starter", credits: 500, bonus: 0 },
  { id: "team", label: "Team", credits: 2000, bonus: 200 },
  { id: "studio", label: "Studio", credits: 5000, bonus: 750 },
  { id: "agency", label: "Agency", credits: 20000, bonus: 4000 },
];

/** §7A guardrail 2: "Bonus credits never exceed 20% of a pack." */
export const BONUS_CAP = 0.2;

/**
 * The cap, as a function, applied everywhere a bonus is read rather than only
 * where the table is built.
 *
 * A guardrail that only runs while assembling the pack list is not a
 * guardrail: the number that reaches `grantCredits` is the one frozen on the
 * request row, which was written by an older deployment, or by a
 * `CREDIT_PACKS` that has since changed. So this is applied on the way in AND
 * on the way back out of the database.
 *
 * NaN fails to zero rather than through: `Math.min(NaN, cap)` is NaN, and a
 * NaN bonus would reach a grant and poison a balance.
 */
export function capBonus(credits: number, bonus: unknown): number {
  const b = Math.floor(Number(bonus));
  if (!Number.isFinite(b) || b <= 0) return 0;
  const ceiling = Math.floor(Math.max(0, Number(credits) || 0) * BONUS_CAP);
  return Math.min(b, Number.isFinite(ceiling) ? ceiling : 0);
}

/** One rung. Pure, and exported so the table can be tested without the memo. */
export function pricePack(s: Size, per: number): Pack {
  const credits = Math.round(Number(s.credits) || 0);
  const bonus = capBonus(credits, s.bonus);
  const total = credits + bonus;
  const usd = Math.round(credits * per * 100) / 100;
  return {
    id: s.id, label: s.label, credits, bonus, total, usd,
    /* Not rounded to cents: at 24,000 credits this is a rate, not a price,
       and rounding $0.0833 to $0.08 would misstate the ladder by 4%. */
    perCredit: total > 0 ? usd / total : 0,
  };
}

let _packs: Pack[] | null = null;
export function packs(): Pack[] {
  if (_packs) return _packs;
  let sizes = DEFAULT_PACKS;
  try {
    const raw = process.env.CREDIT_PACKS ? (JSON.parse(process.env.CREDIT_PACKS) as unknown) : null;
    if (Array.isArray(raw) && raw.length) {
      const clean = raw
        .map((p) => (p && typeof p === "object" ? p as Record<string, unknown> : null))
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p!.id === "string" && Number(p!.credits) > 0)
        .map((p) => ({
          id: String(p.id), label: String(p.label ?? p.id),
          credits: Math.round(Number(p.credits)), bonus: Number(p.bonus ?? 0),
        }));
      if (clean.length) sizes = clean;
    }
  } catch { /* an unreadable override keeps the defaults */ }
  const per = creditUsd();
  _packs = sizes.map((s) => pricePack(s, per));
  return _packs;
}

export function packById(id: string): Pack | null {
  return packs().find((p) => p.id === id) ?? null;
}
