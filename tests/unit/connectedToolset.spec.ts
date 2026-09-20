import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CONSUMER_MCP_URL,
  getConsumerGenerationQuote,
  submitConsumerGeneration,
  readConsumerGenerationJob,
  readConsumerGenjutsuJob,
  readConsumerVideoJob,
  readConsumerVoiceToolJob,
} from "../../lib/higgsfield-consumer/mcp";
import { parseConnectedCatalogue, findCatalogueModel, mediaKindForRole, modelVoiceParameters, validateGenerationRequest } from "../../lib/higgsfield-consumer/catalogue";
import { consumerGenerationParams, consumerGenerationOriginalResult, type ConsumerGenerationInput } from "../../lib/higgsfield-consumer/generation-contract";
import { CONNECTED_MODEL_VARIANTS } from "../../lib/higgsfield-consumer/video-contract";
import {
  displayCompleted,
  displayInProgress,
  echoedInjectedVoice,
  waitCompleted,
  waitInProgress,
  type EnvelopeJob,
} from "../fixtures/connectedStatusEnvelopes";
import {
  checkTool,
  normalizeFallbackStatus,
  resetConnectedToolsetCache,
  resolveStatusTool,
  schemaAccepts,
  statusArguments,
  toolsetFrom,
  TOOLSET_TTL_MS,
} from "../../lib/higgsfield-consumer/toolset";

type Tool = { name: string; inputSchema: Record<string, unknown> };
const ninetyEight = JSON.parse(readFileSync("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: Tool[] };
const ninetyOne = JSON.parse(readFileSync("tests/fixtures/connected-tools-91.json", "utf8")) as { tools: Tool[] };
const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8")));
const kling = findCatalogueModel(catalogue, "kling3_0")!;
const wallet = randomUUID(), jobId = randomUUID(), media = randomUUID();
const input: ConsumerGenerationInput = {
  type: "video", model: "kling3_0", prompt: "A slow push in on a bottle.", parameters: { duration: 5, sound: "off", aspect_ratio: "9:16" },
  medias: [{ role: "start_image", source: { uploadId: "still" } }],
};
const params = consumerGenerationParams(kling, input, [{ value: media, role: "start_image" }]);
const sources = [{ url: "https://fixtures.particl.invalid/uploads/still.png", type: "image" as const, role: "start_image" }];
const rawUrl = "https://fixtures.particl.invalid/outputs/take.mp4";
/** The recorded live envelopes, re-keyed to this spec's job, model and media. */
const live: EnvelopeJob = { jobId, model: "kling3_0", type: "video", prompt: input.prompt, medias: [{ id: media, url: sources[0].url }], rawUrl };
const without = (tools: Tool[], ...names: string[]) => tools.filter((tool) => !names.includes(tool.name));
const replacing = (tools: Tool[], name: string, inputSchema: Record<string, unknown>) => tools.map((tool) => (tool.name === name ? { name, inputSchema } : tool));

type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
function session(options: { tools: Tool[] | (() => Tool[]); reply?: (p: Packet) => unknown }) {
  const calls: Packet[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: typeof options.tools === "function" ? options.tools() : options.tools } });
    const advertised = (typeof options.tools === "function" ? options.tools() : options.tools).some((tool) => tool.name === p.params.name);
    if (!advertised) return Response.json({ jsonrpc: "2.0", id: p.id, result: { isError: true, content: [{ type: "text", text: `Tool ${p.params.name} not found` }] } });
    const custom = options.reply?.(p);
    const args = p.params.arguments;
    const value = custom ?? (
      p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "media_import_url" ? { media_id: media }
      : p.params.name === "job_status" ? { generation: { id: jobId, model: "kling3_0", type: "video", status: "completed", results: { rawUrl } } }
      : p.params.name === "job_display" ? displayCompleted(live)
      : p.params.name === "jobs_wait" ? waitCompleted(live)
      : (args.params as Record<string, unknown>).get_cost === true ? { cost: { credits: 42, credits_exact: 42 } }
      : { results: [{ id: jobId, model: "kling3_0", type: "video" }] });
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  const toolCalls = () => calls.filter((p) => p.method === "tools/call");
  return {
    calls, fetch: fetcher, toolCalls,
    lists: () => calls.filter((p) => p.method === "tools/list").length,
    names: () => toolCalls().map((p) => p.params.name),
    paid: () => toolCalls().filter((p) => p.params.name.startsWith("generate_") && (p.params.arguments.params as Record<string, unknown>).get_cost === false),
  };
}
const quoteWith = (f: ReturnType<typeof session>) =>
  getConsumerGenerationQuote("fixture-private-access", kling, input, sources, { fetch: f.fetch, resolveMedia: (_i, _w, perform) => perform() });

test.beforeEach(() => resetConnectedToolsetCache());

test("the two captured surfaces: our 98-tool client has job_status and the v2 template tools, the 91-tool client has neither", () => {
  expect(ninetyEight.tools).toHaveLength(98);
  expect(ninetyOne.tools).toHaveLength(91);
  const has = (tools: Tool[], name: string) => tools.some((tool) => tool.name === name);
  for (const name of ["job_status", "marketing_studio_v2_presets", "marketing_studio_v2_costs", "marketing_studio_v2_create", "marketing_studio_v2_status"]) {
    expect(has(ninetyEight.tools, name)).toBe(true);
    expect(has(ninetyOne.tools, name)).toBe(false);
  }
  for (const name of ["job_display", "jobs_wait", "generate_image", "generate_video", "generate_audio", "generate_3d", "media_import_url", "list_workspaces"])
    expect(has(ninetyOne.tools, name)).toBe(true);
  expect(new Set(ninetyEight.tools.map((tool) => tool.name)).size).toBe(98);
});

test("the schema check accepts exactly what we send and refuses what a tool does not take", () => {
  for (const tools of [ninetyEight.tools, ninetyOne.tools]) {
    const set = toolsetFrom(tools);
    expect(checkTool(set, "generate_video", { params: { ...params, get_cost: true } })).toBe("ok");
    expect(checkTool(set, "generate_video", { params: { ...params, get_cost: false } })).toBe("ok");
    expect(checkTool(set, "media_import_url", { url: sources[0].url, type: "image" })).toBe("ok");
    expect(checkTool(set, "list_workspaces", {})).toBe("ok");
    // Batch items forbid get_cost outright ({"not":{}}).
    expect(checkTool(set, "generate_video_batch", { requests: [{ index: 0, params: { model: "kling3_0", count: 1, get_cost: true } }] })).toBe("mismatch");
    expect(checkTool(set, "generate_video_batch", { requests: [{ index: 0, params: { model: "kling3_0", count: 1, use_unlim: false } }] })).toBe("ok");
    // additionalProperties:false and enums are enforced; missing tools are named as such.
    expect(checkTool(set, "voice_change", { params: { video_id: media, voice_id: "v", get_cost: true } })).toBe("mismatch");
    expect(checkTool(set, "dubbing", { params: { video_id: media, target_language: "xxx" } })).toBe("mismatch");
    expect(checkTool(set, "media_import_url", { url: sources[0].url, type: "document" })).toBe("mismatch");
    expect(checkTool(set, "no_such_tool", {})).toBe("missing");
  }
  // Required keys, types and numeric bounds.
  expect(schemaAccepts({ type: "object", properties: { a: { type: "integer", maximum: 4 } }, required: ["a"] }, {})).toBe(false);
  expect(schemaAccepts({ type: "object", properties: { a: { type: "integer", maximum: 4 } } }, { a: 5 })).toBe(false);
  expect(schemaAccepts({ type: "object", properties: { a: { type: "integer" } } }, { a: 1.5 })).toBe(false);
  expect(schemaAccepts({ type: "object", properties: { a: { type: "number" } } }, { a: 2 })).toBe(true);
});

test("status resolution prefers job_status, then jobs_wait, then job_display, and needs job_status for raw envelopes", () => {
  expect(resolveStatusTool(toolsetFrom(ninetyEight.tools), jobId)).toBe("job_status");
  // A connection advertising BOTH fallbacks takes jobs_wait: it is the one
  // whose live envelope is verified end to end, and the smaller surface.
  expect(resolveStatusTool(toolsetFrom(ninetyOne.tools), jobId)).toBe("jobs_wait");
  expect(resolveStatusTool(toolsetFrom(without(ninetyOne.tools, "jobs_wait")), jobId)).toBe("job_display");
  expect(resolveStatusTool(toolsetFrom(without(ninetyOne.tools, "job_display", "jobs_wait")), jobId)).toBeNull();
  expect(resolveStatusTool(toolsetFrom(ninetyEight.tools), jobId, { rawData: true })).toBe("job_status");
  expect(resolveStatusTool(toolsetFrom(ninetyOne.tools), jobId, { rawData: true })).toBeNull();
  expect(statusArguments("jobs_wait", jobId)).toEqual({ jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 0 });
  expect(statusArguments("job_display", jobId)).toEqual({ id: jobId });
});

const expected = { model: "kling3_0", type: "video" };
const displayOf = (raw: unknown) => normalizeFallbackStatus("job_display", raw, jobId, expected);
const waitOf = (raw: unknown) => normalizeFallbackStatus("jobs_wait", raw, jobId, expected);

test("the REAL job_display envelope qualifies a finished job: the entry is one element of a top-level results array", () => {
  // Recorded live on 20 September 2026. Against the previous code this whole
  // test fails: `job_display` looked only at raw.generation / raw.job / raw,
  // `idOf(raw)` was null, and the reply became the inert
  // { status_source, recognised: false } — a finished, PAID job with a valid
  // output URL was never collected.
  const collected = displayOf(displayCompleted(live));
  expect(collected).toMatchObject({ status_source: "job_display", generation: { id: jobId, status: "completed", model: "kling3_0", type: "video" } });
  expect(collected).not.toHaveProperty("recognised");
  expect(consumerGenerationOriginalResult(collected, jobId, params, "video")).toEqual({ url: rawUrl });
  // The entry's own `results` object carries a thumbnail beside the output;
  // only the output URL is a recognised result key, so it stays a single URL.
  expect((collected.generation as Record<string, unknown>).results).toEqual({ rawUrl });
  // In progress: recognised, bound to the job, and never a collected original.
  const running = displayOf(displayInProgress(live));
  expect(running).toMatchObject({ status_source: "job_display", generation: { id: jobId, status: "in_progress" } });
  expect(consumerGenerationOriginalResult(running, jobId, params, "video")).toBeNull();
  expect(running).not.toHaveProperty("poll_after_seconds");
});

test("the REAL jobs_wait envelope qualifies a finished job and carries the provider's poll hint", () => {
  const collected = waitOf(waitCompleted(live));
  expect(collected).toMatchObject({ status_source: "jobs_wait", generation: { id: jobId, status: "completed", model: "kling3_0", type: "video" } });
  expect(consumerGenerationOriginalResult(collected, jobId, params, "video")).toEqual({ url: rawUrl });
  // all_terminal suppresses the poll hint; thumbnail_url is not a result key.
  expect(collected).not.toHaveProperty("poll_after_seconds");
  const running = waitOf(waitInProgress(live, 5));
  expect(running).toMatchObject({ generation: { id: jobId, status: "in_progress" }, poll_after_seconds: 5 });
  expect(consumerGenerationOriginalResult(running, jobId, params, "video")).toBeNull();
});

test("every safety property of the fallbacks survives the real envelope: the exact job, one https URL, nothing invented", () => {
  const other = randomUUID();
  const entry = (patch: Record<string, unknown>) => ({ results: [{ ...displayCompleted(live).results[0], ...patch }] });
  for (const [name, raw] of [
    // The list names another job: bound to the acknowledged id alone.
    ["another job in the array", entry({ id: other })],
    // Two entries claiming our id: ambiguous, so inert (never "pick one").
    ["our id twice", { results: [displayCompleted(live).results[0], displayCompleted(live).results[0]] }],
    ["another model", entry({ model: "seedance_2_5" })],
    ["another output type", entry({ type: "image" })],
    ["two result URLs", entry({ results: { rawUrl, url: "https://fixtures.particl.invalid/outputs/other.mp4" } })],
    ["a non-https URL", entry({ results: { rawUrl: "http://fixtures.particl.invalid/outputs/take.mp4" } })],
    ["no status", entry({ status: 7 })],
    ["an empty array", { results: [] }],
    ["a list of strings", { results: [rawUrl] }],
    ["an unknown shape", { message: "done" }],
    ["not an object", "completed"],
  ] as const)
    expect(consumerGenerationOriginalResult(displayOf(raw), jobId, params, "video"), name).toBeNull();
  // The single-object shapes some connections return still work unchanged.
  for (const raw of [
    { generation: { id: jobId, status: "completed", model: "kling3_0", type: "video", results: { rawUrl } } },
    { job: { id: jobId, status: "completed", model: "kling3_0", type: "video", results: { rawUrl } } },
    { id: jobId, status: "completed", model: "kling3_0", type: "video", results: { rawUrl } },
  ])
    expect(consumerGenerationOriginalResult(displayOf(raw), jobId, params, "video")).toEqual({ url: rawUrl });
  // jobs_wait keeps its own guards against another job and an ambiguous list.
  expect(consumerGenerationOriginalResult(waitOf({ all_terminal: true, jobs: [{ index: 0, job_id: other, status: "completed", result_url: rawUrl }] }), jobId, params, "video")).toBeNull();
  expect(consumerGenerationOriginalResult(waitOf({ all_terminal: true, jobs: [{ index: 0, job_id: jobId, status: "completed", result_url: rawUrl }, { index: 1, job_id: jobId, status: "completed", result_url: rawUrl }] }), jobId, params, "video")).toBeNull();
});

test("the echoed params.model is a family variant, not the model id — and a different real model id still refuses", () => {
  // The live entry carries top-level model "seedance_2_5" with nested
  // params.model "default". Against the previous contract this fails: the
  // nested variant was compared against our model id and the job never
  // qualified — on the job_status path too, not just the fallbacks.
  expect(CONNECTED_MODEL_VARIANTS.has("default")).toBe(true);
  const variant = (value: unknown) => {
    const one = displayCompleted(live).results[0];
    return displayOf({ results: [{ ...one, params: { ...one.params, model: value } }] });
  };
  for (const tolerated of ["default", "standard", "pro", "fast", "turbo", "lite", "quality", "std", "kling3_0"])
    expect(consumerGenerationOriginalResult(variant(tolerated), jobId, params, "video"), String(tolerated)).toEqual({ url: rawUrl });
  // A different real model id, or a non-string, is still a mismatch.
  for (const refused of ["seedance_2_5", "nano_banana_2", "autosprite", "", 5, null, { id: "kling3_0" }])
    expect(consumerGenerationOriginalResult(variant(refused), jobId, params, "video"), JSON.stringify(refused)).toBeNull();
});

test("the echoed media role is the KIND, not the slot we sent — a paid job with reference media is still collected", () => {
  // Recorded live on 20 September 2026 from twelve completed seedance_2_5 jobs
  // with reference media: every entry echoes
  //   { role: "image", data: { id, type: "media_input", url } }
  // while our request sends the model's declared slot role `start_image`.
  // Against origin/main this whole test fails: evidence() compared "image" to
  // "start_image", returned null, and consumerGenerationOriginalResult
  // discarded a COMPLETED, PAID job with a valid output URL.
  expect(params.medias).toEqual([{ value: media, role: "start_image" }]);
  const echoed = displayCompleted(live).results[0].params.medias;
  expect(echoed).toEqual([{ role: "image", data: { id: media, type: "media_input", url: sources[0].url } }]);
  expect(consumerGenerationOriginalResult(displayOf(displayCompleted(live)), jobId, params, "video")).toEqual({ url: rawUrl });

  const withMedias = (medias: unknown) => {
    const one = displayCompleted(live).results[0];
    return displayOf({ results: [{ ...one, params: { ...one.params, medias } }] });
  };
  // A connection that DOES echo the slot name verbatim still qualifies: both
  // readings of the live sample are accepted, and neither is load-bearing.
  for (const role of ["image", "start_image"])
    expect(consumerGenerationOriginalResult(withMedias([{ role, data: { id: media, type: "media_input", url: sources[0].url } }]), jobId, params, "video"), role).toEqual({ url: rawUrl });
  // The older per-kind `data.type` spellings, and an entry with no type at all.
  for (const type of ["media_input", "image", undefined])
    expect(consumerGenerationOriginalResult(withMedias([{ role: "image", data: { id: media, ...(type === undefined ? {} : { type }) } }]), jobId, params, "video"), String(type)).toEqual({ url: rawUrl });
  // The binding that carries the guarantee is the media id we uploaded, and it
  // is exact. A different id, a different count, an unrecognised data.type, a
  // role of another kind, or a non-object entry all still refuse the job.
  for (const [name, medias] of [
    ["another media id", [{ role: "image", data: { id: randomUUID(), type: "media_input" } }]],
    ["no media id", [{ role: "image", data: { type: "media_input" } }]],
    ["a second reference we never sent", [{ role: "image", data: { id: media, type: "media_input" } }, { role: "image", data: { id: media, type: "media_input" } }]],
    ["no references at all", []],
    ["an unknown data.type", [{ role: "image", data: { id: media, type: "instruction" } }]],
    ["a role of another kind", [{ role: "video", data: { id: media, type: "media_input" } }]],
    ["a string entry", ["image"]],
    ["not an array", { role: "image" }],
  ] as const)
    expect(consumerGenerationOriginalResult(withMedias(medias), jobId, params, "video"), name).toBeNull();
});

test("on the 91-tool surface a generation quotes, submits and polls through jobs_wait without job_status", async () => {
  const f = session({ tools: ninetyOne.tools });
  const quote = await quoteWith(f);
  expect(quote.credits).toBe(42);
  const submitted = await submitConsumerGeneration("fixture-private-access", kling, input, params, wallet, 42, { fetch: f.fetch, admit: async () => {} });
  expect(submitted).toMatchObject({ state: "accepted", providerJobId: jobId });
  const status = await readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: f.fetch });
  expect(consumerGenerationOriginalResult(status.raw, jobId, params, "video")).toEqual({ url: rawUrl });
  expect(f.names()).not.toContain("job_status");
  expect(f.toolCalls().at(-1)!.params).toEqual({ name: "jobs_wait", arguments: { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 0 } });
  expect(f.paid()).toHaveLength(1);
  // One list for the three sessions: the cache holds within its TTL.
  expect(f.lists()).toBe(1);
});

test("on the 98-tool surface the poll uses job_status; with only job_display it reads and collects the real gallery envelope", async () => {
  const ours = session({ tools: ninetyEight.tools });
  const status = await readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: ours.fetch });
  expect(ours.toolCalls().at(-1)!.params).toEqual({ name: "job_status", arguments: { jobId, sync: false, raw_data: false } });
  expect(consumerGenerationOriginalResult(status.raw, jobId, params, "video")).toEqual({ url: rawUrl });
  // The last-resort fallback, answering with the LIVE envelope. This whole
  // branch fails against the previous code: the reply was inert and the paid
  // original was never collected.
  resetConnectedToolsetCache();
  const displayOnly = session({ tools: without(ninetyOne.tools, "jobs_wait") });
  const shown = await readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: displayOnly.fetch });
  expect(displayOnly.toolCalls().at(-1)!.params).toEqual({ name: "job_display", arguments: { id: jobId } });
  expect(consumerGenerationOriginalResult(shown.raw, jobId, params, "video")).toEqual({ url: rawUrl });
  // Genjutsu and voice-tool polls share the same fallback, on the same envelope.
  resetConnectedToolsetCache();
  const motion: EnvelopeJob = { ...live, model: "hf_mult_motion_control" };
  const genjutsu = session({ tools: without(ninetyOne.tools, "jobs_wait"), reply: (p) => (p.params.name === "job_display" ? displayInProgress(motion) : undefined) });
  const moving = await readConsumerGenjutsuJob("fixture-private-access", jobId, wallet, "hf_mult_motion_control", { fetch: genjutsu.fetch });
  expect(moving.raw).toMatchObject({ status_source: "job_display", generation: { id: jobId, status: "in_progress" } });
  const voice = await readConsumerVoiceToolJob("fixture-private-access", jobId, wallet, "dubbing", { fetch: genjutsu.fetch });
  expect(voice.raw).toMatchObject({ generation: { id: jobId, type: "video" } });
});

test("with no status tool advertised the poll fails closed without calling one; the raw-envelope poll needs job_status", async () => {
  const f = session({ tools: without(ninetyOne.tools, "job_display", "jobs_wait") });
  await expect(readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: f.fetch })).rejects.toMatchObject({ code: "status_unavailable", status: 503 });
  expect(f.names()).toEqual(["list_workspaces"]);
  resetConnectedToolsetCache();
  const video = session({ tools: ninetyOne.tools });
  await expect(readConsumerVideoJob("fixture-private-access", jobId, wallet, { fetch: video.fetch })).rejects.toMatchObject({ code: "status_unavailable" });
  expect(video.names()).toEqual(["list_workspaces"]);
});

test("a missing or changed tool refuses before any import, wallet read or spend, with a neutral reason", async () => {
  const missing = session({ tools: without(ninetyEight.tools, "generate_video") });
  const refused = await quoteWith(missing).catch((error) => error);
  expect(refused).toMatchObject({ code: "tool_unavailable", status: 409 });
  expect(refused.message).not.toMatch(/higgsfield|supercomputer/i);
  expect(missing.toolCalls()).toEqual([]);
  resetConnectedToolsetCache();
  const noImport = session({ tools: without(ninetyEight.tools, "media_import_url") });
  await expect(quoteWith(noImport)).rejects.toMatchObject({ code: "tool_unavailable" });
  expect(noImport.toolCalls()).toEqual([]);
  resetConnectedToolsetCache();
  const closed = { type: "object", properties: { params: { type: "object", additionalProperties: false, properties: { model: { type: "string" }, prompt: { type: "string" }, get_cost: { type: "boolean" } } } }, required: ["params"] };
  const changed = session({ tools: replacing(ninetyEight.tools, "generate_video", closed) });
  const contract = await quoteWith(changed).catch((error) => error);
  expect(contract).toMatchObject({ code: "tool_contract_changed" });
  expect(contract.message).not.toMatch(/higgsfield|supercomputer/i);
  expect(changed.toolCalls()).toEqual([]);
  resetConnectedToolsetCache();
  let admitted = false;
  const submit = session({ tools: without(ninetyEight.tools, "generate_video") });
  await expect(submitConsumerGeneration("fixture-private-access", kling, input, params, wallet, 42, { fetch: submit.fetch, admit: async () => { admitted = true; } })).rejects.toMatchObject({ code: "tool_unavailable" });
  expect(admitted).toBe(false);
  expect(submit.toolCalls()).toEqual([]);
});

test("the cache re-reads the list on a miss, and a failed status read drops a stale list", async () => {
  let live = without(ninetyEight.tools, "generate_video");
  const f = session({ tools: () => live });
  await expect(quoteWith(f)).rejects.toMatchObject({ code: "tool_unavailable" });
  expect(f.lists()).toBe(1);
  // The tool appears: the cached list misses it, so the guard refreshes once and proceeds.
  live = ninetyEight.tools;
  expect((await quoteWith(f)).credits).toBe(42);
  expect(f.lists()).toBe(2);
  // job_status disappears while the cached list still has it: the read fails,
  // the cache is dropped, and the next poll re-reads and falls back.
  live = ninetyOne.tools;
  await expect(readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: f.fetch })).rejects.toBeTruthy();
  const recovered = await readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: f.fetch });
  expect(consumerGenerationOriginalResult(recovered.raw, jobId, params, "video")).toEqual({ url: rawUrl });
  expect(f.toolCalls().at(-1)!.params.name).toBe("jobs_wait");
  expect(f.lists()).toBe(3);
  expect(TOOLSET_TTL_MS).toBeLessThanOrEqual(60_000);
});

test("a completed AUDIO job whose echo carries the provider's injected voice entry is still collected", () => {
  // RECORDED FROM PRODUCTION, 20 September 2026 — free read-only
  // `show_generations(type=audio)` on the connected account; no job submitted,
  // US$0.00 spent. Completed `seed_audio` jobs
  // 70990834-1f07-45aa-a325-a8bc55d1d921, 87c8a5b1-1863-43b8-8265-614605d17fad
  // and d0450755-703e-43c0-b15e-24a8f75d433e echo TWO `params.medias` entries
  // where we sent ONE:
  //   [{"role":"audio","data":{"url":"https://…/6f332b29-….wav"}},
  //    {"role":"audio","data":{"id":"70bbc31b-…","type":"audio_input","url":"…_sfx.wav"}}]
  // The first is the VOICE reference, sent through `voice_type`/`voice_id` and
  // never through a medias array. Against origin/main this test fails at the
  // first collection expect: evidence() required
  // `p.medias.length === params.medias.length`, so a completed, PAID audio job
  // that used a voice was discarded as uncollectable.
  const seedAudio = findCatalogueModel(catalogue, "seed_audio")!;
  // Our own path really can compose this request: `seed_audio` declares the
  // voice pair AND the reference roles, so the refusal was reachable, not
  // theoretical.
  expect(modelVoiceParameters(seedAudio)).toEqual({ kinds: ["preset", "element"], required: false });
  expect(seedAudio.medias.flatMap((slot) => slot.roles)).toContain("audio_references");
  const audioInput: ConsumerGenerationInput = {
    type: "audio", model: "seed_audio", prompt: "A dry room tone under the line.",
    parameters: { voice_type: "preset", voice_id: "voice-1", format: "wav" },
    medias: [{ role: "audio_references", source: { uploadId: "sfx" } }],
  };
  expect(() => validateGenerationRequest(seedAudio, {
    type: "audio", model: "seed_audio", prompt: audioInput.prompt, parameters: audioInput.parameters,
    medias: audioInput.medias.map((m) => ({ role: m.role, kind: mediaKindForRole(m.role) })),
  })).not.toThrow();
  const reference = randomUUID(), audioJobId = randomUUID();
  const audioParams = consumerGenerationParams(seedAudio, audioInput, [{ value: reference, role: "audio_references" }]);
  expect(audioParams).toMatchObject({ voice_type: "preset", voice_id: "voice-1", medias: [{ value: reference, role: "audio_references" }] });
  const sfx = "https://fixtures.particl.invalid/uploads/sfx.wav";
  const voiceUrl = "https://fixtures.particl.invalid/voices/6f332b29.wav";
  const audioRaw = "https://fixtures.particl.invalid/outputs/line.wav";
  const liveAudio: EnvelopeJob = {
    jobId: audioJobId, model: "seed_audio", type: "audio", prompt: audioInput.prompt,
    medias: [{ id: reference, url: sfx, kind: "audio", dataType: "audio_input" }],
    injectedVoiceUrl: voiceUrl, rawUrl: audioRaw,
  };
  const audioOf = (raw: unknown) => normalizeFallbackStatus("job_display", raw, audioJobId, { model: "seed_audio", type: "audio" });
  // The envelope as recorded: two entries, the injected voice first.
  expect(displayCompleted(liveAudio).results[0].params.medias).toEqual([
    { role: "audio", data: { url: voiceUrl } },
    { role: "audio", data: { id: reference, type: "audio_input", url: sfx } },
  ]);
  expect(consumerGenerationOriginalResult(audioOf(displayCompleted(liveAudio)), audioJobId, audioParams, "audio")).toEqual({ url: audioRaw });
  // A voice and NO reference of our own — the commonest shape, refused on the
  // count by origin/main too.
  const voiceOnly = { ...liveAudio, medias: [] };
  const voiceOnlyParams = consumerGenerationParams(seedAudio, { ...audioInput, medias: [] }, []);
  expect(consumerGenerationOriginalResult(audioOf(displayCompleted(voiceOnly)), audioJobId, voiceOnlyParams, "audio")).toEqual({ url: audioRaw });

  const withMedias = (medias: unknown) => {
    const one = displayCompleted(liveAudio).results[0];
    return audioOf({ results: [{ ...one, params: { ...one.params, medias } }] });
  };
  const ours = { role: "audio", data: { id: reference, type: "audio_input", url: sfx } };
  const voice = echoedInjectedVoice(voiceUrl);
  const second = randomUUID();
  // WHAT STILL REFUSES. A wrong media id, a missing reference and a reordered
  // reference are each still uncollectable: only an entry naming NO media is
  // walked past, so nothing skipped can substitute for a reference of ours.
  for (const [name, medias] of [
    ["a wrong media id beside the voice", [voice, { role: "audio", data: { id: randomUUID(), type: "audio_input", url: sfx } }]],
    ["the reference missing, voice only", [voice]],
    ["no medias at all", []],
    ["an extra entry that DOES claim an id", [ours, { role: "audio", data: { id: second, type: "audio_input", url: sfx } }]],
    ["our reference echoed twice", [ours, ours]],
    ["an extra with no data at all", [ours, { role: "audio" }]],
    ["a string entry beside the voice", [voice, "audio"]],
    ["not an array", { 0: voice, 1: ours }],
  ] as const)
    expect(consumerGenerationOriginalResult(withMedias(medias), audioJobId, audioParams, "audio"), name).toBeNull();
  // Order is still load-bearing: two references echoed in the wrong order, with
  // the injected voice in front, refuses.
  const twoInput: ConsumerGenerationInput = { ...audioInput, medias: [{ role: "audio_references", source: { uploadId: "sfx" } }, { role: "audio_references", source: { uploadId: "room" } }] };
  const twoParams = consumerGenerationParams(seedAudio, twoInput, [{ value: reference, role: "audio_references" }, { value: second, role: "audio_references" }]);
  const other = { role: "audio", data: { id: second, type: "audio_input", url: "https://fixtures.particl.invalid/uploads/room.wav" } };
  const twoLive: EnvelopeJob = { ...liveAudio, medias: [{ id: reference, url: sfx, kind: "audio", dataType: "audio_input" }, { id: second, url: "https://fixtures.particl.invalid/uploads/room.wav", kind: "audio", dataType: "audio_input" }] };
  const twoOf = (medias: unknown) => {
    const one = displayCompleted(twoLive).results[0];
    return audioOf({ results: [{ ...one, params: { ...one.params, medias } }] });
  };
  expect(consumerGenerationOriginalResult(twoOf([voice, ours, other]), audioJobId, twoParams, "audio")).toEqual({ url: audioRaw });
  expect(consumerGenerationOriginalResult(twoOf([voice, other, ours]), audioJobId, twoParams, "audio")).toBeNull();
  expect(consumerGenerationOriginalResult(twoOf([ours, voice, other]), audioJobId, twoParams, "audio")).toEqual({ url: audioRaw });
});
