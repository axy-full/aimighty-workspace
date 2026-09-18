import { test, expect } from "@playwright/test";
import { seedProject, type Asset } from "../../lib/workbench/studio";
import {
  EMPTY_REFERENCE_AD, normalizeReferenceAd, referenceAdAssetIds, referenceAdOriginals,
  referenceAdSchema, resolveReferenceAd, selectReferenceAd, validateReferenceAd,
} from "../../lib/workbench/reference-ad";

function fixture() {
  const project = seedProject();
  const video = (id: string, rest: Partial<Asset>): Asset => ({
    id, name: `${id}.mp4`, kind: "video", category: "Reference", url: "", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], mime: "video/mp4", ...rest,
  });
  project.assets.push(
    video("uploaded", { url: "/api/uploads/upload-original", uploadId: "upload-original", refs: ["hero"] }),
    video("generated", { url: "https://preview.example.com/thumbnail.webp", generationId: "generated-original", parentId: "uploaded" }),
    video("bound-upload", { url: "https://preview.example.com/video.mp4", uploadId: "second-upload" }),
    video("external-only", { url: "https://external.example.com/ad.mp4" }),
    video("blob-only", { url: "blob:https://example.com/unpersisted" }),
    video("bad-original", { url: "/api/thumbnail?id=bad", uploadId: "../private" }),
  );
  project.sharedAssets = [video("shared-only", { url: "/api/uploads/shared-video", uploadId: "shared-video" })];
  return project;
}

test("reference ad selection lists canonical original videos and preserves exact stored identities", () => {
  const project = fixture();
  const before = structuredClone(project);
  const choices = referenceAdOriginals(project);
  expect(choices.map((item) => item.asset.id)).toEqual(["uploaded", "generated", "bound-upload"]);
  expect(choices.map((item) => item.original.url)).toEqual([
    "/api/uploads/upload-original?download=1", "/api/media/generated-original?download=1", "/api/uploads/second-upload?download=1",
  ]);
  const generated = resolveReferenceAd(project, { assetId: "generated" });
  expect(generated?.asset).toBe(project.assets.find((asset) => asset.id === "generated"));
  expect(generated?.asset.generationId).toBe("generated-original");
  expect(generated?.asset.parentId).toBe("uploaded");
  expect(choices[0].asset.uploadId).toBe("upload-original");
  expect(choices[0].asset.refs).toEqual(["hero"]);
  expect(project).toEqual(before);
});

test("foreign, missing, nonvideo, external-only and duplicate selections fail closed", () => {
  const project = fixture();
  const draft = { notes: "Reviewed opening", direction: "Use a calmer pace" };
  for (const assetId of ["foreign", "shared-only", "hero", "external-only", "blob-only", "bad-original"])
    expect(selectReferenceAd(project, draft, assetId)).toEqual(draft);
  const original = project.assets.find((asset) => asset.id === "uploaded")!;
  project.assets.push({ ...original, url: "/api/uploads/another-original" });
  expect(resolveReferenceAd(project, { assetId: "uploaded" })).toBeNull();
  expect(referenceAdOriginals(project).map((item) => item.asset.id)).not.toContain("uploaded");
  expect(() => validateReferenceAd(project, { ...draft, assetId: "uploaded" })).toThrow("original video");
});

test("selection and clear preserve editable direction; removal clears UI without mutating saved state", () => {
  const project = fixture(), current = { notes: "0:02 close-up", direction: "Preserve pace; use our product." };
  const selected = selectReferenceAd(project, current, "generated");
  expect(selected).toEqual({ ...current, assetId: "generated" });
  expect(referenceAdAssetIds(selected)).toEqual(["generated"]);
  expect(selectReferenceAd(project, selected, "")).toEqual(current);
  expect(() => validateReferenceAd(project, selected)).not.toThrow();
  project.assets = project.assets.filter((asset) => asset.id !== "generated");
  expect(normalizeReferenceAd(project, selected)).toEqual(current);
  expect(selected.assetId).toBe("generated");
  expect(() => validateReferenceAd(project, selected)).toThrow("Restore it or clear");
});

test("reference schema admits one bounded asset ID and bounded notes, without remote/provider fields", () => {
  expect(referenceAdSchema.parse(EMPTY_REFERENCE_AD)).toEqual({ notes: "", direction: "" });
  expect(referenceAdAssetIds(EMPTY_REFERENCE_AD)).toEqual([]);
  for (const extra of [
    { assetId: "" }, { assetId: "x".repeat(101) }, { assetId: ["one", "two"] },
    { notes: "x".repeat(2001) }, { direction: "x".repeat(6001) },
    { url: "https://external.example.com/ad.mp4" }, { jobId: "invented-job" }, { analysis: "provider said" },
  ]) expect(referenceAdSchema.safeParse({ ...EMPTY_REFERENCE_AD, ...extra }).success).toBe(false);
  expect(referenceAdSchema.safeParse({ assetId: "one", notes: "x".repeat(2000), direction: "x".repeat(6000) }).success).toBe(true);
});
