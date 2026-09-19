import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONSUMER_MCP_URL, submitConsumerGenerationBatch } from "../../lib/higgsfield-consumer/mcp";
import { parseConnectedCatalogue, findCatalogueModel, validateGenerationRequest, takesPreset } from "../../lib/higgsfield-consumer/catalogue";
import { consumerBatchAcknowledgement, consumerGenerationParams, type ConsumerGenerationInput } from "../../lib/higgsfield-consumer/generation-contract";
import { assignBatches, batchLabel, buildConnectedProposal, plannerModels, type ConnectedStepMeta } from "../../lib/higgsfield-consumer/planner-proposals";
import { resetConnectedToolsetCache } from "../../lib/higgsfield-consumer/toolset";

type Tool = { name: string; inputSchema: Record<string, unknown> };
const ninetyOne = JSON.parse(readFileSync("tests/fixtures/connected-tools-91.json", "utf8")) as { tools: Tool[] };
const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8")));
const nano = findCatalogueModel(catalogue, "nano_banana_2")!;
const preset = findCatalogueModel(catalogue, "higgsfield_preset")!;
const wallet = randomUUID();
const inputs: ConsumerGenerationInput[] = ["First.", "Second.", "Third."].map((prompt) => ({ type: "image", model: "nano_banana_2", prompt, parameters: { resolution: "2k" }, medias: [] }));
const entries = inputs.map((input) => ({ model: nano, input, params: consumerGenerationParams(nano, input, []), credits: 9 }));
test.beforeEach(() => resetConnectedToolsetCache());

test("A3: preset_id is carried only by presetId, only for the preset model; the planner may use only a listed preset", () => {
  expect(takesPreset(preset)).toBe(true);
  expect(takesPreset(nano)).toBe(false);
  const request = { type: "video" as const, model: "higgsfield_preset", prompt: "", parameters: {}, medias: [{ role: "image", kind: "image" as const }] };
  expect(validateGenerationRequest(preset, { ...request, presetId: "preset-dolly" })).toEqual({ preset_id: "preset-dolly" });
  expect(() => validateGenerationRequest(preset, request)).toThrow(/requires the setting/);
  expect(() => validateGenerationRequest(preset, { ...request, parameters: { preset_id: "preset-dolly" } })).toThrow(/managed by the workflow/);
  expect(() => validateGenerationRequest(preset, { ...request, presetId: "bad id!" })).toThrow();
  expect(() => validateGenerationRequest(nano, { type: "image", model: "nano_banana_2", prompt: "x", parameters: {}, medias: [], presetId: "preset-dolly" })).toThrow(/does not take a motion preset/);
  const params = consumerGenerationParams(preset, { type: "video", model: "higgsfield_preset", prompt: "", parameters: {}, medias: [{ role: "image", source: { uploadId: "still" } }], presetId: "preset-dolly" }, [{ value: randomUUID(), role: "image" }]);
  expect(params).toMatchObject({ model: "higgsfield_preset", preset_id: "preset-dolly", count: 1, use_unlim: false });
  const models = plannerModels(catalogue.models), presets = [{ id: "preset-dolly", name: "Dolly zoom" }];
  const files = [{ uploadId: "still", kind: "image" as const }];
  expect(buildConnectedProposal({ kind: "video", title: "Dolly", prompt: "", model: "connected:higgsfield_preset", preset: "preset-dolly" }, models, files, presets))
    .toMatchObject({ ok: true, input: { presetId: "preset-dolly", medias: [{ role: "image", source: { uploadId: "still" } }] } });
  expect(buildConnectedProposal({ kind: "video", title: "Dolly", prompt: "", model: "connected:higgsfield_preset", preset: "preset-made-up" }, models, files, presets))
    .toMatchObject({ ok: false, reason: "choose one of the listed motion presets" });
  expect(buildConnectedProposal({ kind: "video", title: "Dolly", prompt: "", model: "connected:higgsfield_preset", preset: "preset-dolly" }, models, files, []))
    .toMatchObject({ ok: false, reason: "the connected account lists no motion presets" });
});

test("A4: batches group 2–4 priced steps of one output type and one wallet; a lone step runs on its own", () => {
  let n = 0;
  const meta = (type: ConnectedStepMeta["type"], workspaceId = wallet) => ({ type, workspaceId } as ConnectedStepMeta);
  const list = [
    ...Array.from({ length: 5 }, () => ({ label: "variants", meta: meta("image") })),
    { label: "variants", meta: meta("video") },
    { label: "cubes", meta: meta("3d") },
    { label: "cubes", meta: meta("3d") },
    { label: null, meta: meta("image") },
  ];
  assignBatches(list, () => `abat_${++n}`);
  expect(list.map((e) => e.meta.batch ?? null)).toEqual([
    { id: "abat_1", size: 4 }, { id: "abat_1", size: 4 }, { id: "abat_1", size: 4 }, { id: "abat_1", size: 4 },
    null, null, null, null, null,
  ]);
  expect(batchLabel(true)).toBe("batch");
  expect(batchLabel(" variants ")).toBe("variants");
  expect(batchLabel("<script>")).toBeNull();
});

test("A4: the batch acknowledgement maps each index to exactly its job, an explicit refusal, or uncertainty", () => {
  const items = inputs.map(() => ({ model: "nano_banana_2", type: "image" as const }));
  const [a, b] = [randomUUID(), randomUUID()];
  expect(consumerBatchAcknowledgement({ jobs: [{ index: 0, job_id: a }, { index: 1, error: "moderation" }, { index: 2 }] }, items)).toEqual([a, "rejected", null]);
  expect(consumerBatchAcknowledgement({ results: [{ index: 2, id: b, model: "nano_banana_2", type: "image" }] }, items)).toEqual([null, null, b]);
  for (const bad of [
    { jobs: [{ index: 0, job_id: a }, { index: 0, job_id: b }] },
    { jobs: [{ index: 0, job_id: a }, { index: 1, job_id: a }] },
    { jobs: [{ index: 0, job_id: a, model: "kling3_0" }] },
    { jobs: [{ index: 7, job_id: a }] },
    "accepted",
  ])
    expect(consumerBatchAcknowledgement(bad, items)).toEqual([null, null, null]);
});

type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
function session(options: { tools?: Tool[]; price?: (i: number) => number; reply?: unknown } = {}) {
  const calls: Packet[] = [];
  let quoteIndex = 0;
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: options.tools ?? ninetyOne.tools } });
    const args = p.params.arguments;
    const value = p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "generate_image" ? { cost: { credits: options.price?.(quoteIndex++) ?? 9, credits_exact: options.price?.(quoteIndex - 1) ?? 9 } }
      : options.reply ?? { jobs: (args.requests as { index: number }[]).map((r) => ({ index: r.index, job_id: randomUUID() })) };
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  const named = (name: string) => calls.filter((p) => p.method === "tools/call" && p.params.name === name);
  return { calls, fetch: fetcher, named };
}

test("A4: the batch transport re-prices every item, admits before the one paid call, and never sends get_cost inside the batch", async () => {
  const f = session();
  const order: string[] = [];
  const result = await submitConsumerGenerationBatch("fixture-private-access", entries, wallet, { fetch: f.fetch, admit: async () => { order.push(`admit after ${f.named("generate_image").length} quotes`); } });
  expect(order).toEqual(["admit after 3 quotes"]);
  expect(f.named("generate_image").map((p) => (p.params.arguments.params as Record<string, unknown>).get_cost)).toEqual([true, true, true]);
  const paid = f.named("generate_image_batch");
  expect(paid).toHaveLength(1);
  const requests = paid[0].params.arguments.requests as { index: number; params: Record<string, unknown> }[];
  expect(requests.map((r) => r.index)).toEqual([0, 1, 2]);
  expect(requests.every((r) => !("get_cost" in r.params) && r.params.count === 1 && r.params.use_unlim === false)).toBe(true);
  expect(requests.map((r) => r.params.prompt)).toEqual(["First.", "Second.", "Third."]);
  expect(result.items.every((item) => item.state === "accepted")).toBe(true);
  // A changed item price refuses before admission; nothing is paid.
  resetConnectedToolsetCache();
  const changed = session({ price: (i) => (i === 1 ? 10 : 9) });
  let admitted = false;
  await expect(submitConsumerGenerationBatch("fixture-private-access", entries, wallet, { fetch: changed.fetch, admit: async () => { admitted = true; } })).rejects.toMatchObject({ code: "quote_changed" });
  expect(admitted).toBe(false);
  expect(changed.named("generate_image_batch")).toEqual([]);
  // No batch tool advertised: refused before any call at all.
  resetConnectedToolsetCache();
  const missing = session({ tools: ninetyOne.tools.filter((t) => t.name !== "generate_image_batch") });
  await expect(submitConsumerGenerationBatch("fixture-private-access", entries, wallet, { fetch: missing.fetch, admit: async () => { admitted = true; } })).rejects.toMatchObject({ code: "tool_unavailable" });
  expect(missing.calls.filter((p) => p.method === "tools/call")).toEqual([]);
  // An unclear reply leaves every item uncertain (kept, never resent).
  resetConnectedToolsetCache();
  const unclear = session({ reply: { status: "submitted" } });
  const unsure = await submitConsumerGenerationBatch("fixture-private-access", entries, wallet, { fetch: unclear.fetch, admit: async () => {} });
  expect(unsure.items).toEqual([{ state: "uncertain" }, { state: "uncertain" }, { state: "uncertain" }]);
  // Mixed output types, a lone item or a 3D batch are refused locally.
  await expect(submitConsumerGenerationBatch("fixture-private-access", entries.slice(0, 1), wallet, { fetch: unclear.fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
});
