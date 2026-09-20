import { test, expect } from "@playwright/test";
import {
  activeModel,
  billingWording,
  composerBlock,
  composerButtonLabel,
  composerReducer,
  composerSettings,
  connectedModels,
  INITIAL_COMPOSER,
  liveCredits,
  offeredModels,
  quoteKeyFor,
  workspaceModels,
  type ComposerModel,
  type ComposerQuote,
  type ComposerState,
  type EngineRow,
} from "../../lib/workspace/composer";
import { INITIAL_STATE, generateTarget } from "../../lib/workspace/navigation";
import { WORKSPACE_BINDINGS, keyContextFor, resolveKey } from "../../lib/workspace/keys";
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
    billing: state.billing, type: state.type, modelId: model?.id ?? "", settings,
    references: state.references, prompt: state.prompt.trim(), seconds: state.seconds,
    instrumental: state.instrumental, voiceId: state.voiceId,
  });
}

test("the composer opens on Image with a defaulted model, so it works untouched", () => {
  const models = workspaceModels(engines, audio);
  expect(INITIAL_COMPOSER.type).toBe("image");
  expect(INITIAL_COMPOSER.billing).toBe("workspace");
  /* Identity and campaign engines cannot render from an untouched composer. */
  expect(models.filter((m) => m.type === "image").map((m) => m.id)).toEqual(["gemini-3.1-flash-image"]);
  /* Catalogue order kept, so the first of each type is the default. */
  expect(activeModel(INITIAL_COMPOSER, models)?.id).toBe("gemini-3.1-flash-image");
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

test("a chosen model is kept per type and per billing source, and falls back when withdrawn", () => {
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
  /* Switching to the connected source carries no workspace model over. */
  const connected = composerReducer(state, { type: "billing", value: "connected" });
  expect(activeModel(connected, connectedModels([{ id: "cm-video", name: "Motion", outputType: "video" }]))?.id).toBe("cm-video");
});

test("the billing switch changes the model list and the price source", () => {
  const rows = [
    { id: "cm-image", name: "Connected image", outputType: "image", medias: [{ roles: ["reference_image"] }] },
    { id: "cm-video", name: "Connected video", outputType: "video" },
    { id: "cm-3d", name: "Connected 3D", outputType: "3d" },
  ];
  const connected = connectedModels(rows);
  /* 3D is not one of the composer's three types, so it is not offered. */
  expect(connected.map((m) => m.id)).toEqual(["cm-image", "cm-video"]);
  expect(connected[0].referenceRoles).toEqual(["reference_image"]);
  const state = composerReducer(INITIAL_COMPOSER, { type: "billing", value: "connected" });
  expect(state.billing).toBe("connected");
  expect(offeredModels(state, connected).map((m) => m.id)).toEqual(["cm-image"]);
  /* The price belongs to a source: the same inputs under the other source are a different quote. */
  expect(keyOf(state, connected[0])).not.toBe(keyOf({ ...state, billing: "workspace" }, connected[0]));
  /* And the wording says which credits are charged, without naming the provider. */
  expect(billingWording("workspace", { workspaceName: "Northside" })).toContain("Northside");
  const wording = billingWording("connected", { walletName: "Studio wallet" });
  expect(wording).toContain("connected account");
  expect(wording).toContain("Studio wallet");
  expect(`${billingWording("workspace", {})} ${wording}`).not.toMatch(/Higgsfield|Seedance|Kling/i);
});

test("a missing or stale quote blocks the send with a visible reason", () => {
  const models = workspaceModels(engines, audio);
  const model = activeModel(INITIAL_COMPOSER, models)!;
  const withPrompt = composerReducer(INITIAL_COMPOSER, { type: "prompt", value: "a lighthouse at dusk" });
  const key = keyOf(withPrompt, model);
  const base = { state: withPrompt, model, quoteKey: key, submitting: false, capability: null, catalogue };

  /* Nothing written yet. */
  expect(composerBlock({ ...base, state: INITIAL_COMPOSER, quote: ready(keyOf(INITIAL_COMPOSER, model), 3) })).toBe("Write what to generate.");
  /* No quote at all. */
  expect(composerBlock({ ...base, quote: null })).toBe("Getting the live price…");
  /* A quote for other inputs is stale: it blocks, and its figure is never used. */
  expect(composerBlock({ ...base, quote: ready("some other key", 18) })).toBe("Getting the live price…");
  expect(liveCredits(ready("some other key", 18), key)).toBeNull();
  expect(composerButtonLabel({ billing: "workspace", quote: ready("some other key", 18), quoteKey: key, submitting: false })).toBe("Generate");
  /* A refused price says why. */
  expect(composerBlock({ ...base, quote: { key, credits: null, state: "unavailable", reason: "This engine is unavailable." } })).toBe("This engine is unavailable.");
  expect(composerBlock({ ...base, quote: { key, credits: null, state: "loading", reason: null } })).toBe("Getting the live price…");
  /* A current, ready figure clears the block and lands on the button. */
  expect(composerBlock({ ...base, quote: ready(key, 18) })).toBeNull();
  expect(composerButtonLabel({ billing: "workspace", quote: ready(key, 18), quoteKey: key, submitting: false })).toBe("Generate · 18 cr");
  expect(composerButtonLabel({ billing: "connected", quote: ready(key, 1296), quoteKey: key, submitting: false })).toBe("Generate · 1,296 connected cr");
  expect(composerButtonLabel({ billing: "workspace", quote: ready(key, 18), quoteKey: key, submitting: true })).toBe("Submitting…");
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
  expect(quoteKeyFor({ billing: "workspace", type: "video", modelId: video.id, settings: { ...settings, resolution: "1080p" }, references: [], prompt: "", seconds: 10, instrumental: true, voiceId: "" }))
    .not.toBe(quoteKeyFor({ billing: "workspace", type: "video", modelId: video.id, settings, references: [], prompt: "", seconds: 10, instrumental: true, voiceId: "" }));
  /* Video is not priced by its prompt; sound and the connected account are. */
  expect(keyOf({ ...state, prompt: "another wave" }, video)).toBe(key);
  const sound: ComposerState = { ...INITIAL_COMPOSER, type: "audio", prompt: "rain" };
  expect(keyOf({ ...sound, prompt: "thunder" }, models.find((m) => m.audioTask === "sound")!)).not.toBe(keyOf(sound, models.find((m) => m.audioTask === "sound")!));
  expect(keyOf({ ...sound, seconds: 20 }, models.find((m) => m.audioTask === "sound")!)).not.toBe(keyOf(sound, models.find((m) => m.audioTask === "sound")!));
});

test("the connected source blocks with its own reasons until it can pay", () => {
  const model = connectedModels([{ id: "cm-image", name: "Connected image", outputType: "image" }])[0];
  const state = composerReducer(composerReducer(INITIAL_COMPOSER, { type: "billing", value: "connected" }), { type: "prompt", value: "a lighthouse" });
  const key = keyOf(state, model);
  const base = { state, model, quote: ready(key, 9), quoteKey: key, submitting: false, catalogue };
  expect(composerBlock({ ...base, capability: null })).toBe("Reading the connected account…");
  expect(composerBlock({ ...base, capability: { owner: false, connected: false, suspended: false } })).toMatch(/workspace owner/);
  expect(composerBlock({ ...base, capability: { owner: true, connected: false, suspended: false } })).toMatch(/No account is connected/);
  expect(composerBlock({ ...base, capability: { owner: true, connected: true, suspended: true } })).toMatch(/paused/);
  expect(composerBlock({ ...base, capability: { owner: true, connected: true, suspended: false } })).toBeNull();
  /* A catalogue that cannot be read is said so, not silently empty. */
  expect(composerBlock({ ...base, capability: { owner: true, connected: true, suspended: false }, model: null, catalogue: { loading: true, error: null } })).toBe("Reading the available models…");
  expect(composerBlock({ ...base, capability: { owner: true, connected: true, suspended: false }, model: null, catalogue: { loading: false, error: null } }))
    .toBe("No image model is available on this account.");
});

test("sound needs a voice for speech, and a model's own settings are what it renders with", () => {
  const models = workspaceModels(engines, audio);
  const speech = models.find((m) => m.audioTask === "speech")!;
  const state: ComposerState = { ...INITIAL_COMPOSER, type: "audio", prompt: "Read this line." };
  const key = keyOf(state, speech);
  expect(composerBlock({ state, model: speech, quote: ready(key, 2), quoteKey: key, submitting: false, capability: null, catalogue })).toBe("Choose a voice.");
  const voiced = composerReducer(state, { type: "voice", value: "v1" });
  const voicedKey = keyOf(voiced, speech);
  expect(composerBlock({ state: voiced, model: speech, quote: ready(voicedKey, 2), quoteKey: voicedKey, submitting: false, capability: null, catalogue })).toBeNull();
  /* Settings come from the engine, and the project's aspect wins where the engine allows it. */
  const video = models.find((m) => m.id === "dreamina-seedance-2-5-260628")!;
  expect(composerSettings(video)).toEqual({ ratio: "16:9", resolution: "720p", duration: 5 });
  expect(composerSettings(video, "9:16").ratio).toBe("9:16");
  expect(composerSettings(video, "4:5").ratio).toBe("16:9");
  expect(composerSettings(models.find((m) => m.id === "fal-ai/kling-video/v3/standard")!).resolution).toBe("1080p");
});

test("changing type drops what the new type cannot use, and reset keeps the source", () => {
  const reference = { key: "upload:a", id: "a", origin: "upload" as const, kind: "image" as const, name: "a.png", url: "/api/uploads/a" };
  let state = composerReducer(INITIAL_COMPOSER, { type: "addReference", value: reference });
  expect(state.references).toHaveLength(1);
  /* The same file twice is one reference. */
  expect(composerReducer(state, { type: "addReference", value: reference }).references).toHaveLength(1);
  state = composerReducer(state, { type: "type", value: "video" });
  expect(state.references).toHaveLength(1);
  expect(composerReducer(state, { type: "type", value: "audio" }).references).toEqual([]);
  expect(composerReducer(state, { type: "removeReference", key: "upload:a" }).references).toEqual([]);
  const noticed = composerReducer({ ...state, billing: "connected", notice: "The price moved." }, { type: "reset" });
  expect(noticed.billing).toBe("connected");
  expect(noticed.prompt).toBe("");
  expect(noticed.notice).toBeNull();
  /* Any edit clears a stale notice, so a moved price is never shown beside new inputs. */
  expect(composerReducer({ ...state, notice: "The price moved." }, { type: "prompt", value: "x" }).notice).toBeNull();
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

test("the palette shows Generate… first on an empty query", () => {
  const rows = filterPalette(paletteCommands({ shots: null }), "");
  expect(rows[0]).toMatchObject({ id: "composer", label: "Generate…", group: "ACTION", hint: "G", action: { type: "composer" } });
  /* And it is findable by name, beside the Rig row, which no longer claims G. */
  const hits = filterPalette(paletteCommands({ shots: [{ id: "s1", name: "Opening" }] }), "generate");
  expect(hits.map((row) => row.id)).toEqual(["composer", "page:generate", "plan:generate", "generate"]);
  expect(hits.find((row) => row.id === "generate")?.hint).toBe("");
});
