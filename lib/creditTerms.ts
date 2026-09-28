/**
 * The credit: the platform's own unit of spend.
 *
 * One credit is US$0.80 by default (CREDIT_USD). A workspace on the
 * platform's keys buys and burns credits, never dollars: a job is charged in
 * tenths of a credit, rounded up, and nothing that costs the platform money
 * costs a workspace less than a tenth of a credit. Batches multiply before
 * they round. Money code counts in integer tenths ("decicredits", below), so
 * sums, refunds and settlements never drift.
 *
 * The margin sits between what the vendor charges and what the workspace
 * pays; its values are pricing policy (SOW §7A). At launch one rate covers
 * every engine, which is why the table below has a single entry.
 *
 * The table is keyed by engine anyway, and stays keyed by engine, because
 * §7A asks for exactly that: pricing one engine differently is a key added
 * here or an entry in CREDIT_MARGINS, a config change rather than a
 * refactor; nothing downstream has to change for that to work.
 *
 * It is one entry rather than fourteen identical ones on purpose. A table
 * of the same number repeated pretends there are fourteen decisions when
 * there was one, and every copy is a place for the launch rate to drift.
 *
 * This replaced a per-engine table dated 6 September whose prices
 * disagreed with §7A's rate card, so the card and the buttons disagreed.
 * The card is right.
 *
 * CREDIT_MARGINS, a JSON object of the same shape, overrides any entry.
 * SIGNUP_CREDITS is what a workspace starts with the day it signs up.
 *
 * No imports, so both the platform record and the tenant code — and the
 * browser, for the price on a button — can read the terms without pulling
 * anything else in.
 */
/**
 * What one credit sells for, in US dollars, when CREDIT_USD is not set: the
 * public price (SOW §7A). One place, so changing the price is one line.
 */
export const DEFAULT_CREDIT_USD = 0.80;

/** What a new workspace opens with when SIGNUP_CREDITS is not set (SOW §7A, Invite). */
export const DEFAULT_SIGNUP_CREDITS = 25;

/**
 * The unit every stored credit figure was recorded in when it carries no unit
 * of its own: the price before the US$0.80 credit. A snapshot or row written
 * from now on records its own `unitUsd`.
 */
export const LEGACY_CREDIT_USD = 0.10;

/**
 * Credits are charged in tenths. Money code counts integer tenths —
 * "decicredits" — and converts at the edges, so a figure in credits is always
 * a whole number of tenths and adding many of them never drifts.
 */
export const DECI_PER_CREDIT = 10;
/** Credits → integer tenths; exact for any figure that is already a whole number of tenths. */
export const toDeci = (credits: number): number => Math.round(credits * DECI_PER_CREDIT);
/** Integer tenths → credits. */
export const fromDeci = (deci: number): number => Math.round(deci) / DECI_PER_CREDIT;
/** A credit figure rounded UP to the next tenth, as tenths: a charge never rounds down. */
export const ceilDeci = (credits: number): number => Math.ceil(credits * DECI_PER_CREDIT - 1e-9);
/** A credit figure rounded DOWN to a tenth, as tenths: what is left, never more than there is. */
export const floorDeci = (credits: number): number => Math.floor(credits * DECI_PER_CREDIT + 1e-9);
/** A finite, non-negative figure that is a whole number of tenths. */
export function isCreditAmount(credits: unknown): credits is number {
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return false;
  const scaled = credits * DECI_PER_CREDIT;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * A credit figure as people read it: one decimal only when it isn't zero —
 * "12", "12.3", "1,250" — never more, and never shortened.
 */
export function creditsFigure(credits: number): string {
  const deci = toDeci(credits);
  const abs = Math.abs(deci);
  const whole = Math.floor(abs / DECI_PER_CREDIT);
  const tenth = abs % DECI_PER_CREDIT;
  const body = tenth === 0 ? whole.toLocaleString("en-US") : `${whole.toLocaleString("en-US")}.${tenth}`;
  return deci < 0 ? `-${body}` : body;
}

export function creditUsd(): number {
  const n = Number(process.env.CREDIT_USD ?? DEFAULT_CREDIT_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CREDIT_USD;
}

export function signupCredits(): number {
  const n = Number(process.env.SIGNUP_CREDITS ?? DEFAULT_SIGNUP_CREDITS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SIGNUP_CREDITS;
}

/**
 * Margin over vendor cost, by engine id; "*" is the fallback and, at
 * launch, the only entry. Add a key to price one engine differently.
 */
export const LAUNCH_MARGIN = 1.5;
export const DEFAULT_MARGINS: Record<string, number> = {
  "*": LAUNCH_MARGIN,
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

/** The margin key for a job: the engine id for renders, a class for the rest. */
export function marginKeyOf(kind: string | null | undefined, model: string | null | undefined): string {
  if (kind === "training") return "identity-training";
  if (kind === "audio") return "elevenlabs";
  if (kind === "text") return "text";
  return model || "*";
}

export function marginFor(engine: string | null | undefined, table: Record<string, number> = margins()): number {
  const m = engine ? table[engine] : undefined;
  return typeof m === "number" && m > 0 ? m : (table["*"] ?? 1);
}

/** What a job is charged, in tenths of a credit: rounded up, at least one tenth. Pure, for the browser too. */
export function billDeciWith(usd: number, margin: number, perCredit: number): number {
  if (!(usd > 0)) return 0;
  return Math.max(1, Math.ceil((usd * margin * DECI_PER_CREDIT) / perCredit - 1e-9));
}

/** What a job is charged, in credits: a whole number of tenths, rounded up, at least 0.1. Pure, for the browser too. */
export function billCreditsWith(usd: number, margin: number, perCredit: number): number {
  return fromDeci(billDeciWith(usd, margin, perCredit));
}

export function billCredits(usd: number, engine?: string | null): number {
  return billCreditsWith(usd, marginFor(engine), creditUsd());
}

/**
 * What a take held at zero (lib/held.ts heldInfo) costs to start now, in
 * credits (a whole number of tenths): its engine dollars at today's rate. The
 * snapshot's `needs` is what it cost when it was held, and stands in only for
 * a row too old to carry `estUsd`; it is read in the unit it was recorded in
 * (`unitUsd`, or the legacy unit when absent) and converted to today's. The
 * Release button shows this figure and the release charges it.
 */
export function heldPriceNow(held: { estUsd?: unknown; needs?: unknown; unitUsd?: unknown } | null | undefined, kind: string | null | undefined, model: string | null | undefined): number {
  const est = Number(held?.estUsd ?? 0);
  const now = Number.isFinite(est) && est > 0 ? billCredits(est, marginKeyOf(kind, model)) : 0;
  if (now) return now;
  const then = Number(held?.needs ?? 0);
  if (!(Number.isFinite(then) && then > 0)) return 0;
  const unit = Number(held?.unitUsd);
  const recordedAt = Number.isFinite(unit) && unit > 0 ? unit : LEGACY_CREDIT_USD;
  return fromDeci(Math.max(1, ceilDeci((then * recordedAt) / creditUsd())));
}

/** The unrounded figure, for a running total. */
export const usdToCredits = (usd: number, engine?: string | null): number => (usd * marginFor(engine)) / creditUsd();
/** Dollars of vendor cost a number of credits buys at no margin. */
export const creditsToUsd = (credits: number): number => credits * creditUsd();

/**
 * The rate, written out: `1 credit = $0.80`.
 *
 * One sentence, one place. Every surface that tells a person what a credit is
 * worth — the top-up screen, the Settings credits card, the tooltip on the
 * balance in the header — calls this, and passes the rate it was GIVEN rather
 * than one it typed. On the server that rate is `creditUsd()`; in the browser
 * it is the `creditUsd` field of the rate table the server built (lib/
 * rateTable.ts), because `process.env.CREDIT_USD` does not exist there and a
 * browser falling back to DEFAULT_CREDIT_USD would be a second place the price
 * is baked in — exactly what CREDIT_USD is meant to make impossible.
 *
 * A rate that is missing, zero or not a number returns null, and the surface
 * leaves the line out. Nothing invents a price to fill a gap.
 *
 * Two decimals normally, up to four when the rate needs them: at $0.125 a
 * credit, "$0.13" would misstate the unit by 4% on a screen whose whole job is
 * to state it exactly.
 */
export function creditRateLine(perCredit: number | null | undefined): string | null {
  const usd = creditRateUsd(perCredit);
  return usd === null ? null : `1 credit = $${usd}`;
}

/** The rate as a money string, for a surface that words the sentence itself. */
export function creditRateUsd(perCredit: number | null | undefined): string | null {
  if (typeof perCredit !== "number" || !Number.isFinite(perCredit) || perCredit <= 0) return null;
  const trimmed = perCredit.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const decimals = trimmed.split(".")[1]?.length ?? 0;
  return decimals < 2 ? perCredit.toFixed(2) : trimmed;
}

/**
 * Where a credit came from, and whether anyone paid for it.
 *
 * `credit_grants` recorded an amount and a note and nothing else, so the
 * platform could not tell a credit it had sold from one it had given away.
 * That was already wrong before bonus credits existed: the welcome grant goes
 * through the same table, so a workspace spending it reported its whole
 * balance as revenue (SOW §7A).
 *
 * `purchase` is the only kind cash arrives for. `bonus` is §7A's pack
 * discount — free, by decision, because no money changes hands for it;
 * `welcome` is the sign-up grant; `manual` is an admin adding credits, which
 * counts as free because the alternative is booking goodwill as revenue.
 * Understating is the safe direction to be wrong in, and an admin who is
 * recording a payment taken off-platform can say so when there is somewhere
 * to say it.
 */
export type GrantKind = "purchase" | "bonus" | "welcome" | "manual" | "included";
export const GRANT_KINDS: readonly GrantKind[] = ["purchase", "bonus", "welcome", "manual", "included"];
export const isPaidKind = (kind: string | null | undefined): boolean => kind === "purchase";
export function asGrantKind(v: unknown): GrantKind {
  return (GRANT_KINDS as readonly string[]).includes(String(v)) ? (String(v) as GrantKind) : "manual";
}

/**
 * How much of a balance was actually bought, 0 to 1.
 *
 * Which credits a job spent is unknowable without dated lots drawn in order,
 * and those are deliberately not built yet. Apportioning is what is left, and
 * it is the ordinary treatment for a fungible prepaid balance: a workspace
 * whose credits are 90% bought has 90% of its spend funded. It differs from
 * draw-order only in TIMING — by the time a balance is spent out, both have
 * booked the same revenue — so it is unbiased over a workspace's life and
 * wrong only about which month.
 *
 * No grants at all is 0, not 1: an unfunded workspace's spend is all cost.
 */
export function fundedFraction(paidCredits: number, freeCredits: number): number {
  const total = paidCredits + freeCredits;
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, paidCredits / total));
}

/**
 * What the client needs to show a balance.
 *
 * **No `margins` here, on purpose (SOW §2: "margin ... never shown").** It
 * was in this shape while the browser converted vendor dollars into credits
 * itself; that conversion moved to the server, and the field stayed behind as
 * payload nobody read. Dead weight is one thing while it is a table of
 * fourteen numbers somebody has to interpret, and another once it is a
 * single entry — one number in `/api/me` that states the margin outright.
 * Every figure that reaches the browser is already in credits.
 */
export type CreditState = {
  creditUsd: number;
  granted: number;
  used: number;
  balance: number;
};
