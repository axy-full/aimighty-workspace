import { test, expect } from "@playwright/test";
import {
  billCreditsWith, billDeciWith, ceilDeci, creditsFigure, floorDeci, fromDeci, heldPriceNow, isCreditAmount, toDeci,
} from "../../lib/creditTerms";
import {
  approvedHeldPrice, convertDeciDown, convertDeciUp, deciCovering, deciWithin, microOf, roundToTenth, sameCredits, unitOf, valueOf,
} from "../../lib/creditUnits";
import { planRelease } from "../../lib/held";
import { setCreditUsd } from "../helpers/creditRate";

/**
 * Credits are charged in tenths (owner decision, 28 September 2026): every
 * charge rounds UP to the next 0.1 credit and a paid job costs at least 0.1.
 * Money code counts integer tenths, so sums and repeated settlements are
 * exact. These are the pure halves; the ledger's are in creditConversion.spec.
 */

const withRate = (value: string | undefined, fn: () => void) => {
  const before = process.env.CREDIT_USD;
  try { setCreditUsd(value); fn(); } finally { setCreditUsd(before); }
};

test("a charge rounds up to the next tenth, and an exact tenth stays where it is", () => {
  // Plain terms (no margin, US$0.80 a credit) so every figure is legible.
  const at = (usd: number) => billCreditsWith(usd, 1, 0.80);
  expect(at(0.08)).toBe(0.1);          // exactly one tenth
  expect(at(0.96)).toBe(1.2);          // exactly twelve tenths, not 1.3
  expect(at(0.9601)).toBe(1.3);        // a hair over rounds up
  expect(at(0.008)).toBe(0.1);         // 0.01 credit → 0.1
  expect(at(8)).toBe(10);              // whole credits are tenths too
  expect(at(79.92)).toBe(99.9);
  expect(billDeciWith(0.96, 1, 0.80)).toBe(12);
  // Float products that land a hair above an exact tenth do not round up.
  expect(billCreditsWith(0.1 * 3, 1, 0.1)).toBe(3);
  expect(billCreditsWith(0.7, 1, 0.1)).toBe(7);
});

test("any paid job costs at least 0.1 credit, and nothing costs nothing", () => {
  expect(billCreditsWith(0.000001, 1, 0.80)).toBe(0.1);
  expect(billDeciWith(1e-9, 1, 0.80)).toBe(1);
  expect(billCreditsWith(0, 1, 0.80)).toBe(0);
  expect(billCreditsWith(-1, 1, 0.80)).toBe(0);
  expect(billCreditsWith(Number.NaN, 1, 0.80)).toBe(0);
});

test("tenths convert both ways exactly, and only a whole number of tenths is an amount", () => {
  for (const credits of [0, 0.1, 0.3, 1.2, 12.3, 99.9, 1234.5]) {
    expect(fromDeci(toDeci(credits))).toBe(credits);
    expect(roundToTenth(credits)).toBe(credits);
  }
  expect(ceilDeci(0.01)).toBe(1);
  expect(ceilDeci(0.3)).toBe(3);
  expect(ceilDeci(0.1 + 0.2)).toBe(3);   // 0.30000000000000004 is still three tenths
  expect(floorDeci(0.875)).toBe(8);
  expect(floorDeci(0.3 - 1e-12)).toBe(3);
  for (const ok of [0, 0.1, 12.3, 1_000_000]) expect(isCreditAmount(ok), String(ok)).toBe(true);
  for (const bad of [-0.1, 0.15, 0.05, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) expect(isCreditAmount(bad), String(bad)).toBe(false);
});

test("a figure shows one decimal only when it isn't zero, grouped, never shortened", () => {
  expect(creditsFigure(12)).toBe("12");
  expect(creditsFigure(12.3)).toBe("12.3");
  expect(creditsFigure(0.1)).toBe("0.1");
  expect(creditsFigure(1250)).toBe("1,250");
  expect(creditsFigure(1234.5)).toBe("1,234.5");
  expect(creditsFigure(0.1 + 0.2)).toBe("0.3");
  expect(creditsFigure(12.300000000000001)).toBe("12.3");
  expect(creditsFigure(0)).toBe("0");
});

test("a sum of many charges is exact in tenths, where the same sum in floats drifts", () => {
  const charges = Array.from({ length: 10_000 }, (_, i) => fromDeci((i % 9) + 1)); // 0.1 … 0.9
  const floats = charges.reduce((a, c) => a + c, 0);
  const tenths = charges.reduce((a, c) => a + toDeci(c), 0);
  expect(tenths).toBe(Array.from({ length: 10_000 }, (_, i) => (i % 9) + 1).reduce((a, b) => a + b, 0));
  expect(tenths).toBe(49_996);
  expect(Math.abs(floats - fromDeci(tenths))).toBeLessThan(0.05); // floats may drift; never by half a tenth
  expect(roundToTenth(floats)).toBe(fromDeci(tenths));
});

test("values compare figures recorded at different prices exactly", () => {
  expect(microOf(0.10)).toBe(100_000);
  expect(microOf(0.80)).toBe(800_000);
  expect(unitOf(null)).toBe(0.10);
  expect(unitOf(0)).toBe(0.10);
  expect(unitOf(0.8)).toBe(0.8);
  // 29.6 credits at US$0.10 are exactly 3.7 at US$0.80.
  expect(valueOf(296, 0.10)).toBe(valueOf(37, 0.80));
  expect(convertDeciUp(70, 0.10, 0.80)).toBe(9);    // 7 → 0.875 → 0.9
  expect(convertDeciDown(70, 0.10, 0.80)).toBe(8);  // what is spendable, 0.8
  expect(convertDeciUp(37, 0.80, 0.10)).toBe(296);  // back again, exact
  expect(deciCovering(valueOf(-30, 0.10), 0.80)).toBe(-3);  // a debt of 3 → 0.375 → rounds toward zero: 0.3
  expect(deciWithin(valueOf(-30, 0.10), 0.80)).toBe(-4);
  expect(Object.is(deciCovering(0, 0.8), 0)).toBe(true);
});

test("a held take's old figure is read in the unit it was held at, and re-priced from dollars when it can be", () => {
  withRate("0.80", () => {
    // No dollars on the row, recorded before units: 29 credits at US$0.10 → 3.625 → 3.7.
    expect(heldPriceNow({ needs: 29 }, "video", "mock")).toBe(3.7);
    expect(heldPriceNow({ needs: 29, unitUsd: 0.10 }, "video", "mock")).toBe(3.7);
    // Held at today's price: the figure stands.
    expect(heldPriceNow({ needs: 2.4, unitUsd: 0.80 }, "video", "mock")).toBe(2.4);
    // With dollars, always today's price, rounded up to a tenth.
    const fromDollars = heldPriceNow({ estUsd: 0.5, needs: 99 }, "video", "mock");
    expect(isCreditAmount(fromDollars)).toBe(true);
    expect(fromDollars).toBeGreaterThanOrEqual(0.1);
    // What a person approved counts only in the unit they saw it in.
    expect(approvedHeldPrice({ needs: 2.4, unitUsd: 0.80 })).toBe(2.4);
    expect(approvedHeldPrice({ needs: 29 })).toBeNull();
    expect(approvedHeldPrice({ needs: 29, unitUsd: 0.10 })).toBeNull();
    expect(approvedHeldPrice({ needs: 2.45, unitUsd: 0.80 })).toBeNull();
    expect(sameCredits(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameCredits(null, 0.3)).toBe(false);
  });
});

test("held takes release in tenths: exactly what the balance holds, oldest first, no drift", () => {
  const takes = [{ id: "a", needs: 0.3 }, { id: "b", needs: 0.3 }, { id: "c", needs: 0.4 }, { id: "d", needs: 0.1 }];
  // 0.3 + 0.3 + 0.4 is 1.0000000000000002 in floats; in tenths it is exactly 10.
  expect(planRelease(takes, 1)).toEqual({ release: ["a", "b", "c"], short: ["d"] });
  expect(planRelease(takes, 1.1)).toEqual({ release: ["a", "b", "c", "d"], short: [] });
  expect(planRelease(takes, 0.29)).toEqual({ release: [], short: ["a", "b", "c", "d"] });
  expect(planRelease(takes, null)).toEqual({ release: ["a", "b", "c", "d"], short: [] });
});
