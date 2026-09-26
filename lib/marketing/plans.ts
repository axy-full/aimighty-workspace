import type { PlanDef } from "@/lib/plans";
import { count } from "./format";

/**
 * What each plan card says, built from the plan itself. Only what the product
 * does today is listed: §7A also names a priority queue and branded review
 * links, and neither exists yet, so neither is claimed.
 */
export function planLines(plan: PlanDef, inviteCredits: number): string[] {
  const members = plan.maxMembers == null ? "Unlimited people · no seat fees" : `${plan.maxMembers} people`;
  const productions = plan.maxProductions == null ? "Unlimited productions" : `${plan.maxProductions} production${plan.maxProductions === 1 ? "" : "s"}`;
  const credits = plan.id === "invite"
    ? `${count(inviteCredits)} credits once`
    : `${count(plan.includedCredits)} credits a month`;
  const extra: Record<string, string[]> = {
    invite: ["Every suite and engine", "Failed renders never billed"],
    studio: ["Review links", "Exports", "Post tools"],
    agency: ["Review links", "Exports and post tools", "Monthly statements"],
    production: ["Everything in Agency", "Workspace admin and audit", "Setup hours"],
  };
  return [credits, productions, members, ...(extra[plan.id] ?? [])];
}

export const PLAN_AUDIENCE: Record<string, string> = {
  invite: "Try it on a real brief, one production.",
  studio: "A small team making work every week.",
  agency: "Several productions running at once.",
  production: "A studio that runs on it.",
};
