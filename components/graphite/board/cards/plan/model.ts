import type { ApprovalRule } from "@/lib/approvalRule";
import { FREE, creditsText, exact, priceWords, shortBy, upTo, type PriceValue } from "@/lib/shell/price-words";
import { STATED_CHARGE_BAND, ceilTenths, fromTenths, toTenths } from "@/lib/runLimit";
import type { RigAgentPaidStepView, RigAgentRunView, RigAgentStepState } from "@/lib/workbench/rig-agent-plan";

/*
 * The plan card (design/particl-graphite/README.md § 3.1 e, § 4, § 5; CLAUDE.md rule 14: a plan is approved once).
 * The plan is Atomik's durable run on the board (lib/workbench/rig-agent*.ts):
 *
 *  - Before the build: "Make 3 shots" and Build · free (`agent.approve` on the proposal as shown). Building places
 *    cards and wires and spends nothing; shots that are not on the board yet cannot be priced.
 *  - The plan gate, after the build: the server has priced every render the plan names on the exact request it will
 *    send. "Make 3 shots · 93 cr · at most 186 cr", and the button is the price: Approve · 93 cr
 *    (`agent.approvePlan` with the server's quote fingerprint). That one approval covers the listed renders at those
 *    prices and up to two fixes per shot, within the ceiling (2 × the total). The server enforces it, not this card.
 *  - After it: what the plan has used of its ceiling. A render outside the approval (a price that moved, one over
 *    the per-job line) asks at its own price, as does everything in Auto that is not a cheap draft.
 *  - Every price is the server's: the plan's quote, the run's own pricing of a step, or (before the build) a
 *    pre-quote of the exact request it will price. Words come from lib/shell/price-words.ts only.
 *
 * Pure: the phone's plan screen (stream 10) reads the same model.
 */

export type PlanPhase = "planning" | "proposal" | "working" | "needs-you" | "paused" | "ended";

/** A price worked out before the run prices a step: the same request, quoted by the server. */
export type StepEstimate = { credits: number; approximate: boolean } | { unavailable: string };

export type PlanStep = {
  seq: number;
  /** The board card the step renders (read only: used to say which shot it is). */
  nodeId: string | null;
  /** "take": a shot rendered as video; "still": an image-mode shot (a keyframe). Only takes count toward the fix allowance. */
  kind: "take" | "still";
  title: string;
  /** The engine line ("Seedance 2.5 · 5 s · 480p draft"), when the board knows it. */
  meta: string;
  /** What it costs or cost: settled once done; the run's price once it has one; else the pre-quote. */
  price: PriceValue | null;
  source: "settled" | "run" | "estimate" | "none";
  /** Why it can't be priced, when it can't ("Unavailable · …"). */
  unavailable: string | null;
  /** Over the workspace's per-shot rule: a member can't render it; an admin can. */
  needsAdmin: boolean;
  /** Priced, but outside the plan's one approval: it asks at its own price ("Asks on its own · over 200 cr"). */
  asksAlone: string | null;
  state: RigAgentStepState;
  /** Where it is, in a few words. */
  status: string;
  reason: string | null;
  /** The viewer may give the tap it waits for. */
  canRender: boolean;
  fingerprint: string | null;
};

export type PlanPrimary =
  /** The proposal: build it (free). `raiseTo` is never set by this card any more: the plan's approval sets the limit. */
  | { kind: "approve"; label: string; price: PriceValue | null; raiseTo: number | null; fingerprint: string; blocked: string | null }
  /** The plan gate: approve the plan once at the server's total (its quote fingerprint). */
  | { kind: "plan"; label: string; price: PriceValue; fingerprint: string; blocked: string | null }
  /** A render that waits for its tap, at its price; or a paused one to try again or price again. */
  | { kind: "render"; label: string; price: PriceValue | null; seq: number; fingerprint: string | null; blocked: string | null }
  /** A render paused at the run's limit: raise it (the person who asked). */
  | { kind: "raise"; label: string; raiseTo: number; blocked: string | null };

export type PlanModel = {
  runId: string;
  phase: PlanPhase;
  /** "Make 3 shots" before approval; "Making 3 shots" after. */
  title: string;
  steps: PlanStep[];
  /** The renders' total: the server's plan quote at the gate, else every take's price added up; null while one has none. Never the thinking. */
  total: PriceValue | null;
  /** The most the plan may spend, fixes included: 2 × the total (credits). At the gate and after, the server's figure. */
  ceiling: number | null;
  /** After the plan's approval: what it has used of the ceiling (credits). */
  used: number | null;
  /** The balance now, after the total, and how short it is. */
  balance: { now: number; after: number | null; short: number | null } | null;
  /** "93 cr for the 3 shots": what the renders come to, as information (not what Approve spends). */
  totalLine: string | null;
  /** "Thinking · 14 cr · billed when Atomik planned it" */
  thinking: string | null;
  /** How the renders ask, said plainly. */
  modeLine: string | null;
  /** "Members up to 40 cr a shot; an admin above it." when the workspace has that rule. */
  ruleLine: string | null;
  /** The words under a step over the rule: "Needs an admin · over 40 cr on a shot". */
  adminLine: string;
  primary: PlanPrimary | null;
  /** The run's own words when it waits for someone or stopped. */
  note: string | null;
  mine: boolean;
};

export type PlanInput = {
  run: RigAgentRunView | null;
  /** Board building is switched on (`enabled` from the run's read). */
  enabled: boolean;
  /** Pre-quotes, by step, for renders the run has not priced yet. */
  estimates?: Readonly<Record<number, StepEstimate>>;
  /** Engine lines, by step. */
  meta?: Readonly<Record<number, string>>;
  /** Which steps render a still (an image-mode shot), by step; the rest are takes. */
  stills?: ReadonlySet<number>;
  /** The workspace's balance in credits, or null when unknown (or not a credit workspace). */
  balance: number | null;
  /** The cost approval rule as the workspace sets it, and whether the viewer is an admin. */
  rule: { rule: ApprovalRule; cap: number; admin: boolean } | null;
  /** Nothing can be pressed: the sample production's line, or "Needs a connection" offline. */
  readOnly: string | null;
};

const STATUS: Record<RigAgentStepState, string> = {
  proposed: "Planned", queued: "Planned", next: "Up next", waiting: "Ready", approved: "Approved · going next", sending: "Sending",
  rendering: "Rendering", done: "Rendered", failed: "Failed", paused: "Needs you", skipped: "Not rendered",
};

export const SWITCHED_OFF = "Atomik's board building is switched off right now.";
export const NOT_MINE = "Only the person who asked approves this plan.";
export const SHORT_LINE = "Top up, then approve. Nothing is spent until you do.";

/** The most a plan may spend, fixes included, as a multiple of its renders' total (lib/workbench/plan-approval.ts). */
export const PLAN_CEILING_MULTIPLE = 2;

/** A price the server quoted for a request: exact, or up to its band when it settles on what the provider states. */
export function estimatePrice(estimate: { credits: number; approximate: boolean }): PriceValue | null {
  return estimate.approximate ? upTo(fromTenths(toTenths(estimate.credits) * STATED_CHARGE_BAND)) : exact(estimate.credits);
}

/**
 * A run's step at the price the run holds for it: what it settled at once done, else its quote, or
 * up to its worst case when it may settle above the quote (the run keeps room for that worst case).
 * The same figures the shared approvals queue shows.
 */
export function runStepPrice(step: RigAgentPaidStepView): PriceValue | null {
  if (step.state === "done") return step.charged != null ? exact(step.charged) : null;
  if (step.state === "failed") return step.charge ? exact(step.charge.credits) : null;
  if (step.quote == null) return null;
  return step.worst != null && step.worst > step.quote ? upTo(step.worst) : exact(step.quote);
}

/** The credits a price may come to: its figure, rounded up the way price-words shows it. */
function ceilingOf(price: PriceValue): number {
  if (price.kind === "free") return 0;
  return price.kind === "up-to" ? Math.ceil(price.credits - 1e-9) : price.credits;
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

export function planTitle(shots: number, phase: PlanPhase): string {
  if (!shots) return "";
  return phase === "proposal" || phase === "planning" ? `Make ${plural(shots, "shot")}` : `Making ${plural(shots, "shot")}`;
}

function thinkingLine(run: RigAgentRunView): string | null {
  const planning = run.money?.planning;
  if (!planning) return null;
  if (planning.state === "released") return "Thinking · not billed";
  if (planning.credits == null) return null;
  const words = priceWords(planning.state === "settled" ? exact(planning.credits) : upTo(planning.credits));
  return planning.state === "settled" ? `Thinking · ${words} · billed when Atomik planned it` : `Thinking · ${words} · while Atomik plans`;
}

function modeLine(run: RigAgentRunView, gate: boolean): string | null {
  const money = run.money;
  if (!money) return null;
  if (run.plan?.approval?.open) return "Inside the approved plan nothing asks again; anything outside it asks at its price.";
  if (gate || (run.state === "awaiting_approval" && money.mode !== "auto")) return "One approval covers the shots and up to 2 fixes each; anything else asks.";
  if (money.mode === "auto") {
    const line = priceWords(upTo(money.jobCeiling));
    return line ? `Drafts ${line} each render without asking; anything else asks.` : "Drafts under the per-render line run without asking; anything else asks.";
  }
  return "Each shot asks at its price before it renders.";
}

function ruleLine(rule: PlanInput["rule"]): string | null {
  if (!rule || rule.rule !== "cap") return null;
  return `Members up to ${creditsText(rule.cap)} a shot; an admin above it.`;
}

export function phaseOf(run: RigAgentRunView): PlanPhase {
  /* The plan gate: the build is done and the server's quote waits for the one approval. */
  if (run.state === "needs_you" && run.plan?.quote && !run.plan.approval) return "proposal";
  switch (run.state) {
    case "planning": return "planning";
    case "awaiting_approval": return "proposal";
    case "running": return "working";
    case "needs_you": return "needs-you";
    case "paused": return "paused";
    default: return "ended";
  }
}

export function planModel(input: PlanInput): PlanModel | null {
  const run = input.run;
  if (!run) return null;
  const phase = phaseOf(run);
  const plan = run.plan ?? null;
  const gate = phase === "proposal" && run.state !== "awaiting_approval" && plan?.quote ? plan.quote : null;
  const takes = run.paid.filter((p) => p.tool === "render");
  const steps: PlanStep[] = takes.map((p) => {
    const estimate = input.estimates?.[p.seq];
    const fromRun = runStepPrice(p);
    const unavailable = !fromRun && estimate && "unavailable" in estimate ? estimate.unavailable : null;
    const estimated = !fromRun && estimate && !("unavailable" in estimate) ? estimatePrice(estimate) : null;
    const price = fromRun ?? estimated;
    const source: PlanStep["source"] = fromRun ? (p.state === "done" || p.state === "failed" ? "settled" : "run") : estimated ? "estimate" : "none";
    const credits = price ? ceilingOf(price) : null;
    const overCap = Boolean(input.rule && input.rule.rule === "cap" && credits != null && credits > input.rule.cap);
    const settled = p.state === "done" && fromRun ? ` · ${priceWords(fromRun)} settled` : "";
    const status = p.state === "failed"
      ? (p.outcome === "not_billed" ? "Failed · nothing billed" : p.outcome === "charged" ? "Failed · charged" : "Failed")
      : `${STATUS[p.state]}${settled}`;
    return {
      seq: p.seq, nodeId: p.nodeId ?? null, kind: input.stills?.has(p.seq) ? "still" : "take", title: p.title, meta: input.meta?.[p.seq] ?? "", price, source,
      unavailable: unavailable ? `Unavailable · ${unavailable}` : null,
      needsAdmin: overCap || (p.state === "paused" && p.pause === "admin"),
      /* Outside the plan's one approval, with its own price (owner decision L5): it needs an admin, or it is over the per-render line. */
      asksAlone: !gate?.asks.includes(p.seq) ? null
        : p.state === "paused" && p.pause === "admin" ? "Asks on its own · needs an admin" : "Asks on its own · over the per-render line",
      state: p.state, status, reason: p.reason, canRender: p.canRender, fingerprint: p.fingerprint,
    };
  });

  const counted = steps.filter((s) => s.state !== "skipped" && !s.unavailable && !s.asksAlone);
  const approval = plan?.approval ?? null;
  /* The plan's figures are the server's only (review L2): its quote at the gate, then the approved total. Before the gate
     (the proposal, Build · free) the card adds nothing up: no total, no "at most", no fix line, no balance after. */
  const total: PriceValue | null = gate ? (gate.approximate ? upTo(gate.total) : exact(gate.total))
    : approval ? (approval.approximate ? upTo(approval.total) : exact(approval.total))
    : !steps.length ? FREE : null;
  const totalCredits = total ? ceilingOf(total) : null;
  const takesCounted = counted.filter((s) => s.kind === "take");
  const ceiling = gate ? gate.ceiling : approval ? approval.ceiling : null;
  const balance = input.balance == null || !total || total.kind === "free" ? null : {
    now: input.balance,
    after: totalCredits == null ? null : Math.round((input.balance - totalCredits) * 10) / 10,
    short: shortBy(input.balance, total),
  };

  const money = run.money;

  const offBlock = input.readOnly ?? (!input.enabled ? SWITCHED_OFF : !run.mine ? NOT_MINE : null);
  let primary: PlanPrimary | null = null;
  if (gate) {
    /* The plan gate: the button is the price, the server's total. One approval; the server holds it to the ceiling. */
    primary = {
      kind: "plan", label: `${gate.asks.length ? "Approve the rest" : "Approve"} · ${priceWords(total!)}`, price: total!, fingerprint: gate.fingerprint,
      blocked: offBlock ?? (balance?.short != null ? SHORT_LINE : null),
    };
  } else if (phase === "proposal" && run.proposal) {
    /* Building is free and approves no spending: the renders are priced once their shots are on the board, then approved once. */
    primary = {
      kind: "approve", label: total?.kind === "free" ? "Approve · free" : "Build · free", price: null, raiseTo: null, fingerprint: run.proposal.fingerprint,
      blocked: offBlock,
    };
  } else if (phase === "needs-you") {
    /* A render that needs an admin waits in the queue on its own; the card's tap is for the person's own renders. */
    const open = steps.find((s) => s.state === "waiting" || (s.state === "paused" && takes.find((p) => p.seq === s.seq)?.pause !== "admin"));
    const paused = open ? takes.find((p) => p.seq === open.seq) : undefined;
    if (open && paused?.state === "paused" && paused.pause === "limit" && money) {
      const worst = open.price ? toTenths(ceilingOf(open.price)) : null;
      const to = worst != null ? Math.ceil(fromTenths(toTenths(money.limit) + Math.max(0, worst - toTenths(money.left)))) : null;
      if (to != null && ceilTenths(to) > toTenths(money.limit))
        primary = { kind: "raise", label: `Raise the limit to ${creditsText(to)}`, raiseTo: to, blocked: input.readOnly ?? (!input.enabled ? SWITCHED_OFF : !run.mine ? NOT_MINE : null) };
    } else if (open) {
      const again = paused?.state === "paused" && (paused.pause === "unpriced" || paused.pause === "record" || open.price == null);
      const verb = again ? "Price again" : paused?.state === "paused" ? "Retry" : "Render";
      const words = !again && open.price ? priceWords(open.price) : null;
      primary = {
        kind: "render", label: words ? `${verb} · ${words}` : verb, price: again ? null : open.price, seq: open.seq, fingerprint: open.fingerprint,
        blocked: offBlock ?? (!open.canRender ? NOT_MINE : null),
      };
    }
  }

  const shots = planTitle(steps.length, phase);
  const title = gate && total && ceiling != null ? `${shots} · ${priceWords(total)} · at most ${creditsText(ceiling)}` : shots;
  return {
    runId: run.id, phase, title: title || run.proposal?.title || "", steps, total, ceiling, used: approval ? approval.used : null, balance,
    totalLine: gate ? null : totalLineOf(total, takesCounted.length),
    thinking: thinkingLine(run), modeLine: steps.length ? modeLine(run, Boolean(gate)) : null, ruleLine: ruleLine(input.rule),
    adminLine: input.rule?.rule === "cap" ? `Needs an admin · over ${creditsText(input.rule.cap)} on a shot` : "Needs an admin", primary,
    note: phase === "needs-you" || phase === "paused" || phase === "ended" ? run.reason : null,
    mine: run.mine,
  };
}

/** "93 cr for the 3 shots": what the renders come to, as information. Null without a price or a take. */
export function totalLineOf(total: PriceValue | null, takes: number): string | null {
  return total && total.kind !== "free" && takes ? `${priceWords(total)} for ${takes === 1 ? "the shot" : `the ${takes} shots`}` : null;
}

/** "Fixes if needed: up to 2 per shot, within 186 cr"; after approval "41 of 186 cr used". Null without a ceiling. */
export function fixLine(model: Pick<PlanModel, "ceiling" | "used">): string | null {
  if (model.ceiling == null) return null;
  if (model.used != null) return `${creditsText(model.used)} of ${creditsText(model.ceiling)} used · fixes up to 2 per shot`;
  return `Fixes if needed: up to 2 per shot, within ${creditsText(model.ceiling)}`;
}

/** "1,907 cr left after", or "Short by 26 cr"; null when the balance is unknown. */
export function balanceLine(model: Pick<PlanModel, "balance">): string | null {
  const b = model.balance;
  if (!b) return null;
  if (b.short != null) return `Short by ${creditsText(b.short)}`;
  return b.after == null ? null : `${creditsText(b.after)} left after`;
}

/* ── The card's box ──────────────────────────────────────────────────────── */

/** The plan card's width on the board: the master's approval card (340). */
export const PLAN_CARD_WIDTH = 340;

/**
 * The card's height before it renders (the board lays cards out from their sizes). Generous by design: the card
 * draws only what it needs and the box keeps a little air below it, so text that wraps never meets the next card.
 * Counted from the run alone: the lines the card may carry (the fix allowance and balance, the way renders ask,
 * a note), and each step's row when the steps are unfolded or the run is past its proposal.
 */
export function planCardHeight(run: Pick<RigAgentRunView, "state" | "paid" | "reason">, unfolded: boolean): number {
  const takes = run.paid.filter((p) => p.tool === "render").length;
  const proposal = run.state === "awaiting_approval";
  const lines = (chars: number) => Math.ceil(chars / 40);
  let height = 28 + 22 + lines(80) * 21 + 10 + 30;
  height += 10 + lines(52) * 21;
  if (run.reason && !proposal) height += 10 + lines(run.reason.length) * 21;
  if (proposal) height += 10 + 21 * 2 + 10 + 18;
  if (takes && (unfolded || !proposal)) height += takes * 64 + 36;
  /* A money state (./money-state.ts): its line and the rest's line at the gate; the budget's bar and three rows when paused. */
  if (takes) height += proposal ? 52 : run.state === "needs_you" ? 10 + 21 + 14 + 3 * 36 : 0;
  return Math.ceil(height / 4) * 4;
}

/** The sample's plan as the box sizing reads a run: a proposal with a render per step. */
export function shapeOfSample(sample: PlanModel | undefined): Pick<RigAgentRunView, "state" | "paid" | "reason"> {
  return {
    state: "awaiting_approval", reason: null,
    paid: (sample?.steps ?? []).map((s) => ({
      seq: s.seq, tool: "render" as const, title: s.title, state: "next" as const, quote: null, worst: null, pause: null, charged: null,
      outcome: null, charge: null, reason: null, canRender: false, fingerprint: null,
    })),
  };
}
