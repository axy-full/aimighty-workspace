import { test, expect } from "@playwright/test";

process.env.ENGINE_MOCK = "1";

/** Identities (brief 1.3): the trigger rides on a cited name, and the prices before pressing are whole credits. */
test("a cited name becomes the identity's trigger, and training and a Flux still price in whole credits", async () => {
  const { promptWithTrigger, trainCostUsd, TRAIN_STEPS, RENDER_USD_PER_MP } = await import("../../lib/identities");
  const { billCredits } = await import("../../lib/creditTerms");
  const { estimateImageCostUsd } = await import("../../lib/models");
  const identity = { name: "Mara", trigger: "mara_prtcl" } as never;
  expect(promptWithTrigger("@Mara on a rooftop at dusk", identity)).toBe("mara_prtcl on a rooftop at dusk");
  expect(promptWithTrigger("a rooftop at dusk", identity)).toBe("mara_prtcl, a rooftop at dusk");
  expect(trainCostUsd(TRAIN_STEPS)).toBeGreaterThan(0);
  expect(billCredits(trainCostUsd(TRAIN_STEPS), "identity-training")).toBeGreaterThanOrEqual(1);
  expect(estimateImageCostUsd("fal-ai/flux-lora", "1K", 0)?.net).toBe(RENDER_USD_PER_MP);
  expect(billCredits(RENDER_USD_PER_MP, "fal-ai/flux-lora")).toBe(1); // 0.035 × 1.5 / 0.10 = 0.525 → 1 whole credit
});
