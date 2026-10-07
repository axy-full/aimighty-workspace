/**
 * A generating token's monthly ceiling, as a person types it (/connect and
 * Atomik › Tools & connections).
 *
 * Blank is the one way to say "no limit", and it has to be said: a typo, a
 * word or a cancelled dialog must never mint a token that can spend without
 * a stop. `$20`, `20`, `20.50` and `1,000` are dollars; anything else asks
 * again. Zero is refused rather than read as "no limit". Pure, so the /connect
 * dialog and POST /api/tokens read the same value the same way.
 *
 * The ceiling is in the workspace's unit, the way a production's cap is
 * (lib/caps.ts): a workspace on the platform's keys pays in credits, so its
 * tokens are capped in whole credits and the engine's dollars never enter the
 * figure; a workspace on its own keys caps in dollars.
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

export const CREDIT_CEILING_MAX = 1_000_000;
export const CREDIT_CEILING_PROBLEM = "Type a monthly ceiling in whole credits, like 500, or leave it blank for no limit.";

/** `500`, `1,000`, `500 cr` and `500 credits` are credits; fractions, zero and words ask again. */
export function parseCreditCeiling(input: string): { capCredits: number | null } | { error: string } {
  if (!input.trim()) return { capCredits: null };
  const text = input.trim().replace(/\s*(cr|credits?)$/i, "").replace(/,/g, "");
  if (!/^\d+$/.test(text)) return { error: CREDIT_CEILING_PROBLEM };
  const capCredits = Number(text);
  if (!Number.isSafeInteger(capCredits) || capCredits < 1 || capCredits > CREDIT_CEILING_MAX) return { error: CREDIT_CEILING_PROBLEM };
  return { capCredits };
}

export type TokenCeiling = { capUsd: number | null; capCredits: number | null } | { error: string };

const given = (value: unknown) => value != null && !(typeof value === "string" && !value.trim());

/**
 * What POST /api/tokens stores: the ceiling in the workspace's unit, read
 * strictly. A figure in the other unit is refused rather than converted — a
 * dollar figure means nothing against a credit balance, and the conversion
 * would put the engine's dollars back in front of a credits workspace. A
 * read-only token cannot spend, so it keeps no ceiling (a figure sent with
 * one is still read, so a typo is still refused).
 */
export function tokenCeiling(body: { capUsd?: unknown; capCredits?: unknown }, o: { scope: "read" | "render" | "prepare"; inCredits: boolean }): TokenCeiling {
  if (o.inCredits) {
    if (given(body.capUsd)) return { error: "This workspace counts in credits. Set the ceiling in credits, or leave it blank for no limit." };
    const credits = given(body.capCredits) ? parseCreditCeiling(String(body.capCredits)) : { capCredits: null };
    if ("error" in credits) return credits;
    return { capUsd: null, capCredits: o.scope === "render" ? credits.capCredits : null };
  }
  if (given(body.capCredits)) return { error: "This workspace pays its engines in dollars. Set the ceiling in dollars, or leave it blank for no limit." };
  const dollars = given(body.capUsd) ? parseCeiling(String(body.capUsd)) : { capUsd: null };
  if ("error" in dollars) return dollars;
  return { capUsd: o.scope === "render" ? dollars.capUsd : null, capCredits: null };
}
