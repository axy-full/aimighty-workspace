import { test, expect } from "@playwright/test";
import { ACCOUNT_MODEL, cites, nearestSetting, recipeChips, recipePrompt, recreateBlock, recreatePreset, referenceTags, retagRecipe, type RecipeSource } from "../../lib/shell/recipe";
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
  expect(preset).toMatchObject({ billing: "connected", model: "soul_cinematic", type: "image", prompt: "portrait on the pier", picks: { ratio: "3:4", resolution: "2k", soulId: "soul_abc" }, enhance: true });
  expect(preset.references).toEqual([{ origin: "upload", id: "up_face", role: "image", kind: "image" }]);
  /* The measured length of the file is not what was asked for. */
  const clip = recreatePreset(take({ provider: "higgsfield", params: { task: "connected-generation", duration: 4.97, settings: { duration: 5 } } }), { name: "Clip" });
  expect(clip.picks).toEqual({ duration: 5 });
  expect(clip).not.toHaveProperty("enhance");
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
  const made = (kind: "video" | "image" | "audio" | "model", params: Record<string, unknown>, task = "generate", model = "m") => ({ kind, model, params, task });
  expect(recreateBlock(made("video", {}))).toBeNull();
  expect(recreateBlock(made("image", { task: "connected-generation", consumerCreditUnit: "higgsfield_credits" }, "generate", "soul_cinematic"))).toBeNull();
  expect(recreateBlock(made("audio", { task: "music" }))).toBeNull();
  expect(recreateBlock(made("audio", { task: "speech", voiceId: "v1" }))).toBeNull();
  expect(recreateBlock(made("model", {}))).toBe("Gen makes images, video and sound, not 3D.");
  const tool = "Made with a tool Gen does not have. Run it again from that tool.";
  for (const blocked of [
    made("video", {}, "edit"),
    made("video", { task: "genjutsu" }),
    made("video", { task: "connected-generation", workflow: "shorts" }),
    made("image", { marketing: { campaign: "c" } }),
    made("image", { soulIdentityId: "id_1" }),
    made("audio", { task: "voiceChange" }),
    made("audio", { task: "dialogue", lines: [] }),
    /* A dub (lib/dubbing.ts): the task column says "generate", params say "dub". */
    made("audio", { task: "dub", dubbingStatus: "dubbed", dubbingJobId: "dub_1", sourceUploadId: "up_clip", targetLang: "fr" }, "generate", "eleven_dubbing_v1"),
    /* A trained identity's still (app/api/identities/[id]/render). */
    made("image", { ratio: "1:1", resolution: "1K", rawPrompt: "on the pier", identity: { id: "idn_1", name: "Mara" }, cast: ["Mara"] }),
    /* The account's marketing video (lib/higgsfield-consumer/original-identity.ts): no task, receipted in account credits. */
    made("video", { resolution: "720p", aspectRatio: "9:16", ratio: "9:16", generateAudio: true, consumerJobId: "j", consumerCreditUnit: "higgsfield_credits", duration: 8.04 }, "generate", "marketing_studio_video"),
    made("video", { ratio: "16:9" }, "generate", "marketing_studio_video"),
    /* Any tool added later is blocked until Gen can make it. */
    made("video", { task: "upscale" }),
  ]) expect(recreateBlock(blocked), JSON.stringify(blocked)).toBe(tool);

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

const chipsFor = (input: Partial<Parameters<typeof recipeChips>[0]> & Pick<Parameters<typeof recipeChips>[0], "preset" | "model" | "settings">) =>
  recipeChips({ type: input.preset.type ?? "video", billing: "workspace", models: input.model ? [input.model] : [], reading: false, blocked: null, owner: false, identities: null, ...input });

test("the card's chips: kept where Gen holds the take's value, changed with a reason where it cannot", () => {
  const preset = recreatePreset(take({ params: { ratio: "21:9", resolution: "1080p", duration: 8 } }), { name: "Harbour" });
  const kept = chipsFor({ preset, model: seedance, models: [seedance, kling], settings: composerSettings(seedance, "16:9", preset.picks) });
  expect(kept.map((c) => [c.key, c.value, c.state])).toEqual([["model", "Seedance 2.5", "kept"], ["ratio", "21:9", "kept"], ["resolution", "1080p", "kept"], ["duration", "8 s", "kept"]]);

  /* The engine is gone from the list: Gen says which one runs instead, and what it does not offer. */
  const moved = chipsFor({ preset, model: kling, models: [kling], settings: composerSettings(kling, "16:9", preset.picks) });
  expect(moved.map((c) => [c.key, c.value, c.state, c.why])).toEqual([
    ["model", "Seedance 2.5 → Kling 3.0 Standard", "changed", "Not offered here now"],
    ["ratio", "21:9 → 16:9", "changed", "Kling 3.0 Standard has no 21:9"],
    ["resolution", "1080p", "kept", undefined],
    ["duration", "8 s → 5 s", "changed", "Kling 3.0 Standard has no 8 s"],
  ]);
  /* The engine is still offered and the person chose another: that is their change, not a missing engine. */
  const picked = chipsFor({ preset, model: kling, models: [seedance, kling], settings: composerSettings(kling, "16:9", preset.picks) });
  expect(picked[0]).toMatchObject({ value: "Seedance 2.5 → Kling 3.0 Standard", why: "Changed here" });
  /* A setting the person changed afterwards reads as changed here, not as missing. */
  const edited = chipsFor({ preset, model: seedance, settings: composerSettings(seedance, "16:9", { ...preset.picks, ratio: "9:16" }) });
  expect(edited.find((c) => c.key === "ratio")).toMatchObject({ value: "21:9 → 9:16", why: "Changed here" });
  /* While the model list is read, only the model shows, as reading. */
  expect(chipsFor({ preset, model: null, settings: composerSettings(null), reading: true })).toEqual([{ key: "model", label: "Model", value: "Seedance 2.5", state: "reading" }]);
  /* The list failed or the account is not connected: one line, the composer's own reason, and no per-setting noise. */
  expect(chipsFor({ preset, model: null, settings: composerSettings(null), blocked: "The engines could not be read." })).toEqual([
    { key: "model", label: "Model", value: "Seedance 2.5 → none", state: "changed", why: "The engines could not be read." },
  ]);
});

test("a connected recipe: named by the account's list, the right reason for each person, and a vanished identity is never sent", () => {
  const preset = recreatePreset(take({ provider: "higgsfield", kind: "image", model: "soul_cinematic", params: { task: "connected-generation", settings: { aspect_ratio: "3:4", soul_id: "soul_abc" } } }), { name: "Pier" });
  const studio: ComposerModel = { id: "gpt-image-2", label: "GPT Image 2", type: "image", ratios: ["1:1", "3:4"] };
  /* A member: the account is the owner's. Its catalogue id is not a name, so it is not dressed up as one. */
  const member = chipsFor({ preset, model: studio, settings: composerSettings(studio, undefined, preset.picks) });
  expect(member[0]).toMatchObject({ key: "model", value: `${ACCOUNT_MODEL} → GPT Image 2`, state: "changed", why: "The connected account is the owner’s" });
  /* The owner who chose Studio engines is told that, not that the account is someone else's. */
  const ownerOnStudio = chipsFor({ preset, model: studio, owner: true, settings: composerSettings(studio, undefined, preset.picks) });
  expect(ownerOnStudio[0]).toMatchObject({ why: "Studio engines chosen" });
  /* The owner whose account is not connected sees why, once. */
  const unconnected = "No account is connected. Connect one in Workspace › Engines, or use this workspace’s credits.";
  expect(chipsFor({ preset, billing: "connected", owner: true, model: null, settings: composerSettings(null), blocked: unconnected })).toEqual([
    { key: "model", label: "Model", value: `${ACCOUNT_MODEL} → none`, state: "changed", why: unconnected },
  ]);

  const owner = (identities: { soulId: string; name: string; status: string | null }[] | null, picks = preset.picks) =>
    chipsFor({ preset, billing: "connected", owner: true, model: soul, settings: composerSettings(soul, undefined, picks), identities }).find((c) => c.key === "identity");
  /* With the account's list read, the model reads by the catalogue's own name. */
  expect(chipsFor({ preset, billing: "connected", owner: true, model: soul, settings: composerSettings(soul, undefined, preset.picks) })[0]).toMatchObject({ value: "Soul Cinematic", state: "kept" });
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
  /* A member recreating a connected take: no model is carried, so their own workspace engine choice stands. */
  const mine = { ...before, type: "video" as const, chosen: { "workspace:video": "kling-3-std" } };
  expect(composerReducer(mine, { type: "recipe", value: { type: "video", billing: "workspace", picks: { ratio: "9:16" }, prompt: "a gull" } }).chosen).toEqual({ "workspace:video": "kling-3-std" });
});

test("citations count within their kind, the way the engine numbers what it is sent", () => {
  expect(referenceTags(["video", "image", "image", "audio", undefined])).toEqual(["@Video1", "@Image1", "@Image2", null, null]);
  expect(cites("@Image1 walks", "@Image1")).toBe(true);
  expect(cites("@Image12 walks", "@Image1")).toBe(false);
});

test("a gone reference: the ones still here are renumbered, the gone one keeps a citation of its own", () => {
  /* The take: an upload that is gone, then a still that is here. */
  const moved = retagRecipe("@Image2 walks the pier past @Image1", [{ kind: "image", found: false }, { kind: "image", found: true }]);
  expect(moved.was).toEqual(["@Image1", "@Image2"]);
  expect(moved.now).toEqual(["@Image2", "@Image1"]);
  /* The still is @Image1 in the well now; the gone upload's citation is @Image2, which nothing fills yet. */
  expect(moved.prompt).toBe("@Image1 walks the pier past @Image2");
  /* Kinds are counted apart: a gone video does not move the images. */
  const mixed = retagRecipe("@Video1 then @Image1 and @Image2", [{ kind: "video", found: false }, { kind: "image", found: true }, { kind: "image", found: true }]);
  expect(mixed.prompt).toBe("@Video1 then @Image1 and @Image2");
  expect(mixed.now).toEqual(["@Video1", "@Image1", "@Image2"]);
  /* Nothing gone, nothing moved; @Image12 is not @Image1. */
  expect(retagRecipe("@Image1 and @Image12", [{ kind: "image", found: true }]).prompt).toBe("@Image1 and @Image12");
  const three = retagRecipe("@Image1, @Image2, @Image3", [{ kind: "image", found: false }, { kind: "image", found: true }, { kind: "image", found: false }]);
  expect(three.prompt).toBe("@Image2, @Image1, @Image3");
});

test("a size or length the new model does not offer lands on the nearest one at or below it", () => {
  expect(nearestSetting("4k", ["480p", "720p", "1080p"])).toBe("1080p");
  expect(nearestSetting("1080p", ["480p", "720p"])).toBe("720p");
  expect(nearestSetting("480p", ["720p", "1080p"])).toBe("720p");
  expect(nearestSetting("2K", ["1K", "4K"])).toBe("1K");
  expect(nearestSetting("1080p", ["720p", "1080p"])).toBeUndefined();
  expect(nearestSetting("auto", ["720p"])).toBeUndefined();
  expect(nearestSetting(8, [5, 10])).toBe(5);
  expect(nearestSetting(12, [5, 10])).toBe(10);
  expect(nearestSetting(3, [5, 10])).toBe(5);
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
