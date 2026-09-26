import { test, expect } from "@playwright/test";
import { recipeChips, recipePrompt, recreateBlock, recreatePreset, referenceTag, type RecipeSource } from "../../lib/shell/recipe";
import { setupInWords, setupLabels, setupWritable, withSetup } from "../../lib/shell/recipe-setup";
import { assetCapabilities, assetRef } from "../../lib/shell/assets";
import { composerReducer, composerSettings, INITIAL_COMPOSER, type ComposerModel, type ComposerState } from "../../lib/workspace/composer";
import type { LibraryEntry } from "../../lib/workspace/library";

/**
 * Recreate carries a take's whole recipe to Gen (idea 7): the words as typed,
 * the credits that paid, the model, its settings, the references, the Soul
 * identity and the shot setup — and says what Gen could not keep.
 */
const take = (fields: Partial<RecipeSource> & { params: Record<string, unknown> }): RecipeSource => ({
  id: "gen_take", kind: "video", model: "dreamina-seedance-2-5-260628", prompt: "The written prompt", provider: "byteplus", task: "generate", ...fields,
});

test("a Studio take carries its typed words, settings, references in order, and shot setup", () => {
  const preset = recreatePreset(take({
    prompt: "Rewritten by the prompt writer",
    params: {
      rawPrompt: "harbour at dusk, @Image1 walks in", ratio: "21:9", resolution: "1080p", duration: 8, generateAudio: true,
      references: [
        { genId: "gen_plate", role: "reference_image", kind: "image" },
        { uploadId: "up_clip", role: "reference_video", kind: "video" },
        { uploadId: "../etc/passwd", kind: "image" },
        { nothing: true },
      ],
      shotSpec: { shot: "cu", move: "push", empty: "", count: 3 },
    },
  }), { name: "Harbour dusk" });
  expect(preset).toEqual({
    prompt: "harbour at dusk, @Image1 walks in",
    model: "dreamina-seedance-2-5-260628",
    type: "video",
    billing: "workspace",
    picks: { ratio: "21:9", resolution: "1080p", duration: 8 },
    references: [
      { origin: "generation", id: "gen_plate", role: "reference_image", kind: "image" },
      { origin: "upload", id: "up_clip", role: "reference_video", kind: "video" },
    ],
    shotSpec: { shot: "cu", move: "push" },
    from: { id: "gen_take", name: "Harbour dusk" },
    note: "Recreate · Harbour dusk",
  });
  /* An image carries no length; without a raw prompt the stored words are the recipe's. */
  const still = recreatePreset(take({ kind: "image", model: "gpt-image-2", prompt: "a still", params: { ratio: "1:1", resolution: "2K", duration: 5 } }), { name: "Still", settingsOnly: true });
  expect(still).toMatchObject({ prompt: "a still", type: "image", picks: { ratio: "1:1", resolution: "2K" }, settingsOnly: true, note: "Settings · Still" });
  expect(still.picks).not.toHaveProperty("duration");
  expect(recipePrompt({ prompt: "sent", params: { rawPrompt: "  " } })).toBe("sent");
  /* At most ten references, the composer's own limit. */
  const many = recreatePreset(take({ params: { references: Array.from({ length: 14 }, (_, i) => ({ uploadId: `up_${i}`, kind: "image" })) } }), { name: "Many" });
  expect(many.references).toHaveLength(10);
});

test("a take made on the connected account carries the account's own settings and its Soul identity", () => {
  const preset = recreatePreset(take({
    provider: "higgsfield", model: "soul_cinematic", kind: "image", prompt: "portrait on the pier",
    params: {
      task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "image", duration: 4.97, width: 1024,
      settings: { aspect_ratio: "3:4", resolution: "2k", soul_id: "soul_abc", enhance_prompt: true },
      references: [{ uploadId: "up_face", role: "image", kind: "image" }],
      enhancedPrompt: "the account's own rewrite",
    },
  }), { name: "Pier portrait" });
  expect(preset).toMatchObject({ billing: "connected", model: "soul_cinematic", type: "image", prompt: "portrait on the pier", picks: { ratio: "3:4", resolution: "2k", soulId: "soul_abc" } });
  expect(preset.references).toEqual([{ origin: "upload", id: "up_face", role: "image", kind: "image" }]);
  /* The measured length of the file is not what was asked for. */
  const clip = recreatePreset(take({ provider: "higgsfield", params: { task: "connected-generation", duration: 4.97, settings: { duration: 5 } } }), { name: "Clip" });
  expect(clip.picks).toEqual({ duration: 5 });
  /* A Studio engine served by the same vendor bills this workspace: it is not the connected account's. */
  expect(recreatePreset(take({ provider: "higgsfield", params: { ratio: "16:9" } }), { name: "Studio" }).billing).toBe("workspace");
});

test("a sound take carries its length, instrumental switch and voice; never references", () => {
  const music = recreatePreset(take({ kind: "audio", model: "eleven_music", params: { task: "music", lengthMs: 30_000, instrumental: false, references: [{ uploadId: "up_x" }] } }), { name: "Theme" });
  expect(music).toMatchObject({ type: "audio", sound: { seconds: 30, instrumental: false } });
  expect(music.references).toBeUndefined();
  const line = recreatePreset(take({ kind: "audio", model: "eleven_v3", params: { task: "speech", voiceId: "voice_1" } }), { name: "Line" });
  expect(line.sound).toEqual({ voiceId: "voice_1" });
  expect(recreatePreset(take({ kind: "audio", model: "eleven_sfx", params: { task: "sound", durationSeconds: 4 } }), { name: "Hit" }).sound).toEqual({ seconds: 4 });
});

test("what Gen cannot recreate says so, and the menu and the Inspector block it", () => {
  expect(recreateBlock({ kind: "video", params: {}, task: "generate" })).toBeNull();
  expect(recreateBlock({ kind: "image", params: { task: "connected-generation" }, task: "generate" })).toBeNull();
  expect(recreateBlock({ kind: "audio", params: { task: "music" }, task: "generate" })).toBeNull();
  expect(recreateBlock({ kind: "model", params: {}, task: "generate" })).toBe("Gen makes images, video and sound, not 3D.");
  const tool = "Made with a tool Gen does not have. Run it again from that tool.";
  for (const blocked of [
    { kind: "video" as const, params: {}, task: "edit" },
    { kind: "video" as const, params: { task: "genjutsu" }, task: "generate" },
    { kind: "video" as const, params: { task: "connected-generation", workflow: "shorts" }, task: "generate" },
    { kind: "image" as const, params: { marketing: { campaign: "c" } }, task: "generate" },
    { kind: "image" as const, params: { soulIdentityId: "id_1" }, task: "generate" },
    { kind: "audio" as const, params: { task: "voiceChange" }, task: "generate" },
  ]) expect(recreateBlock(blocked)).toBe(tool);

  const entry = (params: Record<string, unknown>, task = "generate") => ({
    take: { id: "generation:g1", sourceId: "g1", name: "Wide" }, media: "video",
    asset: { origin: "generation", value: { id: "g1", kind: "video", params, task, model: "m", prompt: "p", provider: "byteplus" } },
  }) as unknown as LibraryEntry;
  expect(assetRef(entry({}))).not.toHaveProperty("noRecreate");
  const edit = assetRef(entry({}, "edit"));
  expect(edit.noRecreate).toBe(tool);
  const caps = assetCapabilities({ asset: edit, clip: null, projectId: "p1", otherProjects: 0, canUndo: false });
  expect(caps.can.retry).toBeUndefined();
  expect(caps.why.retry).toBe(tool);
});

const seedance: ComposerModel = { id: "dreamina-seedance-2-5-260628", label: "Seedance 2.5", type: "video", ratios: ["16:9", "9:16", "21:9"], resolutions: ["720p", "1080p"], durations: [5, 8, 10] };
const kling: ComposerModel = { id: "kling-3-std", label: "Kling 3.0 Standard", type: "video", ratios: ["16:9", "9:16"], resolutions: ["1080p"], durations: [5, 10] };
const soul: ComposerModel = { id: "soul_cinematic", label: "Soul Cinematic", type: "image", connected: true, soulId: true, ratios: ["3:4", "1:1"] };

test("the card's chips: kept where Gen holds the take's value, changed with a reason where it cannot", () => {
  const preset = recreatePreset(take({ params: { ratio: "21:9", resolution: "1080p", duration: 8 } }), { name: "Harbour" });
  const kept = recipeChips({ preset, billing: "workspace", model: seedance, settings: composerSettings(seedance, "16:9", preset.picks), reading: false, identities: null });
  expect(kept.map((c) => [c.key, c.value, c.state])).toEqual([["model", "Seedance 2.5", "kept"], ["ratio", "21:9", "kept"], ["resolution", "1080p", "kept"], ["duration", "8 s", "kept"]]);

  /* The engine is gone from the list: Gen says which one runs instead, and what it does not offer. */
  const moved = recipeChips({ preset, billing: "workspace", model: kling, settings: composerSettings(kling, "16:9", preset.picks), reading: false, identities: null });
  expect(moved.map((c) => [c.key, c.value, c.state, c.why])).toEqual([
    ["model", "Seedance 2.5 → Kling 3.0 Standard", "changed", "Not offered here now"],
    ["ratio", "21:9 → 16:9", "changed", "Kling 3.0 Standard has no 21:9"],
    ["resolution", "1080p", "kept", undefined],
    ["duration", "8 s → 5 s", "changed", "Kling 3.0 Standard has no 8 s"],
  ]);
  /* A setting the person changed afterwards reads as changed here, not as missing. */
  const edited = recipeChips({ preset, billing: "workspace", model: seedance, settings: composerSettings(seedance, "16:9", { ...preset.picks, ratio: "9:16" }), reading: false, identities: null });
  expect(edited.find((c) => c.key === "ratio")).toMatchObject({ value: "21:9 → 9:16", why: "Changed here" });
  /* While the model list is read, only the model shows, as reading. */
  expect(recipeChips({ preset, billing: "workspace", model: null, settings: composerSettings(null), reading: true, identities: null })).toEqual([{ key: "model", label: "Model", value: "Seedance 2.5", state: "reading" }]);
});

test("a connected recipe: a member recreates on Studio engines, and a vanished identity is never sent", () => {
  const preset = recreatePreset(take({ provider: "higgsfield", kind: "image", model: "soul_cinematic", params: { task: "connected-generation", settings: { aspect_ratio: "3:4", soul_id: "soul_abc" } } }), { name: "Pier" });
  const member = recipeChips({ preset, billing: "workspace", model: null, settings: composerSettings(null, undefined, preset.picks), reading: false, identities: null });
  expect(member[0]).toMatchObject({ key: "model", state: "changed", why: "The connected account is the owner’s" });

  const owner = (identities: { soulId: string; name: string; status: string | null }[] | null, picks = preset.picks) =>
    recipeChips({ preset, billing: "connected", model: soul, settings: composerSettings(soul, undefined, picks), reading: false, identities }).find((c) => c.key === "identity");
  expect(owner(null)).toMatchObject({ state: "reading" });
  expect(owner([{ soulId: "soul_abc", name: "Mara", status: "ready" }])).toMatchObject({ value: "Mara", state: "kept" });
  expect(owner([{ soulId: "soul_abc", name: "Mara", status: "training" }])).toMatchObject({ value: "Identity → none", state: "changed", why: "No longer on the account" });
  expect(owner([])).toMatchObject({ state: "changed", why: "No longer on the account" });
});

test("the composer takes a recipe in one step, a settings-only one keeps its words, and Undo puts it back", () => {
  const before: ComposerState = {
    ...INITIAL_COMPOSER, type: "image", prompt: "my own words", count: 3,
    references: [{ key: "upload:u9", id: "u9", origin: "upload", kind: "image", name: "mine.png", url: "/api/uploads/u9" }],
    picks: { ratio: "1:1" },
  };
  const full = composerReducer(before, { type: "recipe", value: { type: "video", billing: "workspace", model: "seedance-2.5", picks: { ratio: "21:9", duration: 8 }, prompt: "harbour at dusk", references: [] } });
  expect(full).toMatchObject({ type: "video", billing: "workspace", prompt: "harbour at dusk", references: [], picks: { ratio: "21:9", duration: 8 }, count: 1, notice: null });
  expect(full.chosen["workspace:video"]).toBe("seedance-2.5");

  const settingsOnly = composerReducer(before, { type: "recipe", value: { type: "image", billing: "connected", model: "soul_cinematic", picks: { ratio: "3:4", soulId: "soul_abc" } } });
  expect(settingsOnly).toMatchObject({ prompt: "my own words", references: before.references, billing: "connected", picks: { ratio: "3:4", soulId: "soul_abc" } });
  expect(settingsOnly.chosen["connected:image"]).toBe("soul_cinematic");

  const sound = composerReducer(before, { type: "recipe", value: { type: "audio", billing: "workspace", model: "eleven_music", picks: {}, prompt: "a theme", sound: { seconds: 30, instrumental: false } } });
  expect(sound).toMatchObject({ type: "audio", references: [], seconds: 30, instrumental: false });

  expect(composerReducer(full, { type: "restore", value: before })).toEqual({ ...before, notice: null });
});

test("a missing reference is named the way the well named it", () => {
  expect(referenceTag({ kind: "image" }, 1)).toBe("@Image2");
  expect(referenceTag({ kind: "video" }, 0)).toBe("@Video1");
  expect(referenceTag({}, 2)).toBe("@Image3");
});

test("a shot setup travels as words: labelled from the bank, written in once, recognised when already there", () => {
  const spec = { shot: "cu", move: "push", unknown: "custom move" };
  expect(setupLabels(spec)).toEqual(["Close-up", "Push in", "custom move"]);
  expect(setupWritable(spec)).toBe(true);
  expect(setupWritable({ unknown: "x" })).toBe(false);
  const written = withSetup("a fisherman mends a net", spec);
  expect(written.startsWith("a fisherman mends a net.")).toBe(true);
  expect(setupInWords("a fisherman mends a net", spec)).toBe(false);
  expect(setupInWords(written, spec)).toBe(true);
});
