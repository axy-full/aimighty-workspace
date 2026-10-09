import { test, expect } from "@playwright/test";
import { boardRows, cycleDates, cycleNow, heroTakes, historyRows, planNowOf, signedCredits, takesWords, whenWords } from "../../lib/v12/billing";
import { fmtCredits } from "../../lib/price";
import { PLAN_CARDS, PLAN_CARDS_ARE_PLACEHOLDERS, HERO_TAKE } from "../../lib/marketing/planCards";
import { DEFAULT_PLANS } from "../../lib/plans";
import type { CreditLedgerRow } from "../../lib/usageLedgerTerms";

/**
 * Settings › Credits & billing in the new interface, as data (lib/v12/billing.ts; docs/redesign-plan.md, item B2).
 * Figures below stand for what the routes answered: test inputs, not prices.
 */

const NOW = Date.UTC(2026, 9, 10, 15, 0);
const DAY = 86_400_000;

test("the current cycle is the one running now; none outside a paid period", () => {
  const cycles = [
    { startsAt: Date.UTC(2026, 8, 1), endsAt: Date.UTC(2026, 9, 1), credits: 400 },
    { startsAt: Date.UTC(2026, 9, 1), endsAt: Date.UTC(2026, 10, 1), credits: 400 },
  ];
  expect(cycleNow(cycles, NOW)).toBe(cycles[1]);
  expect(cycleNow(cycles, Date.UTC(2026, 10, 1))).toBeNull();
  expect(cycleNow(undefined, NOW)).toBeNull();
  expect(cycleDates(cycles[1])).toBe("1 Oct – 1 Nov");
});

test("History: what each job charged or holds, and what came in, newest first; nothing for a job that cost nothing", () => {
  const ledger: CreditLedgerRow[] = [
    { id: "a", at: NOW - 1000, who: null, engine: "Nano Banana 2", kind: "image", credits: 10, state: "charged" },
    { id: "b", at: NOW - 2000, who: null, engine: "Seedance 2.5", kind: "video", credits: 43, state: "running" },
    { id: "c", at: NOW - 3000, who: null, engine: "Kling 3.0 Standard", kind: "video", credits: 0, state: "failed-not-billed" },
    { id: "d", at: NOW - DAY, who: null, engine: "Kling 3.0 Standard", kind: "video", credits: 7, state: "failed-charged" },
  ];
  const rows = historyRows(ledger, [{ id: "g1", credits: 500, note: "Starter pack", createdAt: NOW - DAY - 1000 }], NOW);
  expect(rows.map((r) => [r.when, r.what, signedCredits(r, fmtCredits)])).toEqual([
    ["Today", "Still · Nano Banana 2", "−10 cr"],
    ["Today", "Video · Seedance 2.5", "43 cr held"],
    ["Yesterday", "Video · Kling 3.0 Standard · failed", "−7 cr"],
    ["Yesterday", "Starter pack", "+500 cr"],
  ]);
  expect(historyRows([], [], NOW)).toEqual([]);
  expect(historyRows(ledger, [], NOW, 2)).toHaveLength(2);
  expect(whenWords(NOW - 9 * DAY, NOW)).toBe(new Date(NOW - 9 * DAY).toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
});

test("Per board: the route's rows, or null when it did not answer in credits", () => {
  expect(boardRows({ unit: "credits", boards: [{ id: "p1", name: "Launch film", n: 8, credits: 186 }, { id: null, name: "Unfiled", n: 1, credits: 2 }] }))
    .toEqual([{ id: "p1", name: "Launch film", n: 8, credits: 186 }, { id: null, name: "Unfiled", n: 1, credits: 2 }]);
  expect(boardRows({ unit: "usd", boards: [] })).toBeNull();
  expect(boardRows(null)).toBeNull();
  expect(takesWords(1)).toBe("1 take");
  expect(takesWords(8)).toBe("8 takes");
});

test("the plan is the server's (paid, else the admin's label); absent on an older server", () => {
  expect(planNowOf({ plan: { id: "studio", label: "Studio", includedCredits: 400 } })).toEqual({ id: "studio", label: "Studio", includedCredits: 400 });
  expect(planNowOf({ plan: null })).toBeNull();
  expect(planNowOf({})).toBeNull();
});

test("the plan cards are one display-only placeholder config, apart from today's plans", () => {
  expect(PLAN_CARDS_ARE_PLACEHOLDERS).toBe(true);
  expect(PLAN_CARDS.map((c) => c.name)).toEqual(["Starter", "Studio", "Team"]);
  for (const card of PLAN_CARDS) {
    expect(card.credits).toBeGreaterThan(0);
    expect(card.priceUsd).toBeGreaterThan(0);
  }
  /* Checkout's plans are untouched and not these. */
  expect(DEFAULT_PLANS.map((p) => p.id)).toEqual(["invite", "studio", "agency", "production"]);
  expect(HERO_TAKE.duration).toBeGreaterThan(0);
  /* "about N hero takes" counts whole takes at the quoted price, and says nothing without one. */
  expect(heroTakes(500, 43)).toBe(11);
  expect(heroTakes(500, null)).toBeNull();
  expect(heroTakes(500, 0)).toBeNull();
});
