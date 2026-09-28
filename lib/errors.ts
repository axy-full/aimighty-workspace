/**
 * Typed failures, one clear next step each (idea 15): a failure kind maps to
 * what happened and what to do, and a take's failure line reads
 *
 *   what happened · what the provider did with the charge · the next step
 *
 * "Refused by the content filter · Higgsfield refunded 12 credits · Change the
 * prompt or reference", in the card contract's words (lib/workspace/takes.ts
 * failureReason): one vocabulary for a take that failed. The charge part is
 * the provider's own outcome (lib/providerOutcome.ts) in its own unit — or,
 * where the workspace pays Particl in credits, what Particl's ledger holds
 * for the take. It says "didn't say" whenever the provider did not; it never
 * infers a refund.
 *
 * Pure and client-safe.
 */
import { PROVIDER_NAME, type FailureKind, type OutcomeProvider, type ProviderBilling, type TakeCharge, type TakeFailure } from "./providerOutcome";

export type FailurePayer = TakeFailure["payer"];
type Copy = { what: string; next: string };

const COPY: Record<FailureKind, Copy> = {
  content_filter: { what: "Refused by the content filter", next: "Change the prompt or reference" },
  rights: { what: "Refused as protected content", next: "Change the prompt or reference" },
  invalid_request: { what: "The engine refused these settings", next: "Check the settings" },
  auth: { what: "The engine refused the connection", next: "Reconnect in Workspace › Engines" },
  provider_quota: { what: "The engine account is out of credits", next: "Top up the engine account" },
  rate_limited: { what: "The engine was busy", next: "Render again in a moment" },
  timeout: { what: "The engine timed out", next: "Render again" },
  canceled: { what: "Canceled", next: "Render again" },
  provider_error: { what: "The engine hit an error", next: "Render again" },
  no_answer: { what: "The engine never confirmed it", next: "It won't be sent again" },
  not_kept: { what: "Finished, but the result couldn't be kept", next: "Its receipt is saved" },
  unknown: { what: "Did not render", next: "Render again" },
};

/**
 * What happened and the one thing to do. A key the platform holds is not the
 * customer's to reconnect or top up; the connected account is its owner's.
 */
export function failureCopy(kind: FailureKind, payer: FailurePayer = null): Copy {
  const copy = COPY[kind] ?? COPY.unknown;
  if (kind === "auth" || kind === "provider_quota") {
    if (payer === "platform") return { what: copy.what, next: "Try again later" };
    if (payer === "account")
      return kind === "auth" ? { what: copy.what, next: "Reconnect in Workspace › Engines" } : { what: "The Higgsfield account is out of credits", next: "Top up the Higgsfield account" };
  }
  return copy;
}

/** A provider amount in its own unit: "12 credits", "$0.05", "1,290 tokens". */
export function billingAmount(billing: Pick<ProviderBilling, "amount" | "unit">): string | null {
  if (billing.amount == null || !billing.unit) return null;
  const n = billing.amount;
  if (billing.unit === "usd") return `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
  if (billing.unit === "tokens") return `${Math.round(n).toLocaleString("en-US")} tokens`;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 8 })} ${n === 1 ? "credit" : "credits"}`;
}

/** What the provider did with the charge, in its own words: refunded, charged, didn't charge, or didn't say. */
export function billingSentence(billing: ProviderBilling, provider: OutcomeProvider | null): string {
  const name = provider ? PROVIDER_NAME[provider] : "The provider";
  const amount = billingAmount(billing);
  switch (billing.state) {
    case "refunded": return amount ? `${name} refunded ${amount}` : `${name} refunded it`;
    case "billed": return amount ? `${name} charged ${amount}` : `${name} charged for it`;
    case "not_charged": return `${name} didn't charge`;
    default: return `${name} didn't say if it charged`;
  }
}

/** What Particl's own ledger holds for a failed take, in credits. */
export function chargeSentence(charge: TakeCharge): string {
  if (!charge.settled) return charge.credits > 0 ? `${fmt(charge.credits)} cr held` : "Settling";
  return charge.credits > 0 ? `${fmt(charge.credits)} cr charged` : "Not billed";
}
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export type FailureLine = { what: string; charge: string | null; next: string; detail: string | null; text: string };

/**
 * The line a card, the Inspector and the ledger print for a failed take.
 * `detail` is the provider's own words when they say more than `what` (a
 * refused setting's field message, for instance).
 */
export function failureLine(failure: TakeFailure, options: { cancelled?: boolean } = {}): FailureLine {
  const copy = options.cancelled && failure.kind === "unknown" ? { what: "Cancelled", next: "Render again" } : failureCopy(failure.kind, failure.payer);
  const charge = failure.charge ? chargeSentence(failure.charge) : failure.billing ? billingSentence(failure.billing, failure.provider) : null;
  const detail = failure.message && failure.message.toLowerCase() !== copy.what.toLowerCase() ? failure.message : null;
  return { what: copy.what, charge, next: copy.next, detail, text: [copy.what, charge, copy.next].filter(Boolean).join(" · ") };
}

/**
 * The short status for a chip: "Failed · refunded", "Failed · not billed"
 * (Particl's ledger), "Failed · charged", or just "Failed" when nothing is
 * confirmed. No provider name, no amount: the line beside it carries those.
 */
export function failedChip(failure: TakeFailure | null | undefined, cancelled = false): string {
  const word = cancelled ? "Cancelled" : "Failed";
  if (!failure) return word;
  if (failure.charge) return failure.charge.settled ? `${word} · ${failure.charge.credits > 0 ? "charged" : "not billed"}` : word;
  switch (failure.billing?.state) {
    case "refunded": return `${word} · refunded`;
    case "not_charged": return `${word} · not charged`;
    case "billed": return `${word} · charged`;
    default: return word;
  }
}

/** True only when a ledger or a provider confirms nothing was kept for the take. */
export function failureUncharged(failure: TakeFailure | null | undefined): boolean {
  if (!failure) return false;
  if (failure.charge) return failure.charge.settled && failure.charge.credits <= 0;
  return failure.billing?.state === "refunded" || failure.billing?.state === "not_charged";
}

/** A failed take's charge in a word or two for a tight meta line ("not billed", "12 cr", "refunded"), or null when unconfirmed. */
export function failureChargeWord(failure: TakeFailure | null | undefined): string | null {
  if (!failure) return null;
  if (failure.charge) return failure.charge.settled ? (failure.charge.credits > 0 ? `${fmt(failure.charge.credits)} cr` : "not billed") : null;
  switch (failure.billing?.state) {
    case "refunded": return "refunded";
    case "not_charged": return "not charged";
    case "billed": return "charged";
    default: return null;
  }
}
