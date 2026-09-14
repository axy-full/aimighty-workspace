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
 * pays. **SOW §7A: sell price = engine cost x 1.5.** One multiplier, flat,
 * for every engine — which is why the table below has a single entry.
 *
 * The table is keyed by engine anyway, and stays keyed by engine, because
 * §7A asks for exactly that: "Build the adapter so the multiplier is per
 * engine from day one, even though it launches at a flat 1.5x. That's a
 * config change later, not a refactor." Phase B tunes premium to 1.7 and
 * commodity to 1.4 by adding keys here or setting CREDIT_MARGINS; nothing
 * downstream has to change for that to work.
 *
 * It is one entry rather than fourteen identical ones on purpose. A table
 * of the same number repeated pretends there are fourteen decisions when
 * §7A made one, and every copy is a place for the launch rate to drift.
 *
 * This replaced a per-engine table dated 6 September that ran from 1.25 to
 * 1.5. Every price it produced was under §7A's rate card — a 5-second
 * Seedance 2.5 1080p take billed 40 credits where the card says 43 — so
 * the card and the buttons disagreed. The card is right; it derives from
 * cost x 1.5 exactly, on all twelve of its lines.
 *
 * CREDIT_MARGINS, a JSON object of the same shape, overrides any entry.
 * SIGNUP_CREDITS is what a workspace starts with the day it signs up.
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
 * fourteen numbers somebody has to interpret, and another once §7A makes it
 * `{"*": 1.5}` — a single number in `/api/me` that states the markup outright.
 * Every figure that reaches the browser is already in credits.
 */
export type CreditState = {
  creditUsd: number;
  granted: number;
  used: number;
  balance: number;
};
