import { creditUsd } from "../creditTerms";

/*
 * How much Atomik may spend on the Rig without asking (plan §8).
 *
 * A run spends only inside the limit a person approved for it. Inside that
 * limit, in Auto mode, one render may run without a tap only when it is a
 * draft priced at or under Auto's ceiling below; anything priced above it,
 * and any full-quality render, always asks. In Ask mode (the default) every
 * paid step asks.
 *
 * Auto's ceiling is Auto's OWN no-tap ceiling. It is not a platform per-job
 * line: that line (SOW §7A guardrail 4) was retired on 20 October 2026 (owner:
 * "Guardrail 4 is retired everywhere, single jobs included: no per-job line in
 * the product"). Auto keeps the value it had while it borrowed that line
 * (US$20 of credits: 200 cr at a credit's US$0.10), so Auto behaves exactly as
 * before. Whether Auto stays at all is open for the owner.
 *
 * The same figure is the most one render may cost inside a plan's single
 * approval (lib/workbench/plan-approval.ts: above it a render asks on its own
 * tap), and the run card suggests it as a run's limit.
 */

/**
 * Auto's own no-tap ceiling, as a price: US$20 of credits, so 200 cr at a
 * credit's US$0.10. Counted in credits at the price of a credit, as it was
 * when it was the platform's line, so it reads as fewer credits when a credit
 * costs more. Not a platform per-job line (retired 20 October 2026); whether
 * Auto stays is an open owner question.
 */
export const AUTO_NO_TAP_CEILING_USD = 20;

/** Auto's ceiling in credits at a price of a credit, in whole tenths (rounded down: a job exactly at it is not above it). */
export function autoNoTapCeilingCredits(perCredit: number): number {
  if (!(Number.isFinite(perCredit) && perCredit > 0)) return 0;
  return Math.floor((AUTO_NO_TAP_CEILING_USD / perCredit) * 10 + 1e-9) / 10;
}

/**
 * THE OWNER'S NUMBER: the most one Atomik job may cost without asking, in
 * credits. `null` follows Auto's own ceiling (above). To give Rig jobs a
 * fixed number of credits instead, change this one line to that number.
 */
export const RIG_AGENT_JOB_CEILING_CREDITS: number | null = null;

/** Auto's ceiling now, in credits: the owner's number when set, else Auto's own ceiling at today's price of a credit. */
export async function rigJobCeiling(): Promise<number> {
  if (RIG_AGENT_JOB_CEILING_CREDITS != null && Number.isFinite(RIG_AGENT_JOB_CEILING_CREDITS) && RIG_AGENT_JOB_CEILING_CREDITS > 0)
    return RIG_AGENT_JOB_CEILING_CREDITS;
  return autoNoTapCeilingCredits(creditUsd());
}

/** The run limit the card suggests: the same figure (the person may change it before asking). */
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
