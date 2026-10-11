/**
 * The Record on the phone (design/particl-graphite/README.md § 3.6, frame E): the parts with no React and no
 * fetch. Spend against the budget, the brief's spec line, one row per Atomik run with what it was quoted and what
 * it settled at, and the decisions still open. Every figure is the server's (the production's own cap and spend,
 * the activity read's ledger figures); nothing here works one out of thin air or words a price by hand.
 *
 * Gaps the code leaves (DECISIONS 9, 13): there is no "held" figure, so work in flight reads "settling"; the 80%
 * pause is not built, so the budget bar marks 80% as a line and says nothing is paused; with no budget set the
 * record says so and draws no bar.
 */
import type { ActivityRun, RunStep } from "@/lib/control-room/activity";
import { RUN_STATE_LABEL, runNumber } from "@/lib/control-room/activity";
import { exact, priceSum, type PriceValue } from "@/lib/shell/price-words";
import type { Project } from "@/lib/workbench/studio";

/** A production's budget read from its own row: what it has settled against its cap. */
export type Budget = {
  spent: number;
  cap: number | null;
  /** 0–100, clamped; null with no cap. */
  pct: number | null;
  /** Where the 80% line sits on the bar, 0–100; null with no cap. */
  line: number | null;
  /** What 80% of the cap comes to, in credits; null with no cap. */
  at80: number | null;
};

export const BUDGET_LINE = 0.8;

export function budgetView(spent: number | null | undefined, cap: number | null | undefined): Budget | null {
  if (typeof spent !== "number" || !Number.isFinite(spent) || spent < 0) return null;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) return { spent, cap: null, pct: null, line: null, at80: null };
  return { spent, cap, pct: Math.min(100, (spent / cap) * 100), line: BUDGET_LINE * 100, at80: Math.round(cap * BUDGET_LINE) };
}

/** "16:9 · 24 fps · 15 s": the frame, the rate and what the shots add up to; whatever of them the project says. */
export function briefSpec(project: Pick<Project, "aspect" | "fps" | "production">): string | null {
  const seconds = (project.production?.beats?.scenes ?? []).flatMap((scene) => scene.shots).reduce((sum, shot) => sum + (Number(shot.duration) > 0 ? Number(shot.duration) : 0), 0);
  const parts = [
    project.aspect || null,
    project.fps > 0 ? `${project.fps} fps` : null,
    seconds > 0 ? `${Number.isInteger(seconds) ? seconds : Math.round(seconds * 10) / 10} s` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export type RecordRow = {
  id: string;
  title: string;
  /** "Approved by you · 09:52", or "Waiting for you · Run 05". */
  line: string;
  /** How the right-hand side reads: a figure that settled, a word, or nothing yet. */
  tone: "settled" | "waiting" | "live" | "ended";
  settled: PriceValue | null;
  /** The word on the right when there is no figure: "waiting", "settling", "Failed", "Stopped". */
  word: string | null;
  /** What the run was put at before it ran: its paid steps' prices added up; null when none has one. */
  quoted: PriceValue | null;
};

const when = (at: number, now: number) => {
  const d = new Date(at);
  return new Date(now).toDateString() === d.toDateString()
    ? `Today ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/** The first paid step somebody approved: who, and when. */
function approval(steps: readonly RunStep[]): { by: string; at: number | null } | null {
  const step = steps.find((s) => s.kind === "paid" && s.by && ["approved", "running", "done", "failed"].includes(s.state));
  return step ? { by: step.byYou ? "you" : step.by!, at: step.at } : null;
}

/** One row for each of the project's runs, oldest first (the Record reads as a ledger). */
export function recordRows(runs: readonly ActivityRun[], now: number): RecordRow[] {
  return [...runs].sort((a, b) => a.startedAt - b.startedAt).map((run) => {
    const quoted = priceSum(run.steps.filter((s) => s.kind === "paid" && s.state !== "skipped" && s.priced).map((s) => s.priced));
    const by = approval(run.steps);
    const line = run.state === "needs-you" || !by
      ? `${RUN_STATE_LABEL[run.state]} · Run ${runNumber(run.n)}`
      : `Approved by ${by.by}${by.at ? ` · ${when(by.at, now)}` : ""}`;
    const settled = run.settled > 0 ? exact(run.settled) : null;
    const tone: RecordRow["tone"] = run.state === "needs-you" ? "waiting" : run.settling || run.state === "running" || run.state === "planning" ? "live" : run.state === "done" && settled ? "settled" : "ended";
    const word = settled && !run.settling ? null
      : run.state === "needs-you" ? "waiting"
      : run.settling || run.state === "running" || run.state === "planning" ? (settled ? null : "settling")
      : run.state === "failed" ? "Failed" : run.state === "stopped" ? "Stopped" : null;
    return { id: run.id, title: run.title, line, tone, settled, word, quoted };
  });
}

/** "2 decisions waiting" and the like: the count said in words. */
export const decisionsLine = (n: number) => (n === 1 ? "1 decision waiting" : `${n.toLocaleString("en-US")} decisions waiting`);
