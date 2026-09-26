import { test, expect } from "@playwright/test";
import { ASSET_LABEL, SAY, assetCapabilities, referenceRole, retryBlock, retryPreset, type AssetRef, type GenPreset } from "../../lib/shell/assets";
import { readGenPresets, sendGenPreset } from "../../lib/shell/gen-preset";
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
  expect(caps.why.duplicate).toContain("Retry generation");
  const items = ctxItems({ kind: "asset", id: gen.id }, caps);
  const disabled = items.filter((i) => !i.sep && i.disabled).map((i) => (i.sep ? "" : `${i.command}: ${i.reason}`));
  expect(disabled).toEqual(["paste: Nothing copied yet.", "duplicate: A generation has one copy. Use Retry generation for a new take with the same inputs.", "undo: Nothing to undo."]);
  expect(ASSET_LABEL.retry).toBe("Retry generation");

  const forUpload = assetCapabilities({ ...base, asset: up, otherProjects: 0 });
  expect(forUpload.why.retry).toContain("nothing to retry");
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

test("Retry hands Gen the render's own inputs: words, engine, catalogue, settings, identity and references", () => {
  const preset = retryPreset({ prompt: "a fox, enhanced", model: "seedance-2.5", kind: "video", params: { rawPrompt: "a fox", ratio: "9:16", resolution: "1080p", duration: 10, references: [{ genId: "g7", role: "reference_image", kind: "image" }, { uploadId: "u3", role: "reference_video", kind: "video" }, { url: "https://elsewhere.invalid/x.png" }] }, title: "Fox" });
  expect(preset).toEqual({ prompt: "a fox", model: "seedance-2.5", type: "video", billing: "workspace", references: [{ genId: "g7", role: "reference_image" }, { uploadId: "u3", role: "reference_video" }], picks: { ratio: "9:16", resolution: "1080p", duration: 10 }, kept: "same inputs", note: "Retry · Fox · same inputs · new seed" });
  expect(SAY.retry("Fox", preset.kept)).toBe("Retry Fox — same inputs, new seed. Quoted before it runs.");
  expect(retryPreset({ prompt: "p", model: "m", kind: "model" }).type).toBeUndefined();
  expect(retryPreset({ prompt: "p", model: "m", kind: "image" }).references).toEqual([]);
  expect(retryPreset({ prompt: "p", model: "m", kind: "image" }).picks).toBeUndefined();
  /* A catalogue render keeps its catalogue, its settings and its Soul ID (lib/higgsfield-consumer/original-identity). */
  const soul = retryPreset({ prompt: "Mira at dusk", model: "soul_2", kind: "image", params: { task: "connected-generation", outputType: "image", settings: { aspect_ratio: "3:4", resolution: "2k", soul_id: "soul_ready" }, references: [{ uploadId: "u9", role: "image", kind: "image" }] } });
  expect(soul).toMatchObject({ billing: "connected", model: "soul_2", soulId: "soul_ready", references: [{ uploadId: "u9", role: "image" }], picks: { ratio: "3:4", resolution: "2k" }, kept: "same inputs" });
  /* This workspace's composer gives a reference its role from its kind: a render's frames come back as references, and it says so. */
  const framed = retryPreset({ prompt: "p", model: "kling-3-pro", kind: "video", params: { references: [{ genId: "g1", role: "first_frame", kind: "image" }, { genId: "g2", role: "last_frame", kind: "image" }] }, title: "Door" });
  expect(framed.kept).toBe("same inputs, frames as references");
  expect(framed.note).toBe("Retry · Door · same inputs, frames as references · new seed");
  /* Made by another tool (a template, a voice tool, Viral, an edit or upscale of a clip): Gen takes the words only, clears the well, and says so. */
  for (const params of [{ task: "connected-generation", workflow: "marketing-template" }, { task: "connected-generation", workflow: "voice-tool" }, { task: "genjutsu" }, { task: "upscale", sourceGenId: "g0" }, { task: "edit", references: [{ genId: "g0" }] }]) {
    const other = retryPreset({ prompt: "p", model: "marketing_studio_v2", kind: "image", params, title: "Poster" });
    expect(other).toEqual({ prompt: "p", type: "image", references: [], kept: "prompt only", note: "Retry · Poster · prompt only" });
  }
  expect(SAY.retry("Poster", "prompt only")).toBe("Retry Poster — prompt only, new seed. Quoted before it runs.");
  expect(retryPreset({ prompt: "p", model: "m", kind: "image", params: { task: "generate" } }).billing).toBe("workspace");
  /* The render's own task column says the same where params do not. */
  expect(retryPreset({ prompt: "p", model: "m", kind: "image", params: {}, task: "generate" }).kept).toBe("same inputs");
  expect(retryPreset({ prompt: "p", model: "topaz", kind: "video", params: {}, task: "upscale" }).kept).toBe("prompt only");
  expect(retryPreset({ prompt: "p", model: "m", kind: "image", params: { references: Array.from({ length: 14 }, (_, i) => ({ genId: `g${i}` })) } }).references).toHaveLength(10);
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

test("Retry carries every input the render was made with: settings, references, the wallet, the sound", () => {
  /* A workspace render: its ratio, resolution, length and references (Gen places them itself, so its frames come back as references and it says so). */
  const workspace = retryPreset({
    prompt: "harbour at dawn", model: "seedance-2.5", kind: "video", title: "Harbour",
    params: { ratio: "9:16", resolution: "1080p", duration: 8, references: [{ genId: "g7", role: "first_frame", kind: "image" }, { uploadId: "u3", role: "reference_image", kind: "image" }] },
  });
  expect(workspace).toMatchObject({
    billing: "workspace", picks: { ratio: "9:16", resolution: "1080p", duration: 8 },
    references: [{ genId: "g7", role: "first_frame" }, { uploadId: "u3", role: "reference_image" }], kept: "same inputs, frames as references",
  });
  expect(workspace).not.toHaveProperty("sound");
  /* A connected-account render is retried on the connected account, with each reference's role. */
  const connected = retryPreset({
    prompt: "neon alley", model: "kling_3_0", kind: "video",
    params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "video", settings: { aspect_ratio: "16:9", resolution: "720p", duration: 5 }, references: [{ uploadId: "u9", role: "start_image", kind: "image" }] },
  });
  expect(connected).toMatchObject({ billing: "connected", model: "kling_3_0", picks: { ratio: "16:9", resolution: "720p", duration: 5 }, references: [{ uploadId: "u9", role: "start_image" }] });
  /* Sound: length, instrumental, voice. */
  expect(retryPreset({ prompt: "rain on tin", model: "eleven_music", kind: "audio", params: { lengthMs: 45_000, instrumental: true } }).sound).toEqual({ seconds: 45, instrumental: true });
  expect(retryPreset({ prompt: "door slam", model: "eleven_sfx", kind: "audio", params: { durationSeconds: 3 } }).sound).toEqual({ seconds: 3 });
  /* Gen's own sound tasks are the same inputs, not "prompt only". */
  expect(retryPreset({ prompt: "Hello there", model: "eleven_multilingual_v2", kind: "audio", params: { task: "speech", voiceId: "abc123XYZ" }, title: "Hello" })).toMatchObject({ kept: "same inputs", sound: { voiceId: "abc123XYZ" }, note: "Retry · Hello · same inputs · new seed" });
});

test("a take Gen cannot make again from its own inputs says why, and Retry is blocked with that reason", () => {
  expect(retryBlock({ prompt: "p", model: "seedance-2.5", kind: "video", params: {} })).toBeNull();
  expect(retryBlock({ prompt: "p", model: "seedance-2.5", kind: "video", params: { task: "extend", sourceGenId: "g1" } })).toContain("source clip");
  expect(retryBlock({ prompt: "", model: "eleven_sts", kind: "audio", params: { sourceUploadId: "u1" } })).toContain("source clip");
  expect(retryBlock({ prompt: "p", model: "marketing_studio_v2", kind: "image", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", workflow: "marketing-template" } })).toContain("connected tool");
  expect(retryBlock({ prompt: "p", model: "marketing_studio_video", kind: "video", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits" } })).toContain("Business");
  expect(retryBlock({ prompt: "p", model: "m", kind: "model", params: {} })).not.toBeNull();
  /* Audio takes as /api/audio stores them (lib/audioAdmission.ts): params.task is always set. */
  expect(retryBlock({ prompt: "rain on tin", model: "eleven_music", kind: "audio", params: { task: "music", lengthMs: 45_000, instrumental: true } })).toBeNull();
  expect(retryBlock({ prompt: "door slam", model: "eleven_sfx", kind: "audio", params: { task: "sound", durationSeconds: 3, loop: false } })).toBeNull();
  expect(retryBlock({ prompt: "Hello there", model: "eleven_multilingual_v2", kind: "audio", params: { task: "speech", voiceId: "abc123XYZ", settings: {} } })).toBeNull();
  expect(retryBlock({ prompt: "", model: "eleven_v3", kind: "audio", params: { task: "dialogue", lines: [{ text: "Hi", voiceId: "v1" }] } })).toContain("dialogue");
  expect(retryBlock({ prompt: "", model: "eleven_sts", kind: "audio", params: { task: "voiceChange", voiceId: "v1", sourceGenId: "g2" } })).toContain("source clip");
  expect(retryBlock({ prompt: "", model: "dub", kind: "audio", params: { task: "dub", sourceKind: "generation", sourceId: "g3" } })).toContain("source clip");
  for (const task of ["edit", "motion", "upscale", "reframe", "genjutsu"])
    expect(retryBlock({ prompt: "p", model: "seedance-2.5", kind: "video", params: { task } })).toContain("source clip");
  expect(retryBlock({ prompt: "p", model: "seedance-2.5", kind: "video", params: { task: "generate" } })).toBeNull();
  expect(retryBlock({ prompt: "p", model: "kling_3_0", kind: "video", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits" } })).toBeNull();
  /* The music preset is reachable from a real take: Gen gets its length and instrumental flag. */
  expect(retryPreset({ prompt: "rain on tin", model: "eleven_music", kind: "audio", params: { task: "music", lengthMs: 45_000, instrumental: true } })).toMatchObject({ type: "audio", model: "eleven_music", sound: { seconds: 45, instrumental: true } });
  const edited: AssetRef = { ...gen, retryBlock: "This take was made from a source clip. Run that tool again from Takes." };
  const caps = assetCapabilities({ ...base, asset: edited });
  expect(caps.can.retry).toBeUndefined();
  expect(caps.why.retry).toBe(edited.retryBlock);
  /* No promise that a node can be bypassed from an asset's menu. */
  expect(caps.why.bypass).toBeUndefined();
});
