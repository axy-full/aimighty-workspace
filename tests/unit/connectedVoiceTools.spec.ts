import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  DUBBING_LANGUAGES,
  VOICE_TOOLS,
  consumerVideoAnalysisFailure,
  consumerVideoAnalysisReport,
  consumerVoiceToolAcknowledgement,
  consumerVoiceToolFailureResult,
  consumerVoiceToolInputSchema,
  consumerVoiceToolOriginalResult,
  consumerVoiceToolParams,
  consumerVoiceToolPollAfter,
  parseConnectedVoices,
  parseConnectedVoicesPage,
  requireVoiceTool,
  voiceToolArgumentShape,
  voiceToolArguments,
  voiceToolResultName,
} from "../../lib/higgsfield-consumer/voice-tools";
import { voiceToolReferenceRequest } from "../../lib/higgsfield-consumer/voice-tool-sources";
import { analysisListing } from "../fixtures/connectedStatusEnvelopes";

const discovery = JSON.parse(readFileSync("tests/fixtures/connected-voice-tools.json", "utf8")) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
const schema = (name: string) => discovery.tools.find((tool) => tool.name === name)!.inputSchema;
const media = "44444444-4444-4444-8444-444444444444", job = "33333333-3333-4333-8333-333333333333";
const voice = { tool: "voice_change", source: { uploadId: "clip" }, voice: { id: "voice-nova", type: "preset", name: "Nova" } } as const;
const dub = { tool: "dubbing", source: { genId: "take" }, targetLanguage: "fra" } as const;
const analysis = { tool: "video_analysis", source: { uploadId: "clip" } } as const;

test("each tool sends exactly the arguments its advertised schema declares, and none of the captured schemas advertises a get_cost preflight", () => {
  const cases = [
    [voice, { video_id: media, voice_id: "voice-nova", voice_type: "preset" }, true],
    [dub, { video_id: media, target_language: "fra" }, true],
    [analysis, { video_input_id: media }, false],
  ] as const;
  for (const [input, expected, nested] of cases) {
    const tool = requireVoiceTool(input.tool);
    const params = consumerVoiceToolParams(input, media.toUpperCase());
    expect(params).toEqual(expected);
    expect(Object.keys(params)).toEqual([...tool.arguments]);
    const shape = voiceToolArgumentShape(schema(tool.create), params);
    expect(shape, tool.name).toEqual({ nested, getCost: false });
    expect(voiceToolArguments(params, shape!, null)).toEqual(nested ? { params } : params);
    expect(voiceToolArguments(params, shape!, true)).toEqual(nested ? { params: { ...params, get_cost: true } } : { ...params, get_cost: true });
  }
  // The dubbing enum in the capture is exactly our language table, in the provider's order.
  const languages = ((schema("dubbing").properties as Record<string, Record<string, unknown>>).params.properties as Record<string, { enum: string[] }>).target_language.enum;
  expect(languages).toEqual(DUBBING_LANGUAGES.map((entry) => entry.code));
  expect(VOICE_TOOLS.map((tool) => [tool.name, tool.create, tool.status])).toEqual([
    ["voice_change", "voice_change", "job_status"], ["dubbing", "dubbing", "job_status"], ["video_analysis", "video_analysis_create", "video_analysis_status"],
    ["reframe", "reframe", "job_status"],
  ]);
  expect(voiceToolArgumentShape(schema("video_analysis_status"), { video_analyze_id: job })).toEqual({ nested: false, getCost: false });
});

test("the request schema pairs each tool with its own settings only and rejects undeclared or malformed values", () => {
  expect(consumerVoiceToolInputSchema.safeParse(voice).success).toBe(true);
  expect(consumerVoiceToolInputSchema.safeParse(dub).success).toBe(true);
  expect(consumerVoiceToolInputSchema.safeParse(analysis).success).toBe(true);
  for (const bad of [
    { ...voice, voice: undefined }, { ...voice, targetLanguage: "fra" }, { ...dub, voice: voice.voice }, { ...dub, targetLanguage: "fr" }, { ...dub, targetLanguage: "xx" },
    { ...analysis, voice: voice.voice }, { ...voice, tool: "virality_predictor" }, { ...voice, prompt: "hi" }, { ...voice, get_cost: true },
    { ...voice, source: { uploadId: "a", genId: "b" } }, { ...voice, source: {} }, { ...voice, voice: { id: "", type: "preset" } }, { ...voice, voice: { id: "x y", type: "preset" } },
    { ...voice, voice: { id: "x", type: "custom" } }, { ...voice, voice: { id: "x", type: "preset", preview_url: "https://x" } },
  ])
    expect(consumerVoiceToolInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  expect(() => consumerVoiceToolParams(voice, "not-a-uuid")).toThrow();
  expect(() => consumerVoiceToolParams({ ...voice, tool: "dubbing" }, media)).toThrow();
  // The source is validated and imported as a one-video Generate reference whose fingerprint carries the tool settings.
  expect(voiceToolReferenceRequest(voice)).toEqual({ type: "video", model: "voice_tool_voice_change", prompt: "", parameters: { voice_id: "voice-nova", voice_type: "preset" }, medias: [{ role: "video", source: { uploadId: "clip" } }] });
  expect(voiceToolReferenceRequest(dub).parameters).toEqual({ target_language: "fra" });
});

test("argument-shape verification fails closed on missing, extra-required, enum-mismatched or foreign schemas", () => {
  const params = consumerVoiceToolParams(dub, media);
  const base = schema("dubbing") as { properties: { params: { properties: Record<string, unknown>; required: string[] } } };
  const withGetCost = { ...base, properties: { params: { ...base.properties.params, properties: { ...base.properties.params.properties, get_cost: { type: "boolean" } } } } };
  expect(voiceToolArgumentShape(withGetCost, params)).toEqual({ nested: true, getCost: true });
  expect(voiceToolArgumentShape({ ...base, properties: { params: { ...base.properties.params, required: [...base.properties.params.required, "voice_id"] } } }, params)).toBeNull();
  expect(voiceToolArgumentShape({ ...base, properties: { params: { ...base.properties.params, properties: { video_id: base.properties.params.properties.video_id } } } }, params)).toBeNull();
  expect(voiceToolArgumentShape(base, { ...params, target_language: "xx" })).toBeNull();
  expect(voiceToolArgumentShape(schema("voice_change"), params)).toBeNull();
  expect(voiceToolArgumentShape(schema("virality_predictor"), params)).toBeNull();
  expect(voiceToolArgumentShape(undefined, params)).toBeNull();
  expect(voiceToolArgumentShape({ type: "object", properties: { video_id: {}, target_language: {} } }, params)).toEqual({ nested: false, getCost: false });
});

test("only one structured job id is acceptance; status envelopes qualify exactly the acknowledged job", () => {
  expect(consumerVoiceToolAcknowledgement({ results: [{ id: job, model: "voice_change", type: "video" }] })).toBe(job);
  expect(consumerVoiceToolAcknowledgement({ video_analyze_id: job.toUpperCase(), status: "queued" })).toBe(job);
  expect(consumerVoiceToolAcknowledgement({ job_id: job, generation: { id: job } })).toBe(job);
  for (const bad of [{ job_id: job, id: media }, { results: [{ id: job }, { id: media }] }, { results: [] }, { status: "submitted" }, { id: "abc" }, "text", null, { results: [{ status: "ok" }] }])
    expect(consumerVoiceToolAcknowledgement(bad), JSON.stringify(bad)).toBeNull();
  const done = { generation: { id: job, model: "voice_change", type: "video", status: "completed", results: { rawUrl: "https://cdn.example.com/out.mp4" } }, poll_after_seconds: 20 };
  expect(consumerVoiceToolOriginalResult(done, job)).toEqual({ url: "https://cdn.example.com/out.mp4" });
  expect(consumerVoiceToolPollAfter(done)).toBe(20);
  expect(consumerVoiceToolFailureResult(done, job)).toBeNull();
  for (const bad of [
    { generation: { ...done.generation, id: media } }, { generation: { ...done.generation, type: "audio" } }, { generation: { ...done.generation, status: "processing" } },
    { generation: { ...done.generation, results: { rawUrl: "http://cdn.example.com/out.mp4" } } }, { generation: { ...done.generation, results: { url: "https://cdn.example.com/x.mp4" } } },
    { job_id: media, generation: done.generation }, { status: "processing", generation: done.generation }, { raw_data: { id: job, status: "completed", result_url: "https://x/y" } },
  ])
    expect(consumerVoiceToolOriginalResult(bad, job), JSON.stringify(bad)).toBeNull();
  expect(consumerVoiceToolFailureResult({ generation: { id: job, type: "video", status: "failed" } }, job)).toBe("failed");
  expect(consumerVoiceToolFailureResult({ generation: { id: job, type: "video", status: "failed", results: { rawUrl: "https://x/y" } } }, job)).toBeNull();
  expect(consumerVoiceToolFailureResult({ generation: { id: media, type: "video", status: "failed" } }, job)).toBeNull();
});

test("an analysis report is reduced to bounded, labelled figures and scenes for exactly its job, and unknown envelopes stay diagnostic", () => {
  const raw = {
    video_analyze_id: job, status: "completed", summary: "A product demo with a strong opening. See https://example.com/x for more.",
    scores: { hook_strength: 72, attention: 64.5, retention_risk: 0.3, ignored: "text" }, virality_score: 58, duration: 15,
    scenes: [{ start: 0, end: 3, description: "Opening on the bottle." }, { start_time: 3, end_time: 9, summary: "Hands turn the cap." }, "closing card"],
  };
  const report = consumerVideoAnalysisReport(raw, job)!;
  // Figures keep the provider's key order; nested score objects are flattened in place.
  expect(report.figures).toEqual([
    { key: "scores.hook_strength", label: "scores hook strength", value: 72 },
    { key: "scores.attention", label: "scores attention", value: 64.5 },
    { key: "scores.retention_risk", label: "scores retention risk", value: 0.3 },
    { key: "virality_score", label: "virality score", value: 58 },
  ]);
  expect(report.scenes).toEqual([{ index: 0, start: 0, end: 3, text: "Opening on the bottle." }, { index: 1, start: 3, end: 9, text: "Hands turn the cap." }, { index: 2, text: "closing card" }]);
  expect(report.sceneCount).toBe(3);
  expect(report.summary).toBe("A product demo with a strong opening. See [link omitted] for more.");
  expect(report.raw).toEqual(raw);
  expect(consumerVideoAnalysisReport({ ...raw, video_analyze_id: media }, job)).toBeNull();
  expect(consumerVideoAnalysisReport({ ...raw, status: "processing" }, job)).toBeNull();
  expect(consumerVideoAnalysisReport({ status: "completed", scenes: [] }, job)).toBeNull();
  expect(consumerVideoAnalysisReport({ analysis: { id: job, status: "completed", scenes: [] } }, job)).toMatchObject({ figures: [], scenes: [], sceneCount: 0 });
  const big = { ...raw, scenes: Array.from({ length: 400 }, (_, i) => ({ description: "x".repeat(400), start: i })) };
  const bounded = consumerVideoAnalysisReport(big, job)!;
  expect(bounded.scenes).toHaveLength(200);
  expect(bounded.sceneCount).toBe(400);
  expect(bounded.raw).toBeUndefined();
  expect(bounded.truncated).toBe(true);
  expect(consumerVideoAnalysisFailure({ video_analyze_id: job, status: "failed", fail_reason: "Too long" }, job)).toBe("Too long");
  expect(consumerVideoAnalysisFailure({ video_analyze_id: media, status: "failed" }, job)).toBeNull();
  expect(consumerVideoAnalysisFailure(raw, job)).toBeNull();
});

test("voice listings keep only the exact voice pair the tools need, never a preview link, and page by next_cursor", () => {
  const page = parseConnectedVoicesPage({ voices: [{ voice_id: "a", voice_type: "preset", name: "Nova", preview_url: "https://cdn.example.com/a.mp3" }], next_cursor: "p2" });
  expect(page.next).toBe("p2");
  expect(parseConnectedVoicesPage({ items: [], next_cursor: null }).next).toBeNull();
  expect(() => parseConnectedVoicesPage({ next_cursor: "p2" })).toThrow();
  expect(() => parseConnectedVoicesPage({ voices: [], next_cursor: "bad cursor" })).toThrow();
  const parsed = parseConnectedVoices({ items: [
    { voice_id: "a", voice_type: "preset", name: "Nova", preview_url: "https://cdn.example.com/a.mp3", language: "en-US" },
    { voice_id: "a", voice_type: "preset", name: "Duplicate" },
    { id: "b", type: "element", title: "My voice" },
    { voice_id: "c", voice_type: "custom", name: "Unknown type" },
    { voice_id: "", voice_type: "preset" }, "text", null,
  ], complete: false }, 5);
  expect(parsed).toEqual({ voices: [{ id: "a", type: "preset", name: "Nova", language: "en-US" }, { id: "b", type: "element", name: "My voice" }], complete: false, fetchedAt: 5 });
  expect(JSON.stringify(parsed)).not.toContain("preview");
  expect(() => parseConnectedVoices({ items: Array.from({ length: 501 }, () => ({})) })).toThrow();
});

test("results are named after the source and the tool", () => {
  expect(voiceToolResultName(requireVoiceTool("voice_change"), "Hero take.mp4")).toBe("Hero take · voice changed");
  expect(voiceToolResultName(requireVoiceTool("dubbing"), "Hero take.mp4", { targetLanguage: "fra" })).toBe("Hero take · dubbed (French)");
  expect(voiceToolResultName(requireVoiceTool("dubbing"), "Hero take.mp4")).toBe("Hero take · dubbed");
  expect(voiceToolResultName(requireVoiceTool("video_analysis"), ".mp4")).toBe("Source · analysed");
});

/**
 * The account held no analysis on 20 September 2026 (`video_analysis_jobs` ->
 * `{"items":[],"total_count":0,"cursor":null}`, read free), so a real
 * `video_analysis_status` reply is unobserved and creating one costs money.
 * Only the NESTING is recorded, and it is recorded everywhere: this provider
 * puts a job in a top-level array. The reader therefore accepts both shapes —
 * UNTESTED AGAINST LIFE for this tool — and a list entry is bound to the
 * acknowledged id and to nothing else. Against `main` every list case here
 * returns null forever and the analysis never settles.
 */
test("an analysis nested in a top-level list settles exactly the acknowledged job", () => {
  const body = { status: "completed", summary: "Strong opening.", scores: { hook_strength: 70 }, scenes: [{ start: 0, end: 2, description: "Bottle on a table." }] };
  const figures = [{ key: "scores.hook_strength", label: "scores hook strength", value: 70 }];
  expect(consumerVideoAnalysisReport(analysisListing(job, body), job)).toMatchObject({ figures, sceneCount: 1, summary: "Strong opening." });
  expect(consumerVideoAnalysisReport(analysisListing(job, body, "video_analyze_id"), job)).toMatchObject({ figures, sceneCount: 1 });
  expect(consumerVideoAnalysisReport({ results: [{ id: job, ...body }] }, job)).toMatchObject({ figures });
  expect(consumerVideoAnalysisReport({ jobs: [{ job_id: job, ...body }] }, job)).toMatchObject({ figures });
  // Another job, two entries claiming ours, conflicting ids, or no terminal
  // status: all stay diagnostic.
  expect(consumerVideoAnalysisReport(analysisListing(media, body), job)).toBeNull();
  expect(consumerVideoAnalysisReport({ items: [{ id: job, ...body }, { id: job, ...body }] }, job)).toBeNull();
  expect(consumerVideoAnalysisReport({ items: [{ id: job, video_analyze_id: media, ...body }] }, job)).toBeNull();
  expect(consumerVideoAnalysisReport(analysisListing(job, { ...body, status: "processing" }), job)).toBeNull();
  expect(consumerVideoAnalysisReport({ items: [{ id: "analysis-1", ...body }] }, job)).toBeNull();
  expect(consumerVideoAnalysisFailure(analysisListing(job, { status: "failed", fail_reason: "Too long" }), job)).toBe("Too long");
  expect(consumerVideoAnalysisFailure(analysisListing(media, { status: "failed" }), job)).toBeNull();
  expect(consumerVideoAnalysisFailure(analysisListing(job, body), job)).toBeNull();
  // The single-object envelopes this module was written against are unchanged.
  expect(consumerVideoAnalysisReport({ analysis: { id: job, status: "completed", scenes: [] } }, job)).toMatchObject({ sceneCount: 0 });
});
