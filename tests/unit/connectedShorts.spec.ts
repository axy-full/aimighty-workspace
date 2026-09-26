import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getConsumerShortsQuote, submitConsumerShorts, readConsumerShortsSession, readConsumerShortsClips, readShortsPresets, CONSUMER_MCP_URL } from "../../lib/higgsfield-consumer/mcp";
import { parseConsumerCreditsForParams } from "../../lib/higgsfield-consumer/video-contract";
import type { QualificationValue } from "../../lib/higgsfield-consumer/qualification";
import {
  consumerShortsAcknowledgement,
  consumerShortsInputSchema,
  consumerShortsParams,
  parseShortsPresetsPage,
  parseShortsSessionStatus,
  shortsClipName,
  shortsCreateSchemaMatches,
  shortsDurationSeconds,
  shortsSettlement,
  type ConsumerShortsInput,
} from "../../lib/higgsfield-consumer/shorts-studio";

const capture = JSON.parse(readFileSync("tests/fixtures/connected-shorts-studio.json", "utf8")) as {
  tools: { name: string; inputSchema: Record<string, unknown> }[];
  presetsPage: Record<string, unknown>;
  costReplies: { arguments: { duration_seconds: number; get_cost: true }; reply: { cost: { credits: number; credits_exact: number } } }[];
};
const recorded = capture.costReplies;
const schema = (name: string) => capture.tools.find((tool) => tool.name === name)!.inputSchema;
const wallet = randomUUID(), sessionId = randomUUID(), media = randomUUID(), clipA = randomUUID(), clipB = randomUUID();
const preset = "7fa32a45-2f1e-45ed-8cc7-03296ddcf07f";
const shorts: ConsumerShortsInput = { source: { uploadId: "clip" }, preset: { id: preset, source: "cms", name: "Bold Urban" }, aspectRatio: "9:16" };
const source = { url: "https://fixtures.particl.invalid/uploads/clip.mp4", type: "video" as const, durationSeconds: 31.004 };
type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
function fixture(options: { tools?: typeof capture.tools; change?: (p: Packet) => unknown } = {}) {
  const calls: Packet[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: options.tools ?? capture.tools } });
    const changed = options.change?.(p);
    if (changed instanceof Error) throw changed;
    const args = p.params.arguments;
    const value = changed ?? (
      p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "media_import_url" ? { media_id: media, type: "video" }
      : p.params.name === "shorts_studio_list_presets" ? (args.cursor ? { items: [capture.presetsPage.items as unknown[]][0].slice(0, 1).map((item) => ({ ...(item as object), id: randomUUID(), preset_source: "user", name: "My look" })), next_cursor: null, has_more: false } : capture.presetsPage)
      : p.params.name === "shorts_studio_status" ? { id: sessionId, status: "completed", job_ids: [clipA, clipB] }
      : p.params.name === "job_status" ? { generation: { id: args.jobId, type: "video", status: "completed", results: { rawUrl: `https://media.example.com/${args.jobId}.mp4` } } }
      : args.get_cost === true ? { cost: { credits: 40, credits_exact: 40 } }
      : { id: sessionId, status: "queued", job_ids: [] });
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  const named = (name: string) => calls.filter((p) => p.method === "tools/call" && p.params.name === name);
  return { calls, fetch: fetcher, named, tools: () => calls.filter((p) => p.method === "tools/call").map((p) => p.params.name),
    paid: () => named("shorts_studio_create").filter((p) => p.params.arguments.get_cost !== true) };
}

test("the Shorts contract takes one project video, an advertised style and orientation, and the stored duration (4–120 s)", () => {
  expect(consumerShortsInputSchema.safeParse(shorts).success).toBe(true);
  for (const bad of [
    { ...shorts, aspectRatio: "1:1" }, { ...shorts, preset: { ...shorts.preset, id: "not-a-uuid" } }, { ...shorts, preset: { ...shorts.preset, source: "public" } },
    { ...shorts, durationSeconds: 5 }, { ...shorts, source: { url: "https://example.com/x.mp4" } }, { ...shorts, resolution: "1080p" },
  ]) expect(consumerShortsInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  expect(consumerShortsParams(shorts, media, 31.004)).toEqual({ preset_id: preset, preset_source: "cms", source_video_id: media, aspect_ratio: "9:16", resolution: "720p", duration_seconds: 31.01 });
  for (const bad of [undefined, 0, 3.99, 120.01, Number.NaN]) expect(() => shortsDurationSeconds(bad)).toThrow();
  expect(shortsDurationSeconds(4)).toBe(4);
  // The captured create schema admits exactly these arguments; a narrowed one does not.
  const params = consumerShortsParams(shorts, media, 31);
  expect(shortsCreateSchemaMatches(schema("shorts_studio_create"), params)).toBe(true);
  const narrowed = JSON.parse(JSON.stringify(schema("shorts_studio_create")));
  narrowed.properties.aspect_ratio.enum = ["16:9"];
  expect(shortsCreateSchemaMatches(narrowed, params)).toBe(false);
  const required = { ...schema("shorts_studio_create"), required: ["preset_id", "webhook"] };
  expect(shortsCreateSchemaMatches(required, params)).toBe(false);
  const unpriced = JSON.parse(JSON.stringify(schema("shorts_studio_create")));
  delete unpriced.properties.get_cost;
  expect(shortsCreateSchemaMatches(unpriced, params)).toBe(false);
  // Presets keep id, name and library; preview media is dropped.
  const page = parseShortsPresetsPage(capture.presetsPage);
  expect(page).toEqual({ items: [{ id: preset, name: "Bold Urban", source: "cms" }, { id: "a1075b8b-5b6b-4f3f-b62b-7f178ac84be7", name: "Green Contrast", source: "cms" }, { id: "a1914fcf-5b8c-4cab-9c21-6bb6c4f3e41a", name: "Claymation", source: "cms" }], next: ":8" });
  expect(JSON.stringify(page)).not.toContain("example.com");
  // A session is accepted only by one structured UUID; status must be for that session.
  expect(consumerShortsAcknowledgement({ id: sessionId, status: "queued", job_ids: [] })).toBe(sessionId);
  for (const reply of [{ status: "queued" }, { id: sessionId, session_id: randomUUID() }, { id: "x" }, { id: sessionId, job_ids: "none" }]) expect(consumerShortsAcknowledgement(reply)).toBeNull();
  expect(parseShortsSessionStatus({ id: sessionId, status: "completed", job_ids: [clipA, clipB] }, sessionId)).toEqual({ sessionId, status: "completed", terminal: true, failed: false, jobIds: [clipA, clipB] });
  expect(parseShortsSessionStatus({ id: sessionId, status: "processing", job_ids: [] }, sessionId).terminal).toBe(false);
  for (const bad of [{ id: randomUUID(), status: "completed", job_ids: [] }, { id: sessionId, status: "completed", job_ids: [clipA, clipA] }, { id: sessionId, status: "completed", job_ids: Array.from({ length: 21 }, () => randomUUID()) }, { id: sessionId, status: "completed", job_ids: [sessionId] }])
    expect(() => parseShortsSessionStatus(bad, sessionId)).toThrow();
  expect(shortsSettlement([{ index: 0, providerJobId: clipA, state: "collected", original: {} }, { index: 1, providerJobId: clipB, state: "failed", reason: "failed" }])).toEqual({ clips: 2, collected: 1, failed: 1 });
  expect(shortsClipName("Launch cut.mp4", 1, 5, "Bold Urban")).toBe("Launch cut · short 2 of 5 (Bold Urban)");
});

test("the style listing follows next_cursor, drops preview media and never calls a paid tool", async () => {
  const f = fixture();
  const listing = await readShortsPresets("fixture-private-access", { fetch: f.fetch });
  // The second page's "user" style was saved on the account itself: its own library, never listed in Particl.
  expect(listing.presets.map((p) => p.source)).toEqual(["cms", "cms", "cms"]);
  expect(listing.complete).toBe(true);
  expect(f.named("shorts_studio_list_presets").map((p) => p.params.arguments)).toEqual([{}, { cursor: ":8" }]);
  expect(f.tools()).toEqual(["shorts_studio_list_presets", "shorts_studio_list_presets"]);
  const looping = fixture({ change: (p) => (p.params.name === "shorts_studio_list_presets" ? capture.presetsPage : undefined) });
  await expect(readShortsPresets("fixture-private-access", { fetch: looping.fetch })).rejects.toMatchObject({ code: "provider_error" });
});

test("a Shorts quote prices the stored duration BEFORE importing the source, then confirms the price with the imported video", async () => {
  const f = fixture();
  const imported: string[] = [];
  const quote = await getConsumerShortsQuote("fixture-private-access", shorts, source, { fetch: f.fetch, resolveMedia: async (w, perform) => { imported.push(w); return perform(); } });
  expect(imported).toEqual([wallet]);
  expect(f.tools()).toEqual(["list_workspaces", "shorts_studio_create", "media_import_url", "shorts_studio_create", "list_workspaces"]);
  expect(f.named("shorts_studio_create").map((p) => p.params.arguments)).toEqual([{ duration_seconds: 31.01, get_cost: true }, { duration_seconds: 31.01, get_cost: true }]);
  expect(quote).toEqual({ input: shorts, params: { preset_id: preset, preset_source: "cms", source_video_id: media, aspect_ratio: "9:16", resolution: "720p", duration_seconds: 31.01 }, workspace: { id: wallet, name: "Fixture wallet", credits: 500 }, credits: 40 });
  expect(f.paid()).toEqual([]);
  // An unusable price stops before any import.
  const bad = fixture({ change: (p) => (p.params.name === "shorts_studio_create" ? { cost: { credits: 40, credits_exact: 39.5 } } : undefined) });
  await expect(getConsumerShortsQuote("fixture-private-access", shorts, source, { fetch: bad.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "invalid_quote" });
  expect(bad.tools()).toEqual(["list_workspaces", "shorts_studio_create"]);
  // A schema that lost its cost form or our arguments is refused before any call but the wallet read.
  const stripped = capture.tools.map((tool) => (tool.name === "shorts_studio_create" ? { ...tool, inputSchema: { type: "object", properties: { preset_id: {}, source_video_id: {} } } } : tool));
  const g = fixture({ tools: stripped });
  await expect(getConsumerShortsQuote("fixture-private-access", shorts, source, { fetch: g.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "contract_unverified" });
  expect(g.tools()).toEqual(["list_workspaces"]);
  // A price that moves across the import is refused.
  let n = 0;
  const drift = fixture({ change: (p) => (p.params.name === "shorts_studio_create" ? { cost: { credits: 40 + n, credits_exact: 40 + n++ } } : undefined) });
  await expect(getConsumerShortsQuote("fixture-private-access", shorts, source, { fetch: drift.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "quote_changed" });
  // No stored duration → no session at all.
  const none = fixture();
  await expect(getConsumerShortsQuote("fixture-private-access", shorts, { url: source.url, type: "video" }, { fetch: none.fetch, resolveMedia: (_w, perform) => perform() })).rejects.toMatchObject({ code: "invalid_input" });
  expect(none.calls).toEqual([]);
});

test("submission re-prices, admits once and sends exactly one paid create; session and clip reads are read-only", async () => {
  const params = consumerShortsParams(shorts, media, 31.01);
  const f = fixture();
  let admitted = 0;
  const result = await submitConsumerShorts("fixture-private-access", shorts, params, wallet, 40, { fetch: f.fetch, admit: async () => { admitted++; } });
  expect(result).toEqual({ state: "accepted", providerJobId: sessionId, raw: { id: sessionId, status: "queued", job_ids: [] } });
  expect(admitted).toBe(1);
  expect(f.paid().map((p) => p.params.arguments)).toEqual([params]);
  // Tampered params, a changed price and an ambiguous reply.
  await expect(submitConsumerShorts("fixture-private-access", shorts, { ...params, aspect_ratio: "16:9" }, wallet, 40, { fetch: fixture().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
  const moved = fixture({ change: (p) => (p.params.name === "shorts_studio_create" && p.params.arguments.get_cost === true ? { cost: { credits: 41, credits_exact: 41 } } : undefined) });
  let count = 0;
  await expect(submitConsumerShorts("fixture-private-access", shorts, params, wallet, 40, { fetch: moved.fetch, admit: async () => { count++; } })).rejects.toMatchObject({ code: "quote_changed" });
  expect(count).toBe(0);
  expect(moved.paid()).toEqual([]);
  const vague = fixture({ change: (p) => (p.params.name === "shorts_studio_create" && p.params.arguments.get_cost !== true ? { status: "submitted" } : undefined) });
  expect((await submitConsumerShorts("fixture-private-access", shorts, params, wallet, 40, { fetch: vague.fetch, admit: async () => {} })).state).toBe("uncertain");
  expect(vague.paid()).toHaveLength(1);
  const lost = fixture({ change: (p) => (p.params.name === "shorts_studio_create" && p.params.arguments.get_cost !== true ? new Error("socket closed") : undefined) });
  expect((await submitConsumerShorts("fixture-private-access", shorts, params, wallet, 40, { fetch: lost.fetch, admit: async () => {} })).state).toBe("uncertain");
  // Reads.
  const r = fixture();
  expect(await readConsumerShortsSession("fixture-private-access", sessionId, wallet, { fetch: r.fetch })).toEqual({ id: sessionId, status: "completed", job_ids: [clipA, clipB] });
  expect(r.named("shorts_studio_status")[0].params.arguments).toEqual({ session_id: sessionId });
  const c = fixture();
  const clips = await readConsumerShortsClips("fixture-private-access", [clipA, clipB], wallet, { fetch: c.fetch });
  expect(clips.map((clip) => clip.jobId)).toEqual([clipA, clipB]);
  expect(c.named("job_status").map((p) => p.params.arguments)).toEqual([{ jobId: clipA, sync: false, raw_data: false }, { jobId: clipB, sync: false, raw_data: false }]);
  const wrong = fixture({ change: (p) => (p.params.name === "job_status" ? { generation: { id: randomUUID(), type: "video", status: "completed" } } : undefined) });
  await expect(readConsumerShortsClips("fixture-private-access", [clipA], wallet, { fetch: wrong.fetch })).rejects.toMatchObject({ code: "invalid_job" });
  expect([...r.tools(), ...c.tools()].filter((name) => name === "shorts_studio_create")).toEqual([]);
});

test("the production cost replies qualify and yield the charged integer; a range, a missing or ambiguous figure still refuses", async () => {
  // Recorded from production 2026-09-20 (get_cost only, no session created).
  expect(recorded.length).toBeGreaterThan(1);
  expect(recorded.some((entry) => entry.reply.cost.credits !== entry.reply.cost.credits_exact)).toBe(true);
  for (const { arguments: args, reply } of recorded)
    expect(parseConsumerCreditsForParams(reply, args), JSON.stringify(reply)).toBe(reply.cost.credits);
  // The whole path, on the reply a measured 4.04 s original really gets: 12 credits, and 12 is what is approved.
  const live = recorded.find((entry) => entry.arguments.duration_seconds === 4.04)!;
  const f = fixture({ change: (p) => (p.params.name === "shorts_studio_create" && p.params.arguments.get_cost === true ? live.reply : undefined) });
  const quote = await getConsumerShortsQuote("fixture-private-access", shorts, { ...source, durationSeconds: 4.04 }, { fetch: f.fetch, resolveMedia: (_w, perform) => perform() });
  expect(quote.credits).toBe(12);
  expect(quote.params.duration_seconds).toBe(4.04);
  expect(f.paid()).toEqual([]);
  const submitted = fixture({ change: (p) => (p.params.name === "shorts_studio_create" && p.params.arguments.get_cost === true ? live.reply : undefined) });
  expect((await submitConsumerShorts("fixture-private-access", shorts, quote.params, wallet, 12, { fetch: submitted.fetch, admit: async () => {} })).state).toBe("accepted");
  expect(submitted.paid().map((p) => p.params.arguments)).toEqual([quote.params]);
  // Nothing ambiguous is admitted: a range, an absent or non-numeric figure, an
  // exact figure under the charged one, a gap of a whole credit or more, a
  // fractional charged figure, and a free or negative price.
  for (const cost of [
    { credits_min: 12, credits_max: 20 },
    { credits: 12 },
    { credits_exact: 12.12 },
    { credits: 12, credits_exact: "12.12" },
    { credits: 12, credits_exact: null },
    { credits: 12, credits_exact: 11.9 },
    { credits: 12, credits_exact: 13.12 },
    { credits: 12, credits_exact: 13 },
    { credits: 12.5, credits_exact: 12.9 },
    { credits: 0, credits_exact: 0 },
    { credits: -12, credits_exact: -12 },
    { credits: { min: 12, max: 20 }, credits_exact: 12 },
    { credits: "12", credits_exact: "12" },
    { credits: 12, credits_exact: Number.NaN },
  ] as Record<string, unknown>[]) {
    expect(() => parseConsumerCreditsForParams({ cost } as QualificationValue, { duration_seconds: 4.04, get_cost: true }), JSON.stringify(cost)).toThrow();
    const refused = fixture({ change: (p) => (p.params.name === "shorts_studio_create" ? { cost } : undefined) });
    await expect(getConsumerShortsQuote("fixture-private-access", shorts, { ...source, durationSeconds: 4.04 }, { fetch: refused.fetch, resolveMedia: (_w, perform) => perform() }), JSON.stringify(cost)).rejects.toMatchObject({ code: "invalid_quote" });
    // Refused before the source is imported, so nothing was created or paid for.
    expect(refused.tools()).toEqual(["list_workspaces", "shorts_studio_create"]);
  }
  // A cost object that is not an object at all, and a reply with no cost.
  for (const reply of [{}, { cost: null }, { cost: 12 }, { cost: [12] }, { credits: 12 }] as unknown as QualificationValue[])
    expect(() => parseConsumerCreditsForParams(reply, { duration_seconds: 4.04, get_cost: true })).toThrow();
  // The schema check still refuses a create tool that does not declare an argument we send.
  const params = consumerShortsParams(shorts, media, 4.04);
  expect(shortsCreateSchemaMatches(schema("shorts_studio_create"), params)).toBe(true);
  for (const key of ["duration_seconds", "resolution", "preset_source", "aspect_ratio"]) {
    const undeclared = JSON.parse(JSON.stringify(schema("shorts_studio_create")));
    delete undeclared.properties[key];
    expect(shortsCreateSchemaMatches(undeclared, params), key).toBe(false);
  }
});
