import { test, expect } from "@playwright/test";
import { charged, leftAfter, EMPTY_TABLE, type RateTable } from "../../lib/rateTable";

/**
 * `· 31 LEFT AFTER` on the Render primary (board 12i): the balance once this
 * press is billed. The figure a stranger reads on their first render has to
 * be the one the ledger will leave them with — whole credits, and never a
 * minus sign on a button.
 */
const cr: RateTable = { ...EMPTY_TABLE, unit: "cr" };
const usd: RateTable = { ...EMPTY_TABLE, unit: "usd" };

test("the board's own line: 50 granted, a 19-credit press, 31 left after", () => {
  expect(leftAfter(50, charged(cr, 19))).toBe(31);
});

test("whole credits: the charge is rounded up before it comes off the balance", () => {
  /* 18.2 credits bills as 19 (charged rounds up to the next whole credit), so
     the button must say 31, not 31.8 or 32. */
  expect(leftAfter(50, charged(cr, 18.2))).toBe(31);
  expect(leftAfter(50, charged(cr, 0))).toBe(50);
});

test("never below zero: a press the balance cannot cover reads 0, and the server refuses it", () => {
  expect(leftAfter(10, charged(cr, 19))).toBe(0);
  expect(leftAfter(0, charged(cr, 1))).toBe(0);
});

test("no price, no figure", () => {
  expect(leftAfter(50, null)).toBeNull();
  expect(leftAfter(50, charged(cr, null))).toBeNull();
  expect(leftAfter(Number.NaN, 19)).toBeNull();
});

test("a dollar table is left in dollars by charged, and the caller decides whether to show it", () => {
  /* The composer only asks on a credit workspace (`money.inCredits`); the
     function itself is unit-blind and just floors what it is handed. */
  expect(charged(usd, 1.16)).toBe(1.16);
  expect(leftAfter(5, charged(usd, 1.16))).toBe(3);
});
