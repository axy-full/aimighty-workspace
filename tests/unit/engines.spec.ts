import { test, expect } from "@playwright/test";

process.env.ENGINE_MOCK = "1";

/** Every vendor has an adapter with the one interface, and the estimates agree with the catalogue. */
test("every provider has an adapter, and the adapters estimate what the catalogue says", async () => {
  const { ENGINES, engineFor, enginesFor } = await import("../../lib/engines");
  const { PROVIDERS } = await import("../../lib/providers");
  const { getModel, DEFAULT_MODEL_ID } = await import("../../lib/models");
  const { estimateCostUsd, estimateImageCostUsd } = await import("../../lib/vendorPricing");
  const { getTask } = await import("../../lib/tasks");
  for (const p of PROVIDERS) {
    const e = ENGINES[p.id];
    expect(e, p.id).toBeTruthy();
    expect(e.id).toBe(p.id);
    expect(e.kinds.length).toBeGreaterThan(0);
    expect(typeof e.estimate).toBe("function");
    expect(typeof e.render).toBe("function");
    // Availability gates belong to individual models (Soul), not the shared provider.
    expect(e.configured()).toBe(true);
  }
  expect(enginesFor("video").map((e) => e.id).sort()).toEqual(["byteplus", "fal", "higgsfield", "xai"]);
  expect(enginesFor("text").map((e) => e.id)).toEqual(["vercel"]);
  expect(() => engineFor("nope")).toThrow();

  const model = getModel(DEFAULT_MODEL_ID);
  const params = { resolution: "1080p", ratio: "16:9", duration: 5, generateAudio: true, watermark: false, fps60: false } as never;
  const est = ENGINES.byteplus.estimate({ kind: "video", genId: "g", model, task: getTask("generate"), prompt: "x", params, references: [], source: null });
  expect(est).toBe(estimateCostUsd(model.id, "1080p", "16:9", 5, 0, false, { audio: true, task: "generate", fps60: false })?.net ?? null);
  expect(est).toBeGreaterThan(0);
  const still = getModel("gemini-3-pro-image");
  const estStill = ENGINES.google.estimate({ kind: "image", genId: "g", model: still, prompt: "x", ratio: "16:9", size: "1K", references: [] });
  expect(estStill).toBe(estimateImageCostUsd(still.id, "1K", 0)?.net ?? null);
  expect(ENGINES.elevenlabs.estimate({ kind: "audio", genId: "g", modelId: "eleven_sfx", task: "sound", text: "wind", params: {} })).toBeGreaterThan(0);
  expect(ENGINES.vercel.estimate({ kind: "audio", genId: "g", modelId: "x", task: "sound", text: "", params: {} })).toBeNull();
});
