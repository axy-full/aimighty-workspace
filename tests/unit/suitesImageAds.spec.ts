import { test, expect } from "@playwright/test";
import {
  IMAGE_AD_ASPECTS, IMAGE_AD_BUILDS, IMAGE_AD_MAX, IMAGE_AD_RESOLUTIONS, INITIAL_IMAGE_AD, PRESET_STILLS_MAX, imageAdBlock, imageAdBuild, imageAdMedias, imageAdRequest,
  imageAdRoom, imageAdSettings, mergePresets, presetGroup, presetShelves, qualityOff, restoreImageAd, withPreset, withProductStill, type ImageAdState, type PresetItem,
} from "../../lib/shell/image-ads";
import { PRESET_TYPES } from "../../lib/shell/business";
import { MARKETING_CAPABILITIES, marketingInput, marketingSettings } from "../../lib/higgsfieldMarketing";
import { MARKETING_IMAGE_MODEL_ID } from "../../lib/models";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import type { DispatchRequest } from "../../lib/workspace/generate-submit";

/**
 * Business › Image ads on Particl's API key (lib/shell/image-ads.ts):
 * Marketing Studio Image through the shared dispatch, with the provider's
 * preset catalogue on shelves. Pure rules, the exact body, and what the
 * server's own settings check accepts.
 */
const still = (id: string, origin: "upload" | "generation" = "upload") => ({ id: `${origin}:${id}`, name: `${id}.png`, sourceId: id, origin, url: `/api/${origin === "upload" ? "uploads" : "media"}/${id}` });
const ready = { hasProject: true, saved: true };
const PRESET = { id: "0b9f3c2e-6a1d-4c8e-9f7a-2d5e8c1b4a60", name: "Studio packshot" };
const bodyOf = (request: DispatchRequest) => {
  if (!("input" in request) || !request.input) throw new Error("A generate request.");
  return generationRequestBody(request.input);
};

test("the builds are a list: 2.0 today, the key model, and the sizes and aspects the model takes", () => {
  expect(IMAGE_AD_BUILDS.map((b) => [b.id, b.label, b.model])).toEqual([["alpha", "Image 2.0", MARKETING_IMAGE_MODEL_ID]]);
  expect(imageAdBuild("not-a-build").id).toBe("alpha");
  /* The same choices the server's own capability list names (lib/higgsfieldMarketing.ts). */
  expect([...IMAGE_AD_BUILDS[0].qualities]).toEqual([...MARKETING_CAPABILITIES.qualities]);
  expect([...IMAGE_AD_RESOLUTIONS]).toEqual([...MARKETING_CAPABILITIES.resolutions]);
  expect([...IMAGE_AD_ASPECTS].sort()).toEqual([...MARKETING_CAPABILITIES.ratios].sort());
  expect(IMAGE_AD_MAX).toBe(MARKETING_CAPABILITIES.maxImages);
  /* Image ads takes nothing from the connected account's setup, so Setup offers it nothing. */
  expect(PRESET_TYPES.dtc).toEqual([]);
});

test("Generate image says why it cannot run, in order", () => {
  const base: ImageAdState = { ...INITIAL_IMAGE_AD, prompt: "Bold hero shot on marble" };
  expect(imageAdBlock(base, { ...ready, hasProject: false })).toBe("Open a project first.");
  expect(imageAdBlock(base, { ...ready, saved: false })).toBe("Save this project first.");
  expect(imageAdBlock({ ...base, prompt: "  " }, ready)).toBe("Write the prompt.");
  expect(imageAdBlock({ ...base, prompt: "x".repeat(5001) }, ready)).toBe("Keep the prompt under 5,000 characters.");
  expect(imageAdBlock(base, ready)).toBeNull();
  /* A preset starts from the product, and takes one more still at most. */
  const preset = withPreset(base, PRESET);
  expect(imageAdBlock(preset, ready)).toBe("A preset starts from the product still. Add the product.");
  expect(imageAdBlock(withProductStill(preset, still("p")), ready)).toBeNull();
  expect(imageAdBlock({ ...withProductStill(preset, still("p")), medias: [still("m1"), still("m2")] }, ready)).toBe("A preset takes the product still and one more still at most.");
  expect(imageAdBlock({ ...base, medias: Array.from({ length: IMAGE_AD_MAX + 1 }, (_, i) => still(`s${i}`)) }, ready)).toBe("Up to 16 reference stills.");
  expect(imageAdBlock({ ...base, aspect: "4:5" }, ready)).toBe("Choose a supported aspect and size.");
  expect(imageAdBlock({ ...base, quality: "max" }, ready)).toBe("Choose a supported quality.");
});

test("the product rides first, each still once; a preset holds the well to one more and runs at the build's quality", () => {
  let s: ImageAdState = { ...INITIAL_IMAGE_AD, medias: [still("p"), still("g1", "generation")] };
  s = withProductStill(s, still("p"));
  expect(imageAdMedias(s).map((m) => m.id)).toEqual(["upload:p", "generation:g1"]);
  expect(imageAdRoom(s)).toBe(IMAGE_AD_MAX - 2);
  const preset = withPreset({ ...s, quality: "low" }, PRESET);
  expect(preset.quality).toBe("high");
  expect(imageAdRoom(preset)).toBe(PRESET_STILLS_MAX - 2);
  expect(qualityOff(preset, "low")).toBe("A preset runs at high quality on Image 2.0.");
  expect(qualityOff(preset, "high")).toBeNull();
  expect(qualityOff(s, "low")).toBeNull();
  /* Clearing the preset keeps the quality where it is. */
  expect(withPreset(preset, null)).toMatchObject({ preset: null, quality: "high" });
});

test("the request is Marketing Studio Image on the key, filed to the project with no shot, the stills by identity", () => {
  const s: ImageAdState = { ...INITIAL_IMAGE_AD, prompt: " Bold hero shot on marble ", aspect: "3:4", resolution: "4k", quality: "medium", productStill: still("p"), medias: [still("g1", "generation")] };
  expect(bodyOf(imageAdRequest(s, { productionProjectId: "prod-1" }))).toEqual({
    prompt: "Bold hero shot on marble", model: MARKETING_IMAGE_MODEL_ID, projectId: "prod-1", ratio: "3:4", resolution: "4k", refine: false,
    references: [{ uploadId: "p", role: "reference_image" }, { genId: "g1", role: "reference_image" }],
    marketing: { quality: "medium", enhancePrompt: false },
  });
  const request = imageAdRequest(s, { productionProjectId: "prod-1" });
  if (!("input" in request) || !request.input) throw new Error("A generate request.");
  expect(generationRequestBody({ ...request.input, maxCredits: 9, quoteFingerprint: "f".repeat(64) })).toMatchObject({ maxCredits: 9, quoteFingerprint: "f".repeat(64) });
  /* With a preset: enhancement on, the preset named, at the build's quality. */
  const preset = withPreset(s, PRESET);
  expect(imageAdSettings(preset)).toEqual({ quality: "high", enhancePrompt: true, presetId: PRESET.id });
  /* No build today names a variant, so none is sent. */
  expect(imageAdSettings(s)).not.toHaveProperty("variant");
});

test("what the composer sends is what the server's own checks accept, and a preset past its rule is refused there too", () => {
  const s: ImageAdState = { ...INITIAL_IMAGE_AD, prompt: "Bold hero shot on marble", productStill: still("p") };
  const plain = marketingSettings(imageAdSettings(s));
  expect(marketingInput("Bold hero shot on marble", s.aspect, s.resolution, plain, ["https://fixtures.particl.invalid/p.png"])).toMatchObject({ enhance_prompt: false, quality: "high" });
  const enhanced = marketingSettings(imageAdSettings({ ...withPreset(s, PRESET), medias: [still("m")] }));
  expect(marketingInput("Bold hero shot on marble", s.aspect, s.resolution, enhanced, ["https://fixtures.particl.invalid/p.png", "https://fixtures.particl.invalid/m.png"]))
    .toMatchObject({ enhance_prompt: true, preset_id: PRESET.id, quality: "high" });
  expect(() => marketingInput("x", s.aspect, s.resolution, enhanced, Array(3).fill("https://fixtures.particl.invalid/p.png"))).toThrow(/1–2/);
});

test("the catalogue sits on the provider's own shelves, in its order, each preset once", () => {
  const item = (id: string, fields: Partial<PresetItem> = {}): PresetItem => ({ id, name: id, type: "ads", ...fields });
  const items = [
    item("a", { group: "Product shots", cover: "https://cdn.example/a.webp", aspectRatio: "1:1" }),
    item("b", { group: "Graphic ads" }),
    item("c", { group: "Product shots" }),
    item("d", { type: "marketplace_design" }),
    item("e", { type: "" }),
  ];
  expect(presetShelves(items).map((shelf) => [shelf.group, shelf.items.map((p) => p.id)])).toEqual([
    ["Product shots", ["a", "c"]], ["Graphic ads", ["b"]], ["Marketplace design", ["d"]], ["Other", ["e"]],
  ]);
  expect(presetGroup({ group: "  ", type: "graphic-ads" })).toBe("Graphic ads");
  expect(mergePresets(items.slice(0, 2), [item("b"), item("f")]).map((p) => p.id)).toEqual(["a", "b", "f"]);
});

test("the draft comes back field by field; anything that does not read cleanly falls back, and the rules hold on the way in", () => {
  const s: ImageAdState = withPreset({ ...INITIAL_IMAGE_AD, prompt: "Hero", aspect: "9:16", resolution: "1k", quality: "low", productStill: still("p"), medias: [still("m")] }, PRESET);
  expect(restoreImageAd(JSON.parse(JSON.stringify(s)))).toEqual(s);
  expect(restoreImageAd({ build: "nope", prompt: 7, aspect: "wide", resolution: "8k", quality: "max", preset: { id: "not-a-uuid", name: "x" }, productStill: { ...still("x"), url: "javascript:alert(1)" }, medias: [{ id: "file:/etc", name: "x" }] }))
    .toEqual(INITIAL_IMAGE_AD);
  /* A still restored twice (product and well) rides once. */
  expect(restoreImageAd({ productStill: still("p"), medias: [still("p"), still("m")] })?.medias.map((m) => m.id)).toEqual(["upload:m"]);
  expect(restoreImageAd(null)).toBeNull();
});
