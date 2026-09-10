/**
 * Plans: what a workspace pays a month, and what that includes (SOW §7A).
 *
 * The word is PLAN, not tier. `tier` already means a resolution band in the
 * vendor rate table (`RateTier`, `TableTier`) and the code's meaning is the
 * older one — rule 5, one vocabulary, decided once.
 *
 * Four rows, credits only. §7A's panel inclusions were struck on 10 September
 * because a "standard panel" is not a unit this product has; a plan
 * differentiates on credits, and on the two counted ceilings Invite carries.
 *
 * **Invite's "50 cr once" is NOT an inclusion, and that is the whole reason
 * `includedCredits` is 0 for it.** Guardrail 1: "Free grant is one-time,
 * never recurring." The 50 is the welcome grant, already written once at
 * sign-up by `createWorkspace` and already marked `welcome` in the ledger.
 * Putting it here would grant it again every cycle and turn a signup gift
 * into a monthly stipend for every free workspace on the platform.
 *
 * Pure — no database — so the browser can validate what the console edits,
 * the same way the rest of the platform layer works.
 */

export type PlanId = "invite" | "studio" | "agency" | "production";

export type PlanDef = {
  id: PlanId;
  label: string;
  /** A month, in dollars. The one figure a plan is sold on. */
  priceUsd: number;
  /** Credits granted at each cycle. They do not roll over (§7A). */
  includedCredits: number;
  /** Productions a workspace may hold, or null for as many as it likes. */
  maxProductions: number | null;
  /** Members, or null for unlimited. §7A: no seat fees on any paid plan. */
  maxMembers: number | null;
};

export const PLAN_IDS: readonly PlanId[] = ["invite", "studio", "agency", "production"];

export const DEFAULT_PLANS: PlanDef[] = [
  /* Invite includes no credits: its 50 are the one-time welcome grant. */
  { id: "invite", label: "Invite", priceUsd: 0, includedCredits: 0, maxProductions: 1, maxMembers: 3 },
  { id: "studio", label: "Studio", priceUsd: 49, includedCredits: 400, maxProductions: null, maxMembers: null },
  { id: "agency", label: "Agency", priceUsd: 199, includedCredits: 1600, maxProductions: null, maxMembers: null },
  { id: "production", label: "Production", priceUsd: 999, includedCredits: 9000, maxProductions: null, maxMembers: null },
];

export const isPlanId = (v: unknown): v is PlanId => (PLAN_IDS as readonly string[]).includes(String(v));

/** A stored plan id, or null for a workspace on no plan at all. */
export function asPlanId(v: unknown): PlanId | null {
  return isPlanId(v) ? v : null;
}

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : fallback;
};

const countOrNull = (v: unknown, fallback: number | null): number | null => {
  if (v === null) return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 100_000 ? n : fallback;
};

/**
 * A plans table from the platform record, cleaned.
 *
 * Unknown ids are dropped and missing ones fall back to the shipped row, so
 * the four §7A plans always exist whatever is stored: a workspace pointing at
 * a plan the console deleted would otherwise resolve to nothing, and "no
 * plan" and "a plan that went missing" are not the same state.
 */
export function cleanPlans(v: unknown): PlanDef[] {
  const stored = new Map<string, Record<string, unknown>>();
  if (Array.isArray(v)) {
    for (const row of v) {
      if (row && typeof row === "object" && isPlanId((row as Record<string, unknown>).id)) {
        stored.set(String((row as Record<string, unknown>).id), row as Record<string, unknown>);
      }
    }
  }
  return DEFAULT_PLANS.map((d) => {
    const s = stored.get(d.id);
    if (!s) return { ...d };
    return {
      id: d.id,
      label: String(s.label ?? d.label).slice(0, 40) || d.label,
      priceUsd: num(s.priceUsd, d.priceUsd, 0, 100_000),
      /* Rounded to a whole credit: a plan grants credits, and a credit is
         the unit. A fractional inclusion would round somewhere else later. */
      includedCredits: Math.round(num(s.includedCredits, d.includedCredits, 0, 10_000_000)),
      maxProductions: s.maxProductions === undefined ? d.maxProductions : countOrNull(s.maxProductions, d.maxProductions),
      maxMembers: s.maxMembers === undefined ? d.maxMembers : countOrNull(s.maxMembers, d.maxMembers),
    };
  });
}

export function planById(plans: PlanDef[], id: string | null | undefined): PlanDef | null {
  if (!id) return null;
  return plans.find((p) => p.id === id) ?? null;
}
