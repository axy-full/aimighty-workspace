import { test, expect } from "@playwright/test";
import { dollars } from "../../lib/format";
import { fmtLedgerUsd } from "../../lib/usageLedgerTerms";
import { FREE, creditsText, exact, priceSum, priceTitle, priceWords, setDollarDisplay, upTo } from "../../lib/shell/price-words";

/*
 * One screen, one unit (owner, 13 Oct). The house workspace pays at cost, in dollars: every price it sees is `dollars()`, two decimals, always rounded UP to the next cent,
 * so no price reads below what it can charge. Display only: nothing here is what is quoted, held or billed. Every other workspace keeps credits.
 */

test("dollars: two decimals, always rounded up to the next cent", () => {
  expect(dollars(0.743)).toBe("$0.75");
  expect(dollars(0.875)).toBe("$0.88");
  expect(dollars(1.001)).toBe("$1.01");
  expect(dollars(0.001)).toBe("$0.01");
  expect(dollars(2)).toBe("$2.00");
  expect(dollars(0)).toBe("$0.00");
  expect(dollars(0.5)).toBe("$0.50");
  /* Float noise on a whole cent is not a cent more. */
  expect(dollars(0.1 + 0.2)).toBe("$0.30");
  expect(dollars(1.1 * 3)).toBe("$3.30");
  expect(dollars(0.07 * 100)).toBe("$7.00");
  expect(dollars(1234.5)).toBe("$1,234.50");
  expect(dollars(1234567.891)).toBe("$1,234,567.90");
  expect(dollars(-0.743)).toBe("-$0.75");
});

test("dollars: no figure reads as a dash, never as zero", () => {
  expect(dollars(null)).toBe("—");
  expect(dollars(undefined)).toBe("—");
  expect(dollars(Number.NaN)).toBe("—");
  expect(dollars(Number.POSITIVE_INFINITY)).toBe("—");
});

test("the usage ledger's dollars are the same formatter", () => {
  for (const n of [0.743, 0.045, 12, 0.0001]) expect(fmtLedgerUsd(n)).toBe(dollars(n));
});

test("in dollar display every price words its dollars and none says cr", () => {
  setDollarDisplay(true, 0.1);
  try {
    expect(priceWords(exact(8, 0.743))).toBe("$0.75");
    expect(priceWords(upTo(9, 0.875))).toBe("up to $0.88");
    /* Without the render's own dollars, credits at the public price of a credit: an upper bound. */
    expect(priceWords(exact(8))).toBe("$0.80");
    expect(priceWords(upTo(16))).toBe("up to $1.60");
    expect(priceWords(FREE)).toBe("free");
    expect(creditsText(24)).toBe("$2.40");
    expect(priceWords(priceSum([exact(5, 0.41), exact(6, 0.52)]))).toBe("$0.93");
    expect(priceTitle(exact(8, 0.743), 0.1)).not.toMatch(/cr\b/);
    for (const text of [priceWords(exact(8, 0.743)), priceWords(upTo(9, 0.875)), creditsText(24)]) expect(text).not.toMatch(/\bcr\b/);
  } finally {
    setDollarDisplay(false, null);
  }
});

test("a credit workspace never reads a dollar: its figures stay N cr", () => {
  setDollarDisplay(false, 0.1);
  expect(priceWords(exact(8, 0.743))).toBe("8 cr");
  expect(priceWords(upTo(9, 0.875))).toBe("up to 9 cr");
  expect(creditsText(24)).toBe("24 cr");
  expect(priceWords(priceSum([exact(5, 0.41), exact(6, 0.52)]))).toBe("11 cr");
});
