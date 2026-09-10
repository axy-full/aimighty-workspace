import { test, expect } from "@playwright/test";
import { isPaidKind, asGrantKind, fundedFraction, GRANT_KINDS } from "../../lib/creditTerms";

/**
 * Which credits were bought (SOW §7A, decided 10 September 2026).
 *
 * `credit_grants` recorded an amount and a note, so the platform could not
 * tell a credit it sold from one it gave away — and the welcome grant goes
 * through the same table, so a workspace spending it reported its balance as
 * revenue the platform never took.
 */
test("only a purchase is paid for", () => {
  expect(isPaidKind("purchase")).toBe(true);
  // Bonus credits are §7A's pack discount. No money arrives for them.
  expect(isPaidKind("bonus")).toBe(false);
  expect(isPaidKind("welcome")).toBe(false);
  // Management adding credits is goodwill until there is somewhere to say
  // otherwise; booking goodwill as revenue is the worse mistake.
  expect(isPaidKind("manual")).toBe(false);
  // A kind from an older row, or a typo, is never revenue by accident.
  expect(isPaidKind(null)).toBe(false);
  expect(isPaidKind("Purchase")).toBe(false);
  expect(isPaidKind("")).toBe(false);
});

test("a kind read back off a row is one of the four, or manual", () => {
  for (const k of GRANT_KINDS) expect(asGrantKind(k)).toBe(k);
  expect(asGrantKind("nonsense")).toBe("manual");
  expect(asGrantKind(null)).toBe("manual");
  expect(asGrantKind(7)).toBe("manual");
});

test("the funded share is the bought share of the balance", () => {
  expect(fundedFraction(2000, 0)).toBe(1);
  expect(fundedFraction(0, 250)).toBe(0);
  expect(fundedFraction(750, 250)).toBe(0.75);
  // §7A's Agency pack: 20,000 bought, 4,000 given.
  expect(fundedFraction(20000, 4000)).toBeCloseTo(0.8333, 4);
});

test("a workspace with no grants funds nothing, rather than everything", () => {
  /* The dangerous default. Reading an empty balance as fully funded would
     make an unfunded workspace's spend look like pure revenue, which is the
     exact failure this was built to stop. */
  expect(fundedFraction(0, 0)).toBe(0);
});

test("a clawback cannot make a workspace look better funded than it is", () => {
  /* Management taking credits back is a negative `manual` row, so it lands on
     the free side. The share bought can be driven above 1 by arithmetic; it
     is clamped, because more than all of a balance cannot have been sold. */
  expect(fundedFraction(1000, -400)).toBe(1);
  expect(fundedFraction(-100, 500)).toBe(0);
});
