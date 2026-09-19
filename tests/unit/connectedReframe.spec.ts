import { test, expect } from "@playwright/test";
import { readFileSync as readToolsFixture } from "node:fs";
import { resetConnectedToolsetCache } from "../../lib/higgsfield-consumer/toolset";

/** The rest of our connection's surface (wallet, import, status reads), minus the tools this spec controls. */
const connectedTools98 = JSON.parse(readToolsFixture("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
const surfaceBeside = (own: { name: string }[], controlled: string[]) => connectedTools98.tools.filter((tool) => !own.some((o) => o.name === tool.name) && !controlled.includes(tool.name));
test.beforeEach(() => resetConnectedToolsetCache());
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getConsumerVoiceToolQuote, submitConsumerVoiceTool, readConsumerVoiceToolJob, CONSUMER_MCP_URL } from "../../lib/higgsfield-consumer/mcp";
import {
  REFRAME_MAX_SECONDS,
  consumerVoiceToolInputSchema,
  consumerVoiceToolOriginalResult,
  consumerVoiceToolParams,
  consumerVoiceToolParamsFromStored,
  findVoiceTool,
  reframeDurationSeconds,
  voiceToolArgumentShape,
  voiceToolCostParams,
  voiceToolResultName,
  type ConsumerVoiceToolInput,
} from "../../lib/higgsfield-consumer/voice-tools";

const discovery = JSON.parse(readFileSync("tests/fixtures/connected-reframe-tool.json", "utf8")) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
const schema = discovery.tools[0].inputSchema;
const wallet = randomUUID(), jobId = randomUUID(), media = randomUUID();
const reframe: ConsumerVoiceToolInput = { tool: "reframe", source: { uploadId: "clip" }, aspectRatio: "9:16", resolution: "720p" };
const source = { url: "https://fixtures.particl.invalid/uploads/clip.mp4", type: "video" as const, durationSeconds: 12.341 };
type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
function fixture(options: { tools?: typeof discovery.tools; change?: (p: Packet, calls: Packet[]) => unknown } = {}) {
  const calls: Packet[] = [];
  const tools = options.tools ?? discovery.tools;
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: [...tools, ...surfaceBeside(tools, ["reframe"])] } });
    const changed = options.change?.(p, calls);
    if (changed instanceof Error) throw changed;
    const body = (p.params.arguments.params as Record<string, unknown> | undefined) ?? p.params.arguments;
    const value = changed ?? (
      p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "media_import_url" ? { media_id: media, type: "video" }
      : p.params.name === "job_status" ? { generation: { id: jobId, type: "video", status: "processing" }, poll_after_seconds: 20 }
      : body.get_cost === true ? { cost: { credits: 18, credits_exact: 18 } }
      : { results: [{ id: jobId, model: "reframe", type: "video" }] });
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  const named = (name: string) => calls.filter((p) => p.method === "tools/call" && p.params.name === name);
  const args = (p: Packet) => p.params.arguments.params as Record<string, unknown>;
  return { calls, fetch: fetcher, named, args, tools: () => calls.filter((p) => p.method === "tools/call").map((p) => p.params.name),
    paid: () => named("reframe").filter((p) => args(p).get_cost !== true) };
}

test("the reframe contract takes one project video, an advertised aspect ratio and resolution, and the stored duration (≤60 s)", () => {
  expect(findVoiceTool("reframe")).toMatchObject({ label: "Reframe", create: "reframe", status: "job_status", output: "video", group: "tools", costArguments: ["duration_seconds", "resolution"] });
  expect(consumerVoiceToolInputSchema.safeParse(reframe).success).toBe(true);
  for (const bad of [
    { ...reframe, aspectRatio: undefined }, { ...reframe, resolution: undefined }, { ...reframe, aspectRatio: "2:1" }, { ...reframe, resolution: "4k" },
    { ...reframe, targetLanguage: "fra" }, { ...reframe, durationSeconds: 5 }, { tool: "dubbing", source: { uploadId: "clip" }, targetLanguage: "fra", aspectRatio: "9:16" },
  ]) expect(consumerVoiceToolInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  const params = consumerVoiceToolParams(reframe, media, { durationSeconds: 12.341 });
  expect(params).toEqual({ medias: [{ role: "video", value: media }], aspect_ratio: "9:16", duration_seconds: 12.35, resolution: "720p" });
  expect(voiceToolCostParams("reframe", params)).toEqual({ duration_seconds: 12.35, resolution: "720p" });
  expect(consumerVoiceToolParamsFromStored(reframe, params)).toEqual(params);
  expect(() => consumerVoiceToolParamsFromStored({ ...reframe, aspectRatio: "1:1" }, { ...params, aspect_ratio: "9:16" })).not.toThrow();
  // Duration comes from the stored original: missing, zero or over the limit is refused.
  expect(reframeDurationSeconds(60)).toBe(60);
  for (const bad of [undefined, 0, -1, Number.NaN, REFRAME_MAX_SECONDS + 0.01]) expect(() => reframeDurationSeconds(bad)).toThrow();
  expect(() => consumerVoiceToolParams(reframe, media)).toThrow(/no stored duration/);
  expect(() => consumerVoiceToolParams(reframe, "not-a-uuid", { durationSeconds: 5 })).toThrow();
  // The captured schema accepts exactly these arguments, nested under params, with a get_cost form.
  expect(voiceToolArgumentShape(schema, params)).toEqual({ nested: true, getCost: true });
  const narrowed = JSON.parse(JSON.stringify(schema));
  narrowed.properties.params.properties.aspect_ratio.enum = ["16:9"];
  expect(voiceToolArgumentShape(narrowed, params)).toBeNull();
  const shorter = JSON.parse(JSON.stringify(schema));
  shorter.properties.params.properties.duration_seconds.maximum = 10;
  expect(voiceToolArgumentShape(shorter, params)).toBeNull();
  // Results are filed as "<source> · reframed (<ratio>)".
  expect(voiceToolResultName(findVoiceTool("reframe")!, "Launch cut.mp4", reframe)).toBe("Launch cut · reframed (9:16)");
});

test("a reframe quote prices duration + resolution BEFORE importing the source, then confirms the same price with the imported video", async () => {
  const f = fixture();
  const imported: string[] = [];
  const quote = await getConsumerVoiceToolQuote("fixture-private-access", reframe, source, { fetch: f.fetch, resolveMedia: async (workspaceId, perform) => { imported.push(workspaceId); return perform(); } });
  expect(imported).toEqual([wallet]);
  expect(f.tools()).toEqual(["list_workspaces", "reframe", "media_import_url", "reframe", "list_workspaces"]);
  expect(f.named("reframe").map((p) => p.params.arguments)).toEqual([
    { params: { duration_seconds: 12.35, resolution: "720p", get_cost: true } },
    { params: { duration_seconds: 12.35, resolution: "720p", get_cost: true } },
  ]);
  expect(quote).toEqual({ input: reframe, params: { medias: [{ role: "video", value: media }], aspect_ratio: "9:16", duration_seconds: 12.35, resolution: "720p" }, shape: { nested: true, getCost: true }, workspace: { id: wallet, name: "Fixture wallet", credits: 500 }, credits: 18, priceSource: "get_cost" });
  expect(f.paid()).toEqual([]);
  // No quote → no import: a refused price stops before any remote mutation.
  const unpriced = fixture({ change: (p) => (p.params.name === "reframe" ? { cost: { credits: 18, credits_exact: 17.5 } } : undefined) });
  await expect(getConsumerVoiceToolQuote("fixture-private-access", reframe, source, { fetch: unpriced.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "invalid_quote" });
  expect(unpriced.tools()).toEqual(["list_workspaces", "reframe"]);
  // A price that moves between the two reads is refused.
  let reads = 0;
  const drift = fixture({ change: (p) => (p.params.name === "reframe" ? { cost: { credits: 18 + reads++, credits_exact: 18 + reads - 1 } } : undefined) });
  await expect(getConsumerVoiceToolQuote("fixture-private-access", reframe, source, { fetch: drift.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "quote_changed" });
  // Without a get_cost form the tool is unpriced and nothing is imported.
  const stripped = JSON.parse(JSON.stringify(schema));
  delete stripped.properties.params.properties.get_cost;
  const g = fixture({ tools: [{ name: "reframe", inputSchema: stripped }] });
  await expect(getConsumerVoiceToolQuote("fixture-private-access", reframe, source, { fetch: g.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "price_unknown" });
  expect(g.tools()).toEqual(["list_workspaces"]);
  // A missing stored duration never opens a session.
  const none = fixture();
  await expect(getConsumerVoiceToolQuote("fixture-private-access", reframe, { url: source.url, type: "video" }, { fetch: none.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "invalid_input" });
  expect(none.calls).toEqual([]);
});

test("reframe submission re-prices, admits once and sends exactly one paid call with the full arguments; status reads job_status", async () => {
  const params = consumerVoiceToolParams(reframe, media, { durationSeconds: 12.35 }), shape = { nested: true, getCost: true };
  const f = fixture();
  let admitted = 0;
  const result = await submitConsumerVoiceTool("fixture-private-access", reframe, params, shape, wallet, 18, { fetch: f.fetch, admit: async () => { admitted++; } });
  expect(result).toMatchObject({ state: "accepted", providerJobId: jobId });
  expect(admitted).toBe(1);
  expect(f.tools()).toEqual(["list_workspaces", "reframe", "list_workspaces", "reframe"]);
  expect(f.named("reframe")[1].params.arguments).toEqual({ params: { ...params, get_cost: false } });
  expect(f.paid()).toHaveLength(1);
  // Params that differ from the input, an over-long duration or a changed price never pay.
  await expect(submitConsumerVoiceTool("fixture-private-access", reframe, { ...params, aspect_ratio: "1:1" }, shape, wallet, 18, { fetch: fixture().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(submitConsumerVoiceTool("fixture-private-access", reframe, { ...params, duration_seconds: 90 }, shape, wallet, 18, { fetch: fixture().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
  const moved = fixture({ change: (p) => (p.params.name === "reframe" ? { cost: { credits: 20, credits_exact: 20 } } : undefined) });
  let count = 0;
  await expect(submitConsumerVoiceTool("fixture-private-access", reframe, params, shape, wallet, 18, { fetch: moved.fetch, admit: async () => { count++; } })).rejects.toMatchObject({ code: "quote_changed" });
  expect(count).toBe(0);
  expect(moved.paid()).toEqual([]);
  const status = await readConsumerVoiceToolJob("fixture-private-access", jobId, wallet, "reframe", { fetch: fixture().fetch });
  expect(status.pollAfterSeconds).toBe(20);
  expect(consumerVoiceToolOriginalResult({ generation: { id: jobId, type: "video", status: "completed", results: { rawUrl: "https://media.example.com/reframed.mp4" } } }, jobId)).toEqual({ url: "https://media.example.com/reframed.mp4" });
  expect(consumerVoiceToolOriginalResult({ generation: { id: randomUUID(), type: "video", status: "completed", results: { rawUrl: "https://media.example.com/other.mp4" } } }, jobId)).toBeNull();
});
