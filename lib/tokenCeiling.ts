/** A new generating token has an explicit monthly credit ceiling. Blank alone means no limit. */
export type Ceiling = { capCredits: number | null } | { error: string };
export const CEILING_PROBLEM = "Type a whole number of credits above zero, or leave it blank for no limit.";
export function parseCeiling(input: string): Ceiling {
  if (!input.trim()) return { capCredits: null };
  const text = input.trim().replace(/\s*(cr|credits)$/i, "");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return { error: CEILING_PROBLEM };
  const capCredits = Number(text.replace(/,/g, ""));
  return Number.isSafeInteger(capCredits) && capCredits > 0 ? { capCredits } : { error: CEILING_PROBLEM };
}
