import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  creditUsd, creditRateLine, creditRateUsd, creditsToUsd, usdToCredits, billCredits, billCreditsWith,
} from "../../lib/creditTerms";
import { buildRateTable } from "../../lib/rateTable.server";
import { EMPTY_TABLE } from "../../lib/rateTable";
import { pricePack } from "../../lib/packs";
import { creditsCard, type MeRead } from "../../lib/workspace/settings-data";
import { creditsLabel, creditsTitle } from "../../lib/workspace/format";
import {
  formatProviderCreditQuote, providerCreditQuote, sumWithProviderCreditQuotes,
} from "../../lib/providerCreditQuote";
import { FALLBACK_USD_PER_CREDIT } from "../../lib/elevenlabs";

/**
 * One credit is ten cents — stated once, derived everywhere, and never applied
 * to somebody else's credits.
 *
 * The rule already held in the pricing core before this file existed: packs are
 * priced at `creditUsd()`, the ledger bills `usd × margin ÷ creditUsd()`. What
 * did not hold was consistency on the surfaces. The top-up screen said
 * "1 credit = US$0.10" as a typed sentence, so a deployment on another
 * CREDIT_USD would have shown prices from one rate and a sentence from another;
 * the browser's empty rate table carried its own copy of 0.1. Both are gone,
 * and the tests below fail on origin/main.
 */

const ROOT = path.join(__dirname, "..", "..");

/* ── 1. The rate has one definition ──────────────────────────────────── */

test("the rate is written from a number it was given, never from a literal", () => {
  expect(creditRateLine(0.10)).toBe("1 credit = $0.10");
  expect(creditRateLine(0.25)).toBe("1 credit = $0.25");
  expect(creditRateUsd(0.10)).toBe("0.10");
  /* Up to four decimals when the rate needs them: rounding $0.125 to $0.13 on
     the one screen whose job is to state the unit would misstate it by 4%. */
  expect(creditRateLine(0.125)).toBe("1 credit = $0.125");
  expect(creditRateLine(0.0005)).toBe("1 credit = $0.0005");
});

test("a rate nobody supplied produces no sentence about one", () => {
  for (const missing of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(creditRateLine(missing as number)).toBeNull();
  /* The table a browser holds before one has loaded says nothing about the
     rate. It used to carry 0.1 — a second copy of the launch rate, shipped to
     every client, which CREDIT_USD could not move. */
  expect(EMPTY_TABLE.creditUsd).toBe(0);
  expect(creditRateLine(EMPTY_TABLE.creditUsd)).toBeNull();
});

test("no surface types the rate as copy", () => {
  /* The exact defect this PR fixes, pinned at source level: the sentence is
     built by creditRateLine from a number, so the words must not appear in any
     component or route. lib/creditTerms.ts is the one place the rate is named,
     and the SOW and CLAUDE.md are the policy that sets it. */
  const banned = /US\$0\.10|\$0\.10|10¢|ten cents|10 cents/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (banned.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(ROOT, full));
    }
  };
  for (const dir of ["app", "components"]) walk(path.join(ROOT, dir));
  expect(offenders, "the rate is derived from creditUsd(), never typed").toEqual([]);
});

/* ── 2. The surfaces that state the rate ─────────────────────────────── */

const ME: MeRead = { credits: { creditUsd: 0.10, granted: 2000, used: 760, balance: 1240 } };

test("the Settings credits card states the rate, from the unit its dollars use", () => {
  const card = creditsCard(ME, null, Date.UTC(2026, 8, 20))!;
  expect(card.balance).toBe("1,240 CR");
  expect(card.usd).toBe("$124.00");
  expect(card.rate).toBe("1 credit = $0.10");
  /* One short line, not a paragraph (CLAUDE.md ground rule 9). */
  expect(card.rate!.length).toBeLessThan(40);
});

test("the credits card follows the workspace's own unit rather than the launch rate", () => {
  const card = creditsCard({ credits: { ...ME.credits!, creditUsd: 0.25 } }, null, 0)!;
  expect(card.rate).toBe("1 credit = $0.25");
  expect(card.usd).toBe("$310.00");
});

test("a card with no unit drops the line instead of guessing ten cents", () => {
  const card = creditsCard({ credits: { ...ME.credits!, creditUsd: Number.NaN } }, null, 0)!;
  expect(card.usd).toBeNull();
  expect(card.rate).toBeNull();
});

test("the credit figure's own tooltip carries the rate, on the phone and the desktop", () => {
  expect(creditsLabel(2250, "cr", 0.10).title).toBe("Workspace credits · 1 credit = $0.10");
  expect(creditsLabel(2250, "cr", 0.25).title).toBe("Workspace credits · 1 credit = $0.25");
  expect(creditsTitle("Workspace credits", 0.10)).toBe("Workspace credits · 1 credit = $0.10");
  expect(creditsTitle("Workspace credits", null)).toBe("Workspace credits");
  /* No table yet, so no rate — and the slot still says what it is. */
  expect(creditsLabel(2250, "cr", EMPTY_TABLE.creditUsd).title).toBe("Workspace credits");
  expect(creditsLabel(2250).title).toBe("Workspace credits");
  /* A dollar workspace has no credit balance and is told so, not given a rate. */
  expect(creditsLabel(null, "usd", 0.10).title).toMatch(/dollars/i);
  expect(creditsLabel(null, "usd", 0.10).title).not.toMatch(/1 credit/);
});

/* ── 3. Connected credits are the provider's, and are never converted ── */

test("a connected quote is labelled as connected credits and carries no dollars", () => {
  const quote = providerCreditQuote({
    provider: "higgsfield", unit: "higgsfield_credits", credits: 42, basis: "approved_quote",
  })!;
  const text = formatProviderCreditQuote(quote);
  expect(text).toContain("connected cr");
  expect(text).toContain("42");
  /* Not our unit: no dollar sign, no rate, no arithmetic against creditUsd(). */
  expect(text).not.toContain("$");
  expect(text).not.toMatch(/1 credit/);
  expect(text).not.toContain(String(creditsToUsd(42)));
  /* And it stays the provider's figure whatever our own rate is. */
  const before = process.env.CREDIT_USD;
  try {
    process.env.CREDIT_USD = "0.99";
    expect(formatProviderCreditQuote(quote)).toBe(text);
  } finally { if (before === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = before; }
});

test("a list mixing our credits and a connected quote keeps the two units apart", () => {
  const summed = sumWithProviderCreditQuotes(
    [{ providerCreditQuote: { provider: "higgsfield", unit: "higgsfield_credits", credits: 8, basis: "approved_quote" } as const }],
    () => "0 cr",
  );
  expect(summed).toBe("8 connected cr (quoted)");
  expect(summed).not.toContain("$");
});

test("no connected surface imports the credit rate, so none of them can apply it", () => {
  /* The rule stated as the only thing that can enforce it: a file that never
     sees creditUsd cannot multiply a provider's credits by ten cents. */
  const connected = [
    "components/suites/ConsumerGenjutsu.tsx",
    "components/suites/ConsumerShorts.tsx",
    "components/suites/ConsumerMarketingVideo.tsx",
    "components/suites/MarketingTemplates.tsx",
    "components/suites/SubatomikWorkspace.tsx",
    "components/suites/AtomikSuite.tsx",
    "lib/providerCreditQuote.ts",
  ];
  for (const file of connected) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    expect(src, `${file} must not read the platform credit rate`)
      .not.toMatch(/creditUsd|creditsToUsd|usdToCredits|creditRateLine|creditRateUsd/);
    /* Every connected price says which credits it is in. */
    if (/higgsfield_credits/.test(src))
      expect(src, `${file} labels the unit as connected credits`).toMatch(/connected cr(edits)?/);
  }
});

test("the connected account's own per-credit rate is not ours and does not move with ours", () => {
  /* /api/usage carries a connected voice account's usdPerCredit. It is that
     provider's wallet rate, nothing to do with CREDIT_USD, and the two must
     never be confused for one another. */
  const before = process.env.CREDIT_USD;
  try {
    const first = FALLBACK_USD_PER_CREDIT;
    process.env.CREDIT_USD = "0.42";
    expect(FALLBACK_USD_PER_CREDIT).toBe(first);
    expect(FALLBACK_USD_PER_CREDIT).not.toBe(creditUsd());
  } finally { if (before === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = before; }
});

/* ── 4. CREDIT_USD stays authoritative ───────────────────────────────── */

test("changing CREDIT_USD moves every derived figure, the browser's rate table included", () => {
  const before = process.env.CREDIT_USD;
  try {
    process.env.CREDIT_USD = "0.10";
    const base = buildRateTable("cr");
    const baseRate = base.models["bytedance/seedance-1-5-pro"] ?? Object.values(base.models)[0];
    expect(base.creditUsd).toBe(0.10);
    expect(creditRateLine(base.creditUsd)).toBe("1 credit = $0.10");

    process.env.CREDIT_USD = "0.25";
    expect(creditUsd()).toBe(0.25);
    /* The table the browser is handed — the only rate a client ever sees. */
    const moved = buildRateTable("cr");
    expect(moved.creditUsd).toBe(0.25);
    expect(creditRateLine(moved.creditUsd)).toBe("1 credit = $0.25");
    /* And every rate in it: credits per second is dollars ÷ the unit, so a
       dearer credit buys more seconds and the figures fall by the ratio. */
    const movedRate = moved.models[Object.keys(base.models).find((id) => base.models[id] === baseRate)!];
    const pick = (r: typeof baseRate) =>
      r.secondRates?.[0]?.withoutAudio ?? r.tiers?.[0]?.withoutVideo ?? Object.values(r.taskRates ?? {})[0]
      ?? Object.values(r.imagePricing ?? {})[0] ?? r.imageRefIn!;
    expect(pick(movedRate)).toBeCloseTo(pick(baseRate) * (0.10 / 0.25), 9);
    /* The writer's rates are on the same terms. */
    const textId = Object.keys(base.text)[0];
    expect(moved.text[textId].input).toBeCloseTo(base.text[textId].input * (0.10 / 0.25), 9);

    /* Server pricing, the ledger's arithmetic, the conversions and the packs. */
    expect(creditsToUsd(10)).toBeCloseTo(2.5, 9);
    expect(usdToCredits(1, "*")).toBeCloseTo(1.5 / 0.25, 9);
    expect(billCredits(1, "*")).toBe(6);
    expect(billCreditsWith(1, 1.5, creditUsd())).toBe(6);
    /* A pack's price is its bought credits at the unit, so the ladder moves. */
    expect(pricePack({ id: "starter", label: "Starter", credits: 500 }, creditUsd()).usd).toBe(125);

    /* The settings card and the tooltip, fed from that same table. */
    expect(creditsCard({ credits: { creditUsd: moved.creditUsd, granted: 0, used: 0, balance: 100 } }, null, 0)!.rate)
      .toBe("1 credit = $0.25");
    expect(creditsLabel(100, moved.unit, moved.creditUsd).title).toContain("$0.25");
  } finally {
    if (before === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = before;
  }
});

test("an unusable CREDIT_USD falls back to the one default, and only there", () => {
  const before = process.env.CREDIT_USD;
  try {
    for (const bad of ["", "nope", "0", "-1"]) {
      process.env.CREDIT_USD = bad;
      expect(creditUsd(), bad).toBe(0.10);
      expect(buildRateTable("cr").creditUsd, bad).toBe(0.10);
    }
  } finally { if (before === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = before; }
});

/* ── 5. The margin story ─────────────────────────────────────────────── */

test("a displayed value of credits is vendor cost at no margin, not a refund rate", () => {
  /* creditsToUsd is deliberately margin-free: it answers "what did the
     platform pay for this", which is what the admin desk and the top-up ladder
     need. What a customer is BILLED is usd × margin ÷ creditUsd, a different
     number, and the two must not be mistaken for each other. */
  process.env.CREDIT_USD = "0.10";
  expect(creditsToUsd(100)).toBeCloseTo(10, 9);
  expect(billCredits(10, "*")).toBe(150);
  expect(usdToCredits(10, "*")).toBeGreaterThan(creditsToUsd(1) === 0 ? 0 : 100);
  /* The card's dollar figure is balance × unit — the same margin-free rate the
     packs were sold at, which is why it cannot imply a better one. */
  const card = creditsCard({ credits: { creditUsd: 0.10, granted: 0, used: 0, balance: 1000 } }, null, 0)!;
  expect(card.usd).toBe("$100.00");
  expect(pricePack({ id: "x", label: "X", credits: 1000 }, 0.10).usd).toBe(100);
});
