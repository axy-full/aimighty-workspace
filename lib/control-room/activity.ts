import { exact } from "@/lib/shell/price-words";
import type { OpenRef, Outcome, QueuePrice, QueueProject } from "./queue";

/**
 * Activity: Atomik's runs and what they settled at, per run and per project
 * (design/particl-graphite/README.md § 3.4; Atomik frame h). The control room's
 * Activity page reads it, and so does the board's Project record (one row per
 * paid step: what, priced, settled, who, when).
 *
 * Pure. The server builds it from the durable records (lib/control-room/
 * activity.server.ts, read through GET /api/control-room/activity). A run is a
 * request to Atomik and the plan it made: a thread in Atomik's panel, or
 * Atomik's work on a board. Figures are the ledger's, in credits only. There is
 * no "held" figure: work in flight reads "settling", and its figure appears
 * once the ledger settles it.
 */

export type RunSource = "thread" | "board";
export type RunState = "planning" | "needs-you" | "running" | "done" | "stopped" | "failed";

/** One step of a run, as the Record lists it. */
export type RunStep = {
  id: string;
  /** "thinking": Atomik's planning turn, billed as today. "paid": a render or a take. */
  kind: "thinking" | "paid";
  title: string;
  /** The price the step was put at before it ran; null when there is no figure to show. */
  priced: QueuePrice;
  /** What the ledger settled it at. */
  settled: Outcome;
  state: "waiting" | "approved" | "running" | "done" | "failed" | "skipped" | "turned down";
  /** Who approved it, under the usage ledger's naming rule; null when the record does not say. */
  by: string | null;
  byYou: boolean;
  /** Auto ran it without a tap: a draft at or under the per-job line. */
  auto: boolean;
  at: number | null;
};

export type ActivityRun = {
  /** `thread:<chat id>` or `board:<run id>`. */
  id: string;
  source: RunSource;
  /** Its place among this project's runs, oldest first: 1 is the first. */
  n: number;
  title: string;
  project: QueueProject;
  startedAt: number;
  state: RunState;
  /** Why it stopped or waits, in the code's own words, when it says. */
  reason: string | null;
  steps: RunStep[];
  /** Credits the ledger has settled for this run, every step and the thinking together. */
  settled: number;
  /** Something of it is still settling: its figure isn't final. */
  settling: boolean;
  /** The request it was asked with, for Run again. */
  request: string;
  open: OpenRef;
};

export type ProjectSpend = { project: QueueProject; settled: number };

export type ActivityReply = {
  inCredits: boolean;
  /** The production the runs are for; null for every production. */
  productionId: string | null;
  /** Settled per project, across the workspace, most first. */
  projects: ProjectSpend[];
  /** This production's runs, newest first. */
  runs: ActivityRun[];
};

export type RunFilter = "All" | "Running" | "Needs you" | "Done";
export const RUN_FILTERS: readonly RunFilter[] = ["All", "Running", "Needs you", "Done"];

const RUNNING: readonly RunState[] = ["planning", "running"];
const ENDED: readonly RunState[] = ["done", "stopped", "failed"];

export function filterRuns(runs: readonly ActivityRun[], filter: RunFilter): ActivityRun[] {
  if (filter === "Running") return runs.filter((r) => RUNNING.includes(r.state));
  if (filter === "Needs you") return runs.filter((r) => r.state === "needs-you");
  if (filter === "Done") return runs.filter((r) => ENDED.includes(r.state));
  return [...runs];
}

/** The counts above the table: running, waiting for a person, and what this project has settled. */
export function runStats(runs: readonly ActivityRun[]): { running: number; needsYou: number; settled: number } {
  return {
    running: runs.filter((r) => RUNNING.includes(r.state)).length,
    needsYou: runs.filter((r) => r.state === "needs-you").length,
    settled: runs.reduce((n, r) => n + r.settled, 0),
  };
}

/** A run's state in the product's words. */
export const RUN_STATE_LABEL: Record<RunState, string> = {
  planning: "Planning", "needs-you": "Waiting for you", running: "Running", done: "Done", stopped: "Stopped", failed: "Failed",
};

/** The run's figure: settled credits as a price, or null while nothing has settled. */
export function settledValue(run: Pick<ActivityRun, "settled">): QueuePrice {
  return run.settled > 0 ? exact(run.settled) : null;
}

/** "01", "02": a run's number, as the table shows it. */
export const runNumber = (n: number) => String(n).padStart(2, "0");
