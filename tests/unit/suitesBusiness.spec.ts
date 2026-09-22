import { test, expect } from "@playwright/test";
import {
  AD_DURATIONS, AD_MODES, INITIAL_ADS, INITIAL_IMAGE_ADS, SETUP_MODES, WHY, adsBlock, adsChipState, adsParameters, clampedDuration, imageAdsBlock,
  takesSetup, withAdReference, withMode, withSetup, type AdsState, NOT_ON_THIS_PATH } from "../../lib/shell/business";
import { consumerVideoInputSchema, consumerVideoOriginalResult, consumerVideoParams } from "../../lib/higgsfield-consumer/video-contract";
import { parseSetupItems } from "../../lib/higgsfield-consumer/marketing-setup";

const ready = { connected: true, hasProject: true };
const ugc: AdsState = { ...INITIAL_ADS, prompt: "Morning routine with the bottle.", productId: "p1" };

test("the nine modes are the account's slugs; five of them take a hook and a setting", () => {
  expect(AD_MODES.map((m) => m[0])).toEqual(["ugc", "ugc_how_to", "ugc_unboxing", "product_showcase", "product_review", "tv_spot", "wild_card", "ugc_virtual_try_on", "virtual_try_on"]);
  expect([...SETUP_MODES]).toEqual(["ugc", "ugc_how_to", "ugc_unboxing", "product_review", "ugc_virtual_try_on"]);
  expect(takesSetup("tv_spot")).toBe(false);
  expect([...AD_DURATIONS]).toEqual([15, 30]);
});

test("hooks and settings are off outside the UGC family and with an ad reference; an ad reference is off with a hook — with the reason, never hidden", () => {
  expect(adsChipState(ugc).hook).toEqual({ disabled: false, why: null });
  const tv = withMode({ ...ugc, hookId: "h1", settingId: "s1" }, "tv_spot");
  expect(tv.hookId).toBeNull(); expect(tv.settingId).toBeNull();
  expect(adsChipState(tv).hook).toEqual({ disabled: true, why: "Hooks are not for tv_spot." });
  const withRef = withAdReference({ ...ugc, hookId: "h1" }, "r1");
  expect(withRef.hookId).toBeNull();
  expect(adsChipState(withRef).hook).toEqual({ disabled: true, why: WHY.hookMode });
  expect(adsChipState(withRef).setting.why).toBe(WHY.settingMode);
  const withHook = withSetup(withRef, { hookId: "h2" });
  expect(withHook.adReferenceId).toBeNull();
  expect(adsChipState(withHook).adReference).toEqual({ disabled: true, why: WHY.adReference });
});

test("Generate ad says why it cannot run, in the prototype's words", () => {
  expect(adsBlock(ugc, ready)).toBeNull();
  expect(adsBlock({ ...ugc, prompt: " " }, ready)).toBe("Write the prompt.");
  expect(adsBlock(ugc, { ...ready, connected: false })).toBe("Connect the account in Workspace › Engines.");
  expect(adsBlock(ugc, { ...ready, hasProject: false })).toBe("Open a project first.");
});

test("the parameters are the catalogue's names, only what is set, clamped to the account's range", () => {
  expect(adsParameters(ugc)).toEqual({ mode: "ugc", aspect_ratio: "9:16", duration: 15, resolution: "720p", generate_audio: true, product_ids: ["p1"] });
  const full = adsParameters({ ...ugc, avatarId: "a1", hookId: "h1", settingId: "s1", duration: 30 }, { min: 4, max: 20 });
  expect(full).toMatchObject({ avatar_ids: ["a1"], hook_id: "h1", setting_id: "s1", duration: 20 });
  expect(clampedDuration({ ...ugc, duration: 30 }, { min: 4, max: 20 })).toBe(20);
  expect(clampedDuration(ugc, { min: 4, max: 20 })).toBeNull();
  /* Click-to-Ad and the other gateway-only fields never ride on this path: the tool's schema does not name them. */
  for (const name of NOT_ON_THIS_PATH) expect(Object.keys(adsParameters({ ...ugc, avatarId: "a1", hookId: "h1", settingId: "s1" }))).not.toContain(name.split(".")[0]);
  /* A hook never rides outside the family, whatever the state says. */
  expect(adsParameters({ ...ugc, mode: "tv_spot", hookId: "h1" })).not.toHaveProperty("hook_id");
  expect(adsParameters({ ...ugc, hookId: "h1", adReferenceId: "r1" })).not.toHaveProperty("hook_id");
});

test("Image ads needs a prompt or a reference, and a reference for aspect auto", () => {
  expect(imageAdsBlock(INITIAL_IMAGE_ADS, ready)).toBe("Write the prompt or add a reference.");
  expect(imageAdsBlock({ ...INITIAL_IMAGE_ADS, prompt: "Hero on marble", aspect: "auto" }, ready)).toBe("Aspect auto needs a reference still.");
  expect(imageAdsBlock({ ...INITIAL_IMAGE_ADS, prompt: "Hero on marble" }, ready)).toBeNull();
  /* DTC Ads (ms_image): a style is required and has no default; batch 1–20; up to four products. */
  const dtc = { ...INITIAL_IMAGE_ADS, engine: "ms_image" as const, prompt: "Hero on marble" };
  expect(imageAdsBlock(dtc, ready)).toBe("Pick a style — the ad format. DTC Ads has no default.");
  expect(imageAdsBlock({ ...dtc, styleId: "st1", batch: 21 }, ready)).toBe("Batch is 1–20 images per job.");
  expect(imageAdsBlock({ ...dtc, styleId: "st1", productIds: ["a", "b", "c", "d", "e"] }, ready)).toBe("Up to 4 products.");
  expect(imageAdsBlock({ ...dtc, styleId: "st1", batch: 4, productIds: ["a"] }, ready)).toBeNull();
});

test("the widened video contract carries the setup ids and enforces both server rules", () => {
  const base = { prompt: "A bottle.", duration: 15, resolution: "720p", aspectRatio: "9:16", generateAudio: true, mode: "ugc" as const };
  const ok = consumerVideoInputSchema.safeParse({ ...base, productIds: ["p1"], avatars: [{ id: "a1", type: "preset" }], hookId: "h1", settingId: "s1", medias: [{ id: "11111111-1111-4111-8111-111111111111", role: "start_image" }] });
  expect(ok.success).toBe(true);
  expect(consumerVideoInputSchema.safeParse({ ...base, productIds: ["p1"], webProductIds: ["w1"] }).success).toBe(false);
  expect(consumerVideoInputSchema.safeParse({ ...base, hookId: "h1", adReferenceId: "r1" }).success).toBe(false);
  expect(consumerVideoInputSchema.safeParse({ ...base, mode: "tv_spot", hookId: "h1" }).success).toBe(false);
  expect(consumerVideoInputSchema.safeParse({ ...base, duration: 30, resolution: "1080p" }).success).toBe(true);
  const params = consumerVideoParams(ok.data!, false) as Record<string, unknown>;
  expect(params).toMatchObject({ product_ids: ["p1"], avatars: [{ id: "a1", type: "preset" }], hook_id: "h1", setting_id: "s1", medias: [{ value: "11111111-1111-4111-8111-111111111111", role: "start_image" }] });
  expect(consumerVideoParams(consumerVideoInputSchema.parse(base), true)).not.toHaveProperty("product_ids");
});

test("a finished job carrying exactly the ids and medias we sent is recognised; one carrying anything else is not", () => {
  const job = "3f2c1a4e-9b7d-4c1e-8a2b-5d6e7f8a9b0c";
  const input = consumerVideoInputSchema.parse({ prompt: "A bottle.", duration: 15, resolution: "720p", aspectRatio: "9:16", generateAudio: true, mode: "ugc", productIds: ["p1"], hookId: "h1", medias: [{ id: "11111111-1111-4111-8111-111111111111", role: "image" }] });
  const reply = (params: Record<string, unknown>) => ({ status: "completed", job_id: job, raw_data: { id: job, status: "completed", job_set_type: "marketing_studio_video", result_url: "https://cdn.test/out.mp4", params } });
  const sent = { prompt: "A bottle.", duration: 15, resolution: "720p", aspect_ratio: "9:16", generate_audio: true, mode: "ugc", product_ids: ["p1"], hook_id: "h1", medias: [{ value: "11111111-1111-4111-8111-111111111111", role: "image" }], count: 1, use_unlim: false };
  expect(consumerVideoOriginalResult(reply(sent), job, input)).toEqual({ url: "https://cdn.test/out.mp4" });
  expect(consumerVideoOriginalResult(reply({ ...sent, product_ids: ["p2"] }), job, input)).toBeNull();
  expect(consumerVideoOriginalResult(reply({ ...sent, setting_id: "s9" }), job, input)).toBeNull();
  expect(consumerVideoOriginalResult(reply({ ...sent, medias: [] }), job, input)).toBeNull();
  /* The plain job the older flow sends is still recognised. */
  const plain = consumerVideoInputSchema.parse({ prompt: "A bottle.", duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true, mode: "product_showcase" });
  expect(consumerVideoOriginalResult(reply({ prompt: "A bottle.", duration: 15, resolution: "720p", aspect_ratio: "16:9", generate_audio: true, mode: "product_showcase", medias: [], avatars: [], products: [], count: 1, use_unlim: false }), job, plain)).toEqual({ url: "https://cdn.test/out.mp4" });
});

test("setup items are read from whatever list key the account uses, never invented", () => {
  const hooks = parseSetupItems({ items: [{ id: "h1", name: "Stop scrolling", prompt: "Stop scrolling — this changed my mornings", source: "preset" }, { id: "h2", prompt: "Three things nobody tells you" }, { nope: true }] }, "hook");
  expect(hooks.map((h) => [h.id, h.name])).toEqual([["h1", "Stop scrolling"], ["h2", "Three things nobody tells you"]]);
  expect(hooks[0].meta).toBe("hook · preset · prepended to the prompt");
  expect(parseSetupItems({ results: [{ uuid: "p1", title: "Sneaker Runner", status: "completed", image_url: "https://cdn.test/p.jpg" }] }, "product")[0]).toMatchObject({ id: "p1", name: "Sneaker Runner", previewUrl: "https://cdn.test/p.jpg" });
  expect(parseSetupItems("nothing", "avatar")).toEqual([]);
  expect(parseSetupItems({ items: [{ id: "x", url: "http://insecure/preview.jpg" }] }, "brand_kit")[0].previewUrl).toBeNull();
});
