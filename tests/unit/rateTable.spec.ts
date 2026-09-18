import { test, expect } from "@playwright/test";
import { MODELS, estimateTokens, costUsd } from "../../lib/models";
import { estimateCostUsd, estimateImageCostUsd } from "../../lib/vendorPricing";
import { VENDOR_RATES } from "../../lib/vendorRates";
import { buildRateTable } from "../../lib/rateTable.server";
import { estimateVideo, estimateImage, charged } from "../../lib/rateTable";
import { billCredits } from "../../lib/creditTerms";

/**
 * The client is handed credits instead of dollars (SOW §6). The guarantee that
 * makes that safe is that the NEW path and the OLD one agree everywhere — not
 * that the algebra looks right.
 *
 * Old: estimate in dollars on the vendor's rates, then convert with the margin.
 * New: convert the rates once on the server, then estimate on those.
 */

const cr = buildRateTable("cr");

test("the rate table covers fixed-price catalogue entries; Genjutsu requires a live quote", () => {
  /* Two files hold what used to be one object, so the thing that can go wrong
     is a model in one and not the other — a new engine that silently cannot be
     priced, or a rate for something nobody can pick. */
  const catalogue = new Set(MODELS.map((m) => m.id));
  const rated = new Set(Object.keys(VENDOR_RATES));
  expect([...rated].filter((id) => !catalogue.has(id))).toEqual([]);
  expect([...catalogue].filter((id) => !rated.has(id))).toEqual(MODELS.filter(model => model.genjutsu).map(model => model.id));
  for (const model of MODELS.filter(model => model.genjutsu)) {
    expect(rated.has(model.id)).toBe(false);
    expect(estimateCostUsd(model.id, '720p', '16:9', 5, 0, true)).toBeNull();
    expect(estimateVideo(cr, model.id, '720p', 5, null, costUsd)).toBeNull();
  }
});

test("every video in the catalogue prices the same both ways", () => {
  let checked = 0;
  for (const m of MODELS) {
    if (m.kind === "image") continue;
    for (const res of m.resolutions) {
      for (const seconds of [3, 5, 8, 12]) {
        if (!m.durations.includes(seconds)) continue;
        for (const audio of [false, true]) {
          for (const hasVideoInput of [false, true]) {
            const old = estimateCostUsd(m.id, res, "16:9", seconds, 0, hasVideoInput, { audio });
            const tokens = estimateTokens(res, "16:9", seconds, 0);
            const now = estimateVideo(cr, m.id, res, seconds, tokens, costUsd, { audio, hasVideoInput });
            if (old == null) { expect(now).toBeNull(); continue; }
            expect(now).not.toBeNull();
            // The figure a person is charged, which is the one that matters.
            expect(charged(cr, now)).toBe(billCredits(old.net, m.id));
            checked += 1;
          }
        }
      }
    }
  }
  // A guard on the guard: a loop that checked nothing would pass silently.
  expect(checked).toBeGreaterThan(30);
});

test("60 fps and locked tasks price the same both ways", () => {
  let checked = 0;
  for (const m of MODELS) {
    if (!VENDOR_RATES[m.id]?.secondRates?.length) continue;
    for (const res of m.resolutions) {
      for (const opts of [{ fps60: true }, { task: "motion" as const }, { task: "upscale" as const }]) {
        const old = estimateCostUsd(m.id, res, "16:9", 5, 0, false, opts);
        const now = estimateVideo(cr, m.id, res, 5, null, costUsd, opts);
        if (old == null) { expect(now).toBeNull(); continue; }
        expect(charged(cr, now)).toBe(billCredits(old.net, m.id));
        checked += 1;
      }
    }
  }
  expect(checked).toBeGreaterThan(3);
});

test("every still prices the same both ways, references included", () => {
  let checked = 0;
  for (const m of MODELS) {
    const sizes = VENDOR_RATES[m.id]?.imagePricing;
    if (!sizes) continue;
    for (const size of Object.keys(sizes)) {
      for (const refs of [0, 1, 3]) {
        const old = estimateImageCostUsd(m.id, size, refs);
        const now = estimateImage(cr, m.id, size, refs);
        if (old == null) { expect(now).toBeNull(); continue; }
        expect(charged(cr, now)).toBe(billCredits(old.net, m.id));
        checked += 1;
      }
    }
  }
  expect(checked).toBeGreaterThan(10);
});

test("a workspace on its own keys is quoted its vendor's dollars, unrounded", () => {
  /* Dollars are what leaves its account, to the cent. Rounding them up to
     whole units would be quoting it in a currency it does not spend. */
  const usd = buildRateTable("usd");
  expect(usd.unit).toBe("usd");
  for (const m of MODELS) {
    if (m.kind === "image") continue;
    for (const res of m.resolutions) {
      const old = estimateCostUsd(m.id, res, "16:9", 5, 0, false, {});
      const now = estimateVideo(usd, m.id, res, 5, estimateTokens(res, "16:9", 5, 0), costUsd, {});
      if (old == null) continue;
      expect(now).toBeCloseTo(old.net, 6);
      expect(charged(usd, now)).toBe(now);
    }
  }
});

test("the table carries no dollar figure a margin could be divided out of", () => {
  /* The point of the whole change. If a credit table still held a vendor
     rate, the arithmetic that §2 forbids would still be available. */
  const usd = buildRateTable("usd");
  for (const [id, rates] of Object.entries(cr.models)) {
    const dollars = usd.models[id];
    for (const [i, t] of (rates.secondRates ?? []).entries()) {
      expect(t.withoutAudio).not.toBeCloseTo(dollars.secondRates![i].withoutAudio, 9);
    }
    for (const [i, t] of (rates.tiers ?? []).entries()) {
      expect(t.withoutVideo).not.toBeCloseTo(dollars.tiers![i].withoutVideo, 9);
    }
  }
});
