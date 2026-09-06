/**
 * The credit: the platform's own unit of spend.
 *
 * One credit is ten cents of vendor cost by default (CREDIT_USD). A
 * workspace on the platform's keys buys and burns credits, never dollars:
 * a job is charged in whole credits, rounded up, and nothing that costs the
 * platform money costs a workspace less than one credit. Batches multiply
 * before they round.
 *
 * The margin sits between what the vendor charges and what the workspace
 * pays, per engine, so headline prices land on round numbers (a 5-second
 * Seedance 1080p shot is 40 credits, a Kling shot 6, a still 2). The table
 * below is the one agreed on 6 September 2026; CREDIT_MARGINS, a JSON
 * object of the same shape, overrides any entry. SIGNUP_CREDITS is what a
 * workspace starts with the day it signs up.
 *
 * No imports, so both the platform record and the tenant code — and the
 * browser, for the price on a button — can read the terms without pulling
 * anything else in.
 */
export function creditUsd(): number {
  const n = Number(process.env.CREDIT_USD ?? 0.10);
  return Number.isFinite(n) && n > 0 ? n : 0.10;
}

export function signupCredits(): number {
  const n = Number(process.env.SIGNUP_CREDITS ?? 250);
  return Number.isFinite(n) && n >= 0 ? n : 250;
}

/** Margin over vendor cost, by engine id; "*" is the fallback. */
export const DEFAULT_MARGINS: Record<string, number> = {
  "*": 1.4,
  "dreamina-seedance-2-5-260628": 1.39,
  "dreamina-seedance-2-0-260128": 1.32,
  "fal-ai/kling-video/v3/standard": 1.42,
  "fal-ai/kling-video/v3/pro": 1.42,
  "topaz/upscale/video/creative": 1.33,
  "gemini-3-pro-image": 1.49,
  "gemini-3.1-flash-image": 1.49,
  "fal-ai/flux-lora": 1.5,
  "identity-training": 1.38,
  "elevenlabs": 1.25,
  "text": 1.0,
};

let _margins: Record<string, number> | null = null;
export function margins(): Record<string, number> {
  if (_margins) return _margins;
  let over: Record<string, unknown> = {};
  try { over = JSON.parse(process.env.CREDIT_MARGINS ?? "{}") as Record<string, unknown>; } catch { over = {}; }
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(over ?? {})) if (typeof v === "number" && v > 0) clean[k] = v;
  _margins = { ...DEFAULT_MARGINS, ...clean };
  return _margins;
}

export function marginFor(engine: string | null | undefined, table: Record<string, number> = margins()): number {
  const m = engine ? table[engine] : undefined;
  return typeof m === "number" && m > 0 ? m : (table["*"] ?? 1);
}

/** What a job is charged: whole credits, rounded up, at least one. Pure, for the browser too. */
export function billCreditsWith(usd: number, margin: number, perCredit: number): number {
  if (!(usd > 0)) return 0;
  return Math.max(1, Math.ceil((usd * margin) / perCredit - 1e-9));
}

export function billCredits(usd: number, engine?: string | null): number {
  return billCreditsWith(usd, marginFor(engine), creditUsd());
}

/** The unrounded figure, for a running total. */
export const usdToCredits = (usd: number, engine?: string | null): number => (usd * marginFor(engine)) / creditUsd();
/** Dollars of vendor cost a number of credits buys at no margin. */
export const creditsToUsd = (credits: number): number => credits * creditUsd();

/** What the client needs to show and convert prices. */
export type CreditState = {
  creditUsd: number;
  margins: Record<string, number>;
  granted: number;
  used: number;
  balance: number;
};
