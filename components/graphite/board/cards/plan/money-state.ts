import { creditsText, exact, priceSum, priceWords, type PriceValue } from "@/lib/shell/price-words";
import type { PlanModel, PlanStep } from "./model";

/*
 * The plan card's money states (design Gaps B, "Money states on the board", with the owner's corrections of 6 Oct),
 * as the code does them on release/1. Pure: the card draws what this says, and the unit specs hold it to the rules.
 *
 *  - short:       the plan's renders come to more than the balance. Approve waits; "Top up" beside it opens
 *                 Settings › Plan & credits (a person asks for credits there; nothing is bought from the board).
 *  - admin:       a step is over the workspace's per-shot cap (lib/approvalRule.ts, 50 cr unless an admin changed it)
 *                 and the viewer is not an admin. "Ask an admin" tells the owner and admins; "Approve the rest" leaves
 *                 that step out: it waits for an admin.
 *  - unavailable: a step's engine can't be priced (the server's reason, e.g. no key). "Move Shot N to <engine>" when
 *                 another engine of the plan prices it (the server's quote, free to move), or approve the rest.
 *  - failed:      a render of the run failed. "Nothing billed" only where the ledger says the provider billed
 *                 nothing; otherwise what it charged, or that it isn't known yet. The take's own card carries Retry.
 *  - paused:      the next render reaches the pause at a share of the production's budget (Settings › Spending
 *                 rules: 80 % unless an admin changed it). An admin's unlock lets it past the cap, never past the ask. "Continue · N cr" is that render's own tap at its price,
 *                 or Stop.
 *
 * Every figure is the server's (the plan model's prices, the budget read, the pack list); this only adds them up
 * through price-words and words them. On release/1 Approve is the run's approval and each render then asks at its
 * price (lead decision 27), so Approve carries no figure; `approvePriced` is where plan approval (#555) puts the
 * total on it ("Approve the rest · 50 cr").
 */

export type BudgetRead = { cap: number; used: number; warnPct: number; pauseAt: number | null; unlocked: boolean };
/** Another engine for an unavailable step: its label and the server's quote for the step on it. */
export type MoveOffer = { seq: number; engine: string; engineLabel: string; price: PriceValue | null; nodeId?: string };

export type MoneyState =
  | { kind: "short"; line: string; topUp: string }
  | { kind: "admin"; line: string; seqs: number[]; restLine: string | null; approveLabel: string; rest: PriceValue | null }
  | { kind: "unavailable"; line: string; seq: number; restLine: string | null; approveLabel: string; rest: PriceValue | null; move: { label: string; price: PriceValue; seq: number; engine: string } | null }
  | { kind: "failed"; line: string; seq: number; nothingBilled: boolean }
  | {
      kind: "paused"; title: string; sub: string; line: string; fraction: number;
      rows: { name: string; value: string }[]; continueLabel: string; price: PriceValue; seq: number;
    };

export type MoneyInput = {
  model: PlanModel;
  /** The viewer is the owner or an admin (they press over the cap themselves). */
  admin: boolean;
  /** The workspace's per-shot cap when its rule is "cap", else null. */
  shotCap: number | null;
  /** The production's budget as the gate reckons it (GET /api/workbench/budget); null without one. */
  budget: BudgetRead | null;
  /** "Top up · 500 cr · $50": the smallest pack the platform sells (GET /api/workspaces/topups), or plain "Top up". */
  topUp: string;
  move?: MoveOffer | null;
  /** Plan approval (#555) puts the total on Approve; false on release/1. */
  approvePriced?: boolean;
};

const shotWord = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "shot" : "shots"}`;
const counted = (s: PlanStep) => s.state !== "skipped";
/** What the steps in `list` come to, from their own (server) prices; null while one has none. */
function sumOf(list: readonly PlanStep[]): PriceValue | null {
  if (!list.length) return null;
  return list.every((s) => s.price) ? priceSum(list.map((s) => s.price)) : null;
}

export function planMoneyState(input: MoneyInput): MoneyState | null {
  const { model } = input;
  if (model.phase === "proposal") {
    if (model.balance?.short != null) return { kind: "short", line: `Short by ${creditsText(model.balance.short)}`, topUp: input.topUp };
    const over = model.steps.filter((s) => counted(s) && s.needsAdmin);
    if (over.length && !input.admin) {
      const rest = model.steps.filter((s) => counted(s) && !s.needsAdmin && !s.unavailable);
      const restPrice = sumOf(rest);
      const names = over.map((s) => s.title).join(", ");
      const cap = input.shotCap != null ? `over ${creditsText(input.shotCap)} a shot` : "over the per-shot cap";
      return {
        kind: "admin", line: `${names} ${over.length === 1 ? "is" : "are"} ${cap} · needs an admin`, seqs: over.map((s) => s.seq),
        restLine: rest.length && restPrice ? `The rest: ${shotWord(rest.length)} · ${priceWords(restPrice)}` : null,
        approveLabel: approve("Approve the rest", restPrice, input.approvePriced), rest: restPrice,
      };
    }
    const gone = model.steps.find((s) => counted(s) && s.unavailable);
    if (gone) {
      const rest = model.steps.filter((s) => counted(s) && !s.unavailable);
      const restPrice = sumOf(rest);
      const offer = input.move && input.move.seq === gone.seq && input.move.price ? input.move : null;
      return {
        kind: "unavailable", line: gone.unavailable!.replace(/^Unavailable · /, `${gone.title} can't render · `), seq: gone.seq,
        restLine: rest.length && restPrice ? `The rest: ${shotWord(rest.length)} · ${priceWords(restPrice)}` : null,
        approveLabel: approve(rest.length ? `Approve ${shotWord(rest.length)}` : "Approve", restPrice, input.approvePriced), rest: restPrice,
        move: offer ? { label: `Move ${gone.title} to ${offer.engineLabel} · ${priceWords(offer.price)}`, price: offer.price!, seq: gone.seq, engine: offer.engine } : null,
      };
    }
    return null;
  }

  if (model.phase === "needs-you" && model.primary?.kind === "render" && model.primary.price && input.budget && !(input.budget.unlocked && input.budget.used >= input.budget.cap)) {
    const b = input.budget;
    const price = model.primary.price;
    const next = model.steps.find((s) => s.seq === (model.primary as { seq: number }).seq);
    const needs = price.kind === "free" ? 0 : Math.ceil(price.credits - 1e-9);
    if (b.pauseAt != null && b.used + needs >= b.pauseAt) {
      const words = priceWords(price)!;
      return {
        kind: "paused", title: `Paused at ${b.warnPct} % of the budget`, sub: `${b.used.toLocaleString("en-US", { maximumFractionDigits: 1 })} of ${creditsText(b.cap)} used`,
        line: `${next?.title ?? "The next shot"} waits · ${words} more`, fraction: Math.max(0, Math.min(1, b.used / b.cap)),
        rows: [
          { name: "Used", value: creditsText(b.used) },
          { name: "Next", value: [next?.title, next?.meta, words].filter(Boolean).join(" · ") },
          { name: "Budget", value: `${creditsText(b.cap)} · change in Settings › Spending rules` },
        ],
        continueLabel: `Continue · ${words}`, price, seq: model.primary.seq,
      };
    }
  }

  {
    const failed = model.steps.find((s) => s.state === "failed");
    if (failed) {
      const nothing = failed.status === "Failed · nothing billed";
      /* Charged only where the ledger says the provider charged it; anything else is not known yet. */
      const charged = failed.status === "Failed · charged" && failed.price && failed.price.kind !== "free" ? priceWords(failed.price) : null;
      return {
        kind: "failed", seq: failed.seq, nothingBilled: nothing,
        line: `${failed.title} failed · ${nothing ? "Nothing billed" : charged ? `charged ${charged}` : "what it was charged isn't known yet"}`,
      };
    }
  }
  return null;
}

function approve(label: string, price: PriceValue | null, priced = false): string {
  const words = priced && price ? priceWords(price) : null;
  return words ? `${label} · ${words}` : label;
}

/** The figure a quote gives a move: the server's credits, exact. */
export const movePrice = (credits: number | null | undefined): PriceValue | null => exact(credits);
