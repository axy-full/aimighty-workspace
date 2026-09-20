import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { draftUploadAsset, uploadDraftFiles, DRAFT_UPLOAD_ACCEPT } from "../../lib/workbench/draft-upload";

/**
 * The workspace Marketing page hosts the extracted flow rather than a second
 * copy of it, and the categorised upload picker it mounts is the one Studio
 * already uses.
 */

const file = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type });

test("a stored upload becomes the same draft asset whatever host picked it", () => {
  const asset = draftUploadAsset(file("Bottle.png", "image/png"), { id: "u1", url: "/api/uploads/u1" }, "Product");
  expect(asset).toEqual({
    id: "u1",
    uploadId: "u1",
    name: "Bottle.png",
    kind: "image",
    category: "Product",
    url: "/api/uploads/u1",
    mime: "image/png",
    description: "Uploaded from device",
    prompt: "",
    status: "Draft",
    version: 1,
    locked: false,
    refs: [],
  });
});

test("the kind follows the file's type, and a length is carried only when the store measured one", () => {
  const kinds = [
    ["Clip.mp4", "video/mp4", "video"],
    ["Voice.wav", "audio/wav", "audio"],
    ["Brief.pdf", "application/pdf", "document"],
  ] as const;
  for (const [name, type, kind] of kinds)
    expect(draftUploadAsset(file(name, type), { id: "u", url: "/api/uploads/u" }, "Brand").kind).toBe(kind);
  expect(draftUploadAsset(file("Clip.mp4", "video/mp4"), { id: "u", url: "/u", durationS: 12 }, "Brand").seconds).toBe(12);
  for (const durationS of [0, null, undefined])
    expect(draftUploadAsset(file("Clip.mp4", "video/mp4"), { id: "u", url: "/u", durationS }, "Brand").seconds).toBeUndefined();
  /* The picker accepts what the workbench input has always accepted. */
  expect(DRAFT_UPLOAD_ACCEPT).toContain("image/png");
  expect(DRAFT_UPLOAD_ACCEPT).toContain("video/quicktime");
});

test("uploadDraftFiles is exported for a host to call and never invents a category", () => {
  expect(typeof uploadDraftFiles).toBe("function");
  /* The category is a required option: no default hides a wrong one. */
  const source = readFileSync("lib/workbench/draft-upload.ts", "utf8");
  expect(source).toContain("category: string");
  expect(source).not.toMatch(/category\s*=\s*["']/);
});

test("the workspace Marketing page mounts the shared flow, the shared picker and no second identity panel", () => {
  const tool = readFileSync("components/workspace/spec/tools/MarketingTool.tsx", "utf8");
  expect(tool).toContain("<MarketingStudioFlow");
  expect(tool).toContain("<DraftUploadInput");
  /* Cast owns identity creation and its live-priced approval. */
  expect(tool).not.toContain("SoulIdentityPanel");
  expect(tool).toContain('go("particl", "cast")');
  /* No campaign action is re-implemented here: the flow owns every one. */
  for (const marker of [
    "buildMoleculrStoryboard",
    "prepareMoleculrVariants",
    "bindMoleculrReferences",
    "referenceAdBinding",
    "GenerationDialog",
    "/api/generate",
  ])
    expect(tool, marker).not.toContain(marker);
  /* The page still publishes what its plan prices, and never a price. */
  expect(tool).toContain('usePlanRequest("variants"');
  expect(tool).not.toContain("maxCredits");

  /* The agent slot is the page's own plan on the shell's engine. */
  const panel = readFileSync("components/workspace/spec/tools/MarketingPlanPanel.tsx", "utf8");
  expect(panel).toContain('atomik.start("marketing")');
  for (const marker of ["/api/generate", "quote", "approve"]) expect(panel, marker).not.toContain(marker);

  /* One upload rule: Studio files the same asset through the same builder. */
  const studio = readFileSync("components/workbench/Studio.tsx", "utf8");
  expect(studio).toContain("draftUploadAsset(file,");
  expect(studio).toContain("DRAFT_UPLOAD_ACCEPT");
  expect(studio).not.toContain('description: "Uploaded from device"');
});
