import { test, expect } from "@playwright/test";
import {
  activeModel,
  billingWording,
  COMPOSER_TYPES,
  composerBlock,
  composerButtonLabel,
  composerReducer,
  composerSettings,
  INITIAL_COMPOSER,
  liveCredits,
  quoteKeyFor,
  workspaceModels,
  type ComposerModel,
  type ComposerQuote,
  type ComposerState,
  type EngineRow,
  audioSeconds,
  composerVoices,
  stepAudioSeconds,
} from "../../lib/workspace/composer";
import { nodeAudioBody, speechVoiceFor } from "../../lib/workbench/generation-audio";
import { readFileSync } from "node:fs";
import { SITE_SUITES } from "../../lib/marketing/site";
import { suiteTiles } from "../../lib/shell/studio-home";
import { INITIAL_STATE, generateTarget } from "../../lib/workspace/navigation";
import { WORKSPACE_BINDINGS, inKeyboardOverlay, keyContextFor, resolveKey } from "../../lib/workspace/keys";
import { filterPalette, paletteCommands } from "../../lib/workspace/palette";
import { displayModelName } from "../../lib/models";

/**
 * The global Generate composer's state machine, and the keymap and palette
 * additions that reach it. Fixtures only; nothing here talks to a route.
 */

/* Test fixtures only. */
const engines: EngineRow[] = [
  { id: "gemini-3.1-flash-image", kind: "image", resolutions: ["1K", "2K"], ratios: ["16:9", "1:1"], durations: [] },
  { id: "fal-ai/flux-lora", kind: "image", resolutions: ["1K"], ratios: ["16:9"], durations: [], soulIdentity: true },
  { id: "higgsfield/marketing-studio-image", kind: "image", resolutions: ["1K"], ratios: ["1:1"], durations: [], marketing: true },
  { id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["720p", "1080p"], ratios: ["16:9", "9:16"], durations: [5, 10] },
  { id: "fal-ai/kling-video/v3/standard", kind: "video", resolutions: ["1080p"], ratios: ["16:9"], durations: [5] },
];
const audio = { configured: true, speechModels: [{ id: "eleven_v3", label: "Voice v3" }], defaultSpeechModel: "eleven_v3", voices: [{ id: "v1", name: "Nova" }], voicesError: null };
const ready = (key: string, credits: number): ComposerQuote => ({ key, credits, state: "ready", reason: null });
const settings = { ratio: "16:9", resolution: "720p", duration: 5 };
const catalogue = { loading: false, error: null };

function keyOf(state: ComposerState, model: ComposerModel | null) {
  return quoteKeyFor({
    type: state.type, modelId: model?.id ?? "", settings,
    references: state.references, prompt: state.prompt.trim(), seconds: state.seconds,
    instrumental: state.instrumental, voiceId: state.voiceId,
  });
}

test("the composer opens on Image with a defaulted model, so it works untouched", () => {
  const models = workspaceModels(engines, audio);
  expect(INITIAL_COMPOSER.type).toBe("image");
  /* Identity and campaign engines cannot render from an untouched composer. */
  expect(models.filter((m) => m.type === "image").map((m) => m.id)).toEqual(["gemini-3.1-flash-image"]);
  /* The named default when the list carries it (Seedance 2.5, sound effects, GPT Image 2.5), else the first of the type. */
  expect(activeModel(INITIAL_COMPOSER, models)?.id).toBe("gemini-3.1-flash-image");
  const studio: ComposerModel[] = [
    { id: "dreamina-seedance-2-0-260128", label: "Seedance 2.0", type: "video" }, { id: "dreamina-seedance-2-5-260628", label: "Seedance 2.5", type: "video" },
    { id: "gemini-3.1-flash-image", label: "Nano Banana 2", type: "image" }, { id: "gpt-image-2.5-flare", label: "GPT Image 2.5", type: "image" },
    { id: "eleven_music", label: "Music", type: "audio" }, { id: "eleven_sfx", label: "Sound effects", type: "audio" },
  ];
  expect(activeModel({ ...INITIAL_COMPOSER, type: "video" }, studio)?.id).toBe("dreamina-seedance-2-5-260628");
  expect(activeModel({ ...INITIAL_COMPOSER, type: "image" }, studio)?.id).toBe("gpt-image-2.5-flare");
  expect(activeModel({ ...INITIAL_COMPOSER, type: "audio" }, studio)?.id).toBe("eleven_sfx");
  /* A pick still wins over the default; a list without the default falls back to its first. */
  expect(activeModel({ ...INITIAL_COMPOSER, type: "video", chosen: { "workspace:video": "dreamina-seedance-2-0-260128" } }, studio)?.id).toBe("dreamina-seedance-2-0-260128");
  expect(activeModel({ ...INITIAL_COMPOSER, type: "video" }, studio.filter((m) => m.id !== "dreamina-seedance-2-5-260628"))?.id).toBe("dreamina-seedance-2-0-260128");
  expect(activeModel({ ...INITIAL_COMPOSER, type: "video" }, models)?.id).toBe("dreamina-seedance-2-5-260628");
  expect(activeModel({ ...INITIAL_COMPOSER, type: "audio" }, models)?.id).toBe("eleven_sfx");
  /* Every label is the product's own display name; the composer writes none of
     its own, so #262's renaming of the integrated models reaches it for free. */
  for (const model of models) expect(model.label).toBe(displayModelName(model.id));
});

test("sound models appear only when sound is configured, and speech only with a voice", () => {
  expect(workspaceModels(engines, null).some((m) => m.type === "audio")).toBe(false);
  expect(workspaceModels(engines, { ...audio, configured: false }).some((m) => m.type === "audio")).toBe(false);
  const noVoices = workspaceModels(engines, { ...audio, voices: [] });
  expect(noVoices.filter((m) => m.type === "audio").map((m) => m.audioTask)).toEqual(["sound", "music"]);
  expect(workspaceModels(engines, audio).filter((m) => m.type === "audio").map((m) => m.audioTask)).toEqual(["sound", "music", "speech"]);
});

test("a workspace on Grok Voice alone offers its speech model with its voices, and no sound or music", () => {
  const grokOnly = { configured: true, vendors: { elevenlabs: false, xai: true }, speechModels: [{ id: "grok-tts", label: "Grok Voice" }], defaultSpeechModel: "grok-tts", voices: [{ id: "eve", name: "Eve" }], voicesError: null };
  expect(workspaceModels(engines, grokOnly).filter((m) => m.type === "audio").map((m) => [m.id, m.audioTask, m.label])).toEqual([["grok-tts", "speech", "Grok Voice"]]);
  expect(workspaceModels(engines, { ...grokOnly, vendors: { elevenlabs: true, xai: true } }).filter((m) => m.type === "audio").map((m) => m.audioTask)).toEqual(["sound", "music", "speech"]);
});

test("a chosen model is kept per type, and falls back when withdrawn", () => {
  const models = workspaceModels(engines, audio);
  let state = composerReducer(INITIAL_COMPOSER, { type: "type", value: "video" });
  state = composerReducer(state, { type: "model", value: "fal-ai/kling-video/v3/standard" });
  expect(activeModel(state, models)?.id).toBe("fal-ai/kling-video/v3/standard");
  /* Image keeps its own default; coming back to video keeps the choice. */
  const onImage = composerReducer(state, { type: "type", value: "image" });
  expect(activeModel(onImage, models)?.id).toBe("gemini-3.1-flash-image");
  expect(activeModel(composerReducer(onImage, { type: "type", value: "video" }), models)?.id).toBe("fal-ai/kling-video/v3/standard");
  /* A withdrawn engine falls back to the list's default rather than sending an id the account has lost. */
  const withoutKling = models.filter((m) => m.id !== "fal-ai/kling-video/v3/standard");
  expect(activeModel(state, withoutKling)?.id).toBe("dreamina-seedance-2-5-260628");
  /* Kept under the key it always had, so a choice made before the one credit source still reads. */
  expect(state.chosen).toEqual({ "workspace:video": "fal-ai/kling-video/v3/standard" });
});

test("the credits a render is charged to are this workspace's, said without naming a provider", () => {
  expect(billingWording({ workspaceName: "Northside" })).toBe("Charged to Northside’s credits.");
  expect(billingWording({})).toBe("Charged to this workspace’s credits.");
  expect(billingWording({})).not.toMatch(/Higgsfield|connected|Seedance|Kling/i);
  /* The composer has one credit source: nothing to switch, no account to read. */
  expect(Object.keys(INITIAL_COMPOSER)).not.toContain("billing");
});

test("a missing or stale quote blocks the send with a visible reason", () => {
  const models = workspaceModels(engines, audio);
  const model = activeModel(INITIAL_COMPOSER, models)!;
  const withPrompt = composerReducer(INITIAL_COMPOSER, { type: "prompt", value: "a lighthouse at dusk" });
  const key = keyOf(withPrompt, model);
  const base = { state: withPrompt, model, quoteKey: key, submitting: false, catalogue };

  /* Nothing written yet. */
  expect(composerBlock({ ...base, state: INITIAL_COMPOSER, quote: ready(keyOf(INITIAL_COMPOSER, model), 3) })).toBe("Write what to generate.");
  /* No quote at all. */
  expect(composerBlock({ ...base, quote: null })).toBe("Getting the live price…");
  /* A quote for other inputs is stale: it blocks, and its figure is never used. */
  expect(composerBlock({ ...base, quote: ready("some other key", 18) })).toBe("Getting the live price…");
  expect(liveCredits(ready("some other key", 18), key)).toBeNull();
  expect(composerButtonLabel({ quote: ready("some other key", 18), quoteKey: key, submitting: false })).toBe("Generate");
  /* A refused price says why. */
  expect(composerBlock({ ...base, quote: { key, credits: null, state: "unavailable", reason: "This engine is unavailable." } })).toBe("This engine is unavailable.");
  expect(composerBlock({ ...base, quote: { key, credits: null, state: "loading", reason: null } })).toBe("Getting the live price…");
  /* A current, ready figure clears the block and lands on the button. */
  expect(composerBlock({ ...base, quote: ready(key, 18) })).toBeNull();
  expect(composerBlock({ ...base, quote: ready(key, 18), projects: "loading" })).toBe("Reading the projects…");
  expect(composerBlock({ ...base, quote: ready(key, 18), projects: "error" })).toContain("Try again");
  expect(composerBlock({ ...base, quote: ready(key, 18), projects: "ready" })).toBeNull();
  expect(composerButtonLabel({ quote: ready(key, 18), quoteKey: key, submitting: false })).toBe("Generate · 18 cr");
  expect(composerButtonLabel({ quote: ready(key, 1296), quoteKey: key, submitting: false })).toBe("Generate · 1,296 cr");
  /* An approximate figure (an engine that settles on what it delivers) never reads as exact. */
  expect(composerButtonLabel({ quote: { ...ready(key, 18), approximate: true }, quoteKey: key, submitting: false })).toBe("Generate · about 18 cr");
  expect(composerButtonLabel({ quote: { ...ready(key, 18), approximate: true }, quoteKey: key, submitting: false, count: 3 })).toBe("Generate 3 takes · about 54 cr");
  expect(composerButtonLabel({ quote: ready(key, 18), quoteKey: key, submitting: true })).toBe("Submitting…");
  expect(composerBlock({ ...base, quote: ready(key, 18), submitting: true })).toBe("Submitting this generation…");
  /* Changing the model moves the key, so the old figure cannot be sent. */
  const another = composerReducer(withPrompt, { type: "type", value: "video" });
  expect(keyOf(another, activeModel(another, models))).not.toBe(key);
});

test("every input that moves the price is in the quote key", () => {
  const models = workspaceModels(engines, audio);
  const video = activeModel({ ...INITIAL_COMPOSER, type: "video" }, models)!;
  const state: ComposerState = { ...INITIAL_COMPOSER, type: "video", prompt: "a wave" };
  const key = keyOf(state, video);
  expect(keyOf({ ...state, references: [{ key: "upload:a", id: "a", origin: "upload", kind: "image", name: "a.png", url: "/api/uploads/a" }] }, video)).not.toBe(key);
  expect(quoteKeyFor({ type: "video", modelId: video.id, settings: { ...settings, resolution: "1080p" }, references: [], prompt: "", seconds: 10, instrumental: true, voiceId: "" }))
    .not.toBe(quoteKeyFor({ type: "video", modelId: video.id, settings, references: [], prompt: "", seconds: 10, instrumental: true, voiceId: "" }));
  /* Video is not priced by its prompt; sound is. */
  expect(keyOf({ ...state, prompt: "another wave" }, video)).toBe(key);
  const sound: ComposerState = { ...INITIAL_COMPOSER, type: "audio", prompt: "rain" };
  expect(keyOf({ ...sound, prompt: "thunder" }, models.find((m) => m.audioTask === "sound")!)).not.toBe(keyOf(sound, models.find((m) => m.audioTask === "sound")!));
  expect(keyOf({ ...sound, seconds: 20 }, models.find((m) => m.audioTask === "sound")!)).not.toBe(keyOf(sound, models.find((m) => m.audioTask === "sound")!));
});

test("a line needs a voice to be read in, and a model's own settings are what it renders with", () => {
  const models = workspaceModels(engines, audio);
  const speech = models.find((m) => m.audioTask === "speech")!;
  const state: ComposerState = { ...INITIAL_COMPOSER, type: "audio", prompt: "Read this line." };
  const key = keyOf(state, speech);
  /* The composer hands in the voice the line is read in (the pick, else the model's first): none at all blocks, and says what to do. */
  expect(composerBlock({ state, model: speech, quote: ready(key, 2), quoteKey: key, submitting: false, catalogue }))
    .toBe(`${speech.label} has no voice to read in here. Choose another model.`);
  const voiced = composerReducer(state, { type: "voice", value: "v1" });
  const voicedKey = keyOf(voiced, speech);
  expect(composerBlock({ state: voiced, model: speech, quote: ready(voicedKey, 2), quoteKey: voicedKey, submitting: false, catalogue })).toBeNull();
  /* Settings come from the engine, and the project's aspect wins where the engine allows it. */
  const video = models.find((m) => m.id === "dreamina-seedance-2-5-260628")!;
  expect(composerSettings(video)).toEqual({ ratio: "16:9", resolution: "720p", duration: 5 });
  expect(composerSettings(video, "9:16").ratio).toBe("9:16");
  expect(composerSettings(video, "4:5").ratio).toBe("16:9");
  expect(composerSettings(models.find((m) => m.id === "fal-ai/kling-video/v3/standard")!).resolution).toBe("1080p");
});

test("changing type drops what the new type cannot use, and reset keeps the chosen models", () => {
  const reference = { key: "upload:a", id: "a", origin: "upload" as const, kind: "image" as const, name: "a.png", url: "/api/uploads/a" };
  let state = composerReducer(INITIAL_COMPOSER, { type: "addReference", value: reference });
  expect(state.references).toHaveLength(1);
  /* The same file twice is one reference. */
  expect(composerReducer(state, { type: "addReference", value: reference }).references).toHaveLength(1);
  state = composerReducer(state, { type: "type", value: "video" });
  expect(state.references).toHaveLength(1);
  expect(composerReducer(state, { type: "type", value: "audio" }).references).toEqual([]);
  expect(composerReducer(state, { type: "removeReference", key: "upload:a" }).references).toEqual([]);
  const chosen = composerReducer(state, { type: "model", value: "dreamina-seedance-2-5-260628" });
  const noticed = composerReducer({ ...chosen, notice: "The price moved." }, { type: "reset" });
  expect(noticed.chosen).toEqual(chosen.chosen);
  expect(noticed.prompt).toBe("");
  expect(noticed.notice).toBeNull();
  /* Any edit clears a stale notice, so a moved price is never shown beside new inputs. */
  expect(composerReducer({ ...state, notice: "The price moved." }, { type: "prompt", value: "x" }).notice).toBeNull();
});

test("the sound and music length is held to what the audio route bills, so the seconds shown are the seconds charged", () => {
  let state = composerReducer(INITIAL_COMPOSER, { type: "type", value: "audio" });
  state = composerReducer(state, { type: "model", value: "eleven_music" });
  /* Music has a ten-second floor and a five-minute ceiling. */
  expect(composerReducer(state, { type: "seconds", value: 5, task: "music" }).seconds).toBe(10);
  expect(composerReducer(state, { type: "seconds", value: 999, task: "music" }).seconds).toBe(300);
  expect(composerReducer(state, { type: "seconds", value: 45.4, task: "music" }).seconds).toBe(45);
  /* A sound effect runs 1–30 s. */
  expect(composerReducer(state, { type: "seconds", value: 999, task: "sound" }).seconds).toBe(30);
  expect(composerReducer(state, { type: "seconds", value: 0, task: "sound" }).seconds).toBe(1);
  /* Switching model holds the length already typed to the new model's range. */
  const long = composerReducer(state, { type: "seconds", value: 200, task: "music" });
  expect(composerReducer(long, { type: "model", value: "eleven_sfx" }).seconds).toBe(30);
  const short = composerReducer(composerReducer(state, { type: "model", value: "eleven_sfx" }), { type: "seconds", value: 3, task: "sound" });
  expect(short.seconds).toBe(3);
  expect(composerReducer(short, { type: "model", value: "eleven_music" }).seconds).toBe(10);
  /* A model with no length leaves it alone. */
  expect(audioSeconds("speech", 3)).toBe(3);
  expect(audioSeconds(undefined, 3)).toBe(3);
  expect(audioSeconds("music", Number.NaN)).toBe(10);
});

/* Test fixtures: a workspace on both sound vendors, in GET /api/audio's shape. */
const both = {
  configured: true, vendors: { elevenlabs: true, xai: true },
  speechModels: [
    { id: "eleven_multilingual_v2", label: "Multilingual v2", note: "The dependable studio voice." },
    { id: "eleven_flash_v2_5", label: "Flash v2.5" },
    { id: "grok-tts", label: "Grok Voice", note: "Speech tags in the text." },
  ],
  defaultSpeechModel: "eleven_multilingual_v2",
  voices: [{ id: "voiceRachel01", name: "Rachel" }, { id: "voiceSarah002", name: "Sarah" }],
  grokVoices: [{ id: "eve", name: "Eve" }, { id: "ara", name: "Ara" }],
  voicesError: null,
};

test("every speech model with voices is offered, the default first, and each reads in its own vendor's voices", () => {
  const speech = workspaceModels(engines, both).filter((m) => m.audioTask === "speech");
  expect(speech.map((m) => [m.id, m.label, m.description])).toEqual([
    ["eleven_multilingual_v2", displayModelName("eleven_multilingual_v2"), "The dependable studio voice."],
    ["eleven_flash_v2_5", displayModelName("eleven_flash_v2_5"), "Your words, read in a chosen voice."],
    ["grok-tts", "Grok Voice", "Speech tags in the text."],
  ]);
  /* Picking the model swaps the list: Grok Voice never lists an ElevenLabs voice, nor the reverse. */
  expect(composerVoices(both, "grok-tts").map((v) => v.id)).toEqual(["eve", "ara"]);
  expect(composerVoices(both, "eleven_flash_v2_5").map((v) => v.id)).toEqual(["voiceRachel01", "voiceSarah002"]);
  /* A voice picked on one vendor's model falls to the other's first, so a line is never priced in a voice its model cannot read. */
  expect(speechVoiceFor(composerVoices(both, "grok-tts"), "voiceSarah002")?.id).toBe("eve");
  expect(speechVoiceFor(composerVoices(both, "grok-tts"), "ara")?.id).toBe("ara");
  /* Grok's own list could not be read: its model is not offered, rather than offered with no voice. */
  expect(workspaceModels(engines, { ...both, grokVoices: [] }).some((m) => m.id === "grok-tts")).toBe(false);
  /* An older reply on a Grok-only workspace, without Grok's own list: `voices` are the default model's, so Grok's. */
  const older = { configured: true, speechModels: [{ id: "grok-tts", label: "Grok Voice" }], defaultSpeechModel: "grok-tts", voices: [{ id: "eve", name: "Eve" }], voicesError: null };
  expect(composerVoices(older, "grok-tts").map((v) => v.id)).toEqual(["eve"]);
  expect(composerVoices(null, "grok-tts")).toEqual([]);
});

test("the length stepper moves a second for an effect and five for music, never past the range the route bills", () => {
  expect(stepAudioSeconds("sound", 10, 1)).toBe(11);
  expect(stepAudioSeconds("sound", 1, -1)).toBe(1);
  expect(stepAudioSeconds("sound", 30, 1)).toBe(30);
  expect(stepAudioSeconds("music", 10, 1)).toBe(15);
  expect(stepAudioSeconds("music", 10, -1)).toBe(10);
  /* A length off the step (a recreated take's) lands on the next step either way. */
  expect(stepAudioSeconds("music", 12, 1)).toBe(15);
  expect(stepAudioSeconds("music", 12, -1)).toBe(10);
  expect(stepAudioSeconds("music", 298, 1)).toBe(300);
  expect(stepAudioSeconds("music", 300, 1)).toBe(300);
});

test("the voice, the length and Instrumental are each in the price's key, whose shape recovery records keep", () => {
  const base = { type: "audio" as const, modelId: "eleven_music", settings, references: [], prompt: "a slow cello", seconds: 30, instrumental: true, voiceId: "" };
  const key = quoteKeyFor(base);
  expect(quoteKeyFor({ ...base, seconds: 35 })).not.toBe(key);
  expect(quoteKeyFor({ ...base, instrumental: false })).not.toBe(key);
  expect(quoteKeyFor({ ...base, modelId: "grok-tts", voiceId: "eve" })).not.toBe(quoteKeyFor({ ...base, modelId: "grok-tts", voiceId: "ara" }));
  /* The key also names a take in this browser's recovery records (a lost reply's claim, a batch left part way): a take
     left unconfirmed before a release is found by the same key after it, so its shape does not move. */
  expect(key).toBe('["workspace","audio","eleven_music","16:9","720p",5,"",[],"a slow cello",30,true,""]');
  /* What is priced is what is sent: the body carries the length and the switch the key names. */
  expect(nodeAudioBody({ task: "music", text: "a slow cello", seconds: audioSeconds("music", 35), instrumental: false, voiceId: "", modelId: "eleven_music" }))
    .toEqual({ task: "music", text: "a slow cello", lengthMs: 35_000, instrumental: false });
  expect(nodeAudioBody({ task: "sound", text: "a door", seconds: audioSeconds("sound", 45), instrumental: true, voiceId: "", modelId: "eleven_sfx" }))
    .toEqual({ task: "sound", text: "a door", durationSeconds: 30 });
});

test("Gen's copy promises only the outputs its composer makes: no 3D while the composer has none", () => {
  expect(COMPOSER_TYPES).not.toContain("3d");
  const gen = SITE_SUITES.find((suite) => suite.id === "gen")!;
  expect(`${gen.blurb} · ${gen.pages.join(" · ")}`).not.toMatch(/3D/i);
  expect(readFileSync("app/(marketing)/site/_pages/gen/index.tsx", "utf8")).not.toMatch(/3D/i);
  /* In the app: the Home tile's line (lib/shell/studio-home.ts). */
  expect(suiteTiles([], { rendering: 0, videoEngine: "", viralResolution: "", awaiting: 0, seats: null }).find((t) => t.id === "gen")!.line).not.toMatch(/3D/i);
});

/* ── The keymap and the palette ─────────────────────────────────────────── */

const studio = { ...INITIAL_STATE, view: "studio" as const, page: "rig" as const, projectId: "p1" };

test("G opens the composer with no shot selected, and keeps Rig's Generate with one", () => {
  /* With a ready shot selected in Rig, G is still the Rig's own Generate. */
  const selected = { ...studio, selKind: "shot" as const, selId: "s1", lists: { ...studio.lists, shots: [{ id: "s1", name: "Opening" }] } };
  expect(generateTarget(selected, true)).toBe("rig");
  /* No selection, another page, or Home: the composer. */
  expect(generateTarget({ ...selected, selId: null }, true)).toBe("composer");
  expect(generateTarget({ ...selected, page: "takes" }, true)).toBe("composer");
  expect(generateTarget({ ...INITIAL_STATE }, true)).toBe("composer");
  /* Rig with no Generate seam wired is not the Rig's job either. */
  expect(generateTarget(selected, false)).toBe("composer");
});

test("G obeys the typing guard, answers on Home, and is swallowed while the composer is open", () => {
  const inStudio = keyContextFor(studio, { canGenerate: true, canCompose: true });
  const atHome = keyContextFor(INITIAL_STATE, { canCompose: true });
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "g" }, inStudio)?.id).toBe("generate");
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "G" }, atHome)?.id).toBe("generate");
  /* Typing a prompt must never fire G, I or A. */
  for (const key of ["g", "i", "a"])
    expect(resolveKey(WORKSPACE_BINDINGS, { key, target: { tagName: "TEXTAREA" } }, inStudio)).toBeNull();
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "g", target: { tagName: "INPUT" } }, inStudio)).toBeNull();
  /* While the composer is open, the shell's single keys stay out of its way. */
  const open = keyContextFor({ ...studio, composer: true }, { canGenerate: true, canCompose: true, canPlay: true });
  for (const key of ["g", "i", "a", "3", " ", "ArrowRight"]) expect(resolveKey(WORKSPACE_BINDINGS, { key }, open)).toBeNull();
  /* Esc and ⌘K still reach the shell. */
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "Escape" }, open)?.id).toBe("escape");
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "k", metaKey: true }, open)?.id).toBe("palette");
  /* ⌘G is the browser's, not ours. */
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "g", metaKey: true }, inStudio)).toBeNull();
});

/** A DOM-ish target: `closest` answers for anything the composer contains. */
const inComposer = (tagName: string) => ({ tagName, closest: (selector: string) => (selector === ".pxw-composer" ? {} : null) });
const outside = (tagName: string) => ({ tagName, closest: () => null });

test("anything inside the composer is inert to the single-key map, whatever its tag", () => {
  expect(inKeyboardOverlay(inComposer("BUTTON"))).toBe(true);
  expect(inKeyboardOverlay(outside("BUTTON"))).toBe(false);
  expect(inKeyboardOverlay(null)).toBe(false);
  /* A plain object with no `closest` (the unit fixtures elsewhere) is not in an overlay. */
  expect(inKeyboardOverlay({ tagName: "BODY" })).toBe(false);

  const open = keyContextFor({ ...studio, composer: true }, { canGenerate: true, canCompose: true, canPlay: true });
  /* The guard is containment, not tag: a button, the click-catcher and a
     tabindex div all receive keys without being fields. */
  for (const tagName of ["BUTTON", "DIV", "A", "LABEL", "SPAN"])
    for (const key of ["g", "i", "a", "3", " ", "ArrowRight"])
      expect(resolveKey(WORKSPACE_BINDINGS, { key, target: inComposer(tagName) }, open), `${key} on ${tagName}`).toBeNull();

  /* It holds even if a binding forgot the state flag — which is the point of
     guarding by containment as well as by state. */
  const stateForgot = keyContextFor(studio, { canGenerate: true, canCompose: true, canPlay: true });
  for (const key of ["g", "i", "a"])
    expect(resolveKey(WORKSPACE_BINDINGS, { key, target: inComposer("BUTTON") }, stateForgot)).toBeNull();

  /* Esc and ⌘K are the two that must still get through, so the composer can
     always be closed and the palette always opened. */
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "Escape", target: inComposer("BUTTON") }, open)?.id).toBe("escape");
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "k", metaKey: true, target: inComposer("TEXTAREA") }, open)?.id).toBe("palette");
  /* Outside the composer the same keys work as before. */
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "i", target: outside("BODY") }, keyContextFor(studio, { canGenerate: true }))?.id).toBe("inspector");
});

test("the palette shows Generate… first on an empty query", () => {
  const rows = filterPalette(paletteCommands({ shots: null }), "");
  expect(rows[0]).toMatchObject({ id: "composer", label: "Generate…", group: "ACTION", hint: "G", action: { type: "composer" } });
  /* And it is findable by name, beside the Rig row, which no longer claims G. */
  const hits = filterPalette(paletteCommands({ shots: [{ id: "s1", name: "Opening" }] }), "generate");
  expect(hits.map((row) => row.id)).toEqual(["composer", "page:generate", "plan:generate", "generate"]);
  expect(hits.find((row) => row.id === "generate")?.hint).toBe("");
});

test("a pick is used only where the engine allows it; anything else falls back to the engine's default", () => {
  const engine = { id: "e", label: "Engine", type: "video" as const, ratios: ["16:9", "9:16", "1:1"], resolutions: ["720p", "1080p"], durations: [4, 5, 6, 7, 8] };
  expect(composerSettings(engine, "9:16")).toEqual({ ratio: "9:16", resolution: "720p", duration: 5 });
  expect(composerSettings(engine, "9:16", { ratio: "1:1", resolution: "1080p", duration: 7 })).toEqual({ ratio: "1:1", resolution: "1080p", duration: 7 });
  /* Picks left over from another engine are ignored, never sent. */
  expect(composerSettings(engine, undefined, { ratio: "21:9", resolution: "4k", duration: 30 })).toEqual({ ratio: "16:9", resolution: "720p", duration: 5 });
  const picked = composerReducer(INITIAL_COMPOSER, { type: "pick", value: { duration: 12 } });
  expect(composerReducer(picked, { type: "pick", value: { ratio: "9:16" } }).picks).toEqual({ duration: 12, ratio: "9:16" });
});

test("takes per Generate: the stepper clamps to 1–4 and the button says the count times the take's price", async () => {
  const { INITIAL_COMPOSER, TAKES_MAX, composerButtonLabel, composerReducer } = await import("../../lib/workspace/composer");
  expect(TAKES_MAX).toBe(4);
  expect(composerReducer(INITIAL_COMPOSER, { type: "count", value: 3 }).count).toBe(3);
  expect(composerReducer(INITIAL_COMPOSER, { type: "count", value: 0 }).count).toBe(1);
  expect(composerReducer(INITIAL_COMPOSER, { type: "count", value: 9 }).count).toBe(4);
  const quote = { key: "k", credits: 43, state: "ready" as const, reason: null };
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: false, count: 1 })).toBe("Generate · 43 cr");
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: false, count: 2 })).toBe("Generate 2 takes · 86 cr");
  expect(composerButtonLabel({ quote: null, quoteKey: "k", submitting: false, count: 3 })).toBe("Generate 3 takes");
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: true, count: 3 })).toBe("Submitting…");
});
