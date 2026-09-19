import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CatalogueError, findCatalogueModel, parseConnectedCatalogue } from "../../lib/higgsfield-consumer/catalogue";
import {
  CONNECTED_TOOLS,
  connectedToolModels,
  connectedToolResultName,
  connectedToolRoles,
  findConnectedTool,
  requireConnectedTool,
  validateToolRequest,
} from "../../lib/higgsfield-consumer/tools";
import { consumerGenerationInputSchema, consumerGenerationParams } from "../../lib/higgsfield-consumer/generation-contract";

const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8")), 1_000);
const model = (id: string) => findCatalogueModel(catalogue, id)!;
const tool = (name: string) => requireConnectedTool(name);
const media = "44444444-4444-4444-8444-444444444444";
const audio = "55555555-5555-4555-8555-555555555555";
const code = (run: () => unknown) => {
  try { run(); } catch (error) { if (error instanceof CatalogueError) return error.code; throw error; }
  return null;
};

test("every tool preset maps to catalogue models that declare the roles it needs, and only to those", () => {
  const expected: Record<string, { models: string[]; roles: string[] }> = {
    upscale_image: { models: ["bytedance_image_upscale", "topaz_image"], roles: ["image_references", "image_references"] },
    upscale_video: { models: ["video_upscale", "topaz_video", "bytedance_video_upscale"], roles: ["input_video", "video_references", "video_references"] },
    remove_background_image: { models: ["image_background_remover"], roles: ["image_references"] },
    remove_background_video: { models: ["video_background_remover"], roles: ["video_references"] },
    extend_canvas: { models: ["outpaint", "flux_2_pro_outpaint"], roles: ["image_references", "image_references"] },
    deflicker: { models: ["video_deflicker"], roles: ["input_video"] },
    lip_sync: { models: ["sync_so"], roles: ["input_video"] },
  };
  expect(CONNECTED_TOOLS.map((t) => t.name)).toEqual(Object.keys(expected));
  for (const preset of CONNECTED_TOOLS) {
    const models = connectedToolModels(preset, catalogue);
    expect(models.map((m) => m.id), preset.name).toEqual(expected[preset.name].models);
    expect(models.map((m) => connectedToolRoles(preset, m).source), preset.name).toEqual(expected[preset.name].roles);
    for (const m of models) expect(m.outputType).toBe(preset.outputType);
    expect(preset.label.toLowerCase()).not.toContain("higgsfield");
  }
  expect(connectedToolRoles(tool("lip_sync"), model("sync_so"))).toEqual({ source: "input_video", extras: [{ kind: "audio", role: "input_audio" }] });
  // A candidate missing from the catalogue, or with the wrong type, is simply not offered.
  expect(connectedToolModels(tool("upscale_image"), { models: [model("topaz_image"), model("kling3_0")] }).map((m) => m.id)).toEqual(["topaz_image"]);
  expect(findConnectedTool("reframe")).toBeNull();
  expect(code(() => requireConnectedTool("clipify"))).toBe("tool_unknown");
  expect(code(() => connectedToolRoles(tool("upscale_image"), model("nano_banana_2")))).toBe("tool_model");
  expect(code(() => connectedToolRoles(tool("upscale_video"), model("topaz_image")))).toBe("tool_model");
});

test("tool requests need exactly one source of the right kind, an audio track for lip-sync, and only declared settings", () => {
  const upscale = tool("upscale_image"), topaz = model("topaz_image");
  const base = { type: "image" as const, model: "topaz_image", prompt: "", parameters: { output_width: 2048, output_height: 2048 }, medias: [{ role: "image_references", kind: "image" as const }] };
  expect(validateToolRequest(upscale, topaz, base)).toEqual({ output_width: 2048, output_height: 2048 });
  expect(code(() => validateToolRequest(upscale, topaz, { ...base, medias: [] }))).toBe("tool_source");
  expect(code(() => validateToolRequest(upscale, topaz, { ...base, medias: [base.medias[0], base.medias[0]] }))).toBe("tool_source");
  expect(code(() => validateToolRequest(upscale, topaz, { ...base, medias: [{ role: "image_references", kind: "video" }] }))).toBe("tool_source");
  expect(code(() => validateToolRequest(upscale, topaz, { ...base, parameters: {} }))).toBe("parameter_required");
  expect(code(() => validateToolRequest(upscale, topaz, { ...base, parameters: { ...base.parameters, resolution: "4k" } }))).toBe("parameter_unknown");
  expect(code(() => validateToolRequest(upscale, topaz, { ...base, parameters: { ...base.parameters, sharpen: 2 } }))).toBe("parameter_invalid");
  expect(code(() => validateToolRequest(upscale, model("nano_banana_2"), base))).toBe("tool_model");
  expect(validateToolRequest(tool("upscale_image"), model("bytedance_image_upscale"), { ...base, model: "bytedance_image_upscale", parameters: { resolution: "2k", remove_bg: false } })).toEqual({ resolution: "2k", remove_bg: false });
  // Video tools take one video; lip-sync also needs exactly one audio file.
  const video = { type: "video" as const, model: "video_upscale", prompt: "", parameters: {}, medias: [{ role: "input_video", kind: "video" as const }] };
  expect(validateToolRequest(tool("upscale_video"), model("video_upscale"), video)).toEqual({});
  expect(code(() => validateToolRequest(tool("upscale_video"), model("video_upscale"), { ...video, medias: [] }))).toBe("tool_source");
  expect(validateToolRequest(tool("deflicker"), model("video_deflicker"), { ...video, model: "video_deflicker", parameters: { duration: 4 } })).toEqual({ duration: 4 });
  expect(validateToolRequest(tool("remove_background_video"), model("video_background_remover"), { ...video, model: "video_background_remover", medias: [{ role: "video_references", kind: "video" }] })).toEqual({});
  const sync = { ...video, model: "sync_so", parameters: { sync_mode: "loop" } };
  expect(code(() => validateToolRequest(tool("lip_sync"), model("sync_so"), sync))).toBe("tool_source");
  expect(code(() => validateToolRequest(tool("lip_sync"), model("sync_so"), { ...sync, medias: [...sync.medias, { role: "input_audio", kind: "audio" }, { role: "input_audio", kind: "audio" }] }))).toBe("tool_source");
  expect(validateToolRequest(tool("lip_sync"), model("sync_so"), { ...sync, medias: [...sync.medias, { role: "input_audio", kind: "audio" }] })).toEqual({ sync_mode: "loop" });
  expect(code(() => validateToolRequest(tool("lip_sync"), model("sync_so"), { ...sync, medias: [...sync.medias, { role: "input_audio", kind: "audio" }, { role: "input_video", kind: "video" }] }))).toBe("tool_source");
  // Extend canvas exposes only the declared expansion settings.
  expect(validateToolRequest(tool("extend_canvas"), model("flux_2_pro_outpaint"), { ...base, model: "flux_2_pro_outpaint", parameters: { expand_left: 256, expand_right: 256 } })).toEqual({ expand_left: 256, expand_right: 256 });
  expect(code(() => validateToolRequest(tool("extend_canvas"), model("flux_2_pro_outpaint"), { ...base, model: "flux_2_pro_outpaint", parameters: { expand_left: 4096 } }))).toBe("parameter_invalid");
  expect(validateToolRequest(tool("extend_canvas"), model("outpaint"), { ...base, model: "outpaint", parameters: { aspect_ratio: "16:9" } })).toEqual({ aspect_ratio: "16:9" });
});

test("the request contract records the tool without sending it to the provider, and refuses a tool whose model differs", () => {
  const input = consumerGenerationInputSchema.parse({
    type: "image", model: "bytedance_image_upscale", prompt: "", parameters: { resolution: "4k" },
    medias: [{ role: "image_references", source: { uploadId: "still" } }], tool: { name: "upscale_image", model: "bytedance_image_upscale" },
  });
  expect(input.tool).toEqual({ name: "upscale_image", model: "bytedance_image_upscale" });
  expect(consumerGenerationParams(model("bytedance_image_upscale"), input, [{ value: media, role: "image_references" }])).toEqual({ resolution: "4k", model: "bytedance_image_upscale", medias: [{ value: media, role: "image_references" }], count: 1, use_unlim: false });
  for (const bad of [
    { tool: { name: "upscale_image", model: "topaz_image" } }, { tool: { name: "reframe", model: "bytedance_image_upscale" } }, { tool: { name: "upscale_image" } },
    { tool: { name: "upscale_image", model: "bytedance_image_upscale", extra: 1 } }, { tool: "upscale_image" },
  ])
    expect(consumerGenerationInputSchema.safeParse({ ...input, ...bad }).success, JSON.stringify(bad)).toBe(false);
  // Tool constraints apply on the server path too: a missing source or extra media is refused before pricing.
  expect(() => consumerGenerationParams(model("bytedance_image_upscale"), { ...input, medias: [] }, [])).toThrow(/needs one image/);
  const sync = consumerGenerationInputSchema.parse({ type: "video", model: "sync_so", prompt: "", parameters: {}, medias: [{ role: "input_video", source: { uploadId: "clip" } }], tool: { name: "lip_sync", model: "sync_so" } });
  expect(() => consumerGenerationParams(model("sync_so"), sync, [{ value: media, role: "input_video" }])).toThrow(/needs one audio file/);
  const synced = { ...sync, medias: [...sync.medias, { role: "input_audio", source: { uploadId: "voice" } }] };
  expect(consumerGenerationParams(model("sync_so"), synced, [{ value: media, role: "input_video" }, { value: audio, role: "input_audio" }])).toEqual({ model: "sync_so", medias: [{ value: media, role: "input_video" }, { value: audio, role: "input_audio" }], count: 1, use_unlim: false });
  // A tool on the wrong model id is refused as a tool mismatch, not sent as a plain generation.
  const mismatch = consumerGenerationInputSchema.parse({ ...input, model: "nano_banana_2", tool: { name: "upscale_image", model: "nano_banana_2" } });
  expect(() => consumerGenerationParams(model("nano_banana_2"), mismatch, [{ value: media, role: "image_references" }])).toThrow(/does not run on/);
});

test("tool results are filed under the source name", () => {
  expect(connectedToolResultName(tool("upscale_image"), "Bottle.png")).toBe("Bottle · upscaled");
  expect(connectedToolResultName(tool("remove_background_video"), "Hero take 3.mp4")).toBe("Hero take 3 · background removed");
  expect(connectedToolResultName(tool("lip_sync"), "")).toBe("Source · lip-synced");
  expect(connectedToolResultName(tool("extend_canvas"), `${"n".repeat(150)}.jpeg`)).toHaveLength(100 + " · extended".length);
});
