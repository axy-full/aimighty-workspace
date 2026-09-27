import { billCreditsWith, creditUsd, marginFor, marginKeyOf } from "./creditTerms";

/** Private terms captured when a job reserves its budget. Never serialize these to a customer. */
export type BillingTerms = { creditUsd: number; margin: number };
type StoredTerms = Record<string, unknown>;

const positive = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export function currentBillingTerms(kind: string, model: string): BillingTerms {
  return { creditUsd: creditUsd(), margin: marginFor(marginKeyOf(kind, model)) };
}

/** Missing snapshots belong to jobs admitted before snapshot support. */
export function recordedBillingTerms(row: StoredTerms, kind: string, model: string): BillingTerms {
  return {
    creditUsd: positive(row.credit_usd) ?? 0.10,
    margin: positive(row.credit_margin) ?? marginFor(marginKeyOf(kind, model)),
  };
}

export function creditsAtTerms(cost: number, terms: BillingTerms): number {
  return billCreditsWith(cost, terms.margin, terms.creditUsd);
}
