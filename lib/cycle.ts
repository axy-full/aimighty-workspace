/**
 * The billing cycle: the window a workspace's spend and inclusions fall in.
 *
 * The code has known exactly one period — the UTC calendar month — and has
 * computed it inline in two places that could not see each other:
 * `platformSpendThisMonth` walks a Date back to the 1st, and `monthRange`
 * builds one from a "YYYY-MM" string. They agree today by coincidence of
 * both being right, not by construction.
 *
 * §7A needs more than that. "Included credits expire at cycle end, no
 * rollover" is a rule about a boundary, and a boundary that three different
 * files each work out for themselves is a rule with three chances to be
 * wrong on the day it matters. So the month becomes a function, and the
 * function takes the day it turns on.
 *
 * **`anchorDay = 1` reproduces both callers exactly**, which is the whole
 * reason this can land before anything uses the rest of it: it is a refactor
 * with a proof, not a new behaviour. Nothing stores an anchor yet; when a
 * plan does, this already knows what to do with it.
 *
 * Pure, no clock, no database — so a test can ask it about February without
 * waiting for February.
 */

/** Days in a UTC month. `Date.UTC(y, m + 1, 0)` is the last day of month m. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The instant a cycle turns over in a given month.
 *
 * **Clamped, not rolled over.** An anchor of the 31st in a 30-day month is
 * the 30th, not the 1st of the month after — `Date.UTC(y, m, 31)` would
 * silently become 1 July for June, moving the boundary into the next cycle
 * and making that cycle a day long.
 *
 * Clamping is also why the anchor is kept as a DAY rather than as the date
 * it last turned on: a cycle anchored on the 31st has to come back to the
 * 31st in March after being the 28th in February, and a stored date cannot
 * remember what it was clamped from.
 */
function anchorAt(year: number, month: number, anchorDay: number): number {
  return Date.UTC(year, month, Math.min(anchorDay, daysInMonth(year, month)));
}

/** An anchor is a day of the month; anything else is the 1st. */
export function cleanAnchorDay(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : 1;
}

/**
 * The cycle containing `at`: `[start, end)`, both UTC instants.
 *
 * Half-open on purpose, and the same shape `monthRange` already returns, so
 * the boundary instant belongs to the cycle it opens and to nothing else. A
 * closed range would put every anchor-day midnight in two cycles at once,
 * and a job metered at exactly that millisecond would be counted twice.
 */
export function cycleBounds(anchorDay: number, at: number): { start: number; end: number } {
  const day = cleanAnchorDay(anchorDay);
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();

  // This month's turn has either happened by `at`, or it is the next one.
  const thisMonth = anchorAt(y, m, day);
  const start = at >= thisMonth ? thisMonth : anchorAt(y, m - 1, day);
  const startD = new Date(start);
  const end = anchorAt(startD.getUTCFullYear(), startD.getUTCMonth() + 1, day);
  return { start, end };
}

/** The cycle `at` sits in, as the month string statements are keyed by. */
export const cycleKey = (start: number): string => {
  const d = new Date(start);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
