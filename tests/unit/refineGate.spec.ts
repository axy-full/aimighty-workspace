import { test, expect } from "@playwright/test";
import { shouldRefine, promptRichness, estimateRefineUsd, rateFor, SYSTEM_TOKENS, OUT_TOKENS } from "../../lib/refineGate";
import { billCredits } from "../../lib/creditTerms";

/** The writer's gate and price, on the client (brief 1.8): it runs only for an idea too thin to film, and one call is priced before pressing. */
test("the gate: raw and structured prompts never refine; a thin idea does; a filmable one does not", () => {
  expect(shouldRefine("raw: whatever").refine).toBe(false);
  expect(shouldRefine("【scene】 a street").refine).toBe(false);
  expect(shouldRefine("wet silk, sea, dusk", 0).refine).toBe(false); // "dusk" is a light signal: the words already carry an axis
  expect(shouldRefine("a courier", 0)).toEqual(expect.objectContaining({ refine: true, why: "too thin to film" }));
  expect(shouldRefine("a courier", 1).refine).toBe(false);
  expect(shouldRefine("a courier crosses a flooded street in a storm at dusk, wide shot, static camera").refine).toBe(false);
  expect(promptRichness("golden hour, 35mm, handheld").score).toBe(3);
});

test("one writer call is priced from the model's rates, and lands as a whole credit", () => {
  const usd = estimateRefineUsd("anthropic/claude-sonnet-5", 60, 1500)!;
  const rate = rateFor("anthropic/claude-sonnet-5")!;
  const expected = ((SYSTEM_TOKENS + Math.ceil(1500 / 4) + Math.ceil(60 / 4)) * rate.input + OUT_TOKENS * rate.output) / 1e6;
  expect(Math.abs(usd - expected)).toBeLessThan(1e-4);
  expect(usd).toBeGreaterThan(0.001); expect(usd).toBeLessThan(0.05);
  expect(billCredits(usd, "text")).toBe(1);
  expect(estimateRefineUsd("claude-sonnet-5", 60)).toBe(estimateRefineUsd("anthropic/claude-sonnet-5", 60));
  expect(estimateRefineUsd("nope", 60)).toBeNull();
});
