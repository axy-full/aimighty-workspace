import type { ActivityRun, RunStep } from "@/lib/control-room/activity";
import type { QueueItem, QueuePrice } from "@/lib/control-room/queue";
import { creditsText, exact, priceWords } from "./price-words";

/**
 * The Project record (design/particl-graphite/README.md § 3.1 n; phone Record e1, e2): the brief, what was
 * approved and what each approval settled at, what still waits for a person, and what the project has spent
 * against its budget. A pure model over what exists: the brief as the draft holds it, stream 8's activity read (runs
 * with per-step rows) and approvals queue, and the production's cap and spend, which the reservation gate enforces
 * (lib/caps.ts). Credits only; no figure is worked out here, and none is invented.
 *
 * Left out because the code does not do it: the 80 % pause line (no pause is built), and a workspace "held" total
 * (work in flight reads "settling", and its figure appears once the ledger settles it).
 */

/* ── Brief ─────────────────────────────────────────────────────────────── */

export type RecordBrief = { brief: string; look: string; footer: string };

/** The brief as the board's brief card reads it: the draft's brief and direction, and "16:9 · 24 fps · 15 s". */
export function recordBrief(input: { brief: string; direction: string; aspect: string; fps: number; length: string | null }): RecordBrief {
  return {
    brief: input.brief.trim(),
    look: input.direction.trim(),
    footer: [input.aspect, input.fps ? `${input.fps} fps` : null, input.length].filter(Boolean).join(" · "),
  };
}

/* ── Approvals: priced → settled ───────────────────────────────────────── */

/** What the ledger shows for a step, as the row words it. */
export type RecordSettled =
  | { kind: "price"; price: QueuePrice }
  /* Sent, and not settled yet: its figure appears once the ledger settles it. */
  | { kind: "settling" }
  /* Only where the ledger confirms nothing was charged. */
  | { kind: "nothing" }
  /* Nothing to show: the workspace is not billed in credits, or the ledger holds no row for it. */
  | { kind: "none" };

export type RecordApproval = {
  id: string;
  title: string;
  /** "you", or the name the usage ledger gives; null when the record does not say. */
  by: string | null;
  /** Auto ran it without a tap. */
  auto: boolean;
  at: number | null;
  priced: QueuePrice;
  settled: RecordSettled;
  /** The run it belongs to, for the row's open. */
  runId: string;
};

const APPROVED_STATES: readonly RunStep["state"][] = ["approved", "running", "done", "failed"];

function settledOf(step: RunStep): RecordSettled {
  switch (step.settled.kind) {
    case "settled": return { kind: "price", price: exact(step.settled.credits) };
    case "settling": return { kind: "settling" };
    case "nothing": return step.state === "failed" || step.state === "done" ? { kind: "nothing" } : { kind: "none" };
    default: return { kind: "none" };
  }
}

/**
 * One row per approved step of this production's runs (the thinking turn and each paid step), newest first.
 * A step still waiting, skipped or turned down is not an approval, so it is not a row.
 */
export function recordApprovals(runs: readonly ActivityRun[]): RecordApproval[] {
  const rows = runs.flatMap((run) => run.steps
    .filter((s) => APPROVED_STATES.includes(s.state))
    .map((s): RecordApproval => ({
      id: `${run.id}:${s.id}`, title: s.title, by: s.byYou ? "you" : s.by, auto: s.auto, at: s.at, priced: s.priced, settled: settledOf(s), runId: run.id,
    })));
  return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id));
}

/** "up to 4 cr → 4 cr", "43 cr → settling", "43 cr → Nothing billed"; only the parts there are figures for. */
export function approvalWords(row: Pick<RecordApproval, "priced" | "settled">): string {
  const priced = priceWords(row.priced) ?? "";
  const settled = row.settled.kind === "price" ? priceWords(row.settled.price) ?? ""
    : row.settled.kind === "settling" ? "settling" : row.settled.kind === "nothing" ? "Nothing billed" : "";
  return [priced, settled].filter(Boolean).join(" → ");
}

/* ── Open decisions ────────────────────────────────────────────────────── */

export type RecordDecision = { id: string; title: string; price: QueuePrice; where: "board" | "approvals"; item: QueueItem };

/**
 * What still waits for a person on this production: stream 8's queue filtered to it. Each row has one action, Open:
 * a board run's items open Atomik's lines on the board (where the press is, at its price); a held take or a plan's
 * step opens Approvals. Nothing here approves.
 */
export function recordDecisions(items: readonly QueueItem[], productionId: string | null): RecordDecision[] {
  if (!productionId) return [];
  return items
    .filter((i) => i.project.productionId === productionId && !i.sample)
    .map((i): RecordDecision => ({ id: i.id, title: i.title, price: i.price, where: i.source === "board-plan" || i.source === "board-render" ? "board" : "approvals", item: i }));
}

/* ── Spend against the budget ──────────────────────────────────────────── */

export type RecordBudget =
  | { kind: "capped"; spent: number; cap: number; fraction: number; over: boolean; line: string }
  | { kind: "none"; spent: number; line: string }
  /* A workspace on its own keys is not billed in credits: no figure here. */
  | { kind: "unbilled" };

/** "N of M cr" with the bar's fraction (the figure the gate enforces), or "N cr spent · no budget". */
export function recordBudget(input: { inCredits: boolean; cap: number | null; spent: number | null }): RecordBudget {
  if (!input.inCredits || input.spent === null) return { kind: "unbilled" };
  const spent = Math.round(input.spent * 10) / 10;
  if (input.cap === null || !(input.cap > 0)) return { kind: "none", spent, line: `${creditsText(spent)} spent · no budget` };
  return { kind: "capped", spent, cap: input.cap, fraction: Math.max(0, Math.min(1, spent / input.cap)), over: spent > input.cap, line: `${spent.toLocaleString("en-US", { maximumFractionDigits: 1 })} of ${creditsText(input.cap)}` };
}
