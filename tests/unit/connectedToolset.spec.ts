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
import { parseConnectedCatalogue, findCatalogueModel } from "../../lib/higgsfield-consumer/catalogue";
import { consumerGenerationParams, consumerGenerationOriginalResult, type ConsumerGenerationInput } from "../../lib/higgsfield-consumer/generation-contract";
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
      : p.params.name === "job_display" ? { generation: { id: jobId, model: "kling3_0", type: "video", status: "completed", results: { rawUrl } } }
      : p.params.name === "jobs_wait" ? { all_terminal: true, jobs: [{ index: 0, job_id: jobId, status: "completed", result_url: rawUrl }] }
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

test("status resolution prefers job_status, falls back to job_display then jobs_wait, and needs job_status for raw envelopes", () => {
  expect(resolveStatusTool(toolsetFrom(ninetyEight.tools), jobId)).toBe("job_status");
  expect(resolveStatusTool(toolsetFrom(ninetyOne.tools), jobId)).toBe("job_display");
  expect(resolveStatusTool(toolsetFrom(without(ninetyOne.tools, "job_display")), jobId)).toBe("jobs_wait");
  expect(resolveStatusTool(toolsetFrom(without(ninetyOne.tools, "job_display", "jobs_wait")), jobId)).toBeNull();
  expect(resolveStatusTool(toolsetFrom(ninetyEight.tools), jobId, { rawData: true })).toBe("job_status");
  expect(resolveStatusTool(toolsetFrom(ninetyOne.tools), jobId, { rawData: true })).toBeNull();
  expect(statusArguments("jobs_wait", jobId)).toEqual({ jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 0 });
});

test("fallback envelopes are bound to the exact job and never invent a result", () => {
  const expected = { model: "kling3_0", type: "video" };
  const display = normalizeFallbackStatus("job_display", { id: jobId, status: "completed", model: "kling3_0", type: "video", results: { rawUrl } }, jobId, expected);
  expect(consumerGenerationOriginalResult(display, jobId, params, "video")).toEqual({ url: rawUrl });
  const waited = normalizeFallbackStatus("jobs_wait", { all_terminal: true, jobs: [{ index: 0, job_id: jobId, status: "completed", results: [rawUrl] }] }, jobId, expected);
  expect(consumerGenerationOriginalResult(waited, jobId, params, "video")).toEqual({ url: rawUrl });
  // Another job, another model, two URLs, an http URL or an unknown shape: nothing qualifies.
  for (const raw of [
    { id: randomUUID(), status: "completed", results: { rawUrl } },
    { id: jobId, status: "completed", model: "seedance_2_5", results: { rawUrl } },
    { id: jobId, status: "completed", results: [rawUrl, "https://fixtures.particl.invalid/other.mp4"] },
    { id: jobId, status: "completed", results: { rawUrl: "http://fixtures.particl.invalid/take.mp4" } },
    { message: "done" },
    "completed",
  ])
    expect(consumerGenerationOriginalResult(normalizeFallbackStatus("job_display", raw, jobId, expected), jobId, params, "video")).toBeNull();
  const pending = normalizeFallbackStatus("jobs_wait", { all_terminal: false, poll_after_seconds: 12, jobs: [{ index: 0, job_id: jobId, status: "in_progress" }] }, jobId, expected);
  expect(pending).toMatchObject({ generation: { id: jobId, status: "in_progress" }, poll_after_seconds: 12 });
});

test("on the 91-tool surface a generation quotes, submits and polls through job_display without job_status", async () => {
  const f = session({ tools: ninetyOne.tools });
  const quote = await quoteWith(f);
  expect(quote.credits).toBe(42);
  const submitted = await submitConsumerGeneration("fixture-private-access", kling, input, params, wallet, 42, { fetch: f.fetch, admit: async () => {} });
  expect(submitted).toMatchObject({ state: "accepted", providerJobId: jobId });
  const status = await readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: f.fetch });
  expect(consumerGenerationOriginalResult(status.raw, jobId, params, "video")).toEqual({ url: rawUrl });
  expect(f.names()).not.toContain("job_status");
  expect(f.toolCalls().at(-1)!.params).toEqual({ name: "job_display", arguments: { id: jobId } });
  expect(f.paid()).toHaveLength(1);
  // One list for the three sessions: the cache holds within its TTL.
  expect(f.lists()).toBe(1);
});

test("on the 98-tool surface the poll uses job_status; with only jobs_wait it long-polls nothing and reads a snapshot", async () => {
  const ours = session({ tools: ninetyEight.tools });
  const status = await readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: ours.fetch });
  expect(ours.toolCalls().at(-1)!.params).toEqual({ name: "job_status", arguments: { jobId, sync: false, raw_data: false } });
  expect(consumerGenerationOriginalResult(status.raw, jobId, params, "video")).toEqual({ url: rawUrl });
  resetConnectedToolsetCache();
  const waitOnly = session({ tools: without(ninetyOne.tools, "job_display") });
  const waited = await readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: waitOnly.fetch });
  expect(waitOnly.toolCalls().at(-1)!.params).toEqual({ name: "jobs_wait", arguments: { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 0 } });
  expect(consumerGenerationOriginalResult(waited.raw, jobId, params, "video")).toEqual({ url: rawUrl });
  // Genjutsu and voice-tool polls share the same fallback.
  resetConnectedToolsetCache();
  const genjutsu = session({ tools: ninetyOne.tools, reply: (p) => (p.params.name === "job_display" ? { generation: { id: jobId, model: "hf_mult_motion_control", type: "video", status: "in_progress" } } : undefined) });
  const moving = await readConsumerGenjutsuJob("fixture-private-access", jobId, wallet, "hf_mult_motion_control", { fetch: genjutsu.fetch });
  expect(moving.raw).toMatchObject({ generation: { id: jobId, status: "in_progress" } });
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
  expect(f.toolCalls().at(-1)!.params.name).toBe("job_display");
  expect(f.lists()).toBe(3);
  expect(TOOLSET_TTL_MS).toBeLessThanOrEqual(60_000);
});
