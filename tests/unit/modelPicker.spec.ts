import { test, expect } from "@playwright/test";
import { connectedModels, workspaceModels, type ComposerModel, type EngineRow } from "../../lib/workspace/composer";
import {
  EMPTY_MEMORY, lengthSpan, maxResolution, modelChips, parsePickerMemory, pickerSections, pushRecent, readPickerMemory,
  recentKey, recentModels, rememberQuote, rememberRecent, rowPrice, searchModels, writePickerMemory,
} from "../../lib/workspace/model-picker";
import { MODELS } from "../../lib/models";
import { quoteWorkbenchMedia, rendersSound, workbenchGenerationModels, workbenchRate } from "../../lib/workbench/media-quote";
import { composerSettings } from "../../lib/workspace/composer";

/**
 * Gen's model sheet (lib/workspace/model-picker.ts) and the rate the engines
 * route prints beside each Studio engine (lib/workbench/media-quote.ts ›
 * workbenchRate). Fixtures only; nothing here talks to a route or a vendor.
 */

/* Test fixtures only. */
const seedance: EngineRow = {
  id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["480p", "720p", "1080p"], ratios: ["16:9", "9:16"], durations: [4, 5, 6, 7, 8, 9, 10],
  maxReferenceImages: 9, maxReferenceVideos: 3, use: "Standard video.", audio: true, rate: { credits: 8, resolution: "480p", ratio: "16:9", duration: 5 },
};
const stills: EngineRow = { id: "gpt-image-2", kind: "image", resolutions: ["Medium", "High", "Low"], ratios: ["1:1"], durations: [], maxReferenceImages: 10, maxReferenceVideos: 0, rate: { credits: 2, resolution: "Medium", ratio: "1:1", duration: null } };
const kling: EngineRow = { id: "fal-ai/kling-video/v3/pro", kind: "video", resolutions: ["1080p"], ratios: ["16:9"], durations: [5, 10], maxReferenceImages: 2, maxReferenceVideos: 0, audio: true, rate: null };

test("sizes rank inside one engine's list, and lengths read as a run or a closed list", () => {
  expect(maxResolution(["480p", "720p", "1080p", "4k"])).toBe("4K");
  expect(maxResolution(["720p", "480p"])).toBe("720p");
  expect(maxResolution(["2k", "1k", "4k"])).toBe("4K");
  expect(maxResolution(["512", "1K", "2K"])).toBe("2K");
  expect(maxResolution(["24MP", "48MP"])).toBe("48MP");
  /* Quality words and "adaptive" name no size: no chip rather than a wrong one. */
  expect(maxResolution(["Medium", "High", "Low"])).toBeNull();
  expect(maxResolution(["adaptive"])).toBeNull();
  expect(maxResolution(undefined)).toBeNull();
  expect(lengthSpan([4, 5, 6, 7])).toBe("4–7 s");
  expect(lengthSpan([10, 5])).toBe("5/10 s");
  expect(lengthSpan([4, 6, 8])).toBe("4/6/8 s");
  expect(lengthSpan([5, 10, 15, 20, 30])).toBe("5–30 s");
  expect(lengthSpan([5])).toBe("5 s");
  expect(lengthSpan([])).toBeNull();
});

test("every row carries its chips in one order: size, length, references, sound, enhance", () => {
  const [video, image] = workspaceModels([seedance, stills], null);
  expect(video.description).toBe("Standard video.");
  expect(modelChips(video).map((c) => c.text)).toEqual(["1080p", "4–10 s", "9 image + 3 video refs", "Audio"]);
  expect(modelChips(image).map((c) => c.text)).toEqual(["10 image refs"]);
  const [none] = workspaceModels([{ ...stills, maxReferenceImages: 0 }], null);
  expect(modelChips(none).map((c) => c.text)).toEqual(["Prompt only"]);
  /* Connected: chips from the live entry; prompt-only, roles, the schema's audio and enhance parameters. */
  const connected = connectedModels([
    { id: "veo_3_1", name: "Veo 3.1", outputType: "video", aspectRatios: ["16:9"], durations: [4, 6, 8], medias: [{ name: "start_image", roles: ["start_image"], max: 1 }], parameters: [{ name: "enhance_prompt" }, { name: "generate_audio" }] },
    { id: "z_image", name: "Z Image", outputType: "image", medias: [], parameters: [] },
    { id: "seedance_2_5", name: "Seedance 2.5", outputType: "video", durationRange: { min: 4, max: 30 }, medias: [{ roles: ["start_image", "video_references"] }], parameters: [{ name: "resolution", options: ["480p", "1080p"] }] },
  ]);
  expect(modelChips(connected[0]).map((c) => c.text)).toEqual(["4/6/8 s", "1 image ref", "Audio", "Enhance"]);
  expect(modelChips(connected[1]).map((c) => c.text)).toEqual(["Prompt only"]);
  expect(modelChips(connected[2]).map((c) => c.text)).toEqual(["1080p", "4–30 s", "Image + video refs"]);
  expect(modelChips(connected[2]).find((c) => c.key === "refs")?.title).toBe("Reference roles: start_image, video_references");
});

test("a Studio row shows its server rate, a connected row only a quote this browser was given, never a guess", () => {
  const [video, image, pro] = workspaceModels([seedance, stills, kling], null);
  expect(rowPrice(video, {})).toMatchObject({ credits: 8, detail: "5 s · 480p", kind: "rate" });
  expect(rowPrice(video, {}).title).toBe("8 cr at 5 s · 480p · 16:9, no references");
  expect(rowPrice(image, {})).toMatchObject({ credits: 2, detail: "Medium", kind: "rate" });
  /* No rate from the server: the price waits for the button. */
  expect(rowPrice(pro, {})).toMatchObject({ credits: null, kind: "none", detail: "priced on Generate" });
  const [veo] = connectedModels([{ id: "veo_3_1", name: "Veo 3.1", outputType: "video" }]);
  expect(rowPrice(veo, {})).toMatchObject({ credits: null, kind: "none" });
  expect(rowPrice(veo, { veo_3_1: { credits: 43, at: 1, detail: "6 s" } })).toMatchObject({ credits: 43, kind: "last", detail: "last quote" });
  expect(rowPrice(veo, { veo_3_1: { credits: 43, at: 1, detail: "6 s" } }).title).toContain("43 connected cr at 6 s");
  /* A connected model never borrows a Studio rate, even under the same id. */
  expect(rowPrice({ ...veo, rate: { credits: 1, resolution: "720p", ratio: "16:9", duration: 5 } }, {}).kind).toBe("none");
});

test("search matches every word across name, id, one-liner and chips", () => {
  const models = workspaceModels([seedance, stills, kling], null);
  expect(searchModels(models, "").map((m) => m.id)).toEqual(models.map((m) => m.id));
  expect(searchModels(models, "KLING").map((m) => m.id)).toEqual(["fal-ai/kling-video/v3/pro"]);
  expect(searchModels(models, "audio 1080p").map((m) => m.id)).toEqual(["dreamina-seedance-2-5-260628", "fal-ai/kling-video/v3/pro"]);
  expect(searchModels(models, "standard video").map((m) => m.id)).toEqual(["dreamina-seedance-2-5-260628"]);
  expect(searchModels(models, "high").map((m) => m.id)).toEqual(["gpt-image-2"]);
  expect(searchModels(models, "nothing like this")).toEqual([]);
});

test("Recent is the last three used for this catalogue and type, first and never twice; a query drops it", () => {
  const offered: ComposerModel[] = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, label: id.toUpperCase(), type: "video" }));
  let list: string[] = [];
  for (const id of ["a", "b", "c", "b", "d"]) list = pushRecent(list, recentKey("workspace", "video", id));
  list = pushRecent(list, recentKey("workspace", "image", "z"));
  list = pushRecent(list, recentKey("connected", "video", "a"));
  expect(list[0]).toBe("connected:video:a");
  const recent = recentModels(list, "workspace", "video", offered);
  expect(recent.map((m) => m.id)).toEqual(["d", "b", "c"]);
  /* A model the list no longer offers is skipped, not shown. */
  expect(recentModels(list, "workspace", "video", offered.filter((m) => m.id !== "b")).map((m) => m.id)).toEqual(["d", "c", "a"]);
  const sections = pickerSections(offered, recent, "");
  expect(sections.recent.map((m) => m.id)).toEqual(["d", "b", "c"]);
  expect(sections.rest.map((m) => m.id)).toEqual(["a", "e", "f"]);
  expect(pickerSections(offered, recent, "b")).toEqual({ recent: [], rest: [offered[1]] });
  /* A short list is already its own recent list. */
  expect(pickerSections(offered.slice(0, 4), recent, "").recent).toEqual([]);
  expect(Array.from({ length: 20 }, (_, i) => i).reduce<string[]>((l, i) => pushRecent(l, `workspace:video:m${i}`), []).length).toBe(12);
});

test("what the browser remembers is parsed defensively, capped, and survives a storage that throws", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  expect(readPickerMemory("scope-a", storage)).toEqual(EMPTY_MEMORY);
  let memory = rememberRecent(EMPTY_MEMORY, "workspace:video:a");
  expect(rememberRecent(memory, "workspace:video:a")).toBe(memory);
  memory = rememberQuote(memory, "veo_3_1", { credits: 43, at: 5, detail: "6 s" });
  expect(rememberQuote(memory, "veo_3_1", { credits: 43, at: 9, detail: "6 s" })).toBe(memory);
  writePickerMemory("scope-a", memory, storage);
  expect([...store.keys()]).toEqual(["particl-picker:scope-a"]);
  expect(readPickerMemory("scope-a", storage)).toEqual(memory);
  /* Per workspace scope: another scope reads nothing. */
  expect(readPickerMemory("scope-b", storage)).toEqual(EMPTY_MEMORY);
  expect(parsePickerMemory("{not json")).toEqual(EMPTY_MEMORY);
  expect(parsePickerMemory(JSON.stringify({ recent: ["ok", 4, null], quoted: { x: { credits: "9", at: 1 }, y: { credits: -1, at: 1 }, z: { credits: 3, at: 2 } } })))
    .toEqual({ recent: ["ok"], quoted: { z: { credits: 3, at: 2 } } });
  let many = EMPTY_MEMORY;
  for (let i = 0; i < 50; i++) many = rememberQuote(many, `m${i}`, { credits: i, at: i });
  expect(Object.keys(many.quoted)).toHaveLength(40);
  expect(many.quoted.m0).toBeUndefined();
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
  expect(readPickerMemory("scope-a", broken)).toEqual(EMPTY_MEMORY);
  expect(() => writePickerMemory("scope-a", memory, broken)).not.toThrow();
});

test("the engines route's rate is the button's own quote at the composer's untouched settings, in credits only", () => {
  let priced = 0;
  for (const model of workbenchGenerationModels(MODELS)) {
    const rate = workbenchRate(model);
    if (model.marketing || model.soulIdentity) { expect(rate).toBeNull(); continue; }
    if (!rate) continue;
    priced++;
    expect(Object.keys(rate).sort()).toEqual(["credits", "duration", "ratio", "resolution"]);
    expect(Number.isInteger(rate.credits) && rate.credits >= 1).toBe(true);
    /* The same settings the composer opens with (no project aspect), so picking the row shows this figure on Generate. */
    const composed = composerSettings({ id: model.id, label: model.label, type: model.kind, ratios: model.ratios, resolutions: model.resolutions, durations: model.durations });
    expect({ resolution: rate.resolution, ratio: rate.ratio }).toEqual({ resolution: composed.resolution, ratio: composed.ratio });
    if (model.kind === "video") expect(rate.duration).toBe(composed.duration);
    else expect(rate.duration).toBeNull();
    const quoted = quoteWorkbenchMedia(model, { resolution: composed.resolution, ratio: composed.ratio, duration: composed.duration }, { images: 0, videos: 0, inputSeconds: 0, hasVideoInput: false });
    expect(rate.credits).toBe(quoted.credits);
  }
  expect(priced).toBeGreaterThan(5);
  /* An engine the rates cannot price at those settings has no rate rather than a wrong one. */
  const video = MODELS.find((m) => m.kind === "video" && m.durations.length)!;
  expect(workbenchRate({ ...video, durations: [] })).toBeNull();
  expect(workbenchRate({ ...video, id: "no-such-engine" })).toBeNull();
});

test("the Audio chip is what a Studio take carries: sound that is always on, never a switch the workbench leaves off", () => {
  const byId = (id: string) => MODELS.find((m) => m.id === id)!;
  /* xAI's video has no switch because its clips always carry sound. */
  expect(rendersSound(byId("grok-imagine-video"))).toBe(true);
  expect(rendersSound(byId("grok-imagine-video-1.5"))).toBe(true);
  /* An audio switch is left off by the workbench (and priced silent), so no chip promises sound. */
  expect(byId("dreamina-seedance-2-5-260628").supportsAudio).toBe(true);
  expect(rendersSound(byId("dreamina-seedance-2-5-260628"))).toBe(false);
  expect(rendersSound(byId("fal-ai/kling-video/v3/pro"))).toBe(false);
  expect(rendersSound(byId("dreamina-seedance-2-0-260128"))).toBe(false);
  expect(rendersSound(byId("grok-imagine-image"))).toBe(false);
  for (const model of MODELS.filter((m) => m.kind === "image")) expect(rendersSound(model), model.id).toBe(false);
});
