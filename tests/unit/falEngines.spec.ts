import { test, expect } from "@playwright/test";
import { MODELS, getModel, atomikMayPropose } from "../../lib/models";
import { VENDOR_RATES } from "../../lib/vendorRates";
import { falEndpointFor, buildFalInput } from "../../lib/falVideo";
import { falEditInput } from "../../lib/falEdit";
import { getTask, TASKS, sourceProblem } from "../../lib/tasks";
import { estimateCostUsd, estimateImageCostUsd } from "../../lib/vendorPricing";

/**
 * CR1 §3, the ten first. Six were new; each is in the registry with its
 * rate, goes to the endpoint fal prints (verbatim, never a family suffix),
 * and says whether Atomik may propose it. Nothing here calls a vendor:
 * the payload builders are exercised only where they need no media.
 */
const TEN: [string, string][] = [
  ["Seedance 2.5 reference-to-video", "bytedance/seedance-2.5/reference-to-video"],
  ["Kling 3.0 Standard", "fal-ai/kling-video/v3/standard"],
  ["Wan 2.6", "wan/v2.6/image-to-video"],
  ["Veo 3.1 Fast", "fal-ai/veo3.1/fast"],
  ["Nano Banana 2 Edit", "fal-ai/nano-banana-2/edit"],
  ["Flux Kontext", "fal-ai/flux-pro/kontext"],
  ["sync-3", "fal-ai/sync-lipsync/v3"],
  ["Topaz Astra 2", "topaz/upscale/video/creative"],
  ["Bria RMBG 2.0", "fal-ai/bria/background/remove"],
];

test("every one of the ten is registered, on fal, priced, and appended after the platform default", () => {
  for (const [, id] of TEN) {
    const m = getModel(id);
    expect(m.provider, id).toBe("fal");
    expect(VENDOR_RATES[id], `${id} has a rate`).toBeTruthy();
    expect(m.use ?? "", `${id} has its one-liner`).not.toBe("");
    expect(m.use ?? "", "no dollar figure reaches the composer").not.toMatch(/\$/);
  }
  expect(getModel("fal-ai/kling-video/v3/standard").supportsTasks).toContain("motion");   // Kling 3.0 Motion is the motion task on the Kling row
  expect(MODELS[0].id, "the default stays the first row").toBe("dreamina-seedance-2-5-260628");
  /* fal reports no token count, so the fal Seedance never offers a frame we cannot name. */
  expect(getModel("bytedance/seedance-2.5/reference-to-video").ratios).not.toContain("adaptive");
  expect(getModel("fal-ai/nano-banana-2/edit").needsStartImage, "an edit engine starts from a still").toBe(true);
  expect(getModel("fal-ai/flux-pro/kontext").needsStartImage).toBe(true);
  expect(getModel("wan/v2.6/image-to-video")).toMatchObject({ needsStartImage: true, noLastFrame: true });
  expect(getModel("fal-ai/veo3.1/fast").noLastFrame, "one frame goes over the wire").toBe(true);
});

test("exact endpoints: what fal prints, not a family suffix", () => {
  const sd = getModel("bytedance/seedance-2.5/reference-to-video");
  expect(falEndpointFor(sd, "generate", false)).toBe("bytedance/seedance-2.5/reference-to-video");
  expect(falEndpointFor(sd, "generate", true)).toBe("bytedance/seedance-2.5/reference-to-video");
  expect(falEndpointFor(sd, "edit", true)).toBe("bytedance/seedance-2.5/reference-to-video");
  const veo = getModel("fal-ai/veo3.1/fast");
  expect(falEndpointFor(veo, "generate", false)).toBe("fal-ai/veo3.1/fast");
  expect(falEndpointFor(veo, "generate", true)).toBe("fal-ai/veo3.1/fast/image-to-video");
  const wan = getModel("wan/v2.6/image-to-video");
  expect(falEndpointFor(wan, "generate", true)).toBe("wan/v2.6/image-to-video");
  expect(falEndpointFor(wan, "generate", false), "no text-to-video for Wan: the only endpoint is image-to-video").toBe("wan/v2.6/image-to-video");
  expect(falEndpointFor(getModel("fal-ai/sync-lipsync/v3"), "lipsync", false)).toBe("fal-ai/sync-lipsync/v3");
  /* The family suffixes still hold for Kling and the tools. */
  const kling = getModel("fal-ai/kling-video/v3/standard");
  expect(falEndpointFor(kling, "generate", false)).toBe("fal-ai/kling-video/v3/standard/text-to-video");
  expect(falEndpointFor(kling, "generate", true)).toBe("fal-ai/kling-video/v3/standard/image-to-video");
  expect(falEndpointFor(kling, "motion", true)).toBe("fal-ai/kling-video/v3/standard/motion-control");
  expect(falEndpointFor(getModel("topaz/upscale/video/creative"), "upscale", false)).toBe("topaz/upscale/video/creative");
});

test("Atomik may propose: the field when set, else any visible engine that generates", () => {
  expect(atomikMayPropose(getModel("bytedance/seedance-2.5/reference-to-video"))).toBe(true);
  expect(atomikMayPropose(getModel("fal-ai/veo3.1/fast"))).toBe(true);
  expect(atomikMayPropose(getModel("fal-ai/kling-video/v3/standard"))).toBe(true);
  expect(atomikMayPropose(getModel("wan/v2.6/image-to-video")), "needs a first frame").toBe(false);
  expect(atomikMayPropose(getModel("fal-ai/nano-banana-2/edit")), "an edit engine").toBe(false);
  expect(atomikMayPropose(getModel("fal-ai/flux-pro/kontext"))).toBe(false);
  expect(atomikMayPropose(getModel("fal-ai/sync-lipsync/v3")), "no generate mode").toBe(false);
  expect(atomikMayPropose(getModel("topaz/upscale/video/creative"))).toBe(false);
  expect(atomikMayPropose(getModel("fal-ai/bria/background/remove")), "hidden").toBe(false);
});

test("the rates read as fal prints them", () => {
  const usd = (id: string, res: string, secs: number, audio = false) => estimateCostUsd(id, res, "16:9", secs, 0, false, { audio })?.list ?? null;
  expect(usd("fal-ai/veo3.1/fast", "1080p", 8, true)).toBeCloseTo(1.2, 6);     // $0.15/s with audio
  expect(usd("fal-ai/veo3.1/fast", "4k", 8, false)).toBeCloseTo(2.4, 6);       // $0.30/s
  expect(usd("wan/v2.6/image-to-video", "1080p", 5)).toBeCloseTo(0.75, 6);     // $0.15/s
  expect(usd("wan/v2.6/image-to-video", "720p", 5)).toBeCloseTo(0.5, 6);       // $0.10/s
  expect(estimateCostUsd("fal-ai/sync-lipsync/v3", "adaptive", "adaptive", 60, 0, false, { task: "lipsync" })?.list).toBeCloseTo(7.998, 3);   // $8 a minute, written as 0.1333/s so both pricing paths agree (see lib/vendorRates.ts)
  expect(estimateImageCostUsd("fal-ai/nano-banana-2/edit", "1K", 0)?.list).toBeCloseTo(0.08, 6);
  expect(estimateImageCostUsd("fal-ai/nano-banana-2/edit", "4K", 3)?.list, "refs are free").toBeCloseTo(0.16, 6);
  expect(estimateImageCostUsd("fal-ai/flux-pro/kontext", "adaptive", 1)?.list).toBeCloseTo(0.04, 6);
  /* Seedance on fal: $0.0214 per 1,000 tokens; 5s of 720p 16:9 at 24fps is 1280×720×24×5/1024 tokens. */
  const sd = estimateCostUsd("bytedance/seedance-2.5/reference-to-video", "720p", "16:9", 5)?.list ?? 0;
  expect(sd).toBeCloseTo((1280 * 720 * 24 * 5 / 1024) * 0.0214 / 1000, 3);
  expect(estimateCostUsd("bytedance/seedance-2.5/reference-to-video", "720p", "16:9", 5, 0, true)?.list ?? 0, "40% less with a video reference").toBeCloseTo(sd * 0.6, 6);
  /* With a 5s video reference the input seconds are tokens too: (5+5)s at the ×0.6 rate — the SOW's 42 cr row. */
  expect(estimateCostUsd("bytedance/seedance-2.5/reference-to-video", "720p", "16:9", 5, 5, true)?.list ?? 0).toBeCloseTo(sd * 2 * 0.6, 6);
  expect(estimateCostUsd("bytedance/seedance-2.5/reference-to-video", "720p", "adaptive", 5), "no frame, no price — the route refuses rather than renders free").toBeNull();
});

test("the payloads fal reads, where no media is needed", async () => {
  const gen = getTask("generate");
  const veo = await buildFalInput({ model: getModel("fal-ai/veo3.1/fast"), task: gen, prompt: " a courier at dawn ", params: { ratio: "9:16", resolution: "1080p", duration: 8, watermark: false, generateAudio: true }, references: [], source: null });
  expect(veo).toEqual({ endpoint: "fal-ai/veo3.1/fast", input: { prompt: "a courier at dawn", duration: "8s", resolution: "1080p", generate_audio: true, aspect_ratio: "9:16" } });
  const sd = await buildFalInput({ model: getModel("bytedance/seedance-2.5/reference-to-video"), task: gen, prompt: "the street", params: { ratio: "16:9", resolution: "720p", duration: 5, watermark: false, generateAudio: false }, references: [], source: null });
  expect(sd).toEqual({ endpoint: "bytedance/seedance-2.5/reference-to-video", input: { prompt: "the street", task: "reference", duration: "5", resolution: "720p", aspect_ratio: "16:9", generate_audio: false } });
  /* An extension carries the length asked for — never "auto", since fal reports no usage and the seal is ours. */
  const ext = await buildFalInput({ model: getModel("bytedance/seedance-2.5/reference-to-video"), task: getTask("extend"), prompt: "Extend @Video1: she turns", params: { ratio: "9:16", resolution: "720p", duration: 10, watermark: false, generateAudio: true }, references: [], source: null });
  expect(ext.input).toMatchObject({ task: "extension", duration: "10", aspect_ratio: "9:16" });
  expect(JSON.stringify(ext.input)).not.toContain("auto");
  await expect(buildFalInput({ model: getModel("wan/v2.6/image-to-video"), task: gen, prompt: "x", params: { ratio: "adaptive", resolution: "1080p", duration: 5, watermark: false }, references: [], source: null })).rejects.toThrow(/first frame/);
  await expect(buildFalInput({ model: getModel("fal-ai/sync-lipsync/v3"), task: getTask("lipsync"), prompt: "", params: { ratio: "adaptive", resolution: "adaptive", duration: 5, watermark: false }, references: [], source: null })).rejects.toThrow(/clip/);
});

test("the edit engines' inputs: Kontext takes one still, Nano Banana 2 Edit takes several and a size", () => {
  const nb = falEditInput(getModel("fal-ai/nano-banana-2/edit"), " swap the jacket for a red one ", ["u1", "u2"], "16:9", "2K");
  expect(nb).toEqual({ endpoint: "fal-ai/nano-banana-2/edit", input: { prompt: "swap the jacket for a red one", num_images: 1, resolution: "2K", aspect_ratio: "16:9", image_urls: ["u1", "u2"] } });
  expect(falEditInput(getModel("fal-ai/nano-banana-2/edit"), "p", ["u1"], "adaptive", "9K").input).toMatchObject({ resolution: "1K", aspect_ratio: "auto" });
  expect(() => falEditInput(getModel("fal-ai/nano-banana-2/edit"), "p", [], "adaptive", "1K"), "an edit with nothing to edit is refused before a row exists").toThrow(/still/);
  const fx = falEditInput(getModel("fal-ai/flux-pro/kontext"), "make it dusk", ["u1"], "adaptive", "adaptive");
  expect(fx).toEqual({ endpoint: "fal-ai/flux-pro/kontext", input: { prompt: "make it dusk", image_url: "u1", output_format: "png" } });
  expect(() => falEditInput(getModel("fal-ai/flux-pro/kontext"), "p", [], "adaptive", "adaptive")).toThrow(/still/);
  expect(JSON.stringify(fx.input) + JSON.stringify(nb.input), "no safety field is loosened").not.toMatch(/safety/i);
});

test("lip-sync is a locked task as long as its clip, with a five-minute ceiling", () => {
  const t = TASKS.find((x) => x.id === "lipsync")!;
  expect(t).toMatchObject({ locked: true, forceDuration: "source", forceRatio: "adaptive", promptOptional: true });
  expect(sourceProblem(t, { duration: 12 })).toBeNull();
  expect(sourceProblem(t, { duration: 301 })).toMatch(/five minutes/);
});
