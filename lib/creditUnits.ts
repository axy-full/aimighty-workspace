import { LEGACY_CREDIT_USD, DECI_PER_CREDIT, creditUsd, fromDeci, isCreditAmount, toDeci } from "./creditTerms";

/**
 * Credit figures recorded at different prices of a credit, compared exactly.
 *
 * Every ledger row states the price its credits were recorded at (`unit_usd`;
 * NULL is LEGACY_CREDIT_USD, what every row written before units existed was
 * recorded at). Two figures at different prices are compared by VALUE: a
 * figure's integer tenths times its price in whole micro-dollars. Both factors
 * are integers, so every sum and comparison below is exact — no floating-point
 * drift however many rows are added. Pure, no imports beyond the terms.
 */

/** Micro-dollars per credit at `unitUsd`, as an integer. */
export const microOf = (unitUsd: number): number => Math.round(unitUsd * 1_000_000);

/** A stored price, or the legacy one when the row has none (NULL, 0, not a number). */
export function unitOf(stored: unknown): number {
  const n = Number(stored);
  return stored != null && Number.isFinite(n) && n > 0 ? n : LEGACY_CREDIT_USD;
}

/** The value of `deci` tenths recorded at `unitUsd`: an integer, comparable across prices. */
export const valueOf = (deci: number, unitUsd: number): number => deci * microOf(unitUsd);

/** Whole tenths at `unitUsd` that `value` buys, rounded UP (what must be taken to cover it). */
export function deciCovering(value: number, unitUsd: number): number {
  const m = microOf(unitUsd);
  return (value > 0 ? Math.ceil(value / m) : -Math.floor(-value / m)) || 0;
}

/** Whole tenths at `unitUsd` that `value` is worth, rounded DOWN (never more than there is). */
export function deciWithin(value: number, unitUsd: number): number {
  const m = microOf(unitUsd);
  return (value >= 0 ? Math.floor(value / m) : -Math.ceil(-value / m)) || 0;
}

/** `deci` tenths at `fromUsd` restated at `toUsd`, rounded UP to a tenth (a charge never rounds down). */
export const convertDeciUp = (deci: number, fromUsd: number, toUsd: number): number =>
  deciCovering(valueOf(deci, fromUsd), toUsd);

/** `deci` tenths at `fromUsd` restated at `toUsd`, rounded DOWN to a tenth. */
export const convertDeciDown = (deci: number, fromUsd: number, toUsd: number): number =>
  deciWithin(valueOf(deci, fromUsd), toUsd);

/** A credit figure on the tenth grid, to the NEAREST tenth: what is written to a REAL column. */
export const roundToTenth = (credits: number): number => fromDeci(toDeci(Number(credits) || 0));

/** A stored credit figure (REAL, a whole number of tenths) as integer tenths. */
export const deciOf = (stored: unknown): number => toDeci(Number(stored ?? 0) || 0);

/** SQL for a column's price in micro-dollars, NULL meaning the legacy price. */
export const microSql = (column: string): string =>
  `CAST(ROUND(COALESCE(NULLIF(${column}, 0), ${LEGACY_CREDIT_USD}) * 1000000) AS INTEGER)`;

/** SQL for a REAL credit column as integer tenths. */
export const deciSql = (expr: string): string => `CAST(ROUND((${expr}) * ${DECI_PER_CREDIT}) AS INTEGER)`;

/**
 * The price a person approved for a held take (its snapshot's `needs`), or
 * null when it cannot stand for today's price: missing, not a whole number of
 * tenths, or recorded at another price of a credit (`unitUsd`; absent is the
 * legacy price). A null never matches today's figure, so the take waits for a
 * person to approve the new one — a number approved in one unit is never read
 * as the same number in another.
 */
export function approvedHeldPrice(held: { needs?: unknown; unitUsd?: unknown } | null | undefined): number | null {
  if (!held || !isCreditAmount(held.needs)) return null;
  return microOf(unitOf(held.unitUsd)) === microOf(creditUsd()) ? held.needs : null;
}

/** Whether two credit figures are the same number of tenths (null never matches). */
export const sameCredits = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a != null && b != null && toDeci(a) === toDeci(b);

/**
 * What a take that predates metering was billed: WHOLE credits at the legacy
 * price, rounded up, at least one — the rule in force when it ran. Such a take
 * has no receipt, so this is its receipt, and it is never restated in tenths
 * or at today's price (lib/creditSql.ts historicalCreditsExpr is the same rule
 * in SQL).
 */
export function legacyBilledCredits(usd: number, margin: number): number {
  if (!(usd > 0)) return 0;
  return Math.max(1, Math.ceil((usd * margin) / LEGACY_CREDIT_USD - 1e-9));
}
