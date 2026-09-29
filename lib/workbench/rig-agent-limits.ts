import { cleanShotCap } from "../approvalRule";
import { getSetting } from "../settings";

/*
 * How much Atomik may spend on the Rig without asking (plan §8).
 *
 * A run spends only inside the limit a person approved for it. Inside that
 * limit, in Auto mode, one render may run without a tap only when its price is
 * at or under the per-job line below; anything priced above it always asks.
 * In Ask mode (the default) every paid step asks.
 *
 * The per-job line is the workspace's own cost approval line — the credits a
 * shot may take before a member needs an admin to start it (Settings › Cost
 * approval, `shotCapCredits`, lib/approvalRule.ts) — so a workspace that sets
 * its line sets Atomik's too. The run card suggests the same figure as a
 * run's limit.
 */

/**
 * THE OWNER'S NUMBER: the most one Atomik job may cost without asking, in
 * credits. `null` follows each workspace's cost approval line (above). To give
 * Rig jobs their own line everywhere, change this one line to that number.
 */
export const RIG_AGENT_JOB_CEILING_CREDITS: number | null = null;

/** The per-job line now, in credits: the owner's number when set, else this workspace's approval line. */
export async function rigJobCeiling(): Promise<number> {
  if (RIG_AGENT_JOB_CEILING_CREDITS != null && Number.isFinite(RIG_AGENT_JOB_CEILING_CREDITS) && RIG_AGENT_JOB_CEILING_CREDITS > 0)
    return RIG_AGENT_JOB_CEILING_CREDITS;
  return cleanShotCap(await getSetting("shotCapCredits"));
}

/** The run limit the card suggests: the same line (the person may change it before asking). */
export async function suggestedRunLimit(): Promise<number> {
  return rigJobCeiling();
}

/**
 * The line a run's Auto mode uses: the lower of the line approved with the run and the line now,
 * so a workspace that lowers its line lowers it for runs in progress, and a raise never widens an
 * approval already given.
 */
export function effectiveJobCeiling(approved: number | null, now: number): number {
  return approved != null && Number.isFinite(approved) && approved > 0 ? Math.min(approved, now) : now;
}
