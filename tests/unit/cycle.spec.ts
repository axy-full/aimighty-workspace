import { test, expect } from "@playwright/test";
import { cycleBounds, cleanAnchorDay, cycleKey } from "../../lib/cycle";
import { monthRange, monthOf } from "../../lib/statements";

/**
 * The billing cycle (SOW §7A — "included credits expire at cycle end").
 *
 * The month was computed inline in two files that could not see each other.
 * This is the one function now, and the first thing it has to earn is that
 * it changes nothing.
 */
test("anchored on the 1st, it IS the calendar month the old code built by hand", () => {
  /* The arithmetic `monthRange` used before this landed, transcribed.
     NOT `monthRange(month)` — that delegates to `cycleBounds` now, so
     comparing against it would be asserting the function equals itself.
     The point of this test is the one thing a refactor has to prove, and it
     can only prove it against the code being replaced. */
  const wasMonthRange = (y: number, mo: number) => ({ from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1) });
  for (const [y, mo] of [[2026, 1], [2026, 2], [2026, 9], [2026, 12], [2024, 2]] as [number, number][]) {
    const old = wasMonthRange(y, mo);
    expect(cycleBounds(1, old.from + 1000), `${y}-${mo}`).toEqual({ start: old.from, end: old.to });
    // ...and the boundary instant itself opens the cycle it belongs to.
    expect(cycleBounds(1, old.from), `${y}-${mo} at its own start`).toEqual({ start: old.from, end: old.to });
  }
});

test("monthRange still answers exactly what it used to", () => {
  // The caller's own contract, checked end to end through the new function.
  const wasMonthRange = (y: number, mo: number) => ({ from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1) });
  expect(monthRange("2026-09")).toEqual(wasMonthRange(2026, 9));
  expect(monthRange("2024-02")).toEqual(wasMonthRange(2024, 2));
  expect(monthRange("2026-12")).toEqual(wasMonthRange(2026, 12));
  // ...and still refuses what it used to refuse.
  for (const bad of ["2026-13", "2026-00", "2026-9", "nonsense", ""]) expect(monthRange(bad), bad).toBeNull();
});

test("anchored on the 1st, it matches what platformSpendThisMonth walks back to", () => {
  /* lib/allowance.ts does: new Date(); setUTCDate(1); setUTCHours(0,0,0,0).
     Same answer, without a mutable Date and without asking the clock. */
  for (const at of [Date.UTC(2026, 8, 10, 13, 44, 12, 7), Date.UTC(2026, 0, 1), Date.UTC(2024, 1, 29, 23, 59, 59, 999)]) {
    const d = new Date(at);
    d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    expect(cycleBounds(1, at).start).toBe(d.getTime());
  }
});

test("the range is half-open, so no instant is in two cycles", () => {
  const sep = cycleBounds(1, Date.UTC(2026, 8, 15));
  const oct = cycleBounds(1, Date.UTC(2026, 9, 15));
  expect(sep.end).toBe(oct.start);
  // The shared instant belongs to October only.
  expect(cycleBounds(1, sep.end)).toEqual(oct);
});

test("a month-end anchor clamps, and comes back", () => {
  /* The case a stored DATE cannot express: an anchor of the 31st has to be
     the 28th in February and the 31st again in March. A date remembers only
     what it was clamped TO, so it would stay on the 28th for ever. */
  const feb = cycleBounds(31, Date.UTC(2026, 1, 10));
  expect(new Date(feb.start).toISOString().slice(0, 10)).toBe("2026-01-31");
  expect(new Date(feb.end).toISOString().slice(0, 10)).toBe("2026-02-28");

  const mar = cycleBounds(31, Date.UTC(2026, 2, 10));
  expect(new Date(mar.start).toISOString().slice(0, 10)).toBe("2026-02-28");
  expect(new Date(mar.end).toISOString().slice(0, 10)).toBe("2026-03-31");
});

test("a 31st anchor in a leap February lands on the 29th", () => {
  const c = cycleBounds(31, Date.UTC(2024, 1, 10));
  expect(new Date(c.start).toISOString().slice(0, 10)).toBe("2024-01-31");
  expect(new Date(c.end).toISOString().slice(0, 10)).toBe("2024-02-29");
});

test("a 30th anchor never rolls a cycle into the next month", () => {
  /* `Date.UTC(y, 1, 30)` is 2 March. Left unclamped, February's cycle would
     open in March and last a day — the boundary in the wrong cycle. */
  const c = cycleBounds(30, Date.UTC(2026, 1, 15));
  expect(new Date(c.start).toISOString().slice(0, 10)).toBe("2026-01-30");
  expect(new Date(c.end).toISOString().slice(0, 10)).toBe("2026-02-28");
  expect(c.end).toBeGreaterThan(c.start);
});

test("every anchor, every month of a year, yields one unbroken chain", () => {
  /* The property that matters more than any single case: cycles must tile
     the year — no gap a job could fall into, no overlap it could be counted
     in twice. */
  for (const day of [1, 5, 15, 28, 29, 30, 31]) {
    let c = cycleBounds(day, Date.UTC(2026, 0, 15));
    for (let i = 0; i < 14; i++) {
      expect(c.end, `anchor ${day}: a cycle moves forward`).toBeGreaterThan(c.start);
      const next = cycleBounds(day, c.end);
      expect(next.start, `anchor ${day}: no gap at ${new Date(c.end).toISOString()}`).toBe(c.end);
      c = next;
    }
  }
});

test("a nonsense anchor is the 1st, not a crash and not day zero", () => {
  for (const bad of [0, -3, 32, Number.NaN, null, undefined, "eleventh"]) {
    expect(cleanAnchorDay(bad as unknown), String(bad)).toBe(1);
  }
  expect(cleanAnchorDay(1.7), "a fraction floors").toBe(1);
  expect(cleanAnchorDay(28)).toBe(28);
  expect(cleanAnchorDay(31)).toBe(31);
  expect(cycleBounds(Number.NaN, Date.UTC(2026, 8, 10))).toEqual(cycleBounds(1, Date.UTC(2026, 8, 10)));
});

test("the cycle key is the month statements are already keyed by", () => {
  const at = Date.UTC(2026, 8, 10);
  expect(cycleKey(cycleBounds(1, at).start)).toBe(monthOf(at));
});
