import { margins } from "./creditTerms";

/**
 * The figure of a take made before metering, at TODAY's margin table: used to freeze a take's figure into `estimated_credits` the first time it is read
 * (lib/estimatedCredits.ts), and by nothing else. No reader may call this: a take with no receipt reads its frozen figure, so a change to the margin
 * table (CREDIT_MARGINS) can never reprice history (owner, 14 Oct 2026: "pre-metering takes marked estimated, no repricing").
 */
export function freezeEstimatesSql(g = ""): string {
  const p = g ? `${g}.` : "";
  const m = margins();
  const classes = new Set(["*", "identity-training", "elevenlabs", "text"]);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const cases = Object.entries(m).filter(([k]) => !classes.has(k)).map(([k, v]) => `WHEN ${q(k)} THEN ${v}`).join(" ");
  const fallback = m["*"] ?? 1;
  /* No per-engine keys means NO CASE, not an empty one.
     `CASE model ELSE <margin> END` is a syntax error — a simple CASE needs
     at least one WHEN — and this expression is inlined into the usage, admin
     and statement queries, so an empty table took all three down rather
     than mispricing anything. It was unreachable while the launch table
     enumerated fourteen engines; §7A's single launch rate is one entry, and
     one entry is the "*" fallback, which lives in `classes`. */
  const byModel = cases ? `(CASE ${p}model ${cases} ELSE ${fallback} END)` : `${fallback}`;
  const margin = `CASE WHEN ${p}kind = 'audio' THEN ${m["elevenlabs"] ?? fallback} ELSE ${byModel} END`;
  const cost = `(COALESCE(${p}cost_usd,0) + COALESCE(${p}refine_cost_usd,0))`;
  const x = `(${cost} * (${margin}) / ${0.10} - 0.000000001)`;
  // ceil(x) for x > 0: the integer part, plus one when anything is left over.
  return `CASE WHEN ${cost} > 0 THEN MAX(1, CAST(${x} AS INTEGER) + (${x} > CAST(${x} AS INTEGER))) ELSE 0 END`;
}

/** A receipt is immutable pricing history. A take made before metering has no receipt: it reads the figure frozen for it (never one computed now), and a take with neither reads 0. */
export function billedCreditsExpr(g = ""): string {
  const id = g ? `${g}.id` : "generations.id";
  return `COALESCE((SELECT credits FROM credit_receipts WHERE event_id=${id}), (SELECT credits FROM estimated_credits WHERE gen_id=${id}), 0)`;
}

export const billedCreditsSum = (g = ""): string => `COALESCE(SUM(${billedCreditsExpr(g)}), 0)`;
