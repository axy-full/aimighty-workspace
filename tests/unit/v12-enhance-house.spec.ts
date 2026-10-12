import { test, expect } from "@playwright/test";
import { goFigure } from "../../lib/shell/make-price";
import { makeQuote } from "../../lib/v12/make";
import { PAYS_AT_COST, priceDisplay } from "../../lib/v12/quote";
import { atomikPublicResponse } from "../../lib/workbench/atomik-response";
import { fmtLedgerUsd } from "../../lib/usageLedgerTerms";

/**
 * Enhance in the house workspace, which pays in dollars at cost (lib/houseWorkspace.ts; the same rules as the at-cost pricing of
 * Make: one total, an estimate shown as "up to", hovered "Pays at cost", never the customer price turned into dollars).
 * The enhancement is the text model's own estimate in dollars (the enhancer's quote carries it to the house alone).
 */
const base = { total: 7, count: 1, type: "image" as const, batchRequoted: false };
const env = { creditUsd: 0.1, dollars: (usd: number) => fmtLedgerUsd(usd) };

test("the button is the take's dollars plus the enhancement's, one total, 'up to', hovered 'Pays at cost'", () => {
  const fig = goFigure({ ...base, takeUsd: 0.4, enhanceCredits: 1, enhanceUsd: 0.0123 });
  expect(fig.usd).toBeCloseTo(0.4123, 6);
  expect(fig.value?.kind).toBe("up-to");
  const shown = priceDisplay(makeQuote(fig.value, { dollars: true, creditUsd: 0.1 }, fig.usd), undefined, env);
  expect(shown).toMatchObject({ state: "ready", kind: "up-to", title: PAYS_AT_COST });
  expect(shown?.text).toBe(`up to ${fmtLedgerUsd(0.4123)}`);
  /* Several takes: the take's dollars are per take; the enhancement is written once. */
  expect(goFigure({ ...base, count: 3, total: 21, takeUsd: 0.4, enhanceCredits: 1, enhanceUsd: 0.01 }).usd).toBeCloseTo(1.21, 6);
});

test("the house's enhancement counts even when it is 0 credits: nothing is billed in credits there, the dollars are the cost", () => {
  const fig = goFigure({ ...base, takeUsd: 0.4, enhanceCredits: 0, enhanceUsd: 0.02 });
  expect(fig.usd).toBeCloseTo(0.42, 6);
  expect(fig.value?.kind).toBe("up-to");
});

test("without both figures in dollars the house has no figure: never the customer price turned into dollars", () => {
  for (const o of [{ takeUsd: null, enhanceUsd: 0.01 }, { takeUsd: 0.4, enhanceUsd: null }]) {
    const fig = goFigure({ ...base, enhanceCredits: 1, ...o });
    expect(fig.usd).toBeNull();
    const shown = priceDisplay(makeQuote(fig.value, { dollars: true, creditUsd: 0.1 }, fig.usd), undefined, env);
    expect(shown?.state).toBe("error");
  }
  /* A batch quoted take by take has no single dollar figure either. */
  expect(goFigure({ ...base, takeUsd: 0.4, batchRequoted: true, enhanceCredits: 1, enhanceUsd: 0.01 }).usd).toBeNull();
});

test("a credit workspace is unchanged: credits of both, exact, no dollars", () => {
  const fig = goFigure({ ...base, takeUsd: null, enhanceCredits: 1, enhanceUsd: null });
  expect(fig).toMatchObject({ usd: null, value: { kind: "exact", credits: 8 } });
  expect(goFigure({ ...base, takeUsd: null, enhanceCredits: null, enhanceUsd: null })).toMatchObject({ usd: null, value: { kind: "exact", credits: 7 } });
  /* With Enhance off (no enhancement) the house's take is its own dollars alone, exact. */
  expect(goFigure({ ...base, takeUsd: 0.4, enhanceCredits: null, enhanceUsd: null })).toMatchObject({ usd: 0.4, value: { kind: "exact" } });
});

test("the enhancer's quote carries its dollars to the house alone", () => {
  const quote = { model: "m", effort: "auto", estimateCredits: 1, estimateUsd: 0.0123 };
  expect(atomikPublicResponse(quote, false)).toEqual(quote);
  expect(atomikPublicResponse(quote, true)).toEqual({ model: "m", effort: "auto", estimateCredits: 1 });
});
