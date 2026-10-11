import type { PlanDef } from "@/lib/plans";
import { count } from "./format";

/**
 * What each plan card says, built from the plan itself. Only what the product
 * does today is listed: §7A also names a priority queue and branded review
 * links, and neither exists yet, so neither is claimed.
 */
export function planLines(plan: PlanDef, inviteCredits: number): string[] {
  /* One person's plans are for one person; only a team plan speaks of people sharing. A legacy plan keeps its own wording. */
  const members = plan.perSeat ? "One pool of credits across every seat"
    : plan.group === "individual" ? "One person"
    : plan.maxMembers == null ? "Unlimited people" : `${plan.maxMembers} people`;
  const productions = plan.maxProductions == null ? "Unlimited productions" : `${plan.maxProductions} production${plan.maxProductions === 1 ? "" : "s"}`;
  const credits = plan.id === "invite"
    ? `${count(inviteCredits)} credits once`
    : plan.perSeat ? `${count(plan.includedCredits)} credits a seat a month`
    : `${count(plan.includedCredits)} credits a month`;
  /* What the owner gave is a name, a price and credits: nothing more is claimed for the owner's plans. The older plans keep their lists. */
  const extra: Record<string, string[]> = {
    studio: ["Review links", "Exports", "Post tools"],
    agency: ["Review links", "Exports and post tools", "Monthly statements"],
    production: ["Everything in Agency", "Team admin and audit", "Setup hours"],
  };
  /* The owner's plans state credits and who they are for; a productions line is only for the plans sold before. */
  return [credits, ...(plan.group === "legacy" ? [productions] : []), members, ...(extra[plan.id] ?? [])];
}

export const PLAN_AUDIENCE: Record<string, string> = {
  explore: "For one person.",
  create: "For one person.",
  master: "For one person.",
  business100: "For a team: one pool of credits.",
  business250: "For a team: one pool of credits.",
  business500: "For a team: one pool of credits.",
  invite: "Try it on a real brief, one production.",
  studio: "A small team making work every week.",
  agency: "Several productions running at once.",
  production: "A studio that runs on it.",
};
