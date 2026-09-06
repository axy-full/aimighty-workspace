/**
 * The credit: the platform's own unit of spend.
 *
 * One credit is ten cents of vendor cost by default (CREDIT_USD), and a
 * workspace on the platform's keys buys and burns credits rather than
 * dollars — 4.2 credits for a 5-second Kling shot, 0.03 for a line of
 * text. CREDIT_MARKUP is the margin on top of vendor cost: 1 means credits
 * are sold at cost, 1.5 means a $1.00 render burns 15 credits. SIGNUP_CREDITS
 * is what a workspace starts with the day it signs up.
 *
 * No imports, so both the platform record and the tenant code can read the
 * terms without pulling each other in.
 */
export function creditUsd(): number {
  const n = Number(process.env.CREDIT_USD ?? 0.10);
  return Number.isFinite(n) && n > 0 ? n : 0.10;
}

export function creditMarkup(): number {
  const n = Number(process.env.CREDIT_MARKUP ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function signupCredits(): number {
  const n = Number(process.env.SIGNUP_CREDITS ?? 250);
  return Number.isFinite(n) && n >= 0 ? n : 250;
}

/** Credits for a vendor cost in dollars. */
export const usdToCredits = (usd: number): number => (usd * creditMarkup()) / creditUsd();
/** Dollars of vendor cost a number of credits buys. */
export const creditsToUsd = (credits: number): number => (credits * creditUsd()) / creditMarkup();

/** What the client needs to show and convert prices. */
export type CreditState = {
  creditUsd: number;
  markup: number;
  granted: number;
  used: number;
  balance: number;
};
