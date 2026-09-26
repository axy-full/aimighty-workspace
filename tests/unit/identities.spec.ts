import { test, expect } from "@playwright/test";

process.env.ENGINE_MOCK = "1";

/** Identities (brief 1.3): the trigger rides on a cited name, and the prices before pressing are whole credits. */
test("a cited name becomes the identity's trigger, and training and a Flux still price in whole credits", async () => {
  const { promptWithTrigger, trainCostUsd, TRAIN_STEPS, RENDER_USD_PER_MP } = await import("../../lib/identities");
  const { billCredits } = await import("../../lib/creditTerms");
  const { estimateImageCostUsd } = await import("../../lib/vendorPricing");
  const identity = { name: "Mara", trigger: "mara_prtcl" } as never;
  expect(promptWithTrigger("@Mara on a rooftop at dusk", identity)).toBe("mara_prtcl on a rooftop at dusk");
  expect(promptWithTrigger("a rooftop at dusk", identity)).toBe("mara_prtcl, a rooftop at dusk");
  expect(trainCostUsd(TRAIN_STEPS)).toBeGreaterThan(0);
  expect(billCredits(trainCostUsd(TRAIN_STEPS), "identity-training")).toBeGreaterThanOrEqual(1);
  expect(estimateImageCostUsd("fal-ai/flux-lora", "1K", 0)?.net).toBe(RENDER_USD_PER_MP);
  expect(billCredits(RENDER_USD_PER_MP, "fal-ai/flux-lora")).toBe(1); // 0.035 × 1.5 / 0.10 = 0.525 → 1 whole credit
});

/* fal bills the renderer per megapixel, rounded up: a size just over one is two. The quote,
   the reservation and the bill all come from the same pixels, at every ratio. */
test("a trained still is quoted, reserved and billed alike at every ratio, the square included", async () => {
  const { RENDER_RATIOS, RENDER_USD_PER_MP, renderSizeFor, renderUsd, renderUsdForRatio } = await import("../../lib/identities");
  for (const ratio of RENDER_RATIOS) {
    const { width, height } = renderSizeFor(ratio);
    expect(width * height, ratio).toBeLessThanOrEqual(1_000_000);
    expect(renderUsdForRatio(ratio), ratio).toBe(renderUsd(width, height));
    expect(renderUsdForRatio(ratio), ratio).toBe(RENDER_USD_PER_MP);
  }
  expect(renderSizeFor("1:1")).toMatchObject({ width: 992, height: 992 });
  expect(renderSizeFor("21:9")).toEqual(renderSizeFor("16:9"));
  /* fal's square_hd preset is 1024 × 1024 = 1.05 MP, which is billed as two. */
  expect(renderUsd(1024, 1024)).toBe(Math.round(2 * RENDER_USD_PER_MP * 10_000) / 10_000);
});
