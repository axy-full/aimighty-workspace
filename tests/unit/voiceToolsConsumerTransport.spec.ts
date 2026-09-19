import { test, expect } from "@playwright/test";
import { readFileSync as readToolsFixture } from "node:fs";
import { resetConnectedToolsetCache } from "../../lib/higgsfield-consumer/toolset";

/** The rest of our connection's surface (wallet, import, status reads), minus the tools this spec controls. */
const connectedTools98 = JSON.parse(readToolsFixture("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
const surfaceBeside = (own: { name: string }[], controlled: string[]) => connectedTools98.tools.filter((tool) => !own.some((o) => o.name === tool.name) && !controlled.includes(tool.name));
test.beforeEach(() => resetConnectedToolsetCache());
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readConnectedVoices, getConsumerVoiceToolQuote, submitConsumerVoiceTool, readConsumerVoiceToolJob, CONSUMER_MCP_URL } from "../../lib/higgsfield-consumer/mcp";
import { consumerVoiceToolParams, type ConsumerVoiceToolInput } from "../../lib/higgsfield-consumer/voice-tools";

const discovery = JSON.parse(readFileSync("tests/fixtures/connected-voice-tools.json", "utf8")) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
const wallet = randomUUID(), jobId = randomUUID(), media = randomUUID();
const voice: ConsumerVoiceToolInput = { tool: "voice_change", source: { uploadId: "clip" }, voice: { id: "voice-nova", type: "preset", name: "Nova" } };
const dub: ConsumerVoiceToolInput = { tool: "dubbing", source: { uploadId: "clip" }, targetLanguage: "fra" };
const analysis: ConsumerVoiceToolInput = { tool: "video_analysis", source: { uploadId: "clip" } };
const source = { url: "https://fixtures.particl.invalid/uploads/clip.mp4", type: "video" as const };
type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
/** Adds a get_cost form to the captured schema of one tool, at the level its arguments live. */
function priced(name: string) {
  const tools = discovery.tools.map((tool) => {
    if (tool.name !== name) return tool;
    const schema = tool.inputSchema as { properties: Record<string, Record<string, unknown>> };
    const nested = "params" in schema.properties;
    const target = nested ? (schema.properties.params as { properties: Record<string, unknown> }) : schema;
    return { ...tool, inputSchema: nested
      ? { ...schema, properties: { params: { ...target, properties: { ...target.properties, get_cost: { type: "boolean" } } } } }
      : { ...schema, properties: { ...schema.properties, get_cost: { type: "boolean" } } } };
  });
  return tools;
}
function fixture(options: { tools?: typeof discovery.tools; change?: (p: Packet, calls: Packet[]) => unknown } = {}) {
  const calls: Packet[] = [];
  const tools = options.tools ?? discovery.tools;
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-private-access");
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: [...tools, ...surfaceBeside(tools, ["voice_change", "dubbing", "video_analysis_create", "video_analysis_status"])] } });
    const changed = options.change?.(p, calls);
    if (changed instanceof Error) throw changed;
    const args = p.params.arguments, body = (args.params as Record<string, unknown> | undefined) ?? args;
    const value = changed ?? (
      p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "media_import_url" ? { media_id: media, type: "video" }
      : p.params.name === "job_status" ? { generation: { id: jobId, type: "video", status: "processing" }, poll_after_seconds: 20 }
      : p.params.name === "video_analysis_status" ? { video_analyze_id: jobId, status: "processing" }
      : p.params.name === "list_voices" ? { voices: [{ voice_id: "voice-nova", voice_type: "preset", name: "Nova" }], next_cursor: null }
      : body.get_cost === true ? { cost: { credits: 12, credits_exact: 12 } }
      : p.params.name === "video_analysis_create" ? { video_analyze_id: jobId, status: "queued" }
      : { results: [{ id: jobId, model: p.params.name, type: "video" }] });
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  const named = (name: string) => calls.filter((p) => p.method === "tools/call" && p.params.name === name);
  return { calls, fetch: fetcher, named, tools: () => calls.filter((p) => p.method === "tools/call").map((p) => p.params.name),
    paid: () => calls.filter((p) => p.method === "tools/call" && ["voice_change", "dubbing", "video_analysis_create"].includes(p.params.name) && ((p.params.arguments.params as Record<string, unknown> | undefined) ?? p.params.arguments).get_cost !== true) };
}

test("with the captured schemas (no get_cost) every quote is refused as price_unknown before any import or paid call", async () => {
  for (const input of [voice, dub, analysis]) {
    const f = fixture();
    await expect(getConsumerVoiceToolQuote("fixture-private-access", input, source, { fetch: f.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "price_unknown" });
    expect(f.tools()).toEqual(["list_workspaces"]);
    expect(f.calls.filter((p) => p.method === "tools/list")).toHaveLength(1);
    expect(f.paid()).toEqual([]);
  }
  // A schema that does not declare our arguments is contract_unverified, also before any import.
  const stripped = discovery.tools.map((tool) => (tool.name === "voice_change" ? { ...tool, inputSchema: { type: "object", properties: { params: { type: "object", properties: { video_id: {}, voice_id: {} }, required: ["video_id", "voice_id"] } } } } : tool));
  const g = fixture({ tools: stripped });
  await expect(getConsumerVoiceToolQuote("fixture-private-access", voice, source, { fetch: g.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "contract_unverified" });
  expect(g.tools()).toEqual(["list_workspaces"]);
  // A language the advertised enum does not list never reaches the provider.
  const narrowed = priced("dubbing").map((tool) => (tool.name !== "dubbing" ? tool : { ...tool, inputSchema: { ...tool.inputSchema, properties: { params: { ...(tool.inputSchema as { properties: { params: { properties: Record<string, unknown> } } }).properties.params, properties: { ...(tool.inputSchema as { properties: { params: { properties: Record<string, unknown> } } }).properties.params.properties, target_language: { type: "string", enum: ["eng"] } } } } } }));
  const h = fixture({ tools: narrowed });
  await expect(getConsumerVoiceToolQuote("fixture-private-access", dub, source, { fetch: h.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "contract_unverified" });
  expect(h.tools()).toEqual(["list_workspaces"]);
  // Malformed inputs never open a session.
  const bad = fixture();
  await expect(getConsumerVoiceToolQuote("fixture-private-access", { ...voice, tool: "dubbing" } as ConsumerVoiceToolInput, source, { fetch: bad.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(getConsumerVoiceToolQuote("fixture-private-access", voice, { url: "http://fixtures.particl.invalid/x.mp4", type: "video" }, { fetch: bad.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "invalid_input" });
  expect(bad.calls).toEqual([]);
});

test("when the live schema declares get_cost, a quote verifies the contract, imports the video once and prices with exactly the declared arguments", async () => {
  const f = fixture({ tools: priced("voice_change") });
  const imported: string[] = [];
  const quote = await getConsumerVoiceToolQuote("fixture-private-access", voice, source, { fetch: f.fetch, resolveMedia: async (workspaceId, perform) => { imported.push(workspaceId); return perform(); } });
  expect(imported).toEqual([wallet]);
  const params = consumerVoiceToolParams(voice, media);
  expect(quote).toEqual({ input: voice, params, shape: { nested: true, getCost: true }, workspace: { id: wallet, name: "Fixture wallet", credits: 500 }, credits: 12, priceSource: "get_cost" });
  expect(f.tools()).toEqual(["list_workspaces", "media_import_url", "voice_change", "list_workspaces"]);
  expect(f.named("media_import_url")[0].params.arguments).toEqual({ url: source.url, type: "video" });
  expect(f.named("voice_change")[0].params.arguments).toEqual({ params: { video_id: media, voice_id: "voice-nova", voice_type: "preset", get_cost: true } });
  expect(f.paid()).toEqual([]);
  // Dubbing and analysis use their own tools and argument levels.
  const d = fixture({ tools: priced("dubbing") });
  const dubbed = await getConsumerVoiceToolQuote("fixture-private-access", dub, source, { fetch: d.fetch, resolveMedia: (_w, perform) => perform() });
  expect(dubbed.params).toEqual({ video_id: media, target_language: "fra" });
  expect(d.named("dubbing")[0].params.arguments).toEqual({ params: { video_id: media, target_language: "fra", get_cost: true } });
  const a = fixture({ tools: priced("video_analysis_create") });
  const analysed = await getConsumerVoiceToolQuote("fixture-private-access", analysis, source, { fetch: a.fetch, resolveMedia: (_w, perform) => perform() });
  expect(analysed.shape).toEqual({ nested: false, getCost: true });
  expect(a.named("video_analysis_create")[0].params.arguments).toEqual({ video_input_id: media, get_cost: true });
  // A failed import stops before pricing; a wrong-typed import is refused.
  const stopped = fixture({ tools: priced("voice_change"), change: (p) => (p.params.name === "media_import_url" ? { media_id: media, type: "image" } : undefined) });
  await expect(getConsumerVoiceToolQuote("fixture-private-access", voice, source, { fetch: stopped.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "provider_error" });
  expect(stopped.tools()).toEqual(["list_workspaces", "media_import_url"]);
  // An adjustment the owner did not approve rejects the quote.
  const adjusted = fixture({ tools: priced("voice_change"), change: (p) => ((p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost === true ? { cost: { credits: 12, credits_exact: 12 }, adjustments: { "params.voice_type": { requested: "preset", used: "element" } } } : undefined) });
  await expect(getConsumerVoiceToolQuote("fixture-private-access", voice, source, { fetch: adjusted.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "unapproved_adjustment" });
});

test("submission re-verifies the contract, wallet and price, admits once, sends exactly one paid call and keeps ambiguous replies uncertain", async () => {
  const params = consumerVoiceToolParams(voice, media), shape = { nested: true, getCost: true };
  const f = fixture({ tools: priced("voice_change") });
  let admitted = 0;
  const result = await submitConsumerVoiceTool("fixture-private-access", voice, params, shape, wallet, 12, { fetch: f.fetch, admit: async () => { admitted++; } });
  expect(result).toEqual({ state: "accepted", providerJobId: jobId, raw: { results: [{ id: jobId, model: "voice_change", type: "video" }] } });
  expect(admitted).toBe(1);
  expect(f.tools()).toEqual(["list_workspaces", "voice_change", "list_workspaces", "voice_change"]);
  expect(f.named("voice_change")[1].params.arguments).toEqual({ params: { ...params, get_cost: false } });
  expect(f.paid()).toHaveLength(1);
  // The live schema losing its get_cost form, a changed wallet, price or balance all stop before admission.
  for (const [options, code] of [
    [{ tools: discovery.tools }, "contract_unverified"],
    [{ tools: priced("voice_change"), change: (p: Packet) => (p.params.name === "list_workspaces" ? { workspaces: [{ id: randomUUID(), is_selected: true, credits: 500 }] } : undefined) }, "workspace_changed"],
    [{ tools: priced("voice_change"), change: (p: Packet) => ((p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost === true ? { cost: { credits: 13, credits_exact: 13 } } : undefined) }, "quote_changed"],
    [{ tools: priced("voice_change"), change: (p: Packet) => (p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 1 }] } : undefined) }, "insufficient_credits"],
  ] as const) {
    const g = fixture(options);
    let count = 0;
    await expect(submitConsumerVoiceTool("fixture-private-access", voice, params, shape, wallet, 12, { fetch: g.fetch, admit: async () => { count++; } })).rejects.toMatchObject({ code });
    expect(count).toBe(0);
    expect(g.paid()).toEqual([]);
  }
  // Tampered params and a refused admission never pay.
  await expect(submitConsumerVoiceTool("fixture-private-access", voice, { ...params, voice_type: "element" }, shape, wallet, 12, { fetch: fixture().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(submitConsumerVoiceTool("fixture-private-access", voice, { ...params, get_cost: "false" }, shape, wallet, 12, { fetch: fixture().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
  const refused = fixture({ tools: priced("voice_change") });
  await expect(submitConsumerVoiceTool("fixture-private-access", voice, params, shape, wallet, 12, { fetch: refused.fetch, admit: async () => { throw new Error("ALREADY_CLAIMED"); } })).rejects.toThrow("ALREADY_CLAIMED");
  expect(refused.paid()).toEqual([]);
  for (const reply of [{ results: [{ id: jobId }, { id: randomUUID() }] }, { job_id: jobId, id: randomUUID() }, { status: "submitted" }, { isError: true }]) {
    const g = fixture({ tools: priced("voice_change"), change: (p) => ((p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost === false ? reply : undefined) });
    expect((await submitConsumerVoiceTool("fixture-private-access", voice, params, shape, wallet, 12, { fetch: g.fetch, admit: async () => {} })).state, JSON.stringify(reply)).toBe("uncertain");
    expect(g.paid()).toHaveLength(1);
  }
  const lost = fixture({ tools: priced("voice_change"), change: (p) => ((p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost === false ? new Error("socket closed") : undefined) });
  expect((await submitConsumerVoiceTool("fixture-private-access", voice, params, shape, wallet, 12, { fetch: lost.fetch, admit: async () => {} })).state).toBe("uncertain");
  // An analysis submission sends its top-level arguments and accepts its own identifier.
  const analysisParams = consumerVoiceToolParams(analysis, media);
  const a = fixture({ tools: priced("video_analysis_create") });
  expect(await submitConsumerVoiceTool("fixture-private-access", analysis, analysisParams, { nested: false, getCost: true }, wallet, 12, { fetch: a.fetch, admit: async () => {} })).toMatchObject({ state: "accepted", providerJobId: jobId });
  expect(a.named("video_analysis_create")[1].params.arguments).toEqual({ video_input_id: media, get_cost: false });
});

test("status reads use job_status for revoiced or dubbed videos and the verified video_analysis_status argument for analyses", async () => {
  const f = fixture();
  const status = await readConsumerVoiceToolJob("fixture-private-access", jobId, wallet, "voice_change", { fetch: f.fetch });
  expect(status.pollAfterSeconds).toBe(20);
  expect(f.calls.at(-1)?.params).toEqual({ name: "job_status", arguments: { jobId, sync: false, raw_data: false } });
  for (const generation of [{ id: randomUUID(), type: "video" }, { id: jobId, type: "audio" }]) {
    const g = fixture({ change: (p) => (p.params.name === "job_status" ? { generation: { ...generation, status: "processing" } } : undefined) });
    await expect(readConsumerVoiceToolJob("fixture-private-access", jobId, wallet, "dubbing", { fetch: g.fetch })).rejects.toMatchObject({ code: "invalid_job" });
  }
  const a = fixture();
  const report = await readConsumerVoiceToolJob("fixture-private-access", jobId, wallet, "video_analysis", { fetch: a.fetch });
  expect(report.raw).toEqual({ video_analyze_id: jobId, status: "processing" });
  expect(a.calls.at(-1)?.params).toEqual({ name: "video_analysis_status", arguments: { video_analyze_id: jobId } });
  const unverified = fixture({ tools: discovery.tools.filter((tool) => tool.name !== "video_analysis_status") });
  await expect(readConsumerVoiceToolJob("fixture-private-access", jobId, wallet, "video_analysis", { fetch: unverified.fetch })).rejects.toMatchObject({ code: "contract_unverified" });
  expect(unverified.tools()).toEqual(["list_workspaces"]);
  await expect(readConsumerVoiceToolJob("fixture-private-access", "not-a-job", wallet, "voice_change", { fetch: fixture().fetch })).rejects.toMatchObject({ code: "invalid_job" });
  await expect(readConsumerVoiceToolJob("fixture-private-access", jobId, wallet, "virality" as "voice_change", { fetch: fixture().fetch })).rejects.toMatchObject({ code: "tool_unknown" });
});

test("the voice listing pages by next_cursor through a fixed limit, fails closed on loops and never calls a generating tool", async () => {
  const pages: Record<string, unknown> = {
    first: { voices: [{ voice_id: "a", voice_type: "preset", name: "Nova" }], next_cursor: "p2" },
    p2: { voices: [{ voice_id: "b", voice_type: "element", name: "Mine" }], next_cursor: null },
  };
  const f = fixture({ change: (p) => (p.params.name === "list_voices" ? pages[String(p.params.arguments.cursor ?? "first")] : undefined) });
  const listing = await readConnectedVoices("fixture-private-access", { fetch: f.fetch });
  expect(listing).toEqual({ items: [{ voice_id: "a", voice_type: "preset", name: "Nova" }, { voice_id: "b", voice_type: "element", name: "Mine" }], complete: true });
  expect(f.named("list_voices").map((p) => p.params.arguments)).toEqual([{ size: 100 }, { size: 100, cursor: "p2" }]);
  expect(f.tools()).toEqual(["list_voices", "list_voices"]);
  const looping = fixture({ change: (p) => (p.params.name === "list_voices" ? { voices: [{ voice_id: "a", voice_type: "preset" }], next_cursor: "same" } : undefined) });
  await expect(readConnectedVoices("fixture-private-access", { fetch: looping.fetch })).rejects.toMatchObject({ code: "provider_error" });
  const malformed = fixture({ change: (p) => (p.params.name === "list_voices" ? { next_cursor: "x" } : undefined) });
  await expect(readConnectedVoices("fixture-private-access", { fetch: malformed.fetch })).rejects.toMatchObject({ code: "provider_error" });
});
