import { test, expect } from "@playwright/test";
import { dollars } from "../../lib/format";
import { fmtLedgerUsd } from "../../lib/usageLedgerTerms";
import {
  CREDITS_MODE, FREE, NO_AT_COST_FIGURE, NO_AT_COST_TITLE, creditsText, dollarDisplay, exact, heldExact, modeOf, priceSum, priceTitle, priceView, priceWords, setDollarDisplay, upTo,
  type DollarMode,
} from "../../lib/shell/price-words";
import { NO_AT_COST_PRICE } from "../../lib/v12/quote";
import { limitBoxText, limitFromBox } from "../../lib/shell/run-limit-input";

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
  /* A refund (negative) rounds toward zero, never overstated: Math.ceil. */
  expect(dollars(-0.743)).toBe("-$0.74");
  expect(dollars(-0.001)).toBe("$0.00");
  expect(dollars(-2)).toBe("-$2.00");
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

const HOUSE: DollarMode = modeOf({ unit: "usd", creditUsd: 0.1 });

test("in dollar display every price words its dollars and none says cr", () => {
  expect(priceWords(exact(8, 0.743), HOUSE)).toBe("$0.75");
  expect(priceWords(upTo(9, 0.875), HOUSE)).toBe("up to $0.88");
  expect(priceWords(FREE, HOUSE)).toBe("free");
  /* A limit, ceiling or hold kept in credits reads at the public price of a credit, its dollars at cost. */
  expect(priceWords(heldExact(8), HOUSE)).toBe("$0.80");
  expect(creditsText(24, HOUSE)).toBe("$2.40");
  expect(priceWords(priceSum([exact(5, 0.41), exact(6, 0.52)]), HOUSE)).toBe("$0.93");
  expect(priceTitle(exact(8, 0.743), 0.1, HOUSE)).toBe("Pays at cost");
  for (const text of [priceWords(exact(8, 0.743), HOUSE), priceWords(upTo(9, 0.875), HOUSE), priceWords(heldExact(8), HOUSE), creditsText(24, HOUSE)]) expect(text).not.toMatch(/\bcr\b/);
});

test("a quote with no dollar figure reads a dash and says why, never its credits times a credit's price", () => {
  expect(priceWords(exact(8), HOUSE)).toBe(NO_AT_COST_FIGURE);
  expect(priceWords(upTo(16), HOUSE)).toBe(NO_AT_COST_FIGURE);
  expect(NO_AT_COST_TITLE).toBe(NO_AT_COST_PRICE);
  expect(priceTitle(exact(8), 0.1, HOUSE)).toBe(NO_AT_COST_TITLE);
  expect(priceView(exact(8), 0.1, HOUSE)).toMatchObject({ text: "—", title: NO_AT_COST_TITLE });
  /* A sum with a part that has none has none either. */
  expect(priceWords(priceSum([exact(5, 0.41), exact(6)]), HOUSE)).toBe(NO_AT_COST_FIGURE);
});

test("a credit workspace never reads a dollar: its figures stay N cr", () => {
  expect(priceWords(exact(8, 0.743), CREDITS_MODE)).toBe("8 cr");
  expect(priceWords(upTo(9, 0.875), CREDITS_MODE)).toBe("up to 9 cr");
  expect(creditsText(24, CREDITS_MODE)).toBe("24 cr");
  expect(priceWords(priceSum([exact(5, 0.41), exact(6, 0.52)]), CREDITS_MODE)).toBe("11 cr");
  expect(modeOf({ unit: "cr", creditUsd: 0.1 })).toBe(CREDITS_MODE);
});

test("a customer's price and a house price, worded at the same moment, never meet: the mode is carried, not shared", async () => {
  /* Renders interleaved across awaits, as concurrent server renders are: each words with its own session's mode. */
  const customer = modeOf({ unit: "cr", creditUsd: 0.1 });
  const words = async (mode: DollarMode, usd: number) => { await new Promise((r) => setTimeout(r, Math.random() * 5)); return { text: priceWords(exact(8, usd), mode), title: priceTitle(exact(8, usd), 0.1, mode) }; };
  const batch = await Promise.all(Array.from({ length: 40 }, (_, i) => words(i % 2 ? HOUSE : customer, 0.743)));
  batch.forEach((got, i) => {
    if (i % 2) expect(got).toEqual({ text: "$0.75", title: "Pays at cost" });
    else expect(got).toEqual({ text: "8 cr", title: "$0.80" });
  });
});

test("on the server nothing a render sets outlives it: the shared dollar flag is never written there", () => {
  /* The tests run in node, as the server does: no window. */
  expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
  setDollarDisplay(true, 0.1);
  expect(dollarDisplay()).toBe(false);
  expect(priceWords(exact(8, 0.743))).toBe("8 cr");
  expect(creditsText(24)).toBe("24 cr");
});

test("in a browser the session's unit sets the words that take no mode, and credits come back with it", () => {
  const g = globalThis as { window?: unknown };
  g.window = {};
  try {
    setDollarDisplay(true, 0.1);
    expect(dollarDisplay()).toBe(true);
    expect(priceWords(exact(8, 0.743))).toBe("$0.75");
    expect(creditsText(24)).toBe("$2.40");
    setDollarDisplay(false, 0.1);
    expect(priceWords(exact(8, 0.743))).toBe("8 cr");
  } finally {
    setDollarDisplay(false, null);
    delete g.window;
  }
});

test("the run-limit box: the house types dollars and saves whole credits rounded up; a customer types credits", () => {
  /* Shown back in dollars with the shared formatter: 24 credits is 2.40, 8 is 0.80, never a credit figure. */
  expect(limitBoxText(24, HOUSE)).toBe("2.40");
  expect(limitBoxText(8, HOUSE)).toBe("0.80");
  expect(limitBoxText(12500, HOUSE)).toBe("1250.00");
  /* What is typed becomes credits, rounded UP: never below what was typed. */
  expect(limitFromBox("2.40", HOUSE)).toBe(24);
  expect(limitFromBox("0.743", HOUSE)).toBe(8);
  expect(limitFromBox("0.70", HOUSE)).toBe(7);
  expect(limitFromBox("0.71", HOUSE)).toBe(8);
  expect(limitFromBox("0.3", HOUSE)).toBe(3);
  expect(limitFromBox("", HOUSE)).toBeNull();
  expect(limitFromBox("0", HOUSE)).toBeNull();
  expect(limitFromBox("-1", HOUSE)).toBeNull();
  expect(limitFromBox("abc", HOUSE)).toBeNull();
  /* A round trip never lowers a stored limit. */
  for (const credits of [1, 7, 8, 24, 100, 4301]) expect(limitFromBox(limitBoxText(credits, HOUSE), HOUSE)).toBe(credits);
  /* A customer's box is credits, as ever. */
  expect(limitBoxText(24, CREDITS_MODE)).toBe("24");
  expect(limitFromBox("24", CREDITS_MODE)).toBe(24);
  expect(limitFromBox("2.5", CREDITS_MODE)).toBe(2.5);
  expect(limitFromBox("2.55", CREDITS_MODE)).toBeNull();
});
