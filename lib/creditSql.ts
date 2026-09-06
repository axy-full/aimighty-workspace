import { margins, creditUsd } from "./creditTerms";

/**
 * The rounding rule as SQL, so a ledger over thousands of rows can be
 * summed in one query and still agree with the meter row by row: whole
 * credits per job, rounded up, at least one, at the engine's margin.
 * `g` is the generations alias when the query has one.
 */
export function billedCreditsExpr(g = ""): string {
  const p = g ? `${g}.` : "";
  const m = margins();
  const classes = new Set(["*", "identity-training", "elevenlabs", "text"]);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const cases = Object.entries(m).filter(([k]) => !classes.has(k)).map(([k, v]) => `WHEN ${q(k)} THEN ${v}`).join(" ");
  const fallback = m["*"] ?? 1;
  const margin = `CASE WHEN ${p}kind = 'audio' THEN ${m["elevenlabs"] ?? fallback} ELSE (CASE ${p}model ${cases} ELSE ${fallback} END) END`;
  const cost = `(COALESCE(${p}cost_usd,0) + COALESCE(${p}refine_cost_usd,0))`;
  const x = `(${cost} * (${margin}) / ${creditUsd()} - 0.000000001)`;
  // ceil(x) for x > 0: the integer part, plus one when anything is left over.
  return `CASE WHEN ${cost} > 0 THEN MAX(1, CAST(${x} AS INTEGER) + (${x} > CAST(${x} AS INTEGER))) ELSE 0 END`;
}

export const billedCreditsSum = (g = ""): string => `COALESCE(SUM(${billedCreditsExpr(g)}), 0)`;
