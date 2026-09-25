import { test, expect } from "@playwright/test";
import { ASSET_LABEL, SAY, assetCapabilities, referenceRole, retryPreset, type AssetRef, type GenPreset } from "../../lib/shell/assets";
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

test("Retry hands Gen the render's own inputs: words, engine, catalogue, identity and references", () => {
  const preset = retryPreset({ prompt: "a fox, enhanced", model: "seedance-2.5", kind: "video", params: { rawPrompt: "a fox", references: [{ genId: "g7", role: "reference_image", kind: "image" }, { uploadId: "u3", role: "reference_video", kind: "video" }, { url: "https://elsewhere.invalid/x.png" }] }, title: "Fox" });
  expect(preset).toEqual({ prompt: "a fox", model: "seedance-2.5", type: "video", billing: "workspace", references: [{ genId: "g7", role: "reference_image" }, { uploadId: "u3", role: "reference_video" }], note: "Retry · Fox · same inputs · new seed" });
  expect(retryPreset({ prompt: "p", model: "m", kind: "model" }).type).toBeUndefined();
  expect(retryPreset({ prompt: "p", model: "m", kind: "image" }).references).toEqual([]);
  /* A catalogue render keeps its catalogue and its Soul ID (lib/higgsfield-consumer/original-identity). */
  const soul = retryPreset({ prompt: "Mira at dusk", model: "soul_2", kind: "image", params: { task: "connected-generation", outputType: "image", settings: { aspect_ratio: "3:4", soul_id: "soul_ready" }, references: [{ uploadId: "u9", role: "image", kind: "image" }] } });
  expect(soul).toMatchObject({ billing: "connected", model: "soul_2", soulId: "soul_ready", references: [{ uploadId: "u9", role: "image" }] });
  /* Another connected workflow (a template, a voice tool) is not a Gen catalogue render. */
  expect(retryPreset({ prompt: "p", model: "marketing_studio_v2", kind: "image", params: { task: "connected-generation", workflow: "marketing-template" } }).billing).toBe("workspace");
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
