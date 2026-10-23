import { creditsText, exact, priceSum, priceWords, type PriceValue } from "@/lib/shell/price-words";
import type { PlanModel, PlanPrimary, PlanStep } from "./model";

/*
 * The plan card's money states (design Gaps B, "Money states on the board", with the owner's corrections of 6 Oct),
 * as the code does them on release/1. Pure: the card draws what this says, and the unit specs hold it to the rules.
 *
 *  - short:       the plan's renders come to more than the balance. Approve waits; "Top up" beside it opens
 *                 Settings › Plan & credits (a person asks for credits there; nothing is bought from the board).
 *  - unavailable: a step's engine can't be priced (the server's reason, e.g. no key). "Move Shot N to <engine>" when
 *                 another engine of the plan prices it (the server's quote, free to move), or approve the rest.
 *  - failed:      a render of the run failed. "Nothing billed" only where the ledger says the provider billed
 *                 nothing; otherwise what it charged, or that it isn't known yet. The take's own card carries Retry.
 *
 * Gone on 21 Oct 2026 (owner): the "admin" state (a step over the workspace's per-shot cap, "Ask an admin") went with the
 * admin approval rule, and the "paused" state (the Paused card at 80 % of the budget) goes: "The monthly limit
 * stays as a mechanism, off by default, owner-only, no Paused card." A render that waits, waits on its own price and tap.
 *
 * Every figure is the server's (the plan model's prices, the pack list); this only adds them up
 * through price-words and words them. On release/1 Approve is the run's approval and each render then asks at its
 * price (lead decision 27), so Approve carries no figure; `approvePriced` is where plan approval (#555) puts the
 * total on it ("Approve the rest · 50 cr").
 */

/** Another engine for an unavailable step: its label and the server's quote for the step on it. */
export type MoveOffer = { seq: number; engine: string; engineLabel: string; price: PriceValue | null; nodeId?: string };

export type MoneyState =
  | { kind: "short"; line: string; topUp: string }
  | { kind: "unavailable"; line: string; seq: number; restLine: string | null; approveLabel: string; rest: PriceValue | null; move: { label: string; price: PriceValue; seq: number; engine: string } | null }
  | { kind: "failed"; line: string; seq: number; nothingBilled: boolean };

export type MoneyInput = {
  model: PlanModel;
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

/**
 * What the plan gate's budget line (GET /api/workbench/budget with the run) is read again for: the plan's quote (its
 * fingerprint, so a re-priced plan) and what the run has used and holds (so spend that moved). Null off the gate.
 */
export function planLineKey(primary: PlanPrimary | null | undefined, money: { spent: number; inFlight: number } | null | undefined): string | null {
  if (primary?.kind !== "plan") return null;
  return `${primary.fingerprint}|${money ? `${money.spent}+${money.inFlight}` : "-"}`;
}

/** The figure a quote gives a move: the server's credits, exact. */
export const movePrice = (credits: number | null | undefined, usd?: number | null): PriceValue | null => exact(credits, usd);
