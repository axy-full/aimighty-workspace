/**
 * An approved limit on a run of paid work (an Atomik run on a Rig board): the
 * pure arithmetic, shared by the reservation that enforces it under its write
 * lock (lib/generationRequests.ts reserveGenerationSpend) and by the run,
 * which checks it before it asks for anything (lib/workbench/rig-agent-runs.ts).
 *
 * Everything is counted in whole tenths of a credit, so a sum of figures in
 * tenths never slips past a limit it only meets (0.1 + 0.2 is exactly 0.3
 * here). A job is let through only when
 *
 *   settled + held at worst + this job at worst  ≤  limit
 *
 *  - settled: what the run's finished jobs were charged (their final bill,
 *    after any refund);
 *  - held: what its jobs in flight have reserved, each at its worst case;
 *  - a job's worst case is its estimate times its band: STATED_CHARGE_BAND for
 *    a job whose final charge follows the provider's stated amount (settled
 *    anywhere up to that multiple of its quote), 1 for a job that settles
 *    at, or under, its quote.
 *
 * So the limit is a true ceiling under approximate pricing, at the price of
 * being careful: fewer jobs fit in flight at once than their quotes add up to.
 *
 * No imports: the reservation, the run and the browser all read the same
 * figures from here.
 */

export const TENTHS_PER_CREDIT = 10;

/** Credits as whole tenths (exact for any figure already in tenths). */
export const toTenths = (credits: number): number => Math.round(credits * TENTHS_PER_CREDIT);
/** Credits as whole tenths, rounded up: a limit or a price is never read below itself. */
export const ceilTenths = (credits: number): number => Math.ceil(credits * TENTHS_PER_CREDIT - 1e-9);
export const fromTenths = (tenths: number): number => Math.round(tenths) / TENTHS_PER_CREDIT;

/** How far over its quote a job whose charge follows the provider's stated amount may settle (lib/jobs.ts clamps it there). */
export const STATED_CHARGE_BAND = 3;

/** A job's band: the stated-charge multiple when its quote is approximate or its provider states its own charge, else 1. */
export function jobBand(job: { approximate?: boolean; statesCharge?: boolean }): number {
  return job.approximate || job.statesCharge ? STATED_CHARGE_BAND : 1;
}

/** One job of a run as the ledger has it: still reserved (in flight) or finished, its credits, and its band. */
export type RunCharge = { running: boolean; credits: number; band?: number | null };

export type RunTally = {
  /** What the run's finished jobs were charged, in tenths. */
  settledTenths: number;
  /** What its jobs in flight have reserved, at their estimates, in tenths. */
  heldTenths: number;
  /** The same jobs in flight at their worst case, in tenths: what the limit keeps room for. */
  worstTenths: number;
};

export function runTally(charges: readonly RunCharge[]): RunTally {
  let settledTenths = 0, heldTenths = 0, worstTenths = 0;
  for (const charge of charges) {
    const tenths = Math.max(0, toTenths(Number.isFinite(charge.credits) ? charge.credits : 0));
    if (!charge.running) { settledTenths += tenths; continue; }
    const band = Number.isFinite(charge.band) && Number(charge.band) >= 1 ? Math.round(Number(charge.band)) : 1;
    heldTenths += tenths;
    worstTenths += tenths * band;
  }
  return { settledTenths, heldTenths, worstTenths };
}

export type RunLimitVerdict = {
  ok: boolean;
  /** What the run would stand at with this job at its worst case, in tenths. */
  afterTenths: number;
  /** What is left under the limit before this job, in tenths (never below zero). */
  leftTenths: number;
  /** This job at its worst case, in tenths. */
  needTenths: number;
};

/** Whether one more job fits under the limit: settled + held at worst + this job at worst ≤ limit. */
export function runLimitVerdict(input: { limitTenths: number; tally: RunTally; jobTenths: number; band?: number }): RunLimitVerdict {
  const band = Number.isFinite(input.band) && Number(input.band) >= 1 ? Math.round(Number(input.band)) : 1;
  const needTenths = Math.max(0, Math.round(input.jobTenths)) * band;
  const standing = input.tally.settledTenths + input.tally.worstTenths;
  const afterTenths = standing + needTenths;
  return { ok: afterTenths <= input.limitTenths, afterTenths, leftTenths: Math.max(0, input.limitTenths - standing), needTenths };
}

/** Credits as a figure for a sentence: one decimal only when it is not a whole number ("12", "12.5", "1,234.5"), never cut short. */
export function creditFigure(credits: number): string {
  const tenths = Math.round((Number.isFinite(credits) ? credits : 0) * TENTHS_PER_CREDIT);
  return (tenths / TENTHS_PER_CREDIT).toLocaleString("en-US", { minimumFractionDigits: tenths % TENTHS_PER_CREDIT ? 1 : 0, maximumFractionDigits: 1 });
}

/** A credit amount a person may approve: positive, finite, in whole tenths, at most `max`. */
export function isRunLimitAmount(credits: unknown, max = 1_000_000): credits is number {
  return typeof credits === "number" && Number.isFinite(credits) && credits > 0 && credits <= max
    && Math.abs(credits * TENTHS_PER_CREDIT - Math.round(credits * TENTHS_PER_CREDIT)) < 1e-9;
}

/**
 * What a reservation needs to count a job toward its run (reserveGenerationSpend's `run`):
 * the run, its approved limit, this job's band, and whether it may still spend — read inside the
 * reservation's write lock, so a stop that has just landed reserves nothing.
 */
export type RunSpend = {
  id: string;
  limitCredits: number;
  band: number;
  /** Null while the run may spend; otherwise why not, said to the person. */
  live?: () => Promise<string | null>;
};
