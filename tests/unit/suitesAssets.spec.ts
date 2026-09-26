import { test, expect } from "@playwright/test";
import { ASSET_LABEL, GEN_PRESET_KEY, SAY, assetCapabilities, readGenPreset, referenceRole, retryPreset, type AssetRef } from "../../lib/shell/assets";
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
  expect(disabled).toEqual(["paste: Nothing copied yet.", "duplicate: A generation has one copy. Use Retry generation for a new take from its prompt and model.", "undo: Nothing to undo."]);
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
  expect(preset).toEqual({ prompt: "a fox", model: "seedance-2.5", type: "video", note: "Retry · Fox · same prompt and model" });
  expect(retryPreset({ prompt: "p", model: "m", kind: "model" }).type).toBeUndefined();
  expect(readGenPreset(JSON.stringify(preset))).toEqual(preset);
  expect(readGenPreset("plain words from Crew")).toEqual({ prompt: "plain words from Crew" });
  expect(readGenPreset(null)).toBeNull();
  expect(GEN_PRESET_KEY).toBe("particl-gen-preset");
});
