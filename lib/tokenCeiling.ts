/**
 * A generating token's monthly ceiling, as a person types it (/connect).
 *
 * Blank is the one way to say "no limit", and it has to be said: a typo, a
 * word or a cancelled dialog must never mint a token that can spend without
 * a stop. `$20`, `20`, `20.50` and `1,000` are dollars; anything else asks
 * again. Zero is refused rather than read as "no limit". Pure, so the /connect
 * dialog and POST /api/tokens read the same value the same way.
 */
export type Ceiling = { capUsd: number | null } | { error: string };

export const CEILING_PROBLEM = "Type a monthly ceiling in dollars above $0, like 20, or leave it blank for no limit.";

export function parseCeiling(input: string): Ceiling {
  if (!input.trim()) return { capUsd: null };
  const text = input.trim().replace(/^\$\s*/, "").replace(/\s*usd$/i, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return { error: CEILING_PROBLEM };
  const capUsd = Math.round(Number(text) * 100) / 100;
  if (!Number.isFinite(capUsd) || capUsd <= 0) return { error: CEILING_PROBLEM };
  return { capUsd };
}
