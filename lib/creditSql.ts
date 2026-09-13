import { creditUsd, tableFor } from "./creditTerms";
import { currentTenant } from "./tenant";

/**
 * The rounding rule as SQL, so a ledger over thousands of rows can be
 * summed in one query and still agree with the meter row by row: whole
 * credits per job, rounded up, at least one, at the engine's margin.
 * `g` is the generations alias when the query has one.
 */
export function billedCreditsExpr(g = "", internal = currentTenant()?.workspace?.internal === true): string {
  const p = g ? `${g}.` : "";
  /* The table this workspace is billed on: at cost when it is flagged
     internal (§7A guardrail 6). Defaulted from the tenant in scope, because
     this text is inlined by nine callers and the ledger they sum is always
     the tenant's own. */
  const m = tableFor(internal);
  const classes = new Set(["*", "identity-training", "elevenlabs", "text"]);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const cases = Object.entries(m).filter(([k]) => !classes.has(k)).map(([k, v]) => `WHEN ${q(k)} THEN ${v}`).join(" ");
  const fallback = m["*"] ?? 1;
  /* No per-engine keys means NO CASE, not an empty one.
     `CASE model ELSE 1.5 END` is a syntax error — a simple CASE needs at
     least one WHEN — and this expression is inlined into the usage, admin
     and statement queries, so an empty table took all three down rather
     than mispricing anything. It was unreachable while the launch table
     enumerated fourteen engines; §7A's flat 1.5 is one entry, and one
     entry is the "*" fallback, which lives in `classes`. */
  const byModel = cases ? `(CASE ${p}model ${cases} ELSE ${fallback} END)` : `${fallback}`;
  const margin = `CASE WHEN ${p}kind = 'audio' THEN ${m["elevenlabs"] ?? fallback} ELSE ${byModel} END`;
  const cost = `(COALESCE(${p}cost_usd,0) + COALESCE(${p}refine_cost_usd,0))`;
  const x = `(${cost} * (${margin}) / ${creditUsd()} - 0.000000001)`;
  // ceil(x) for x > 0: the integer part, plus one when anything is left over.
  return `CASE WHEN ${cost} > 0 THEN MAX(1, CAST(${x} AS INTEGER) + (${x} > CAST(${x} AS INTEGER))) ELSE 0 END`;
}

export const billedCreditsSum = (g = ""): string => `COALESCE(SUM(${billedCreditsExpr(g)}), 0)`;
