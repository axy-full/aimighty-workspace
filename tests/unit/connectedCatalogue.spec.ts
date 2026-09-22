import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  CatalogueError,
  effectiveParameters,
  GAME_PIPELINE_ONLY_MODELS,
  findCatalogueModel,
  isStandaloneModel,
  listCatalogueModels,
  mediaKindForRole,
  consumerEchoedMediaMatches,
  consumerEchoedMediasMatch,
  ECHOED_MEDIA_EXTRA_LIMIT,
  echoedMediaTypeAccepted,
  ECHOED_MEDIA_TYPES,
  modelVoiceParameters,
  parseConnectedCatalogue,
  parseConnectedModel,
  validateGenerationRequest,
  type ConnectedModel,
} from "../../lib/higgsfield-consumer/catalogue";
import { RECORDED_MEDIA_DATA_TYPES, echoedInjectedVoice, echoedMedia, echoedMediaVideoInput } from "../fixtures/connectedStatusEnvelopes";
import {
  consumerGenerationInputSchema,
  consumerGenerationParams,
  consumerGenerationOriginalResult,
  consumerGenerationFailureResult,
  consumerGenerationEnhancedPrompt,
} from "../../lib/higgsfield-consumer/generation-contract";
import { connectedEnhancedPrompt, type ConnectedJob } from "../../lib/higgsfield-consumer/generation-client";

const raw = JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8"));
const catalogue = parseConnectedCatalogue(raw, 1_000);
const model = (id: string) => findCatalogueModel(catalogue, id)!;
const media = "44444444-4444-4444-8444-444444444444";

test("the captured models_explore catalogue parses into 98 typed models with provider names removed from copy", () => {
  expect(catalogue.models).toHaveLength(98);
  expect(catalogue.complete).toBe(true);
  expect(catalogue.unlim).toEqual({ available: false, remaining: null, expiresAt: null });
  expect(listCatalogueModels(catalogue, { type: "image" })).toHaveLength(34);
  expect(listCatalogueModels(catalogue, { type: "video" })).toHaveLength(41);
  expect(listCatalogueModels(catalogue, { type: "3d" })).toHaveLength(17);
  // Six audio models are listed; three are reserved for the game pipeline.
  expect(catalogue.models.filter((m) => m.outputType === "audio")).toHaveLength(6);
  expect(listCatalogueModels(catalogue, { type: "audio" })).toHaveLength(3);
  expect(listCatalogueModels(catalogue)).toHaveLength(95);
  for (const entry of catalogue.models) {
    expect(entry.name.toLowerCase()).not.toContain("higgsfield");
    expect(entry.description.toLowerCase()).not.toContain("higgsfield");
    expect(entry).not.toHaveProperty("providerName");
  }
  expect(model("soul_2").name).toBe("Persona 2.0");
  expect(model("seedance_2_0_mini").name).toBe("Motion 2.0 Mini");
  expect(model("veo3_1").name).toBe("Vista 3.1");
  expect(model("soul_2").supportsUnlim).toBe(true);
  expect(model("kling3_0").aspectRatios).toEqual(["16:9", "9:16", "1:1"]);
  expect(model("sam_3_3d").medias).toEqual([{ name: "medias", roles: ["image"], max: 1, required: true, description: "Single image of the object to lift into 3D (role: image)." }]);
  expect(model("seed_audio").parameters.find((p) => p.name === "sample_rate")).toMatchObject({ type: "number", options: [8000, 16000, 24000, 32000, 44100, 48000], default: 24000 });
  expect(model("ms_image").parameters.find((p) => p.name === "product_ids")).toMatchObject({ type: "string_array", maxItems: 4 });
});

test("aspect ratios and durations become validated settings beside the declared parameters", () => {
  const kling = effectiveParameters(model("kling3_0"));
  expect(kling.find((p) => p.name === "aspect_ratio")).toMatchObject({ synthetic: true, options: ["16:9", "9:16", "1:1"] });
  expect(kling.find((p) => p.name === "duration")).toMatchObject({ type: "number", min: 3, max: 15 });
  expect(kling.filter((p) => p.name === "duration")).toHaveLength(1);
  const ranged = catalogue.models.find((m) => m.durationRange)!;
  expect(effectiveParameters(ranged).find((p) => p.name === "duration")).toMatchObject({ synthetic: true, min: ranged.durationRange!.min, max: ranged.durationRange!.max });
  expect(effectiveParameters(model("sam_3_3d")).some((p) => p.name === "aspect_ratio")).toBe(false);
  expect(mediaKindForRole("video_references")).toBe("video");
  expect(mediaKindForRole("audio_references")).toBe("audio");
  expect(mediaKindForRole("start_image")).toBe("image");
  expect(mediaKindForRole("mask")).toBe("image");
});

test("requests are validated against the model before any provider call; undeclared or reserved settings are rejected", () => {
  const kling = model("kling3_0");
  const base = { type: "video" as const, model: "kling3_0", prompt: "A slow push in on a bottle.", parameters: {}, medias: [] };
  expect(validateGenerationRequest(kling, { ...base, parameters: { duration: 10, mode: "pro", sound: "off", aspect_ratio: "9:16" } })).toEqual({ duration: 10, mode: "pro", sound: "off", aspect_ratio: "9:16" });
  const failures: [Record<string, unknown>, string][] = [
    [{ parameters: { resolution: "4k" } }, "parameter_unknown"],
    [{ parameters: { get_cost: false } }, "parameter_reserved"],
    [{ parameters: { use_unlim: true } }, "parameter_reserved"],
    [{ parameters: { model: "other" } }, "parameter_reserved"],
    [{ parameters: { preset_id: "x" } }, "parameter_reserved"],
    [{ parameters: { duration: 16 } }, "parameter_invalid"],
    [{ parameters: { duration: 2 } }, "parameter_invalid"],
    [{ parameters: { duration: "10" } }, "parameter_invalid"],
    [{ parameters: { mode: "ultra" } }, "parameter_invalid"],
    [{ parameters: { aspect_ratio: "4:3" } }, "parameter_invalid"],
    [{ parameters: { sound: true } }, "parameter_invalid"],
    [{ type: "image" }, "type_mismatch"],
    [{ model: "kling2_6" }, "model_unknown"],
    [{ prompt: "" }, "prompt_required"],
    [{ prompt: "a".repeat(5001) }, "prompt_limit"],
    [{ medias: [{ role: "image_references", kind: "image" }] }, "media_role_unknown"],
    [{ medias: [{ role: "start_image", kind: "video" }] }, "media_role_unknown"],
    [{ medias: Array.from({ length: 31 }, () => ({ role: "start_image", kind: "image" })) }, "media_limit"],
  ];
  for (const [patch, code] of failures) {
    let caught: unknown;
    try { validateGenerationRequest(kling, { ...base, ...patch } as Parameters<typeof validateGenerationRequest>[1]); } catch (error) { caught = error; }
    expect(caught, JSON.stringify(patch)).toBeInstanceOf(CatalogueError);
    expect((caught as CatalogueError).code, JSON.stringify(patch)).toBe(code);
    expect((caught as CatalogueError).message.toLowerCase()).not.toContain("higgsfield");
  }
  expect(validateGenerationRequest(kling, { ...base, medias: [{ role: "start_image", kind: "image" }, { role: "end_image", kind: "image" }] })).toEqual({});
  // Required media and per-slot caps.
  const sam = model("sam_3_3d");
  expect(() => validateGenerationRequest(sam, { type: "3d", model: "sam_3_3d", prompt: "the cup", parameters: {}, medias: [] })).toThrow(/needs a reference file/);
  expect(() => validateGenerationRequest(sam, { type: "3d", model: "sam_3_3d", prompt: "", parameters: {}, medias: [{ role: "image", kind: "image" }, { role: "image", kind: "image" }] })).toThrow(/at most 1 reference file/);
  expect(validateGenerationRequest(sam, { type: "3d", model: "sam_3_3d", prompt: "", parameters: { export_textured_glb: false, detection_threshold: 0.5 }, medias: [{ role: "image", kind: "image" }] })).toEqual({ export_textured_glb: false, detection_threshold: 0.5 });
  // Required parameters.
  const speech = model("text2speech_v2");
  expect(() => validateGenerationRequest(speech, { type: "audio", model: "text2speech_v2", prompt: "Hello", parameters: { voice_type: "preset", voice_id: "v1" }, medias: [] })).toThrow(/requires the setting “variant”/);
  // String arrays honour the declared cap.
  const ads = model("ms_image");
  expect(() => validateGenerationRequest(ads, { type: "image", model: "ms_image", prompt: "Poster", parameters: { product_ids: Array.from({ length: 5 }, () => media) }, medias: [] })).toThrow(/at most 4 values/);
});

test("provider params carry only validated settings, one result, credits billing and imported media UUIDs", () => {
  const input = consumerGenerationInputSchema.parse({
    type: "video", model: "kling3_0", prompt: "A slow push in.", parameters: { duration: 5, sound: "off" },
    medias: [{ role: "start_image", source: { uploadId: "still" } }],
  });
  const params = consumerGenerationParams(model("kling3_0"), input, [{ value: media.toUpperCase(), role: "start_image" }]);
  expect(params).toEqual({ duration: 5, sound: "off", model: "kling3_0", prompt: "A slow push in.", medias: [{ value: media, role: "start_image" }], count: 1, use_unlim: false });
  expect(() => consumerGenerationParams(model("kling3_0"), input, [])).toThrow();
  expect(() => consumerGenerationParams(model("kling3_0"), input, [{ value: "https://x/y.png", role: "start_image" }])).toThrow();
  expect(() => consumerGenerationParams(model("kling3_0"), input, [{ value: media, role: "end_image" }])).toThrow();
  for (const bad of [
    { type: "gif" }, { model: "../x" }, { parameters: { "bad name": 1 } }, { parameters: { a: null } }, { parameters: { a: { nested: 1 } } },
    { medias: [{ role: "start_image", source: { url: "https://x" } }] }, { medias: [{ role: "start_image", source: { uploadId: "a", genId: "b" } }] },
    { medias: [{ role: "start_image", source: { uploadId: "a" } }, { role: "end_image", source: { uploadId: "a" } }] },
    { medias: [{ role: "start image", source: { uploadId: "a" } }] }, { prompt: 5 }, { extra: true },
  ])
    expect(consumerGenerationInputSchema.safeParse({ ...input, ...bad }).success, JSON.stringify(bad)).toBe(false);
  // Optional prompt for reference-driven models is omitted rather than sent empty.
  const sam = consumerGenerationInputSchema.parse({ type: "3d", model: "sam_3_3d", prompt: "", parameters: {}, medias: [{ role: "image", source: { genId: "still" } }] });
  expect(consumerGenerationParams(model("sam_3_3d"), sam, [{ value: media, role: "image" }])).not.toHaveProperty("prompt");
});

test("normalized status envelopes qualify only the exact job, model, type and prompt", () => {
  const input = consumerGenerationInputSchema.parse({ type: "image", model: "nano_banana_2", prompt: "A bottle.", parameters: { resolution: "2k" }, medias: [] });
  const params = consumerGenerationParams(model("nano_banana_2"), input, []);
  const job = "55555555-5555-4555-8555-555555555555";
  const done = (patch: Record<string, unknown> = {}, results: unknown = { rawUrl: "https://media.example.com/out.png" }) => ({
    generation: { id: job, model: "nano_banana_2", type: "image", status: "completed", params: { ...params }, results, ...patch },
  });
  expect(consumerGenerationOriginalResult(done(), job, params, "image")).toEqual({ url: "https://media.example.com/out.png" });
  for (const value of [done({ model: "soul_2" }), done({ type: "video" }), done({ id: media }), done({ params: { ...params, prompt: "Other" } }),
    done({}, { rawUrl: "http://media.example.com/out.png" }), done({}, { rawUrl: "https://user:pw@media.example.com/out.png" }), done({}, { url: "https://media.example.com/out.png" }),
    done({ status: "processing" }), { generation: { ...done().generation }, results: [{ id: media, model: "nano_banana_2", type: "image" }] }, { raw_data: { id: job, result_url: "https://media.example.com/out.png" } }])
    expect(consumerGenerationOriginalResult(value, job, params, "image"), JSON.stringify(value).slice(0, 120)).toBeNull();
  /* The prompt the account rendered is read from the same qualified evidence: sanitised, capped, never from another job. */
  expect(consumerGenerationEnhancedPrompt(done({ params: { ...params, enhanced_prompt: "A bottle, \u0007rim-lit, see https://x.test/a.png\n" } }), job, params, "image"))
    .toBe("A bottle, rim-lit, see [link omitted]");
  expect(consumerGenerationEnhancedPrompt(done(), job, params, "image")).toBeUndefined();
  expect(consumerGenerationEnhancedPrompt(done({ params: { ...params, enhanced_prompt: "   " } }), job, params, "image")).toBeUndefined();
  expect(consumerGenerationEnhancedPrompt(done({ id: media, params: { ...params, enhanced_prompt: "Other job" } }), job, params, "image")).toBeUndefined();
  expect(consumerGenerationEnhancedPrompt(done({ params: { ...params, enhanced_prompt: "x".repeat(9000) } }), job, params, "image")).toHaveLength(8000);
  const saved = { status: "completed", result: { providerResult: { model: "nano_banana_2", type: "image", enhancedPrompt: "A bottle, rim-lit" } } } as unknown as ConnectedJob;
  expect(connectedEnhancedPrompt(saved)).toBe("A bottle, rim-lit");
  expect(connectedEnhancedPrompt({ ...saved, status: "accepted" } as ConnectedJob)).toBeNull();
  expect(connectedEnhancedPrompt({ status: "completed", result: { providerResult: { model: "nano_banana_2", type: "image" } } } as unknown as ConnectedJob)).toBeNull();
  expect(consumerGenerationFailureResult(done({ status: "failed", results: null }), job, params, "image")).toBe("failed");
  expect(consumerGenerationFailureResult(done({ status: "nsfw", results: null }), job, params, "image")).toBe("nsfw");
  expect(consumerGenerationFailureResult(done({ status: "failed" }), job, params, "image")).toBeNull();
  expect(consumerGenerationFailureResult(done({ status: "processing", results: null }), job, params, "image")).toBeNull();
});

test("malformed catalogue entries fail closed instead of relaxing constraints", () => {
  const entry = raw.items.find((item: { id: string }) => item.id === "kling3_0");
  expect(parseConnectedModel(entry).id).toBe("kling3_0");
  for (const patch of [{ id: "bad id" }, { output_type: "text" }, { parameters: [{ name: "x", type: "object", required: "optional" }] },
    { parameters: [{ name: "x", type: "number", required: "sometimes" }] }, { parameters: [{ name: "dup", type: "bool", required: "optional" }, { name: "dup", type: "bool", required: "optional" }] },
    { medias: [{ name: "medias", roles: ["Bad Role"] }] }, { aspect_ratios: ["16:9 "] }, { duration_range: { min: 9, max: 3 } }, { durations: ["5"] }])
    expect(() => parseConnectedModel({ ...entry, ...patch }), JSON.stringify(patch)).toThrow(CatalogueError);
  expect(() => parseConnectedCatalogue({ items: [entry, entry] })).toThrow(CatalogueError);
  expect(() => parseConnectedCatalogue({ items: "none" })).toThrow(CatalogueError);
  expect(parseConnectedCatalogue({ items: [entry], has_more: true, unlim: { available: true, remaining: 3, expires_at: "2026-10-01T00:00:00Z" } })).toMatchObject({ complete: false, unlim: { available: true, remaining: 3, expiresAt: "2026-10-01T00:00:00Z" } });
  const minimal = parseConnectedModel({ id: "x", output_type: "audio" }) satisfies ConnectedModel;
  expect(minimal).toMatchObject({ name: "x", parameters: [], medias: [], aspectRatios: [], supportsUnlim: false });
});

test("game-pipeline-only audio models are excluded from every standalone listing and lookup", () => {
  // Names verified against the captured catalogue: each says "Game pipeline only."
  expect([...GAME_PIPELINE_ONLY_MODELS]).toEqual(["sonilo_music", "mirelo_text_to_audio", "inworld_text_to_speech"]);
  for (const id of GAME_PIPELINE_ONLY_MODELS) {
    const entry = catalogue.models.find((m) => m.id === id)!;
    expect(entry.outputType).toBe("audio");
    expect(entry.description).toMatch(/game pipeline only/i);
    expect(isStandaloneModel(entry)).toBe(false);
    expect(findCatalogueModel(catalogue, id)).toBeNull();
  }
  const listed = listCatalogueModels(catalogue).map((m) => m.id);
  for (const id of GAME_PIPELINE_ONLY_MODELS) expect(listed).not.toContain(id);
  expect(listCatalogueModels(catalogue, { type: "audio" }).map((m) => m.id).sort()).toEqual(["qwen_audio_tts", "seed_audio", "text2speech_v2"]);
  // A future model carrying the provider's wording is excluded too.
  expect(isStandaloneModel({ id: "new_game_sfx", description: "Sound effects. Game pipeline only." })).toBe(false);
  expect(isStandaloneModel({ id: "new_sfx", description: "Must be used only for the game-generation pipeline and not for standalone audio." })).toBe(false);
  expect(isStandaloneModel({ id: "seed_audio", description: "Text-to-audio synthesis." })).toBe(true);
});

test("speech models that declare voice_type + voice_id are offered the connected voice picker", () => {
  expect(modelVoiceParameters(model("text2speech_v2"))).toEqual({ kinds: ["preset", "element"], required: true });
  expect(modelVoiceParameters(model("qwen_audio_tts"))).toEqual({ kinds: ["preset", "element"], required: true });
  expect(modelVoiceParameters(model("seed_audio"))).toEqual({ kinds: ["preset", "element"], required: false });
  expect(modelVoiceParameters(model("nano_banana_2"))).toBeNull();
  // The picker fills a pair the catalogue validation accepts as declared settings.
  expect(validateGenerationRequest(model("seed_audio"), { type: "audio", model: "seed_audio", prompt: "Hello there.", parameters: { voice_type: "preset", voice_id: "voice-1" }, medias: [] })).toEqual({ voice_type: "preset", voice_id: "voice-1" });
});

test("an echoed reference is matched by the `<kind>_input` FAMILY, not a list of samples", () => {
  // RECORDED FROM PRODUCTION on 20 September 2026 (free read-only
  // `show_generations`; no job submitted, US$0.00 spent). Reframe job
  // aa426b31-437c-439f-aca2-93d6bd23a6c9 echoed its source as
  //   { "role": "video",
  //     "data": { "id": "851d883d-…", "type": "video_input", "url": "…mp4" } }
  // and seed_audio jobs echo "audio_input", while every image reference echoes
  // "media_input". Against origin/main the first expect below fails:
  // ECHOED_MEDIA_TYPES was ["media_input","image","video","audio"], so a video
  // reference's own spelling refused the entry and the contracts threw away a
  // completed, PAID job.
  const sent = { value: media, role: "video_references" };
  expect(consumerEchoedMediaMatches(echoedMediaVideoInput({ id: media, url: "https://fixtures.particl.invalid/uploads/source.mp4" }), sent)).toBe(true);
  // Every spelling we have actually seen, plus the bare kinds the contracts
  // used to demand, plus an entry with no type at all.
  for (const type of [...ECHOED_MEDIA_TYPES, ...Object.values(RECORDED_MEDIA_DATA_TYPES), "model_input", "start_image_input", "video3d_input"])
    expect(echoedMediaTypeAccepted(type), type).toBe(true);
  for (const type of Object.values(RECORDED_MEDIA_DATA_TYPES))
    expect(consumerEchoedMediaMatches({ role: "video", data: { id: media, type } }, sent), type).toBe(true);
  expect(consumerEchoedMediaMatches({ role: "video", data: { id: media } }, sent)).toBe(true);
  // Bounded: anything outside the bare kinds and outside `<word>_input` is junk
  // and still refuses, so the widening buys no licence for arbitrary labels.
  for (const type of ["instruction", "input", "_input", "video input", "VIDEO_INPUT", "video-input", "media_input ", "input_video", `${"a".repeat(64)}_input`])
    expect(echoedMediaTypeAccepted(type), type).toBe(false);
  for (const type of ["instruction", "input_video", "VIDEO_INPUT"])
    expect(consumerEchoedMediaMatches({ role: "video", data: { id: media, type } }, sent), type).toBe(false);
  // The guarantee is the media uuid we uploaded — still exact, whatever the
  // label says — and the role must still be this reference's kind or slot.
  expect(consumerEchoedMediaMatches({ role: "video", data: { id: randomUUID(), type: "video_input" } }, sent)).toBe(false);
  expect(consumerEchoedMediaMatches({ role: "video", data: { type: "video_input" } }, sent)).toBe(false);
  expect(consumerEchoedMediaMatches({ role: "image", data: { id: media, type: "video_input" } }, sent)).toBe(false);
  // `role` accepts `<kind>_input` too, for symmetry with `data.type`.
  for (const role of ["video", "video_references", "video_input"])
    expect(consumerEchoedMediaMatches({ role, data: { id: media, type: "video_input" } }, sent), role).toBe(true);
  // `requireData` (the transform path) still refuses an entry with no `data`.
  expect(consumerEchoedMediaMatches({ role: "video", value: media }, sent)).toBe(true);
  expect(consumerEchoedMediaMatches({ role: "video", value: media }, sent, { requireData: true })).toBe(false);
});

test("a provider-injected extra medias entry is walked past, and every reference we sent must still appear in order", () => {
  // RECORDED FROM PRODUCTION, 20 September 2026 (free read-only
  // `show_generations(type=audio)`; no job submitted, US$0.00 spent). Completed
  // `seed_audio` jobs 70990834-1f07-45aa-a325-a8bc55d1d921,
  // 87c8a5b1-1863-43b8-8265-614605d17fad and d0450755-703e-43c0-b15e-24a8f75d433e
  // echo TWO entries where we would have sent ONE: the voice reference — which
  // goes out through `voice_type`/`voice_id`, never through a medias array —
  // followed by our own audio reference. The injected entry's `data` has only a
  // `url`: no `id`, no `type`.
  // Against origin/main there is no consumerEchoedMediasMatch at all; the rule
  // was `p.medias.length === params.medias.length`, so the first expect below —
  // and every voice-plus-reference case under it — refused a PAID job.
  const second = "55555555-5555-4555-8555-555555555555";
  const voice = echoedInjectedVoice("https://fixtures.particl.invalid/voices/6f332b29.wav");
  const one = echoedMedia({ id: media, url: "https://fixtures.particl.invalid/uploads/sfx.wav", kind: "audio", dataType: RECORDED_MEDIA_DATA_TYPES.audio_input });
  const two = echoedMedia({ id: second, url: "https://fixtures.particl.invalid/uploads/room.wav", kind: "audio", dataType: RECORDED_MEDIA_DATA_TYPES.audio_input });
  const sent = [{ value: media, role: "audio_references" }, { value: second, role: "audio_references" }];
  const sentOne = [sent[0]];

  // The recorded envelope, verbatim in shape: the injected voice then our one
  // reference. This is the job origin/main threw away.
  expect(voice).toEqual({ role: "audio", data: { url: "https://fixtures.particl.invalid/voices/6f332b29.wav" } });
  expect(consumerEchoedMediasMatch([voice, one], sentOne)).toBe(true);
  // The extra may sit anywhere, there may be more than one, and a job that sent
  // NO reference at all but used a voice collects too — the commonest case, and
  // one the equal-length rule also refused.
  expect(consumerEchoedMediasMatch([one, voice], sentOne)).toBe(true);
  expect(consumerEchoedMediasMatch([voice, one, voice, two], sent)).toBe(true);
  expect(consumerEchoedMediasMatch([voice], [])).toBe(true);
  expect(consumerEchoedMediasMatch([], [])).toBe(true);
  expect(consumerEchoedMediasMatch([one, two], sent)).toBe(true);
  // `requireData` (the transform path) is unchanged for OUR references.
  expect(consumerEchoedMediasMatch([voice, one], sentOne, { requireData: true })).toBe(true);
  expect(consumerEchoedMediasMatch([voice, { role: "audio", value: media }], sentOne, { requireData: true })).toBe(false);

  // WHAT STAYS EXACT. A wrong media id, a missing reference, and a reordered
  // reference all still refuse: only an entry naming NO media is walked past,
  // so nothing skipped can ever supply a reference we did not find by uuid.
  expect(consumerEchoedMediasMatch([voice, echoedMedia({ id: randomUUID(), url: "https://fixtures.particl.invalid/uploads/other.wav", kind: "audio", dataType: RECORDED_MEDIA_DATA_TYPES.audio_input })], sentOne)).toBe(false);
  expect(consumerEchoedMediasMatch([voice, one], sent)).toBe(false);
  expect(consumerEchoedMediasMatch([voice, two], sent)).toBe(false);
  expect(consumerEchoedMediasMatch([two, one], sent)).toBe(false);
  expect(consumerEchoedMediasMatch([voice], sentOne)).toBe(false);
  expect(consumerEchoedMediasMatch([], sentOne)).toBe(false);
  // An entry that DOES claim an identity is never treated as an extra: a
  // reference of ours repeated, or one carrying a `value` we never sent, refuses.
  expect(consumerEchoedMediasMatch([one, one], sentOne)).toBe(false);
  expect(consumerEchoedMediasMatch([one, { role: "audio", value: second }], sentOne)).toBe(false);
  expect(consumerEchoedMediasMatch([one, { role: "audio", data: { id: second, type: "audio_input" } }], sentOne)).toBe(false);
  // Neither is a non-object entry, an entry with no `data` at all, or a
  // non-array echo: the tolerated extra is exactly the recorded shape.
  expect(consumerEchoedMediasMatch([one, "audio"], sentOne)).toBe(false);
  expect(consumerEchoedMediasMatch([one, { role: "audio" }], sentOne)).toBe(false);
  expect(consumerEchoedMediasMatch([one, null], sentOne)).toBe(false);
  expect(consumerEchoedMediasMatch({ 0: one }, sentOne)).toBe(false);
  expect(consumerEchoedMediasMatch(undefined, sentOne)).toBe(false);
  // Bounded: extras are tolerated up to ECHOED_MEDIA_EXTRA_LIMIT, so an echo
  // padded without limit is still refused rather than walked.
  expect(ECHOED_MEDIA_EXTRA_LIMIT).toBe(30);
  expect(consumerEchoedMediasMatch([...Array.from({ length: ECHOED_MEDIA_EXTRA_LIMIT }, () => voice), one], sentOne)).toBe(true);
  expect(consumerEchoedMediasMatch([...Array.from({ length: ECHOED_MEDIA_EXTRA_LIMIT + 1 }, () => voice), one], sentOne)).toBe(false);
});
