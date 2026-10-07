import { test, expect } from "@playwright/test";
import { MAKE_MODEL_PREFERENCE, MAKE_PICKS, makeQuoteValue, rowSettings } from "../../lib/shell/make-price";
import { priceWords } from "../../lib/shell/price-words";
import { priceWords as recreateWords, quoteRecreate, type QuoteReader } from "../../lib/shell/recreate-price";
import { activeModel, composerReducer, composerSettings, INITIAL_COMPOSER, type ComposerModel, type ComposerState } from "../../lib/workspace/composer";
import { generation } from "../helpers/workspaceFixtures";

/* The owner's D0 Make items 6 and 7: Make's own defaults (README § 0 rule 2, § 4), the sound estimate's words, and the settings a sheet
   row's figure is at. No figure is typed here as a price: the quotes below are inputs, as the server would answer. */

const SEEDANCE_25: ComposerModel = { id: "dreamina-seedance-2-5-260628", label: "Seedance 2.5", type: "video", ratios: ["adaptive", "16:9", "9:16"], resolutions: ["480p", "720p", "1080p"], durations: [4, 5, 6, 8, 10], draft: true };
const SEEDANCE_20: ComposerModel = { id: "dreamina-seedance-2-0-260128", label: "Seedance 2.0", type: "video", ratios: ["16:9"], resolutions: ["480p", "720p"], durations: [5, 10] };
const GPT_IMAGE: ComposerModel = { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", type: "image", ratios: ["16:9"], resolutions: ["Medium", "High", "Low"], durations: [] };
const BANANA_PRO: ComposerModel = { id: "gemini-3-pro-image", label: "Nano Banana Pro", type: "image", ratios: ["16:9"], resolutions: ["1K", "2K", "4K"], durations: [] };
const BANANA_2: ComposerModel = { id: "gemini-3.1-flash-image", label: "Nano Banana 2", type: "image", ratios: ["16:9"], resolutions: ["512", "1K", "2K", "4K"], durations: [] };
const SFX: ComposerModel = { id: "eleven_sfx", label: "Eleven Sound Effects", type: "audio", audioTask: "sound" };
const MUSIC: ComposerModel = { id: "eleven_music", label: "Eleven Music", type: "audio", audioTask: "music" };
const SPEECH: ComposerModel = { id: "eleven_multilingual_v2", label: "Eleven Multilingual v2", type: "audio", audioTask: "speech" };
const CATALOGUE = [SEEDANCE_20, SEEDANCE_25, GPT_IMAGE, BANANA_2, BANANA_PRO, SFX, MUSIC, SPEECH];

const at = (type: ComposerState["type"], chosen: Record<string, string> = {}) => ({ ...INITIAL_COMPOSER, type, chosen });

test("Make opens on Seedance 2.5, Nano Banana Pro and a voice, whatever order the engines arrive in", () => {
  expect(activeModel(at("video"), CATALOGUE, MAKE_MODEL_PREFERENCE)?.id).toBe(SEEDANCE_25.id);
  expect(activeModel(at("image"), CATALOGUE, MAKE_MODEL_PREFERENCE)?.id).toBe(BANANA_PRO.id);
  expect(activeModel(at("audio"), CATALOGUE, MAKE_MODEL_PREFERENCE)?.id).toBe(SPEECH.id);
  /* The composer's own defaults elsewhere are unchanged. */
  expect(activeModel(at("image"), [GPT_IMAGE, BANANA_PRO])?.id).toBe(GPT_IMAGE.id);
  expect(activeModel(at("audio"), CATALOGUE)?.id).toBe(SFX.id);
});

test("a default the workspace does not offer falls through, and a person's pick wins over every default", () => {
  expect(activeModel(at("image"), [GPT_IMAGE, BANANA_2], MAKE_MODEL_PREFERENCE)?.id).toBe(GPT_IMAGE.id);
  expect(activeModel(at("audio"), [MUSIC, SFX], MAKE_MODEL_PREFERENCE)?.id).toBe(SFX.id);
  expect(activeModel(at("video"), [SEEDANCE_20], MAKE_MODEL_PREFERENCE)?.id).toBe(SEEDANCE_20.id);
  expect(activeModel(at("image", { "workspace:image": BANANA_2.id }), CATALOGUE, MAKE_MODEL_PREFERENCE)?.id).toBe(BANANA_2.id);
  expect(activeModel(at("video", { "workspace:video": SEEDANCE_20.id }), CATALOGUE, MAKE_MODEL_PREFERENCE)?.id).toBe(SEEDANCE_20.id);
});

test("Make opens at 1080p and 5 s; a later pick, Draft or a recipe replaces the size, and an engine without 1080p renders at its own", () => {
  expect(composerSettings(SEEDANCE_25, "16:9", MAKE_PICKS)).toMatchObject({ resolution: "1080p", duration: 5, ratio: "16:9" });
  /* Untouched elsewhere, the engine's first size. */
  expect(composerSettings(SEEDANCE_25, "16:9", {})).toMatchObject({ resolution: "480p" });
  expect(composerSettings(SEEDANCE_20, "16:9", MAKE_PICKS).resolution).toBe("480p");
  expect(composerSettings(BANANA_PRO, "16:9", MAKE_PICKS).resolution).toBe("1K");
  const opened: ComposerState = { ...INITIAL_COMPOSER, type: "video", picks: { ...MAKE_PICKS } };
  expect(composerSettings(SEEDANCE_25, "16:9", composerReducer(opened, { type: "pick", value: { resolution: "720p" } }).picks).resolution).toBe("720p");
  expect(composerSettings(SEEDANCE_25, "16:9", composerReducer(opened, { type: "pick", value: { draft: true } }).picks).resolution).toBe("480p");
  const recreated = composerReducer(opened, { type: "recipe", value: { type: "video", billing: "workspace", picks: { resolution: "720p", duration: 8 } } });
  expect(composerSettings(SEEDANCE_25, "16:9", recreated.picks)).toMatchObject({ resolution: "720p", duration: 8 });
  expect(MAKE_PICKS).toEqual({ resolution: "1080p" });
});

test("a sound is a live estimate and reads \"up to N cr\"; a still or a clip is its exact figure", () => {
  expect(priceWords(makeQuoteValue(1, "audio"))).toBe("up to 1 cr");
  expect(priceWords(makeQuoteValue(43, "video"))).toBe("43 cr");
  expect(priceWords(makeQuoteValue(3, "image"))).toBe("3 cr");
  expect(makeQuoteValue(null, "audio")).toBeNull();
  expect(makeQuoteValue(Number.NaN, "video")).toBeNull();
});

test("a sheet row names the size and length its figure is at, in the engine line's order", () => {
  const where = { aspect: "16:9", picks: { resolution: "1080p", duration: 6 } };
  expect(rowSettings(SEEDANCE_25, where)).toBe("1080p · 6 s");
  /* An engine without the picked size or length is priced at its own, and its row says which. */
  expect(rowSettings(SEEDANCE_20, where)).toBe("480p · 5 s");
  expect(rowSettings(BANANA_PRO, where)).toBe("1K");
  expect(rowSettings(SFX, where, "10 s")).toBe("10 s");
  expect(rowSettings(SPEECH, where, "")).toBeNull();
});

test("Again prices the recipe as Make will: on Make's own default when the take's engine is gone, and a sound as an estimate", async () => {
  const asked: string[] = [];
  const read: QuoteReader = async (url, init) => {
    asked.push(init ? `POST ${url}` : url);
    if (url === "/api/workbench/engines") return { models: [
      { id: GPT_IMAGE.id, kind: "image", resolutions: GPT_IMAGE.resolutions, ratios: GPT_IMAGE.ratios, durations: [] },
      { id: BANANA_PRO.id, kind: "image", resolutions: BANANA_PRO.resolutions, ratios: BANANA_PRO.ratios, durations: [] },
    ] };
    if (url.startsWith("/api/workbench/engines?")) return { credits: new URL(url, "http://x").searchParams.get("model") === BANANA_PRO.id ? 3 : 2 };
    if (url === "/api/audio" && !init) return { configured: true, speechModels: [{ id: SPEECH.id, name: "Multilingual" }], defaultSpeechModel: SPEECH.id, voices: [{ voiceId: "v1", name: "Rachel" }] };
    return { estimatedCredits: 1 };
  };
  /* A still from an engine no longer offered lands on Nano Banana Pro, as Make itself would. */
  const gone = generation({ id: "g1", kind: "image", model: "retired-image-engine", prompt: "a lantern", params: { ratio: "16:9", resolution: "1K" } });
  const still = await quoteRecreate(gone as never, read, { aspect: "16:9" });
  expect(still).toEqual({ state: "ready", credits: 3, approximate: false });
  expect(asked.some((u) => u.includes(`model=${BANANA_PRO.id}`))).toBe(true);
  expect(recreateWords({ state: "ready", credits: 3, approximate: false })).toBe("3 cr");
  expect(recreateWords({ state: "ready", credits: 1, approximate: false, estimate: true })).toBe("up to 1 cr");
});
