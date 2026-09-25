import { test, expect } from "@playwright/test";
import { ASSET_LABEL, GEN_PRESET_KEY, SAY, assetCapabilities, readGenPreset, referenceRole, retryBlock, retryPreset, type AssetRef } from "../../lib/shell/assets";
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

test("Retry hands Gen the render's own inputs, and Gen reads old and new presets", () => {
  const preset = retryPreset({ prompt: "a fox, enhanced", model: "seedance-2.5", kind: "video", params: { rawPrompt: "a fox" }, title: "Fox" });
  expect(preset).toEqual({ prompt: "a fox", model: "seedance-2.5", type: "video", billing: "workspace", note: "Retry · Fox · same inputs · new seed" });
  expect(retryPreset({ prompt: "p", model: "m", kind: "model" }).type).toBeUndefined();
  expect(readGenPreset(JSON.stringify(preset))).toEqual(preset);
  expect(readGenPreset("plain words from Crew")).toEqual({ prompt: "plain words from Crew" });
  expect(readGenPreset(null)).toBeNull();
  expect(GEN_PRESET_KEY).toBe("particl-gen-preset");
});

test("Retry carries every input the render was made with: settings, references, the wallet, the sound", () => {
  /* A workspace render: its ratio, resolution, length and references; the engine places references itself. */
  const workspace = retryPreset({
    prompt: "harbour at dawn", model: "seedance-2.5", kind: "video", title: "Harbour",
    params: { ratio: "9:16", resolution: "1080p", duration: 8, references: [{ genId: "g7", role: "first_frame", kind: "image" }, { uploadId: "u3", role: "reference_image", kind: "image" }] },
  });
  expect(workspace).toMatchObject({
    billing: "workspace", picks: { ratio: "9:16", resolution: "1080p", duration: 8 },
    references: [{ id: "generation:g7" }, { id: "upload:u3" }],
  });
  expect(workspace.references![0]).not.toHaveProperty("role");
  /* A connected-account render is retried on the connected account, with each reference's role. */
  const connected = retryPreset({
    prompt: "neon alley", model: "kling_3_0", kind: "video",
    params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "video", settings: { aspect_ratio: "16:9", resolution: "720p", duration: 5 }, references: [{ uploadId: "u9", role: "start_image", kind: "image" }] },
  });
  expect(connected).toMatchObject({ billing: "connected", model: "kling_3_0", picks: { ratio: "16:9", resolution: "720p", duration: 5 }, references: [{ id: "upload:u9", role: "start_image" }] });
  /* Sound: length, instrumental, voice. */
  expect(retryPreset({ prompt: "rain on tin", model: "eleven_music", kind: "audio", params: { lengthMs: 45_000, instrumental: true } }).sound).toEqual({ seconds: 45, instrumental: true });
  expect(retryPreset({ prompt: "door slam", model: "eleven_sfx", kind: "audio", params: { durationSeconds: 3 } }).sound).toEqual({ seconds: 3 });
});

test("a take Gen cannot make again from its own inputs says why, and Retry is blocked with that reason", () => {
  expect(retryBlock({ prompt: "p", model: "seedance-2.5", kind: "video", params: {} })).toBeNull();
  expect(retryBlock({ prompt: "p", model: "seedance-2.5", kind: "video", params: { task: "extend", sourceGenId: "g1" } })).toContain("source clip");
  expect(retryBlock({ prompt: "", model: "eleven_sts", kind: "audio", params: { sourceUploadId: "u1" } })).toContain("source clip");
  expect(retryBlock({ prompt: "p", model: "marketing_studio_v2", kind: "image", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", workflow: "marketing-template" } })).toContain("connected tool");
  expect(retryBlock({ prompt: "p", model: "marketing_studio_video", kind: "video", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits" } })).toContain("Business");
  expect(retryBlock({ prompt: "p", model: "m", kind: "model", params: {} })).not.toBeNull();
  const edited: AssetRef = { ...gen, retryBlock: "This take was made from a source clip. Run that tool again from Takes." };
  const caps = assetCapabilities({ ...base, asset: edited });
  expect(caps.can.retry).toBeUndefined();
  expect(caps.why.retry).toBe(edited.retryBlock);
  /* No promise that a node can be bypassed from an asset's menu. */
  expect(caps.why.bypass).toBeUndefined();
});
