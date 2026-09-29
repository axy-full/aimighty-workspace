import { jobApprovalLineCredits } from "../approvalRule";
import { creditUsd } from "../creditTerms";

/*
 * How much Atomik may spend on the Rig without asking (plan §8).
 *
 * A run spends only inside the limit a person approved for it. Inside that
 * limit, in Auto mode, one render may run without a tap only when its price is
 * at or under the per-job line below; anything priced above it always asks.
 * In Ask mode (the default) every paid step asks.
 *
 * The per-job line is the platform's approval line (owner, 29 September: Rig
 * jobs use it): SOW §7A guardrail 4, a job price whose single source is
 * lib/approvalRule.ts (JOB_APPROVAL_LINE_USD), counted in credits at the price
 * of a credit. The run card suggests the same figure as a run's limit.
 */

/**
 * THE OWNER'S NUMBER: the most one Atomik job may cost without asking, in
 * credits. `null` follows the platform's approval line (above). To give Rig
 * jobs a line of their own, change this one line to that number of credits.
 */
export const RIG_AGENT_JOB_CEILING_CREDITS: number | null = null;

/** The per-job line now, in credits: the owner's number when set, else the approval line at today's price of a credit. */
export async function rigJobCeiling(): Promise<number> {
  if (RIG_AGENT_JOB_CEILING_CREDITS != null && Number.isFinite(RIG_AGENT_JOB_CEILING_CREDITS) && RIG_AGENT_JOB_CEILING_CREDITS > 0)
    return RIG_AGENT_JOB_CEILING_CREDITS;
  return jobApprovalLineCredits(creditUsd());
}

/** The run limit the card suggests: the same line (the person may change it before asking). */
export async function suggestedRunLimit(): Promise<number> {
  return rigJobCeiling();
}

/**
 * The line a run's Auto mode uses: the lower of the line approved with the run and the line now,
 * so a line lowered since lowers it for runs in progress, and a raise never widens an approval
 * already given.
 */
export function effectiveJobCeiling(approved: number | null, now: number): number {
  return approved != null && Number.isFinite(approved) && approved > 0 ? Math.min(approved, now) : now;
}
