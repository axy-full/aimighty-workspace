import { test, expect } from "@playwright/test";
import {
  IMAGE_AD_ASPECTS, IMAGE_AD_BUILDS, IMAGE_AD_MAX, IMAGE_AD_RESOLUTIONS, INITIAL_IMAGE_AD, PRESET_STILLS_MAX, imageAdBlock, imageAdBuild, imageAdMedias, imageAdRequest,
  imageAdRoom, imageAdSettings, mergePresets, presetGroup, presetShelves, qualityLabel, qualityOff, restoreImageAd, withBuild, withPreset, withProductStill, type ImageAdState, type PresetItem,
} from "../../lib/shell/image-ads";
import { MARKETING_CAPABILITIES, MARKETING_VARIANTS, marketingInput, marketingPath, marketingSettings } from "../../lib/higgsfieldMarketing";
import { MARKETING_BUILDS, marketingQualities, marketingQualityFor, type MarketingQuality } from "../../lib/workbench/moleculr";
import { MARKETING_IMAGE_MODEL_ID } from "../../lib/models";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import type { DispatchRequest } from "../../lib/workspace/generate-submit";

/**
 * Business › Image ads on Particl's API key (lib/shell/image-ads.ts):
 * Marketing Studio Image through the shared dispatch — 2.0 Alpha and the 2.5
 * builds Flare and Sunburst, as Moleculr names them — with the provider's
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

test("the builds are Moleculr's: 2.0 Alpha priced live, 2.5 Flare and Sunburst priced approximately, each with the qualities the server takes", () => {
  expect(IMAGE_AD_BUILDS.map((b) => [b.id, b.label, b.model, b.variant ?? null, b.approximate])).toEqual([
    ["alpha", "2.0 Alpha", MARKETING_IMAGE_MODEL_ID, null, false],
    ["flare", "2.5 Flare", MARKETING_IMAGE_MODEL_ID, "flare", true],
    ["sunburst", "2.5 Sunburst", MARKETING_IMAGE_MODEL_ID, "sunburst", true],
  ]);
  /* The same builds, names and order as Moleculr's picker and the server's variants. */
  expect(IMAGE_AD_BUILDS.map((b) => [b.id, b.label])).toEqual(MARKETING_BUILDS.map((b) => [b.id, b.label]));
  expect(IMAGE_AD_BUILDS.map((b) => b.id)).toEqual([...MARKETING_VARIANTS]);
  expect(imageAdBuild("not-a-build").id).toBe("alpha");
  /* The same qualities the server's own capability list names (lib/higgsfieldMarketing.ts), said the way Moleculr says them. */
  expect([...imageAdBuild("alpha").qualities]).toEqual([...MARKETING_CAPABILITIES.qualities]);
  for (const id of ["flare", "sunburst"]) expect([...imageAdBuild(id).qualities]).toEqual([...MARKETING_CAPABILITIES.qualities25]);
  expect(MARKETING_CAPABILITIES.qualities25.map(qualityLabel)).toEqual(marketingQualities("flare").map((q) => q.label));
  expect(qualityLabel("xhigh")).toBe("Extra high");
  /* A preset fixes the quality on 2.0 Alpha only. */
  expect(IMAGE_AD_BUILDS.map((b) => b.presetQuality)).toEqual(["high", null, null]);
  expect([...IMAGE_AD_RESOLUTIONS]).toEqual([...MARKETING_CAPABILITIES.resolutions]);
  expect([...IMAGE_AD_ASPECTS].sort()).toEqual([...MARKETING_CAPABILITIES.ratios].sort());
  expect(IMAGE_AD_MAX).toBe(MARKETING_CAPABILITIES.maxImages);
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
  expect(qualityOff(preset, "low")).toBe("On 2.0 Alpha, presets use high quality.");
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
  /* 2.0 Alpha is left unnamed, as every take before the 2.5 builds was. */
  expect(imageAdSettings(s)).not.toHaveProperty("variant");
});

test("a 2.5 build names its variant, offers extra high and max, and keeps the chosen quality with a preset; back on 2.0 Alpha the quality falls to what it takes", () => {
  const s: ImageAdState = { ...INITIAL_IMAGE_AD, prompt: "Bold hero shot on marble", productStill: still("p") };
  const flare = { ...withBuild(s, "flare"), quality: "xhigh" as const };
  expect(imageAdBlock(flare, ready)).toBeNull();
  expect(bodyOf(imageAdRequest(flare, { productionProjectId: "prod-1" })).marketing).toEqual({ variant: "flare", quality: "xhigh", enhancePrompt: false });
  /* A preset on 2.5 keeps the quality chosen, and no quality chip is off. */
  const sunburst = withPreset({ ...withBuild(s, "sunburst"), quality: "max" }, PRESET);
  expect(sunburst.quality).toBe("max");
  expect(imageAdSettings(sunburst)).toEqual({ variant: "sunburst", quality: "max", enhancePrompt: true, presetId: PRESET.id });
  for (const q of MARKETING_CAPABILITIES.qualities25) expect(qualityOff(sunburst, q), q).toBeNull();
  /* Back on 2.0 Alpha: max is not a 2.0 quality, and a preset runs at high. */
  expect(withBuild({ ...flare, quality: "max" }, "alpha")).toMatchObject({ build: "alpha", quality: "high" });
  expect(withBuild(sunburst, "alpha")).toMatchObject({ build: "alpha", quality: "high" });
  expect(withBuild({ ...flare, quality: "low" }, "alpha").quality).toBe("low");
  expect(imageAdSettings(withBuild(flare, "alpha"))).not.toHaveProperty("variant");
  /* On every build, at every quality, with and without a preset: the quality sent is Moleculr's rule, never a second one. */
  for (const build of IMAGE_AD_BUILDS)
    for (const quality of MARKETING_CAPABILITIES.qualities25)
      for (const preset of [null, PRESET]) {
        const state = withPreset({ ...withBuild(s, build.id), quality: quality as MarketingQuality }, preset);
        expect(imageAdSettings(state).quality, `${build.id} ${quality} ${preset ? "preset" : "plain"}`)
          .toBe(marketingQualityFor({ variant: build.id, quality: quality as MarketingQuality, enhancePrompt: Boolean(preset) }));
      }
});

test("what the composer sends is what the server's own checks accept, and a preset past its rule is refused there too", () => {
  const s: ImageAdState = { ...INITIAL_IMAGE_AD, prompt: "Bold hero shot on marble", productStill: still("p") };
  const plain = marketingSettings(imageAdSettings(s));
  expect(marketingInput("Bold hero shot on marble", s.aspect, s.resolution, plain, ["https://fixtures.particl.invalid/p.png"])).toMatchObject({ enhance_prompt: false, quality: "high" });
  const enhanced = marketingSettings(imageAdSettings({ ...withPreset(s, PRESET), medias: [still("m")] }));
  expect(marketingInput("Bold hero shot on marble", s.aspect, s.resolution, enhanced, ["https://fixtures.particl.invalid/p.png", "https://fixtures.particl.invalid/m.png"]))
    .toMatchObject({ enhance_prompt: true, preset_id: PRESET.id, quality: "high" });
  expect(() => marketingInput("x", s.aspect, s.resolution, enhanced, Array(3).fill("https://fixtures.particl.invalid/p.png"))).toThrow(/1–2/);
  /* Every build, quality and preset choice the composer can make passes the server's own settings check, on the build's own route. */
  for (const build of IMAGE_AD_BUILDS)
    for (const quality of build.qualities)
      for (const preset of [null, PRESET]) {
        const state = withPreset({ ...withBuild(s, build.id), quality }, preset);
        if (imageAdBlock(state, ready)) continue;
        const settings = marketingSettings(imageAdSettings(state));
        expect(settings.variant ?? "alpha", `${build.id} ${quality}`).toBe(build.id);
        expect(marketingPath(settings)).toBe(build.id === "alpha" ? "marketing-studio/image" : `marketing-studio/image/${build.id}`);
      }
  /* And the server refuses what 2.0 Alpha cannot take, so the composer never offers it. */
  expect(() => marketingSettings({ quality: "max", enhancePrompt: false })).toThrow(/2\.5 builds only/);
  expect(imageAdBlock({ ...s, quality: "max" }, ready)).toBe("Choose a supported quality.");
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
  /* A 2.5 draft comes back on its build, at its quality; a 2.5 quality on 2.0 Alpha does not. */
  const sunburst: ImageAdState = withPreset({ ...withBuild(s, "sunburst"), quality: "xhigh" }, PRESET);
  expect(restoreImageAd(JSON.parse(JSON.stringify(sunburst)))).toEqual(sunburst);
  expect(restoreImageAd({ build: "alpha", quality: "xhigh" })?.quality).toBe(INITIAL_IMAGE_AD.quality);
});
