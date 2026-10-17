import { BILLING_STATES, parseOutcome, type BillingState, type ProviderOutcome } from "../providerOutcome";

/**
 * The closed lists of a v30 job and an Agent command (docs/plans/v30-data-model.md § 4.1, 4.2; PR A3), and the one
 * mapping from what the provider did with a job to the job's refund status.
 *
 * The tables' CHECK constraints are built from these lists, so the code and the database cannot disagree.
 * Pure: no database, no imports beyond lib/providerOutcome.ts.
 */

/** Who decided how the job is made. Not `mode`: that already means Ask | Auto (atomik_chats.agent_mode, rig_agent_runs.mode). */
export const DECIDERS = ["agent", "director"] as const;
export type Decider = (typeof DECIDERS)[number];

/** What the job makes (the brief's list, in its order). */
export const PRODUCTS = ["generation", "reading", "research", "analysis", "writing", "layers", "enhance", "render", "upscale"] as const;
export type JobProduct = (typeof PRODUCTS)[number];

export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const FINISHED: readonly JobStatus[] = ["done", "failed", "cancelled"];

/** Where a job may go from where it is. A finished job stays finished. */
export const JOB_MOVES: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export const COMMAND_STATES = ["quoted", "approved", "running", "done", "failed", "cancelled", "declined"] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

/** Where a command may go from where it is. `approved` is written only with a person's approval (see the store). */
export const COMMAND_MOVES: Readonly<Record<CommandState, readonly CommandState[]>> = {
  quoted: ["approved", "declined", "cancelled"],
  approved: ["running", "cancelled"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
  declined: [],
};

/**
 * A job's refund status: the provider's own billing state, the same four values (lib/providerOutcome.ts BILLING_STATES).
 * It records what the vendor did. It does not decide what the workspace is charged: today's billing of failed and
 * cancelled jobs is unchanged (owner, 17 Oct: "store the refund status on every job now; keep today's billing behaviour").
 * It is internal: no view sends it (owner, 17 Oct: "the word refund never appears; vendor refunds stay internal").
 */
export const REFUND_STATUSES = BILLING_STATES;
export type RefundStatus = BillingState;

/**
 * The one mapping, written once when a job fails or is cancelled, from the same outcome `meter()` and
 * `generations.provider_outcome` receive (the object, or its stored JSON). No outcome, or one that cannot be read, is
 * `unknown`: "the provider didn't say". Never a guess.
 */
export function refundStatusOf(outcome: ProviderOutcome | string | null | undefined): RefundStatus {
  const parsed = typeof outcome === "string" ? parseOutcome(outcome) : outcome ? parseOutcome(outcome) : null;
  const state = parsed?.billing.state;
  return state && (REFUND_STATUSES as readonly string[]).includes(state) ? state : "unknown";
}

/** `'a','b'` for a CHECK constraint, from one of the lists above (fixed identifiers, never input). */
export const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(",");
