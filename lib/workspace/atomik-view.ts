/**
 * What every Atomik surface shows, derived from the run engine's state
 * (04 "Agent surfaces"). Pure, so the surfaces cannot disagree and the
 * copy is unit-tested. Prices are credits from the live quote, never fixed.
 */

import type { Plan, PlanContext, Runnable } from "./plan-types";
import { formatCredits, type RunView } from "./run-engine";

export type StepTone = "done" | "now" | "gate" | "failed" | "idle";

export type StepRow = { label: string; meta: string; mark: string; tone: StepTone; gate: boolean };

/** ✓ done · ● current · $ gate · ! failed · index otherwise. */
export function stepRows(plan: Plan, run: RunView | null, ctx: PlanContext): StepRow[] {
  return plan.steps.map((step, i) => {
    const gate = step.executor.type === "gate";
    const done = !!run && (run.status === "done" || i < run.i);
    const here = !!run && !done && i === run.i;
    const failed = here && run!.status === "failed";
    const now = here && run!.status === "running";
    let meta = run?.details[i] ?? safeDetail(() => step.detail(ctx, {}));
    if (gate && run?.quote && !done) meta = formatCredits(run.quote.credits, run.quote.unit);
    const tone: StepTone = done ? "done" : failed ? "failed" : now ? "now" : gate ? "gate" : "idle";
    const mark = tone === "done" ? "✓" : tone === "now" ? "●" : tone === "failed" ? "!" : gate ? "$" : String(i + 1);
    return { label: step.label, meta, mark, tone, gate };
  });
}

function safeDetail(read: () => string) {
  try {
    return read();
  } catch {
    return "";
  }
}

export type AgentLook = {
  status: "idle" | "running" | "waiting" | "open";
  badge: string;
  waiting: boolean;
  running: boolean;
};

/**
 * The top-right button. A waiting gate or a running plan anywhere in the
 * project shows here — the approval never hides behind another page.
 */
export function agentButton(run: RunView | null, plan: Plan | null, open: boolean): AgentLook {
  const waiting = run?.status === "waiting";
  const running = run?.status === "running";
  const badge = waiting
    ? "1 approval"
    : running && plan
      ? `${Math.min(run!.i, plan.steps.length)}/${plan.steps.length}`
      : "ready";
  return { status: open ? "open" : waiting ? "waiting" : running ? "running" : "idle", badge, waiting, running };
}

/** Header state: WAITING ON YOU / QUOTING / RUNNING / PAUSED / FAILED / DONE / IDLE. */
export function agentStateLabel(run: RunView | null): string {
  if (!run) return "IDLE";
  if (run.quoting) return "QUOTING";
  const labels: Record<RunView["status"], string> = {
    running: "RUNNING",
    waiting: "WAITING ON YOU",
    paused: "PAUSED",
    failed: "FAILED",
    done: "DONE",
  };
  return labels[run.status];
}

export type RunButton = { label: string; disabled: boolean; busy: boolean };

/** The panel's run button. */
export function runButton(run: RunView | null, runnable: Runnable): RunButton {
  if (run?.status === "waiting") return { label: "Waiting", disabled: true, busy: true };
  if (run?.status === "running") return { label: "Pause run", disabled: false, busy: true };
  if (run?.status === "done") return { label: "Run again", disabled: !runnable.ok, busy: false };
  if (run) return { label: "Resume run", disabled: !runnable.ok, busy: false };
  return { label: "Run this page", disabled: !runnable.ok, busy: false };
}

/** The "Run with Atomik" chip in the page header; "Approve 18 cr" in amber while its gate waits. */
export function runChip(run: RunView | null): { label: string; tone: "idle" | "running" | "waiting" } {
  if (run?.status === "waiting" && run.quote)
    return { label: `Approve ${formatCredits(run.quote.credits, run.quote.unit)}`, tone: "waiting" };
  if (run?.status === "waiting") return { label: "Approve", tone: "waiting" };
  if (run?.status === "running") return { label: "Pause run", tone: "running" };
  if (run?.status === "done") return { label: "Run again", tone: "idle" };
  if (run) return { label: "Resume run", tone: "idle" };
  return { label: "Run with Atomik", tone: "idle" };
}

/** The price beside the run button: the live quote once there is one, else the plan's label. */
export function priceText(plan: Plan, run: RunView | null): string {
  if (run?.quote) return formatCredits(run.quote.credits, run.quote.unit);
  return plan.priceLabel;
}
