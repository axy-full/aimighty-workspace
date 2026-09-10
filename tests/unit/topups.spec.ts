import { test, expect } from "@playwright/test";
import { packs, packById, pricePack, capBonus, BONUS_CAP } from "../../lib/packs";
import { creditUsd, billCredits } from "../../lib/creditTerms";
import { nextStatus } from "../../lib/topups";

/** SOW §7A: unit stays $0.10, the discount is bonus credits, capped at 20%. */
test("the four packs are §7A's four packs", () => {
  process.env.CREDIT_USD = "0.10";
  const all = packs();
  expect(all.map((p) => p.id)).toEqual(["starter", "team", "studio", "agency"]);
  expect(all.map((p) => p.credits)).toEqual([500, 2000, 5000, 20000]);
  expect(all.map((p) => p.bonus)).toEqual([0, 200, 750, 4000]);
  expect(all.map((p) => p.total)).toEqual([500, 2200, 5750, 24000]);
  // The price is the BOUGHT credits at the unit rate, and nothing else.
  expect(all.map((p) => p.usd)).toEqual([50, 200, 500, 2000]);
  expect(packById("agency")?.bonus).toBe(4000);
  // The old three are gone; a stale id is null rather than a silent fallback.
  expect(packById("house")).toBeNull();
});

test("the effective rate is §7A's Effective column", () => {
  const [starter, team, studio, agency] = packs();
  expect(starter.perCredit).toBeCloseTo(0.100, 3);
  expect(team.perCredit).toBeCloseTo(0.091, 3);
  expect(studio.perCredit).toBeCloseTo(0.087, 3);
  expect(agency.perCredit).toBeCloseTo(0.083, 3);
});

test("the ladder only ever goes down, and never below the cap", () => {
  const all = packs();
  for (let i = 1; i < all.length; i++) {
    expect(all[i].credits, `${all[i].id} is bigger`).toBeGreaterThan(all[i - 1].credits);
    expect(all[i].perCredit, `${all[i].id} costs no more per credit`).toBeLessThanOrEqual(all[i - 1].perCredit);
  }
  // §7A guardrail 2, on the shipped table: 4,000/20,000 sits exactly on 20%.
  for (const p of all) expect(p.bonus, p.id).toBeLessThanOrEqual(p.credits * BONUS_CAP);
  for (const p of all) expect(p.perCredit).toBeLessThanOrEqual(creditUsd());
});

test("the discount is credits given, never a cheaper unit", () => {
  /* The whole safety argument. `creditUsd()` is the platform's unit of
     account: every job is billed against it and every per-engine margin is
     set against it. If the pack leaked into that, the same shot would cost
     different credits for different customers. Priced while the deepest rung
     is 20% off: the bill does not move. */
  process.env.CREDIT_USD = "0.10";
  expect(packById("agency")!.perCredit).toBeLessThan(creditUsd());
  expect(billCredits(2.864, "dreamina-seedance-2-5-260628")).toBe(43);
  expect(billCredits(0.63, "fal-ai/kling-video/v3/standard")).toBe(10);
});

test("guardrail 2 clamps, and fails to zero rather than through", () => {
  expect(capBonus(20000, 4000)).toBe(4000);          // exactly 20% survives
  expect(capBonus(1000, 999)).toBe(200);             // more is cut to the cap
  expect(capBonus(500, -5)).toBe(0);                 // a surcharge is not a bonus
  expect(capBonus(500, 0)).toBe(0);
  /* NaN is the one that matters: `Math.min(NaN, cap)` is NaN, and a NaN
     bonus reaching a grant poisons a balance no query can repair. */
  expect(capBonus(500, Number.NaN)).toBe(0);
  expect(capBonus(500, "nonsense")).toBe(0);
  expect(capBonus(500, undefined)).toBe(0);
  expect(capBonus(Number.NaN, 100)).toBe(0);
});

test("a pack is priced from the unit rate, so the table moves with it", () => {
  expect(pricePack({ id: "s", label: "S", credits: 2000, bonus: 200 }, 0.10).usd).toBe(200);
  expect(pricePack({ id: "s", label: "S", credits: 2000, bonus: 200 }, 0.20).usd).toBe(400);
  // The bonus is credits, not dollars, so it does not move with the rate.
  expect(pricePack({ id: "s", label: "S", credits: 2000, bonus: 200 }, 0.20).bonus).toBe(200);
  expect(pricePack({ id: "s", label: "S", credits: 500 }, 0.10).bonus).toBe(0);
});

test("a request moves once, and only from requested", () => {
  expect(nextStatus("requested", "approve")).toBe("approved");
  expect(nextStatus("requested", "decline")).toBe("declined");
  expect(nextStatus("requested", "cancel")).toBe("cancelled");
  expect(nextStatus("approved", "decline")).toBeNull();
  expect(nextStatus("cancelled", "approve")).toBeNull();
});
