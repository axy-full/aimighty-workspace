import { test, expect } from "@playwright/test";
import type { Generation } from "../../lib/jobs";
import { renderTakeOf } from "../../components/v12/make/use-results";
import { batchSummary, renderState } from "../../lib/v12/renderState";

/**
 * What a failed take is said to have cost (components/v12/make/use-results.ts renderTakeOf; review of #633): "nothing billed" only
 * when a ledger or the provider confirmed it, the rule the Takes page uses (lib/errors.ts failureUncharged). A hold that still
 * stands is not a charge, and a recorded zero alone is not proof.
 */
const failed = (over: Partial<Generation> = {}): Generation => ({
  id: "g1", status: "failed", kind: "video", model: "fal-ai/kling-video/v3/standard", provider: "fal", createdAt: 0, params: {}, creditsBilled: 0, costUsd: null,
  failure: null, ...over,
}) as unknown as Generation;
const failure = (over: Record<string, unknown>) => ({ provider: "fal", stage: null, code: "x", kind: "provider_error", message: null, billing: null, payer: "platform", ...over }) as Generation["failure"];
const metaOf = (g: Generation) => { const state = renderState(renderTakeOf(g, null, false), 60_000); return { state, meta: batchSummary([{ name: "Shot 3", state }]) }; };

test("a hold that still stands is not 'nothing billed': the figure is unknown, so the meta says only that it did not finish", () => {
  const g = failed({ failure: failure({ charge: { credits: 7, settled: false } }) });
  expect(renderTakeOf(g, null, false).charged).toBeNull();
  const { state, meta } = metaOf(g);
  expect(state.nothingBilled).toBe(false);
  expect(meta).toContain("Shot 3 didn’t finish");
  expect(meta).not.toMatch(/nothing billed/i);
  expect(state.money?.text).not.toMatch(/nothing billed/i);
});

test("a recorded zero alone is not proof: with no ledger and no provider word, nothing is claimed", () => {
  const g = failed({ creditsBilled: 0, failure: failure({}) });
  expect(renderTakeOf(g, null, false).charged).toBeNull();
  expect(metaOf(g).meta).not.toMatch(/nothing billed/i);
  expect(renderTakeOf(failed({ failure: null }), null, false).charged).toBeNull();
});

test("'nothing billed' when the ledger settled at nothing, or the provider refunded or did not charge", () => {
  for (const f of [failure({ charge: { credits: 0, settled: true } }), failure({ billing: { state: "refunded" } }), failure({ billing: { state: "not_charged" } })]) {
    const g = failed({ failure: f });
    expect(renderTakeOf(g, null, false).charged).toEqual({ amount: 0, unit: "cr" });
    expect(metaOf(g).meta).toContain("Shot 3 didn’t finish · nothing billed");
  }
});

test("a charge the ledger settled is said as a charge, never as nothing", () => {
  const g = failed({ failure: failure({ charge: { credits: 7, settled: true } }) });
  expect(renderTakeOf(g, null, false).charged).toEqual({ amount: 7, unit: "cr" });
  expect(metaOf(g).meta).not.toMatch(/nothing billed/i);
  expect(metaOf(g).state.money?.text).toMatch(/^Didn’t finish · 7 cr charged/);
});

test("a workspace paying in dollars is told nothing unless its provider confirmed: a recorded zero cost is not proof", () => {
  expect(renderTakeOf(failed({ costUsd: 0, failure: failure({}) }), null, true).charged).toBeNull();
  expect(renderTakeOf(failed({ costUsd: 0.4, failure: failure({}) }), null, true).charged).toEqual({ amount: 0.4, unit: "usd" });
  expect(renderTakeOf(failed({ failure: failure({ billing: { state: "not_charged" } }) }), null, true).charged).toEqual({ amount: 0, unit: "usd" });
});
