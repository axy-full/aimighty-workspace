import type { RigAgentPaidStepView, RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import { ACTIVE_STATES } from "@/lib/workbench/rig-agent-plan";
import type { QueueItem } from "@/lib/control-room/queue";
import { exact, FREE, priceWords, upTo, type PriceValue } from "./price-words";

/**
 * The board's docked Atomik panel, as a model (design/particl-graphite/README.md § 3.1; Atomik on a board is
 * today's run, lib/workbench/rig-agent*.ts). Pure: it words what the server's run holds and which queue item is
 * which press, and never works out a price of its own.
 *
 * Approvals go through the one queue (lib/control-room): Build · free and Not now on the proposal, Render · N cr
 * and Skip on a render, each on that item's own row, so every screen shows the same price and wording.
 */

export const AGENT_OFF = "Atomik’s board building is switched off right now.";
export const SAMPLE_LINE = "Sample production · nothing you do here spends credits";

/** The run is still going, or waiting for someone: a new ask has to wait for it to finish or stop. */
export const runOpen = (run: RigAgentRunView | null): boolean => !!run && ACTIVE_STATES.includes(run.state);

/** The queue's row for a run's proposed build. */
export function planItemOf(items: readonly QueueItem[], run: RigAgentRunView | null): QueueItem | null {
  if (!run) return null;
  return items.find((i) => i.approve?.kind === "board-approve" && i.approve.runId === run.id) ?? null;
}

/** The queue's row for one render of a run: its approval while it waits, or its Skip while it is paused. */
export function renderItemOf(items: readonly QueueItem[], run: RigAgentRunView | null, seq: number): QueueItem | null {
  if (!run) return null;
  return items.find((i) => (i.approve?.kind === "board-render" && i.approve.runId === run.id && i.approve.seq === seq)
    || (i.decline?.kind === "board-skip" && i.decline.runId === run.id && i.decline.seq === seq)) ?? null;
}

/** A render's price as the run holds it: its price, or up to the most it may settle at when that is higher. Null: nothing has priced it. */
export function renderPrice(step: Pick<RigAgentPaidStepView, "quote" | "worst">): PriceValue | null {
  if (step.quote == null) return null;
  return step.worst != null && step.worst > step.quote ? upTo(step.worst) : exact(step.quote);
}

/** The limit a paused render needs: the run's limit, plus what this render's worst case is short of what is left. */
export function raiseTarget(run: RigAgentRunView): { step: RigAgentPaidStepView; to: number } | null {
  const step = run.paid.find((p) => p.tool === "render" && p.state === "paused" && p.pause === "limit");
  const money = run.money;
  if (!step || !money) return null;
  return { step, to: Math.ceil(money.limit + Math.max(0, (step.worst ?? step.quote ?? 0) - money.left)) };
}

export type AgentAsk = {
  label: string;
  price: PriceValue | null;
  disabled: boolean;
  /** Why it can't be pressed, in the product's words; null when it can. */
  reason: string | null;
};

/**
 * The composer's button: "Ask · up to N cr", N being the code's planning figure for this board now (`ask.planning`).
 * The ask is sent with that figure as its limit, so the price on the button is exactly the approval. Disabled, with
 * the reason, while there is no figure, while a run is open, while Atomik is off, or on the sample production.
 */
export function agentAsk(input: { read: boolean; enabled: boolean; run: RigAgentRunView | null; planning: number | null; words: string; busy: boolean; sample: boolean; offline: boolean }): AgentAsk {
  const price = upTo(input.planning);
  const label = priceWords(price) ? `Ask · ${priceWords(price)}` : "Ask";
  const off = (reason: string): AgentAsk => ({ label, price, disabled: true, reason });
  /* Nothing spends here: disabled with the sample's line, and no price on it. */
  if (input.sample) return { label: "Ask", price: null, disabled: true, reason: SAMPLE_LINE };
  if (input.offline) return off("Needs a connection");
  if (!input.read) return off("Reading Atomik…");
  if (!input.enabled) return off(AGENT_OFF);
  if (runOpen(input.run)) return off("Atomik is working on this board. Stop it first to ask again.");
  if (!price) return off("Atomik’s thinking has no price right now, so nothing can be sent.");
  if (input.words.trim().length < 3) return { label, price, disabled: true, reason: null };
  if (input.busy) return { label: "Asking…", price, disabled: true, reason: null };
  return { label, price, disabled: false, reason: null };
}

export type AgentTone = "plain" | "needs" | "problem";
export const RENDER_STATE: Partial<Record<RigAgentPaidStepView["state"], string>> = {
  next: "Up next", waiting: "Ready", approved: "Approved · going next", sending: "Sending", rendering: "Rendering…",
  done: "Rendered · in Takes", failed: "Failed", paused: "Needs you", skipped: "Not rendered",
};

/** A short word for the run's state, for the rail and the head. */
export function runStateWord(run: RigAgentRunView | null): string {
  if (!run) return "";
  switch (run.state) {
    case "planning": return "Planning";
    case "awaiting_approval": return "Proposal";
    case "running": return "Working";
    case "paused": return "Paused";
    case "needs_you": return "Needs you";
    case "done": return "Done";
    default: return "Stopped";
  }
}

/** Whether the run needs this person now: the dock lights its rail. */
export function runNeedsYou(run: RigAgentRunView | null): boolean {
  if (!run || !run.mine) return false;
  return run.state === "awaiting_approval" || run.state === "needs_you" || run.state === "paused";
}

/** "Building · 3 of 7 steps". */
export function buildLine(run: RigAgentRunView): string | null {
  const build = run.steps.filter((s) => s.state !== "next");
  if (!build.length) return null;
  const done = build.filter((s) => s.state === "done").length;
  return `Building · ${done} of ${build.length} ${build.length === 1 ? "step" : "steps"}`;
}

/** What a finished build placed: "7 cards · 6 wires". */
export function placedWords(run: RigAgentRunView): string {
  const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;
  return `${plural(run.built.cards, "card")} · ${plural(run.built.wires, "wire")}`;
}

export const FREE_PRICE = FREE;
