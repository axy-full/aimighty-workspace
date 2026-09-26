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

/* The table above is only half of it: fal draws what the request body names. A preset
   is resolved by fal's own sizes, so a square sent as square_hd (1024 × 1024) fails here
   even if the table still says 992. */
const FAL_PRESETS: Record<string, { width: number; height: number }> = {
  square_hd: { width: 1024, height: 1024 },
  square: { width: 512, height: 512 },
  portrait_4_3: { width: 768, height: 1024 },
  portrait_16_9: { width: 576, height: 1024 },
  landscape_4_3: { width: 1024, height: 768 },
  landscape_16_9: { width: 1024, height: 576 },
};
test("the size fal is asked for is the size quoted, under one megapixel at every ratio", async () => {
  const { RENDER_RATIOS, renderInput, renderSizeFor } = await import("../../lib/identities");
  const identity = { name: "Mara", trigger: "mara_prtcl", loraUrl: "https://example.invalid/lora.safetensors" } as never;
  for (const ratio of RENDER_RATIOS) {
    const asked = renderInput(identity, { prompt: "mara_prtcl on a rooftop", ratio, seed: null }).image_size;
    const drawn = typeof asked === "string" ? FAL_PRESETS[asked] : asked;
    expect(drawn, `${ratio}: ${JSON.stringify(asked)}`).toBeTruthy();
    expect(drawn.width * drawn.height, ratio).toBeLessThanOrEqual(1_000_000);
    expect(drawn, ratio).toEqual({ width: renderSizeFor(ratio).width, height: renderSizeFor(ratio).height });
  }
  expect(renderInput(identity, { prompt: "p", ratio: "1:1", seed: 7 }).image_size).toEqual({ width: 992, height: 992 });
});
