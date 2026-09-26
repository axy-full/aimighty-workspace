import { test, expect } from "@playwright/test";
import { ASSET_LABEL, SAY, assetCapabilities, referenceRole, type AssetRef, type GenPreset } from "../../lib/shell/assets";
import { readGenPresets, sendGenPreset } from "../../lib/shell/gen-preset";
import { recreateBlock, recreatePreset, type RecipeSource } from "../../lib/shell/recipe";
import { ctxItems } from "../../lib/shell/context-menu";

const gen: AssetRef = { id: "generation:g1", sourceId: "g1", origin: "generation", name: "Wide on the water", media: "video" };
const up: AssetRef = { id: "upload:u1", sourceId: "u1", origin: "upload", name: "Harbour plate", media: "image" };
const audio: AssetRef = { ...up, id: "upload:u2", sourceId: "u2", name: "Room tone", media: "audio" };
const base = { clip: null, projectId: "p1", otherProjects: 1, canUndo: false };

test("a reference is an image or a video; the toast names the role", () => {
  expect(referenceRole("image")).toBe("Image");
  expect(referenceRole("video")).toBe("Video");
  expect(referenceRole("audio")).toBeNull();
  expect(SAY.referenced("Harbour plate", "Image")).toBe("Harbour plate added as Image");
});

test("every command is offered; the ones this asset cannot do say exactly why", () => {
  const caps = assetCapabilities({ ...base, asset: gen });
  expect(caps.can).toMatchObject({ copy: true, cut: true, delete: true, "use-as-reference": true, retry: true, move: true, "open-in-inspector": true });
  expect(caps.why.duplicate).toContain("Recreate");
  const items = ctxItems({ kind: "asset", id: gen.id }, caps);
  const disabled = items.filter((i) => !i.sep && i.disabled).map((i) => (i.sep ? "" : `${i.command}: ${i.reason}`));
  expect(disabled).toEqual(["paste: Nothing copied yet.", "duplicate: A generation has one copy. Recreate makes a new take from the same recipe.", "undo: Nothing to undo."]);
  expect(ASSET_LABEL.retry).toBe("Recreate");

  const forUpload = assetCapabilities({ ...base, asset: up, otherProjects: 0 });
  expect(forUpload.why.retry).toContain("nothing to recreate");
  /* A take from a tool Gen does not have is blocked, and says why. */
  const edit = assetCapabilities({ ...base, asset: { ...gen, noRecreate: "Made with a tool Gen does not have. Run it again from that tool." } });
  expect(edit.can.retry).toBeUndefined();
  expect(edit.why.retry).toBe("Made with a tool Gen does not have. Run it again from that tool.");
  expect(forUpload.why.move).toContain("no other project");
  expect(assetCapabilities({ ...base, asset: audio }).why["use-as-reference"]).toBe("References are images and videos.");
});

test("paste needs a clip and a project; a copied generation cannot be pasted, a cut one can", () => {
  expect(assetCapabilities({ ...base, asset: null, clip: { mode: "copy", asset: up } }).can.paste).toBe(true);
  expect(assetCapabilities({ ...base, asset: null, clip: { mode: "cut", asset: gen } }).can.paste).toBe(true);
  const copiedGen = assetCapabilities({ ...base, asset: null, clip: { mode: "copy", asset: gen } });
  expect(copiedGen.can.paste).toBeUndefined();
  expect(copiedGen.why.paste).toContain("cut it to move it");
  expect(assetCapabilities({ ...base, asset: null, clip: { mode: "copy", asset: up }, projectId: null }).why.paste).toBe("Open a project to paste into.");
  expect(assetCapabilities({ ...base, asset: null }).hasClipboard).toBe(false);
});

test("delete says what really happens to each kind of asset", () => {
  expect(SAY.deleted(gen)).toBe("Deleted Wide on the water · ⌘Z to undo. The original stays on the server indefinitely.");
  expect(SAY.deleted(up)).toBe("Deleted Harbour plate from this project · ⌘Z to undo. The original stays in All assets.");
  expect(SAY.cut("X")).toBe("Cut X — paste to move it.");
  expect(SAY.pasted("X", "Northline")).toBe("Pasted X into Northline");
});

/* A take as the library holds it: a plain Studio generation unless the fields say otherwise. */
const take = (fields: Partial<RecipeSource> & Pick<RecipeSource, "prompt" | "model" | "kind" | "params">): RecipeSource => ({ id: "g1", provider: "byteplus", task: "generate", ...fields });
const blockOf = (g: Pick<RecipeSource, "model" | "kind" | "params">) => recreateBlock({ task: "generate", ...g });

test("Recreate hands Gen the render's recipe, through Gen's one letterbox", () => {
  const preset = recreatePreset({ id: "g1", prompt: "a fox, enhanced", model: "seedance-2.5", kind: "video", params: { rawPrompt: "a fox" }, provider: "byteplus", task: "generate" }, { name: "Fox" });
  expect(preset).toMatchObject({ prompt: "a fox", model: "seedance-2.5", type: "video", billing: "workspace", from: { id: "g1", name: "Fox" }, note: "Recreate · Fox" });
  expect(recreatePreset({ id: "g2", prompt: "p", model: "m", kind: "model", params: {}, provider: "fal", task: "generate" }, { name: "Mesh" }).type).toBeUndefined();
  expect(SAY.recreate("Fox")).toBe("Fox’s recipe is in Gen.");
  /* A recipe travels the same letterbox as Crew's words and Soul ID's identity, and arrives whole. */
  const got: GenPreset[] = [];
  const stop = readGenPresets((p) => got.push(p));
  sendGenPreset(preset);
  expect(got).toEqual([preset]);
  stop();
});

test("a preset reaches a mounted Gen at once, and waits (the newest only) for one that is not", () => {
  const got: GenPreset[] = [];
  sendGenPreset({ prompt: "old" });
  sendGenPreset({ prompt: "new" });
  const stop = readGenPresets((p) => got.push(p));
  expect(got.map((p) => p.prompt)).toEqual(["new"]);
  sendGenPreset({ prompt: "live" });
  expect(got.map((p) => p.prompt)).toEqual(["new", "live"]);
  stop();
  /* Nothing lingers: a later Gen mount does not replay what was already applied. */
  const later: GenPreset[] = [];
  readGenPresets((p) => later.push(p))();
  expect(later).toEqual([]);
});

test("Recreate carries every input the render was made with: settings, references, the wallet, the sound", () => {
  /* A workspace render: its ratio, resolution, length and references, in order and with their roles. */
  const workspace = recreatePreset(take({
    prompt: "harbour at dawn", model: "seedance-2.5", kind: "video",
    params: { ratio: "9:16", resolution: "1080p", duration: 8, references: [{ genId: "g7", role: "first_frame", kind: "image" }, { uploadId: "u3", role: "reference_image", kind: "image" }] },
  }), { name: "Harbour" });
  expect(workspace).toMatchObject({
    billing: "workspace", picks: { ratio: "9:16", resolution: "1080p", duration: 8 },
    references: [{ origin: "generation", id: "g7", role: "first_frame", kind: "image" }, { origin: "upload", id: "u3", role: "reference_image", kind: "image" }],
  });
  expect(workspace).not.toHaveProperty("sound");
  /* A connected-account render is recreated on the connected account, with each reference's role. */
  const connected = recreatePreset(take({
    prompt: "neon alley", model: "kling_3_0", kind: "video", provider: "higgsfield",
    params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "video", settings: { aspect_ratio: "16:9", resolution: "720p", duration: 5 }, references: [{ uploadId: "u9", role: "start_image", kind: "image" }] },
  }), { name: "Alley" });
  expect(connected).toMatchObject({ billing: "connected", model: "kling_3_0", picks: { ratio: "16:9", resolution: "720p", duration: 5 }, references: [{ origin: "upload", id: "u9", role: "start_image", kind: "image" }] });
  /* Sound: length, instrumental, voice. */
  expect(recreatePreset(take({ prompt: "rain on tin", model: "eleven_music", kind: "audio", params: { task: "music", lengthMs: 45_000, instrumental: true } }), { name: "Rain" }).sound).toEqual({ seconds: 45, instrumental: true });
  expect(recreatePreset(take({ prompt: "door slam", model: "eleven_sfx", kind: "audio", params: { task: "sound", durationSeconds: 3 } }), { name: "Door" }).sound).toEqual({ seconds: 3 });
  expect(recreatePreset(take({ prompt: "Hello there", model: "eleven_multilingual_v2", kind: "audio", params: { task: "speech", voiceId: "abc123XYZ" } }), { name: "Hello" })).toMatchObject({ type: "audio", sound: { voiceId: "abc123XYZ" }, note: "Recreate · Hello" });
});

test("a take Gen cannot make again from its own inputs says why, and Recreate is blocked with that reason", () => {
  expect(blockOf({ model: "seedance-2.5", kind: "video", params: {} })).toBeNull();
  expect(blockOf({ model: "seedance-2.5", kind: "video", params: { task: "extend", sourceGenId: "g1" } })).toContain("source clip");
  expect(blockOf({ model: "eleven_sts", kind: "audio", params: { sourceUploadId: "u1" } })).toContain("source clip");
  expect(blockOf({ model: "marketing_studio_v2", kind: "image", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", workflow: "marketing-template" } })).toContain("connected tool");
  expect(blockOf({ model: "marketing_studio_video", kind: "video", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits" } })).toContain("Business");
  expect(blockOf({ model: "m", kind: "model", params: {} })).not.toBeNull();
  /* Audio takes as /api/audio stores them (lib/audioAdmission.ts): params.task is always set. */
  expect(blockOf({ model: "eleven_music", kind: "audio", params: { task: "music", lengthMs: 45_000, instrumental: true } })).toBeNull();
  expect(blockOf({ model: "eleven_sfx", kind: "audio", params: { task: "sound", durationSeconds: 3, loop: false } })).toBeNull();
  expect(blockOf({ model: "eleven_multilingual_v2", kind: "audio", params: { task: "speech", voiceId: "abc123XYZ", settings: {} } })).toBeNull();
  expect(blockOf({ model: "eleven_v3", kind: "audio", params: { task: "dialogue", lines: [{ text: "Hi", voiceId: "v1" }] } })).toBe("A dialogue is made in Edit & Sound, not Gen.");
  expect(blockOf({ model: "eleven_sts", kind: "audio", params: { task: "voiceChange", voiceId: "v1", sourceGenId: "g2" } })).toContain("source clip");
  expect(blockOf({ model: "dub", kind: "audio", params: { task: "dub", sourceKind: "generation", sourceId: "g3" } })).toContain("source clip");
  for (const task of ["edit", "motion", "upscale", "reframe", "genjutsu"])
    expect(blockOf({ model: "seedance-2.5", kind: "video", params: { task } })).toBe("This take was made from a source clip. Run that tool again from Takes.");
  expect(blockOf({ model: "seedance-2.5", kind: "video", params: { task: "generate" } })).toBeNull();
  expect(blockOf({ model: "kling_3_0", kind: "video", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits" } })).toBeNull();
  const edited: AssetRef = { ...gen, noRecreate: "This take was made from a source clip. Run that tool again from Takes." };
  const caps = assetCapabilities({ ...base, asset: edited });
  expect(caps.can.retry).toBeUndefined();
  expect(caps.why.retry).toBe(edited.noRecreate);
  /* No promise that a node can be bypassed from an asset's menu. */
  expect(caps.why.bypass).toBeUndefined();
});
