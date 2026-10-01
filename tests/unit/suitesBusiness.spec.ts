import { test, expect } from "@playwright/test";
import { consumerVideoInputSchema, consumerVideoOriginalResult, consumerVideoParams } from "../../lib/higgsfield-consumer/video-contract";
import { parseSetupItems } from "../../lib/higgsfield-consumer/marketing-setup";

/**
 * Business's Ads and Setup ran on the signed-in Higgsfield account, whose
 * sign-in is retired: their composers are gone (they are the retired card).
 * What stays until the account's server code goes is its contract: the video
 * input it validated, how a finished job is recognised, and how setup lists
 * are read.
 */

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
