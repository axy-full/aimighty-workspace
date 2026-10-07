import { test, expect } from "@playwright/test";
import { imageUpscaleBody, upscaleModel, upscaleSource, upscaleSources, upscaleSurface, videoUpscaleBody } from "../../lib/shell/upscale";
import { isMakeTool, readMake, makeType } from "../../lib/shell/make";
import { DEFAULT_ASTRA } from "../../lib/astra";
import { DEFAULT_TOPAZ_IMAGE } from "../../lib/topaz";

const entry = (over: Record<string, unknown> = {}, take: Record<string, unknown> = {}) => ({
  url: "/api/media/g1", media: "video",
  asset: { origin: "generation", value: { id: "g1", kind: "video" } },
  take: { id: "generation:g1", sourceId: "g1", name: "Take 1", status: "review" , ...take },
  ...over,
}) as never;

test("Upscale is a Make quick tool at its own address, beside Motion transfer and Object swap", () => {
  expect(isMakeTool("upscale")).toBe(true);
  expect(readMake("?make=upscale")).toBe("upscale");
  expect(makeType("upscale")).toBeNull();
  for (const tool of ["motion", "swap"]) expect(isMakeTool(tool)).toBe(true);
  expect(isMakeTool("edit")).toBe(false);
});

test("only a finished picture or clip of this project can be upscaled: never a take still rendering, held or failed", () => {
  expect(upscaleSource(entry())).toMatchObject({ id: "generation:g1", sourceId: "g1", origin: "generation", kind: "video" });
  for (const status of ["rendering", "held", "failed"]) expect(upscaleSource(entry({}, { status })), status).toBeNull();
  expect(upscaleSource(entry({ url: null }))).toBeNull();
  expect(upscaleSource(entry({ media: "audio" }))).toBeNull();
  expect(upscaleSource({ url: "/u", media: "image", asset: { origin: "upload", value: { id: "u1" } }, take: { id: "upload:u1", sourceId: "u1", name: "still.png", status: "uploaded" } } as never)).toMatchObject({ origin: "upload", kind: "image" });
  expect(upscaleSources([entry(), entry({}, { status: "failed" })])).toHaveLength(1);
});

test("a clip's request is the Topaz Astra 2 upscale the existing panel sends: to 4K, at the chosen frame rate, with the source's own id", () => {
  expect(videoUpscaleBody({ origin: "generation", sourceId: "g1" }, "prj_1", { ...DEFAULT_ASTRA, fps: 60 })).toEqual({
    projectId: "prj_1", model: "topaz/upscale/video/creative", task: "upscale", prompt: "", refine: false, sourceGenId: "g1", sourceUploadId: undefined,
    resolution: "4k", fps60: true, astra: { ...DEFAULT_ASTRA, fps: 60 }, references: [],
  });
  expect(videoUpscaleBody({ origin: "upload", sourceId: "u1" }, "prj_1")).toMatchObject({ sourceUploadId: "u1", fps60: false });
  expect(videoUpscaleBody(null, "prj_1")).toMatchObject({ sourceGenId: undefined, sourceUploadId: undefined });
});

test("a still's request is the Topaz image upscale the existing panel sends, with the scale chosen and the source as its one reference", () => {
  expect(imageUpscaleBody({ origin: "upload", sourceId: "u1" }, "prj_1", { ...DEFAULT_TOPAZ_IMAGE, factor: 4 })).toEqual({
    projectId: "prj_1", model: "fal-ai/topaz/upscale/image", task: "generate", prompt: "", resolution: "24MP", ratio: "adaptive", refine: false,
    topaz: { ...DEFAULT_TOPAZ_IMAGE, factor: 4 }, references: [{ uploadId: "u1", role: "reference_image" }],
  });
  expect(imageUpscaleBody({ origin: "generation", sourceId: "g1" }, "prj_1").references).toEqual([{ genId: "g1", role: "reference_image" }]);
  expect(imageUpscaleBody(null, "prj_1").references).toEqual([]);
});

test("the tool keeps the existing panels' paid-action claims, so a saved request is recovered by either; the model's name is its own", () => {
  expect(upscaleSurface("video", "p1")).toBe("gen:astra-2-upscale:p1");
  expect(upscaleSurface("image", "p1")).toBe("gen:topaz-image-upscale:p1");
  expect(upscaleSurface("video", null)).toBe("gen:astra-2-upscale");
  expect(upscaleModel("video")).toBe("Topaz Astra 2");
  expect(upscaleModel("image")).toBe("Topaz image upscale");
});
