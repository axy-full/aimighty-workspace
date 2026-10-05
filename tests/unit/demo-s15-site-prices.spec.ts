import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SITE_CREDIT_USD, siteRates } from "../../lib/marketing/prices.server";
import { NAV_SUITES, SITE_SUITES } from "../../lib/marketing/site";

/**
 * The public site states the published rate card (CLAUDE.md § Pricing) at the
 * public price of a credit, whatever unit the ledger counts in on the day.
 * Run with CREDIT_USD set to another price to prove the site does not follow it.
 */

const CARD = [1, 3, 7, 10, 13, 18, 29, 43, 23, 38, 54, 1];

test("the rate card and packs are CLAUDE.md's, even while the ledger counts in another unit", () => {
  const before = process.env.CREDIT_USD;
  process.env.CREDIT_USD = "0.8";
  try {
    const rates = siteRates();
    expect(SITE_CREDIT_USD).toBe(0.1);
    expect(rates.perCredit).toBe(0.1);
    expect(rates.rateCard.map((row) => row.credits)).toEqual(CARD);
    expect(rates.hero.credits).toBe(43);
    expect(rates.packs.map((pack) => [pack.usd, pack.credits, pack.bonus])).toEqual([
      [50, 500, 0], [200, 2000, 200], [500, 5000, 750], [2000, 20000, 4000],
    ]);
  } finally {
    if (before === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = before;
  }
});

test("the site's tabs use the product's names", () => {
  expect(NAV_SUITES.map((suite) => suite.tab)).toEqual(["Studio", "Ads", "Social", "Make", "Atomik"]);
  const said = SITE_SUITES.flatMap((suite) => [suite.tab, suite.tag, suite.name, suite.blurb, ...suite.pages]).join("\n");
  expect(said).not.toMatch(/\b(Gen|Business|Viral|Workspace|Moleculr|Subatomik|Genjutsu|Rig|Astra|Soul)\b/);
});

test("every sign-up on the site says Sign up", () => {
  const files = [
    "components/marketing/SiteChrome.tsx", "components/marketing/SharedBottom.tsx", "components/marketing/HeroPrompt.tsx",
    "app/(marketing)/site/_pages/gen/index.tsx", "app/(marketing)/site/_pages/studio/index.tsx",
    "app/(marketing)/site/_pages/business/index.tsx", "app/(marketing)/site/_pages/viral/index.tsx",
    "app/(marketing)/site/_pages/atomik/index.tsx", "app/(marketing)/site/_pages/workspace/index.tsx",
    "app/(marketing)/site/_pages/pricing/PlanCards.tsx",
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toMatch(/Request access|Opens in Gen|Open Gen|Five suites/);
  }
});
