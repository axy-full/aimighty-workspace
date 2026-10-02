import { creditUsd } from "./creditTerms";

/**
 * Credit packs: what a workspace buys (SOW §7A).
 *
 *   Starter   $49.60    62
 *   Team      $200     250 + 25
 *   Studio    $500     625 + 94
 *   Agency  $2,000   2,500 + 500
 *
 * **The unit never moves.** §7A: "Unit stays $0.80. Discount only through
 * bonus credits, capped at 20%." So a pack's price is its bought credits at
 * `creditUsd()` and nothing else — $49.60, $200, $500, $2,000 fall straight
 * out of the table — and the discount is credits given on top rather than a
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

/* One row per pack, so changing a pack is one line. Priced at $0.80 a credit:
   the $0.10-era dollar prices kept, credits divided by eight. Half a credit
   cannot be sold, so Starter is 62 credits ($49.60) rather than $50. */
const DEFAULT_PACKS: Size[] = [
  { id: "starter", label: "Starter", credits: 62, bonus: 0 },
  { id: "team", label: "Team", credits: 250, bonus: 25 },
  { id: "studio", label: "Studio", credits: 625, bonus: 94 },
  { id: "agency", label: "Agency", credits: 2500, bonus: 500 },
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
    /* Not rounded to cents: at 3,000 credits this is a rate, not a price,
       and rounding $0.6667 to $0.67 would misstate the ladder. */
    perCredit: total > 0 ? usd / total : 0,
  };
}

/* Kept per rate and override, so the table moves with CREDIT_USD even inside
   one process (a test that prices a credit differently) rather than serving
   whatever rate first asked. */
let _packs: { per: number; override: string | undefined; list: Pack[] } | null = null;
export function packs(): Pack[] {
  const per = creditUsd();
  const override = process.env.CREDIT_PACKS;
  if (_packs && _packs.per === per && _packs.override === override) return _packs.list;
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
  _packs = { per, override, list: sizes.map((s) => pricePack(s, per)) };
  return _packs.list;
}

export function packById(id: string): Pack | null {
  return packs().find((p) => p.id === id) ?? null;
}
