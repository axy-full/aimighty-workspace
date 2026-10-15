/**
 * The one way Particl words a price (CLAUDE.md rule 14; design/particl-graphite/README.md § 5).
 *
 *  - "43 cr": a figure the server quoted exactly (the rate card, through the server's price path);
 *  - "up to 69 cr": a live estimate the charge cannot go over;
 *  - "free": nothing to pay.
 *
 * Hovering a price shows its dollar value at the server's credit rate: `rates.creditUsd` in the
 * session, which the server fills from `creditUsd()` (lib/rateTable.server.ts). No rate is typed
 * here, so an unknown rate means no dollars rather than a guessed one.
 *
 * Pure: no React, no fetch, no figure invented. A figure comes from the server; this only words it.
 * components/graphite/Price.tsx draws it, with the dollars on hover. Every screen words its prices
 * through these two, and none formats a price by hand.
 *
 * Never the bare word "quoted", and never "about". Cinema Studio's "about N cr, at most 3N cr" is
 * its own wording (PR #523), not a kind here.
 */

import { dollars } from "../format";

export type PriceKind = "exact" | "up-to" | "free";

/**
 * `usd` is the same figure in the engines' dollars, where the server gave one: the house workspace (lib/houseWorkspace.ts) pays at cost in dollars and reads it
 * (`DollarMode` below); every other workspace reads the credits and never sees `usd`. `capped` marks a limit, ceiling or hold the plan keeps in credits: in dollar
 * mode it reads at the public price of a credit (the at-cost figure for the house). A quote with neither has no dollar figure to show there, and reads "—".
 */
export type PriceValue =
  | { kind: "exact"; credits: number; usd?: number; capped?: true }
  | { kind: "up-to"; credits: number; usd?: number; capped?: true }
  | { kind: "free" };

export const FREE: PriceValue = Object.freeze({ kind: "free" });

const EPSILON = 1e-9;
const usable = (credits: unknown): credits is number => typeof credits === "number" && Number.isFinite(credits) && credits >= 0;

/**
 * A price from a server figure and its kind, or null when the figure is missing or is not a figure
 * (NaN, negative, infinite). Null means "show no price": never a zero, a guess or a placeholder.
 */
export function priceValue(credits: number | null | undefined, kind: Exclude<PriceKind, "free">, usd?: number | null): PriceValue | null {
  if (!usable(credits)) return null;
  const dollars = usable(usd) ? { usd } : {};
  return kind === "up-to" ? { kind: "up-to", credits, ...dollars } : { kind: "exact", credits, ...dollars };
}

/** A figure the server quoted exactly (`usd`: the same in the engines' dollars, for the house). */
export const exact = (credits: number | null | undefined, usd?: number | null): PriceValue | null => priceValue(credits, "exact", usd);
/** A limit, ceiling or hold kept in credits (an approved plan's total): in the house it reads at the public price of a credit, its dollars at cost. */
export const heldExact = (credits: number | null | undefined): PriceValue | null => { const v = priceValue(credits, "exact"); return v && v.kind !== "free" ? { ...v, capped: true } : v; };
export const heldUpTo = (credits: number | null | undefined): PriceValue | null => { const v = priceValue(credits, "up-to"); return v && v.kind !== "free" ? { ...v, capped: true } : v; };
/** A live estimate the charge cannot go over (`usd`: the same in the engines' dollars, for the house). */
export const upTo = (credits: number | null | undefined, usd?: number | null): PriceValue | null => priceValue(credits, "up-to", usd);

/* ── The house reads dollars ──────────────────────────────────────────────── */

/**
 * The house workspace pays at cost in dollars, so every price on every screen reads in dollars there (owner, 13 Oct: one screen, one unit). Which unit a workspace pays in
 * is `rates.unit` in its session (lib/session.tsx), and `modeOf` turns that into a mode.
 *
 * The mode is carried, never shared: the components that word a price (components/graphite/Price.tsx) read it from their own session and pass it down, so two renders at
 * the same moment, a customer's and the house's, cannot see each other's. The words with no mode passed read the BROWSER's mode, set once by the session provider in the
 * browser (`setDollarDisplay`, a no-op on the server, where nothing is shared between requests): on the server they read credits.
 *
 * With dollars on, a price words its own `usd` where the server gave one; a limit, ceiling or hold (`capped`) words its credits at the public price of a credit, which is
 * its dollars at cost; a quote with neither has no dollar figure and reads "—" (never its credits times a credit's price). Display only: nothing here changes what is
 * quoted, held or billed.
 */
export type DollarMode = { readonly on: boolean; readonly creditUsd: number | null };
export const CREDITS_MODE: DollarMode = Object.freeze({ on: false, creditUsd: null });
/** The mode a session's rates say: dollars when the workspace pays at cost (`unit: "usd"`). */
export function modeOf(rates: { unit?: string | null; creditUsd?: number | null } | null | undefined): DollarMode {
  return rates?.unit === "usd" ? { on: true, creditUsd: creditRate(rates.creditUsd) } : CREDITS_MODE;
}

let browserMode: DollarMode = CREDITS_MODE;
/** The browser's mode, from its session. Never writes on the server: concurrent server renders share one module, so nothing a render sets may outlive it. */
export function setDollarDisplay(on: boolean, creditUsd?: number | null): void {
  if (typeof window === "undefined") return;
  browserMode = on ? { on: true, creditUsd: creditRate(creditUsd) } : CREDITS_MODE;
}
export const dollarDisplay = (): boolean => (typeof window === "undefined" ? false : browserMode.on);
const modeNow = (): DollarMode => (typeof window === "undefined" ? CREDITS_MODE : browserMode);

/** The shown line when the house has no dollar figure for a quote yet (houseAtCostPrice.spec's rule: never the customer price turned into dollars). */
export const NO_AT_COST_FIGURE = "—";
export const NO_AT_COST_TITLE = "Priced at cost once the engine's price is read.";

/** A price's dollars: its own, else (a limit, ceiling or hold) its credits at the credit's price; null when neither is known. */
function dollarsOf(value: Exclude<PriceValue, { kind: "free" }>, mode: DollarMode): number | null {
  if (usable(value.usd)) return value.usd;
  return value.capped && mode.creditUsd !== null ? value.credits * mode.creditUsd : null;
}

/** Whether `value` is a price this module can word: guards a shape read off the wire. */
export function isPriceValue(value: unknown): value is PriceValue {
  if (!value || typeof value !== "object") return false;
  const v = value as { kind?: unknown; credits?: unknown };
  if (v.kind === "free") return true;
  return (v.kind === "exact" || v.kind === "up-to") && usable(v.credits);
}

/**
 * The credits to show. An exact figure is the server's own, to the tenth (the finest unit the code
 * counts in, lib/runLimit.ts). A ceiling rounds up to a whole credit, because every job is charged in
 * whole credits rounded up (CLAUDE.md § Pricing): an "up to" figure must never read below what that
 * rounding could charge.
 */
function shownCredits(value: PriceValue): number {
  if (value.kind === "free") return 0;
  if (value.kind === "up-to") return Math.ceil(value.credits - EPSILON);
  const tenths = Math.round(value.credits * 10);
  /* Only a true zero is "free": a charge under a twentieth of a credit still reads 0.1 cr. */
  return (tenths === 0 && value.credits > 0 ? 1 : tenths) / 10;
}

/** "1,234 cr": a count of credits, grouped en-US, at most one decimal. */
export function creditsText(credits: number, mode: DollarMode = modeNow()): string {
  /* The house reads dollars: a count of credits here is a limit, ceiling or balance, at the public price of a credit (its dollars at cost). */
  if (mode.on && mode.creditUsd !== null && Number.isFinite(credits)) return dollars(credits * mode.creditUsd);
  return `${credits.toLocaleString("en-US", { maximumFractionDigits: 1 })} cr`;
}

/** "43 cr", "up to 69 cr" or "free"; null when there is no price to show. A figure of 0 is "free". */
export function priceWords(value: PriceValue | null | undefined, mode: DollarMode = modeNow()): string | null {
  if (!isPriceValue(value)) return null;
  if (mode.on) {
    if (value.kind === "free") return "free";
    const usd = dollarsOf(value, mode);
    if (usd === null) return NO_AT_COST_FIGURE;
    if (usd === 0) return "free";
    return value.kind === "up-to" ? `up to ${dollars(usd)}` : dollars(usd);
  }
  const credits = shownCredits(value);
  if (value.kind === "free" || credits === 0) return "free";
  return value.kind === "up-to" ? `up to ${creditsText(credits)}` : creditsText(credits);
}

/** A usable credit rate, or null: missing, zero (the session's "not known yet") or nonsense means no dollars. */
export function creditRate(creditUsd: number | null | undefined): number | null {
  return typeof creditUsd === "number" && Number.isFinite(creditUsd) && creditUsd > 0 ? creditUsd : null;
}

/**
 * "$4.30": `credits` at `creditUsd` a credit, or null without a usable rate. `up` rounds the cents
 * up, for a ceiling; otherwise to the nearest cent.
 */
export function creditsUsd(credits: number, creditUsd: number | null | undefined, up = false): string | null {
  const rate = creditRate(creditUsd);
  if (rate === null || !usable(credits)) return null;
  const raw = credits * rate * 100;
  /* 43 × 0.1 is 4.3000000000000001 in floating point: rounding the cents up must not read it as $4.31. */
  const cents = up ? Math.ceil(raw - 1e-6) : Math.round(raw);
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The hover for a price: "$4.30", "up to $6.90", or null. It is null for "free", and for any price
 * while the rate is unknown.
 */
export function priceTitle(value: PriceValue | null | undefined, creditUsd: number | null | undefined, mode: DollarMode = modeNow()): string | null {
  if (!isPriceValue(value) || value.kind === "free") return null;
  /* The house's price is already dollars: its hover says what it pays (the new interface's Price says the same), or why there is no figure yet. */
  if (mode.on) { const usd = dollarsOf(value, mode); return usd === null ? NO_AT_COST_TITLE : usd === 0 ? null : "Pays at cost"; }
  const credits = shownCredits(value);
  if (credits === 0) return null;
  const usd = creditsUsd(credits, creditUsd, value.kind === "up-to");
  if (usd === null) return null;
  return value.kind === "up-to" ? `up to ${usd}` : usd;
}

/** What components/graphite/Price.tsx draws: the words, the hover, and the kind as shown ("free" for a zero). */
export type PriceView = { text: string; title: string | null; kind: PriceKind };

/** Price's drawing for `value` at `creditUsd` a credit, or null when there is no price to draw. */
export function priceView(value: PriceValue | null | undefined, creditUsd: number | null | undefined, mode: DollarMode = modeNow()): PriceView | null {
  const text = priceWords(value, mode);
  if (text === null || !value) return null;
  return { text, title: priceTitle(value, creditUsd, mode), kind: text === "free" ? "free" : value.kind };
}

/**
 * The total of several prices, as a plan or a batch approval shows it. Any estimate in it makes the
 * total "up to". Every part free makes it "free". Each part counts as it is shown (an estimate at its
 * whole-credit ceiling), summed in tenths so 0.1 + 0.2 stays 0.3. Null when the list is empty or holds
 * a part that is not a price: a total is never shown short.
 */
export function priceSum(values: readonly (PriceValue | null | undefined)[]): PriceValue | null {
  if (!values.length || !values.every(isPriceValue)) return null;
  let tenths = 0;
  let estimate = false;
  let cents = 0;
  let allDollars = true;
  let allCapped = true;
  for (const value of values as readonly PriceValue[]) {
    if (value.kind === "free") continue;
    if (value.kind === "up-to") estimate = true;
    tenths += Math.round(shownCredits(value) * 10);
    if (usable(value.usd)) cents += Math.round(value.usd * 1e6); else allDollars = false;
    if (!value.capped) allCapped = false;
  }
  if (tenths === 0) return FREE;
  return { kind: estimate ? "up-to" : "exact", credits: tenths / 10, ...(allDollars ? { usd: cents / 1e6 } : allCapped ? { capped: true as const } : {}) };
}

/**
 * How many credits `balance` is short of `value`, or null when it covers it or either is unknown.
 * For an estimate, the shortfall is against its ceiling.
 */
export function shortBy(balance: number | null | undefined, value: PriceValue | null | undefined): number | null {
  if (typeof balance !== "number" || !Number.isFinite(balance) || !isPriceValue(value) || value.kind === "free") return null;
  const short = shownCredits(value) - balance;
  if (short <= EPSILON) return null;
  /* Rounded up to the tenth: a shortfall is never shown smaller than it is. */
  return Math.ceil(short * 10 - EPSILON) / 10;
}

/** "Short by 3 cr", or null when the balance covers the price or either is unknown. */
export function shortByWords(balance: number | null | undefined, value: PriceValue | null | undefined): string | null {
  const short = shortBy(balance, value);
  return short === null ? null : `Short by ${creditsText(short)}`;
}
