import { test, expect } from "@playwright/test";
import {
  FREE, creditRate, creditsText, creditsUsd, exact, isPriceValue, priceSum, priceTitle, priceValue, priceView, priceWords, shortBy, shortByWords, upTo,
  type PriceValue,
} from "../../lib/shell/price-words";
import { EMPTY_TABLE } from "../../lib/rateTable";

/*
 * The one price formatter (CLAUDE.md rule 14; design/particl-graphite/README.md § 5): "N cr" for an
 * exact figure, "up to N cr" for a live estimate, "free" for nothing, and the dollar value on hover
 * at the server's credit rate. The figures below are inputs, as the server would quote them.
 */

test("an exact figure reads N cr, grouped en-US", () => {
  expect(priceWords(exact(43))).toBe("43 cr");
  expect(priceWords(exact(1))).toBe("1 cr");
  expect(priceWords(exact(1234))).toBe("1,234 cr");
  expect(priceWords(exact(20000))).toBe("20,000 cr");
  /* The code counts in tenths at the finest (lib/runLimit.ts); a figure in tenths reads as it is. */
  expect(priceWords(exact(2.4))).toBe("2.4 cr");
  expect(priceWords(exact(2.45))).toBe("2.5 cr");
  expect(creditsText(1234.5)).toBe("1,234.5 cr");
});

test("an estimate reads up to N cr, never below what whole-credit rounding could charge", () => {
  expect(priceWords(upTo(69))).toBe("up to 69 cr");
  expect(priceWords(upTo(4))).toBe("up to 4 cr");
  /* Every job is charged in whole credits, rounded up: a ceiling of 3.2 can be charged 4. */
  expect(priceWords(upTo(3.2))).toBe("up to 4 cr");
  /* Floating-point noise on a whole figure is not a credit more. */
  expect(priceWords(upTo(68.0000000001))).toBe("up to 68 cr");
  expect(priceWords(priceValue(129, "up-to"))).toBe("up to 129 cr");
});

test("nothing to pay reads free, and only a true zero does", () => {
  expect(priceWords(FREE)).toBe("free");
  expect(priceWords(exact(0))).toBe("free");
  expect(priceWords(upTo(0))).toBe("free");
  /* A charge under a twentieth of a credit is still a charge. */
  expect(priceWords(exact(0.04))).toBe("0.1 cr");
});

test("a figure that is not a figure shows no price at all: never a zero, a guess or a placeholder", () => {
  for (const bad of [Number.NaN, -1, -0.5, Number.POSITIVE_INFINITY, null, undefined]) {
    expect(exact(bad as number), String(bad)).toBeNull();
    expect(upTo(bad as number), String(bad)).toBeNull();
  }
  expect(priceWords(null)).toBeNull();
  expect(priceWords(undefined)).toBeNull();
  expect(priceWords({ kind: "exact", credits: Number.NaN })).toBeNull();
  expect(priceWords({ kind: "quoted", credits: 4 } as unknown as PriceValue)).toBeNull();
  expect(isPriceValue({ kind: "up-to", credits: 3 })).toBe(true);
  expect(isPriceValue({ kind: "free" })).toBe(true);
  expect(isPriceValue({ kind: "exact", credits: "43" })).toBe(false);
  expect(isPriceValue({ kind: "about", credits: 31 })).toBe(false);
  expect(isPriceValue(43)).toBe(false);
});

test("the words are only ever N cr, up to N cr or free: never quoted, never about", () => {
  const shape = /^(free|(up to )?\d{1,3}(,\d{3})*(\.\d)? cr)$/;
  for (const credits of [0, 0.04, 0.1, 1, 3, 7, 43, 52, 69, 129, 1234.5, 99999]) {
    for (const value of [exact(credits), upTo(credits)]) {
      const words = priceWords(value);
      expect(words, `${value?.kind} ${credits}`).toMatch(shape);
      expect(words).not.toMatch(/quoted|about/i);
    }
  }
});

test("hovering shows the dollar value at the server's credit rate", () => {
  expect(priceTitle(exact(43), 0.1)).toBe("$4.30");
  expect(priceTitle(upTo(69), 0.1)).toBe("up to $6.90");
  expect(priceTitle(exact(1), 0.1)).toBe("$0.10");
  expect(priceTitle(exact(12345), 0.1)).toBe("$1,234.50");
  expect(priceTitle(upTo(3.2), 0.1)).toBe("up to $0.40");
  /* Whatever the server's rate is, the hover follows it: the $0.80 unit the ledger held from 3 October. */
  expect(priceTitle(exact(6), 0.8)).toBe("$4.80");
  /* Nothing to pay has no dollar value to show. */
  expect(priceTitle(FREE, 0.1)).toBeNull();
  expect(priceTitle(exact(0), 0.1)).toBeNull();
});

test("no rate from the server, no dollars: the rate is never typed in", () => {
  for (const rate of [0, null, undefined, Number.NaN, -0.1, Number.POSITIVE_INFINITY]) {
    expect(priceTitle(exact(43), rate), String(rate)).toBeNull();
    expect(creditRate(rate), String(rate)).toBeNull();
  }
  expect(creditRate(0.1)).toBe(0.1);
});

test("dollars round to the cent, and a ceiling's cents round up without floating-point noise", () => {
  /* 43 × 0.1 is 4.3000000000000001 in floating point: still $4.30, never $4.31. */
  expect(creditsUsd(43, 0.1, true)).toBe("$4.30");
  expect(creditsUsd(3, 0.1, true)).toBe("$0.30");
  expect(creditsUsd(7, 0.1)).toBe("$0.70");
  expect(creditsUsd(2.5, 0.123)).toBe("$0.31");
  expect(creditsUsd(2.5, 0.123, true)).toBe("$0.31");
  expect(creditsUsd(2.6, 0.123, true)).toBe("$0.32");
  expect(creditsUsd(-1, 0.1)).toBeNull();
});

test("a total is up to N cr when any part is an estimate, and is never shown short", () => {
  /* The plan card's sample: two Seedance 2.5 shots and a Kling 3.0 Standard shot (README § 4). */
  expect(priceWords(priceSum([exact(43), exact(43), exact(7)]))).toBe("93 cr");
  expect(priceWords(priceSum([exact(9), exact(43), upTo(14)]))).toBe("up to 66 cr");
  /* An estimate counts at the ceiling it shows. */
  expect(priceWords(priceSum([upTo(3.2), exact(1)]))).toBe("up to 5 cr");
  /* Summed in tenths. */
  expect(priceSum([exact(0.1), exact(0.2)])).toEqual({ kind: "exact", credits: 0.3 });
  expect(priceSum([FREE, FREE])).toEqual(FREE);
  expect(priceSum([FREE, exact(3)])).toEqual({ kind: "exact", credits: 3 });
  /* Nothing to add, or a part with no figure: no total. */
  expect(priceSum([])).toBeNull();
  expect(priceSum([exact(3), null])).toBeNull();
});

test("a balance short of a price says by how much; a balance that covers it says nothing", () => {
  expect(shortBy(40, exact(43))).toBe(3);
  expect(shortByWords(40, exact(43))).toBe("Short by 3 cr");
  expect(shortBy(43, exact(43))).toBeNull();
  expect(shortBy(500, exact(43))).toBeNull();
  /* Against an estimate's ceiling. */
  expect(shortBy(40, upTo(69))).toBe(29);
  /* Rounded up to the tenth: never shown smaller than it is. */
  expect(shortBy(0.25, exact(1))).toBe(0.8);
  /* An unknown balance or no price: no claim either way. */
  expect(shortBy(null, exact(43))).toBeNull();
  expect(shortBy(Number.NaN, exact(43))).toBeNull();
  expect(shortBy(40, FREE)).toBeNull();
  expect(shortBy(40, null)).toBeNull();
  expect(shortByWords(500, exact(43))).toBeNull();
});

/* What components/graphite/Price.tsx draws is priceView: its words, its hover and its kind. */
test("Price draws the words with the dollars on hover, at the session's rate", () => {
  expect(priceView(exact(43), 0.1)).toEqual({ text: "43 cr", title: "$4.30", kind: "exact" });
  expect(priceView(upTo(69), 0.1)).toEqual({ text: "up to 69 cr", title: "up to $6.90", kind: "up-to" });
  /* The session's empty rate table holds 0, meaning not known yet: the words, and no hover. */
  expect(priceView(exact(43), EMPTY_TABLE.creditUsd)).toEqual({ text: "43 cr", title: null, kind: "exact" });
});

test("Price says free without dollars, and draws nothing for no price", () => {
  expect(priceView(FREE, 0.1)).toEqual({ text: "free", title: null, kind: "free" });
  expect(priceView(exact(0), 0.1)).toEqual({ text: "free", title: null, kind: "free" });
  expect(priceView(null, 0.1)).toBeNull();
  expect(priceView({ kind: "exact", credits: -3 }, 0.1)).toBeNull();
});
