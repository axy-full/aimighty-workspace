import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  readConnectedCatalogue,
  readConnectedModel,
  getConsumerGenerationQuote,
  submitConsumerGeneration,
  readConsumerGenerationJob,
  CONSUMER_MCP_URL,
} from "../../lib/higgsfield-consumer/mcp";
import { parseConnectedCatalogue, findCatalogueModel } from "../../lib/higgsfield-consumer/catalogue";
import { consumerGenerationParams, type ConsumerGenerationInput } from "../../lib/higgsfield-consumer/generation-contract";

const raw = JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8"));
const catalogue = parseConnectedCatalogue(raw);
const kling = findCatalogueModel(catalogue, "kling3_0")!;
const sam = findCatalogueModel(catalogue, "sam_3_3d")!;
const wallet = randomUUID(), jobId = randomUUID(), media = randomUUID();
const input: ConsumerGenerationInput = {
  type: "video", model: "kling3_0", prompt: "A slow push in on a bottle.", parameters: { duration: 5, sound: "off", aspect_ratio: "9:16" },
  medias: [{ role: "start_image", source: { uploadId: "still" } }],
};
const params = consumerGenerationParams(kling, input, [{ value: media, role: "start_image" }]);
type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
function fixture(change?: (p: Packet, calls: Packet[]) => unknown) {
  const calls: Packet[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-private-access");
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    const changed = change?.(p, calls);
    if (changed instanceof Error) throw changed;
    const args = p.params.arguments;
    const value = changed ?? (
      p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "media_import_url" ? { media_id: media }
      : p.params.name === "job_status" ? { job_id: jobId, status: "in_progress", poll_after_seconds: 20 }
      : p.params.name === "models_explore" ? (args.action === "get" ? { model: raw.items[0] } : { items: raw.items.slice(0, 2), has_more: false, unlim: raw.unlim })
      : (args.params as Record<string, unknown>).get_cost === true ? { cost: { credits: 42, credits_exact: 42 } }
      : { results: [{ id: jobId, model: (args.params as Record<string, unknown>).model, type: p.params.name === "generate_3d" ? "3d" : "video" }] });
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  return {
    calls, fetch: fetcher,
    paid: () => calls.filter((p) => p.params?.name?.startsWith("generate_") && (p.params.arguments.params as Record<string, unknown>).get_cost === false),
  };
}

test("the catalogue read lists models page by page through a fixed limit and never calls a generating tool", async () => {
  const pages = [
    { items: raw.items.slice(0, 50), has_more: true, next_page_token: "page-2", unlim: raw.unlim },
    { items: raw.items.slice(50), has_more: false, unlim: { available: true, remaining: 1 } },
  ];
  const f = fixture((p) => (p.params.name === "models_explore" ? pages[p.params.arguments.after === "page-2" ? 1 : 0] : undefined));
  const result = await readConnectedCatalogue("fixture-private-access", { fetch: f.fetch });
  expect(result.items).toHaveLength(98);
  expect(result.has_more).toBe(false);
  expect(result.unlim).toEqual(raw.unlim);
  expect(parseConnectedCatalogue(result).models).toHaveLength(98);
  const reads = f.calls.filter((p) => p.method === "tools/call");
  expect(reads.map((p) => [p.params.name, p.params.arguments])).toEqual([
    ["models_explore", { action: "list", limit: 100 }],
    ["models_explore", { action: "list", limit: 100, after: "page-2" }],
  ]);
  expect(f.paid()).toEqual([]);
  // A looping cursor fails closed.
  const looping = fixture((p) => (p.params.name === "models_explore" ? { items: [], has_more: true, next_page_token: "same" } : undefined));
  await expect(readConnectedCatalogue("fixture-private-access", { fetch: looping.fetch })).rejects.toMatchObject({ code: "provider_error" });
  const single = fixture();
  expect(await readConnectedModel("fixture-private-access", "soul_2", { fetch: single.fetch })).toEqual(raw.items[0]);
  expect(single.calls.at(-1)?.params).toEqual({ name: "models_explore", arguments: { action: "get", model_id: "soul_2" } });
  await expect(readConnectedModel("fixture-private-access", "../x", { fetch: single.fetch })).rejects.toMatchObject({ code: "invalid_input" });
});

test("a quote imports each project original once, prices with get_cost and submits nothing", async () => {
  const f = fixture();
  const imported: number[] = [];
  const quote = await getConsumerGenerationQuote("fixture-private-access", kling, input, [{ url: "https://fixtures.particl.invalid/uploads/still.png", type: "image", role: "start_image" }], {
    fetch: f.fetch,
    resolveMedia: async (index, workspaceId, perform) => { imported.push(index); expect(workspaceId).toBe(wallet); return perform(); },
  });
  expect(imported).toEqual([0]);
  expect(quote).toEqual({ input, params, workspace: { id: wallet, name: "Fixture wallet", credits: 500 }, credits: 42 });
  const calls = f.calls.filter((p) => p.method === "tools/call").map((p) => p.params);
  expect(calls.map((p) => p.name)).toEqual(["list_workspaces", "media_import_url", "generate_video", "list_workspaces"]);
  expect(calls[1].arguments).toEqual({ url: "https://fixtures.particl.invalid/uploads/still.png", type: "image" });
  expect(calls[2].arguments).toEqual({ params: { ...params, get_cost: true } });
  expect(Object.keys((calls[2].arguments.params as Record<string, unknown>)).sort()).toEqual(["aspect_ratio", "count", "duration", "get_cost", "medias", "model", "prompt", "sound", "use_unlim"].sort());
  expect(f.paid()).toEqual([]);
  // The right tool per output type, validated against the catalogue first.
  const three = fixture();
  const threeInput: ConsumerGenerationInput = { type: "3d", model: "sam_3_3d", prompt: "", parameters: { export_textured_glb: true }, medias: [{ role: "image", source: { genId: "still" } }] };
  const threeQuote = await getConsumerGenerationQuote("fixture-private-access", sam, threeInput, [{ url: "https://fixtures.particl.invalid/generations/still.png", type: "image", role: "image" }], { fetch: three.fetch, resolveMedia: (_i, _w, perform) => perform() });
  expect(threeQuote.params).toEqual({ export_textured_glb: true, model: "sam_3_3d", medias: [{ value: media, role: "image" }], count: 1, use_unlim: false });
  expect(three.calls.filter((p) => p.method === "tools/call").map((p) => p.params.name)).toEqual(["list_workspaces", "media_import_url", "generate_3d", "list_workspaces"]);
  // Undeclared settings, wrong model and mismatched sources never reach the provider.
  for (const [bad, sources] of [
    [{ ...input, parameters: { resolution: "4k" } }, [{ url: "https://fixtures.particl.invalid/x.png", type: "image", role: "start_image" }]],
    [{ ...input, model: "kling2_6" }, [{ url: "https://fixtures.particl.invalid/x.png", type: "image", role: "start_image" }]],
    [input, []],
    [input, [{ url: "http://fixtures.particl.invalid/x.png", type: "image", role: "start_image" }]],
    [input, [{ url: "https://fixtures.particl.invalid/x.png", type: "image", role: "end_image" }]],
  ] as const) {
    const g = fixture();
    await expect(getConsumerGenerationQuote("fixture-private-access", kling, bad as ConsumerGenerationInput, [...sources], { fetch: g.fetch, resolveMedia: (_i, _w, perform) => perform() })).rejects.toBeTruthy();
    expect(g.calls).toEqual([]);
  }
  // A failed import stops before pricing and surfaces the caller's own error.
  const stopped = fixture((p) => (p.params.name === "media_import_url" ? { media_id: media, error: "rejected" } : undefined));
  await expect(getConsumerGenerationQuote("fixture-private-access", kling, input, [{ url: "https://fixtures.particl.invalid/uploads/still.png", type: "image", role: "start_image" }], { fetch: stopped.fetch, resolveMedia: (_i, _w, perform) => perform() })).rejects.toMatchObject({ code: "provider_error" });
  expect(stopped.calls.filter((p) => p.method === "tools/call").map((p) => p.params.name)).toEqual(["list_workspaces", "media_import_url"]);
  // Adjustments the owner did not approve reject the quote.
  const adjusted = fixture((p) => ((p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost === true ? { cost: { credits: 42, credits_exact: 42 }, adjustments: { "params.duration": { requested: 5, used: 10 } } } : undefined));
  await expect(getConsumerGenerationQuote("fixture-private-access", kling, input, [{ url: "https://fixtures.particl.invalid/uploads/still.png", type: "image", role: "start_image" }], { fetch: adjusted.fetch, resolveMedia: (_i, _w, perform) => perform() })).rejects.toMatchObject({ code: "unapproved_adjustment" });
});

test("submission re-checks wallet and price, admits once, sends exactly one paid call and keeps ambiguous replies uncertain", async () => {
  const f = fixture();
  let admitted = 0;
  const result = await submitConsumerGeneration("fixture-private-access", kling, input, params, wallet, 42, { fetch: f.fetch, admit: async () => { admitted++; } });
  expect(result).toEqual({ state: "accepted", providerJobId: jobId, raw: { results: [{ id: jobId, model: "kling3_0", type: "video" }] } });
  expect(admitted).toBe(1);
  const calls = f.calls.filter((p) => p.method === "tools/call").map((p) => p.params);
  expect(calls.map((p) => p.name)).toEqual(["list_workspaces", "generate_video", "list_workspaces", "generate_video"]);
  expect(calls[3].arguments).toEqual({ params: { ...params, get_cost: false } });
  expect(f.paid()).toHaveLength(1);
  for (const [change, code] of [
    [(p: Packet) => (p.params.name === "list_workspaces" ? { workspaces: [{ id: randomUUID(), is_selected: true, credits: 500 }] } : undefined), "workspace_changed"],
    [(p: Packet) => ((p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost === true ? { cost: { credits: 43, credits_exact: 43 } } : undefined), "quote_changed"],
    [(p: Packet) => (p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 1 }] } : undefined), "insufficient_credits"],
  ] as const) {
    const g = fixture(change);
    let count = 0;
    await expect(submitConsumerGeneration("fixture-private-access", kling, input, params, wallet, 42, { fetch: g.fetch, admit: async () => { count++; } })).rejects.toMatchObject({ code });
    expect(count).toBe(0);
    expect(g.paid()).toEqual([]);
  }
  // Tampered params never submit; a mismatched approval never submits.
  await expect(submitConsumerGeneration("fixture-private-access", kling, input, { ...params, count: 2 } as unknown as typeof params, wallet, 42, { fetch: fixture().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(submitConsumerGeneration("fixture-private-access", kling, input, { ...params, seed: 4 } as typeof params, wallet, 42, { fetch: fixture().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
  // The caller's admission error propagates unchanged with no paid call.
  const refused = fixture();
  await expect(submitConsumerGeneration("fixture-private-access", kling, input, params, wallet, 42, { fetch: refused.fetch, admit: async () => { throw new Error("ALREADY_CLAIMED"); } })).rejects.toThrow("ALREADY_CLAIMED");
  expect(refused.paid()).toEqual([]);
  // Ambiguous acknowledgements stay uncertain: another model, two ids, a batch, or a transport loss after sending.
  for (const reply of [{ results: [{ id: jobId, model: "kling2_6", type: "video" }] }, { results: [{ id: jobId, model: "kling3_0", type: "image" }] },
    { results: [{ id: jobId, model: "kling3_0", type: "video" }, { id: randomUUID(), model: "kling3_0", type: "video" }] }, { job_id: jobId, id: randomUUID() }, { status: "submitted" }]) {
    const g = fixture((p) => ((p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost === false ? reply : undefined));
    const outcome = await submitConsumerGeneration("fixture-private-access", kling, input, params, wallet, 42, { fetch: g.fetch, admit: async () => {} });
    expect(outcome.state, JSON.stringify(reply)).toBe("uncertain");
    expect(g.paid()).toHaveLength(1);
  }
  const lost = fixture((p) => ((p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost === false ? new Error("socket closed") : undefined));
  expect((await submitConsumerGeneration("fixture-private-access", kling, input, params, wallet, 42, { fetch: lost.fetch, admit: async () => {} })).state).toBe("uncertain");
});

test("status reads use the normalized job_status envelope and reject other jobs, models or output types", async () => {
  const f = fixture((p) => (p.params.name === "job_status" ? { generation: { id: jobId, model: "kling3_0", type: "video", status: "processing", params }, poll_after_seconds: 25 } : undefined));
  const status = await readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: f.fetch });
  expect(status.pollAfterSeconds).toBe(25);
  expect(f.calls.at(-1)?.params).toEqual({ name: "job_status", arguments: { jobId, sync: false, raw_data: false } });
  for (const generation of [{ id: randomUUID(), model: "kling3_0", type: "video" }, { id: jobId, model: "kling2_6", type: "video" }, { id: jobId, model: "kling3_0", type: "image" }]) {
    const g = fixture((p) => (p.params.name === "job_status" ? { generation: { ...generation, status: "processing" } } : undefined));
    await expect(readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "video", { fetch: g.fetch })).rejects.toMatchObject({ code: "invalid_job" });
  }
  await expect(readConsumerGenerationJob("fixture-private-access", jobId, wallet, "kling3_0", "gif" as "video", { fetch: fixture().fetch })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(readConsumerGenerationJob("fixture-private-access", "not-a-job", wallet, "kling3_0", "video", { fetch: fixture().fetch })).rejects.toMatchObject({ code: "invalid_job" });
});
