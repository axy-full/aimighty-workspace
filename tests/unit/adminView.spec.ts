import { test, expect } from "@playwright/test";
import { shareOf, flagsFor, marginPctOf, floorGuardFires, subBarLine, defaultsLine, fmtUsd, fmtPct, monthLabel, OVER_SHARE, UNDER_MARGIN, FLOOR_GUARD_MIN_JOBS } from "../../lib/adminView";
import { adminAlertEmail } from "../../lib/mail";

/** The desk's pure pieces (board 12h): the two flags, the pricing margin, the sub-bar line and the "starts with" line. */
test("share is a studio's engine dollars over the non-internal total; over a quarter is flagged", () => {
  expect(shareOf(1205, 4820)).toBeCloseTo(0.25, 9);
  expect(flagsFor(shareOf(1205, 4820), null).overShare).toBe(false);   // exactly a quarter is not over
  expect(flagsFor(shareOf(1206, 4820), null).overShare).toBe(true);
  expect(shareOf(10, 0)).toBe(0);
  expect(shareOf(-5, 100)).toBe(0);
  expect(OVER_SHARE).toBe(0.25);
});

test("a margin under 10% is under the floor; no margin is not", () => {
  expect(flagsFor(0, 0.0999).underMargin).toBe(true);
  expect(flagsFor(0, 0.10).underMargin).toBe(false);
  expect(flagsFor(0, null).underMargin).toBe(false);
  expect(flagsFor(0, -0.5).underMargin).toBe(true);
  expect(UNDER_MARGIN).toBe(0.10);
});

test("the pricing margin: credits at the rate less cost, over credits at the rate; null on nothing billed", () => {
  /* At 1.5x the ledger reads a third: 43 cr for $2.864 is $4.30 against $2.864. */
  expect(marginPctOf(43, 2.864, 0.10)).toBeCloseTo((4.3 - 2.864) / 4.3, 9);
  expect(marginPctOf(0, 5, 0.10)).toBeNull();
  expect(marginPctOf(10, 2, 0.10)).toBeCloseTo(-1, 9); // $1 billed against $2 of cost
});

test("the floor guard fires on enough jobs under the floor, never on noise", () => {
  expect(floorGuardFires({ jobs: FLOOR_GUARD_MIN_JOBS, marginPct: 0.05 })).toBe(true);
  expect(floorGuardFires({ jobs: FLOOR_GUARD_MIN_JOBS - 1, marginPct: 0.05 })).toBe(false);
  expect(floorGuardFires({ jobs: 500, marginPct: 0.10 })).toBe(false);
  expect(floorGuardFires({ jobs: 500, marginPct: null })).toBe(false);
});

test("the sub-bar line reads as the board prints it", () => {
  const sept = Date.UTC(2026, 8, 1);
  expect(monthLabel(sept)).toBe("September");
  expect(subBarLine({ cycleStart: sept, engineCostUsd: 4820.4, marginPct: 0.333, grantsUsd: 410, grantBudgetUsd: 1000 }))
    .toBe("SEPTEMBER · ENGINE SPEND $4,820 · MARGIN 33% · GRANTS $410 OF $1,000");
  expect(subBarLine({ cycleStart: Date.UTC(2026, 0, 15), engineCostUsd: 0, marginPct: null, grantsUsd: 0, grantBudgetUsd: null }))
    .toBe("JANUARY · ENGINE SPEND $0 · MARGIN — · GRANTS $0");
  expect(fmtUsd(1234567.5)).toBe("$1,234,568");
  expect(fmtPct(-0.2)).toBe("-20%");
});

test("the defaults line reads as the board prints it, with the numbers handed in", () => {
  expect(defaultsLine({ setupRows: 12, rules: 9, recipes: 2, starter: "a demo production", capCredits: 400, warnPct: 80, grant: 250 }))
    .toBe("12 Setup rows · 9 rules · 2 recipes · a demo production · caps at 400 cr, warn at 80% · grant 250 cr");
  expect(defaultsLine({ setupRows: 1, rules: 1, recipes: 1, starter: "Starter production", capCredits: null, warnPct: 80, grant: 50 }))
    .toBe("1 Setup row · 1 rule · 1 recipe · Starter production · caps at no cap, warn at 80% · grant 50 cr");
});

test("the floor guard's email names the provider, the margin, the jobs, and that the multiplier stands", () => {
  const m = adminAlertEmail({ provider: "fal", marginPct: 0.062, jobs: 48, days: 7, multiplier: 1.5 });
  expect(m.subject).toBe("Floor guard: fal margin 6% over 7 days");
  expect(m.text).toContain("fal is under the floor");
  expect(m.text).toContain("6% margin over the last 7 days, on 48 jobs");
  expect(m.text).toContain("The multiplier stands at its setting, 1.5×");
  expect(m.html).toContain("Floor guard: fal margin 6% over 7 days");
  expect(m.html).not.toContain("Open the desk");
  expect(adminAlertEmail({ provider: "fal", marginPct: 0.062, jobs: 48, days: 7, multiplier: 1.5, link: "https://x.y/admin" }).html).toContain("Open the desk");
});
