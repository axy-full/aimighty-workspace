import type { PlanDef } from "./plans";

/**
 * The two ceilings a plan counts (SOW §7A).
 *
 * Only Invite has any: one production, three members. Every paid plan is
 * uncounted, because §7A is explicit — "No seat fees on any paid tier.
 * Differentiate on credits, priority and features, never headcount."
 *
 * **A workspace on NO plan has no ceilings.** That is not an oversight, it is
 * the state every workspace is in until somebody is put on one, and it is
 * what a workspace created by older code lands on mid-deploy. Reading "no
 * plan" as Invite would apply a 1-production limit to workspaces holding
 * twelve, and the first thing they would notice is being unable to work.
 *
 * Pure, so the check and the message come from one place and the browser can
 * ask the same question the server answers.
 */

export type Counted = "productions" | "members";

export function ceilingFor(plan: PlanDef | null | undefined, what: Counted): number | null {
  if (!plan) return null;
  const n = what === "productions" ? plan.maxProductions : plan.maxMembers;
  return typeof n === "number" && n > 0 ? n : null;
}

/**
 * Is one more over the line?
 *
 * `have` is what exists now, so the question is whether have + 1 exceeds the
 * ceiling. A workspace already AT the ceiling can keep what it has — nothing
 * here removes anything — it simply cannot add.
 *
 * A workspace already OVER its ceiling (put on a smaller plan after the fact)
 * is also only stopped from adding. Deleting somebody's work to fit a plan
 * change is not a thing this should ever do quietly.
 */
export function wouldExceed(have: number, ceiling: number | null): boolean {
  if (ceiling == null) return false;
  return have + 1 > ceiling;
}

/**
 * What to tell them, naming the plan rather than the number alone.
 *
 * The person hitting this is usually not the person who chose the plan — an
 * invited member finds out at the moment they accept — so it says which plan
 * and what it allows, and points at the one thing that changes it.
 */
export function ceilingMessage(plan: PlanDef, what: Counted, ceiling: number): string {
  const thing = what === "productions"
    ? `${ceiling} production${ceiling === 1 ? "" : "s"}`
    : `${ceiling} member${ceiling === 1 ? "" : "s"}`;
  return `The ${plan.label} plan allows ${thing}. Move to a larger plan to add another.`;
}
