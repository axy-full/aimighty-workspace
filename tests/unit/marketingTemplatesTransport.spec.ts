import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CONSUMER_MCP_URL,
  readMarketingTemplateCatalogue,
  readMarketingTemplateCosts,
  getConsumerMarketingTemplateQuote,
  submitConsumerMarketingTemplate,
  readConsumerMarketingTemplateJob,
} from "../../lib/higgsfield-consumer/mcp";
import { parseMarketingTemplateCatalogue, parseMarketingTemplateCosts, consumerMarketingTemplateParams, type ConsumerMarketingTemplateInput } from "../../lib/higgsfield-consumer/marketing-templates";

const fixture = JSON.parse(readFileSync("tests/fixtures/marketing-templates.json", "utf8"));
const catalogue = parseMarketingTemplateCatalogue({ items: fixture.pages.flatMap((p: { presets: unknown[] }) => p.presets), total: 6, complete: true });
const costs = parseMarketingTemplateCosts(fixture.costs);
const studio = catalogue.templates.find((t) => t.id === "tpl_product_shot_studio")!;
const hero = catalogue.templates.find((t) => t.id === "tpl_ads_hero")!;
const motion = catalogue.templates.find((t) => t.id === "tpl_motion_loop")!;
const wallet = randomUUID(), jobId = randomUUID(), media = randomUUID();
const input: ConsumerMarketingTemplateInput = { presetId: studio.id, prompt: "A plain bottle.", brandName: "Our bottle", productImage: { uploadId: "still" } };
const source = { url: "https://fixtures.particl.invalid/uploads/still.png", type: "image" as const };
type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown>; cursor?: string } };
const flatSchema = (getCost: boolean) => ({ type: "object", properties: { preset_id: {}, prompt: {}, brand_name: {}, product_image: {}, ...(getCost ? { get_cost: {} } : {}) }, required: ["preset_id"] });
const nestedSchema = { type: "object", properties: { params: { type: "object", properties: { preset_id: {}, prompt: {}, brand_name: {}, product_image: {}, get_cost: {} } } } };
function fixtureSession(options: { create?: unknown; status?: unknown; change?: (p: Packet, calls: Packet[]) => unknown } = {}) {
  const calls: Packet[] = [];
  const tools = [
    { name: "marketing_studio_v2_presets", inputSchema: { type: "object", properties: { category: {}, size: {}, cursor: {} } } },
    { name: "marketing_studio_v2_costs", inputSchema: { type: "object", properties: {} } },
    ...(options.create === null ? [] : [{ name: "marketing_studio_v2_create", inputSchema: options.create ?? flatSchema(false) }]),
    ...(options.status === null ? [] : [{ name: "marketing_studio_v2_status", inputSchema: options.status ?? { type: "object", properties: { job_id: {} }, required: ["job_id"] } }]),
  ];
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-private-access");
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: p.params?.cursor ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: "more" } });
    const changed = options.change?.(p, calls);
    if (changed instanceof Error) throw changed;
    const args = p.params.arguments;
    const value = changed ?? (
      p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "media_import_url" ? { media_id: media }
      : p.params.name === "marketing_studio_v2_presets" ? fixture.pages[args.cursor === "page-2" ? 1 : 0]
      : p.params.name === "marketing_studio_v2_costs" ? fixture.costs
      : p.params.name === "marketing_studio_v2_status" ? { job_id: jobId, status: "processing", poll_after_seconds: 20 }
      : (args.get_cost === true || (args.params as Record<string, unknown> | undefined)?.get_cost === true) ? { cost: { credits: 42, credits_exact: 42 } }
      : { job_id: jobId, status: "pending" });
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  const paid = () => calls.filter((p) => p.params?.name === "marketing_studio_v2_create" && p.params.arguments.get_cost !== true && (p.params.arguments.params as Record<string, unknown> | undefined)?.get_cost !== true);
  return { calls, fetch: fetcher, paid, reads: () => calls.filter((p) => p.method === "tools/call").map((p) => [p.params.name, p.params.arguments]) };
}

test("the presets feed is read page by page through the provider's cursor under a fixed page count, and the cost table once", async () => {
  const f = fixtureSession();
  const result = await readMarketingTemplateCatalogue("fixture-private-access", "all", { fetch: f.fetch });
  expect(result).toMatchObject({ total: 6, complete: true });
  expect(result.items).toHaveLength(6);
  expect(parseMarketingTemplateCatalogue(result).templates).toHaveLength(6);
  expect(f.reads()).toEqual([
    ["marketing_studio_v2_presets", { category: "all", size: 100 }],
    ["marketing_studio_v2_presets", { category: "all", size: 100, cursor: "page-2" }],
  ]);
  expect(f.paid()).toEqual([]);
  const table = parseMarketingTemplateCosts(await readMarketingTemplateCosts("fixture-private-access", { fetch: f.fetch }));
  expect(table.version).toBe("2026-09-18");
  expect(f.reads().at(-1)).toEqual(["marketing_studio_v2_costs", {}]);
  // A looping cursor fails closed; a declared total stops the read; the page cap marks a partial listing.
  const looping = fixtureSession({ change: (p) => (p.params.name === "marketing_studio_v2_presets" ? { presets: [{ id: "a" }], total: 900, next_cursor: "same" } : undefined) });
  await expect(readMarketingTemplateCatalogue("fixture-private-access", "all", { fetch: looping.fetch })).rejects.toMatchObject({ code: "provider_error" });
  let page = 0;
  const endless = fixtureSession({ change: (p) => (p.params.name === "marketing_studio_v2_presets" ? { presets: [{ id: `p${page}` }], next_cursor: `c${++page}` } : undefined) });
  const partial = await readMarketingTemplateCatalogue("fixture-private-access", "ugc", { fetch: endless.fetch });
  expect(partial.complete).toBe(false);
  expect(partial.items).toHaveLength(12);
  await expect(readMarketingTemplateCatalogue("fixture-private-access", "bogus" as "all", { fetch: f.fetch })).rejects.toMatchObject({ code: "invalid_input" });
});

test("a quote imports the product image once, verifies the create tool's advertised arguments and prices from the cost table when no get_cost form is declared", async () => {
  const f = fixtureSession();
  const imports: string[] = [];
  const quote = await getConsumerMarketingTemplateQuote("fixture-private-access", studio, costs, input, source, {
    fetch: f.fetch,
    resolveMedia: async (workspaceId, perform) => { expect(workspaceId).toBe(wallet); const id = await perform(); imports.push(id); return id; },
  });
  expect(quote).toMatchObject({ credits: 40, priceSource: "cost_table", shape: { nested: false, getCost: false }, workspace: { id: wallet, name: "Fixture wallet" } });
  expect(quote.params).toEqual({ preset_id: studio.id, prompt: "A plain bottle.", brand_name: "Our bottle", product_image: media });
  expect(imports).toEqual([media]);
  expect(f.reads().map(([name]) => name)).toEqual(["list_workspaces", "media_import_url", "list_workspaces"]);
  expect(f.paid()).toEqual([]);
  // With a get_cost form the tool prices itself and nothing is submitted.
  const priced = fixtureSession({ create: flatSchema(true) });
  const exact = await getConsumerMarketingTemplateQuote("fixture-private-access", hero, costs, { presetId: hero.id, prompt: "Hero." }, null, { fetch: priced.fetch, resolveMedia: async () => { throw new Error("no media"); } });
  expect(exact).toMatchObject({ credits: 42, priceSource: "get_cost", shape: { nested: false, getCost: true } });
  expect(priced.reads()).toContainEqual(["marketing_studio_v2_create", { preset_id: hero.id, prompt: "Hero.", get_cost: true }]);
  expect(priced.paid()).toEqual([]);
  const nested = fixtureSession({ create: nestedSchema });
  expect((await getConsumerMarketingTemplateQuote("fixture-private-access", hero, costs, { presetId: hero.id, prompt: "Hero." }, null, { fetch: nested.fetch, resolveMedia: async () => "" })).shape).toEqual({ nested: true, getCost: true });
  expect(nested.reads()).toContainEqual(["marketing_studio_v2_create", { params: { preset_id: hero.id, prompt: "Hero.", get_cost: true } }]);
  // No cost-table price and no get_cost form: refused before any call.
  const unpriced = fixtureSession();
  await expect(getConsumerMarketingTemplateQuote("fixture-private-access", motion, parseMarketingTemplateCosts({ version: 1, costs: [] }), { presetId: motion.id, prompt: "" }, null, { fetch: unpriced.fetch, resolveMedia: async () => "" })).rejects.toMatchObject({ code: "price_unknown" });
  expect(unpriced.reads().filter(([name]) => name === "marketing_studio_v2_create")).toEqual([]);
  // An unadvertised or mismatching create schema leaves the contract unverified.
  for (const create of [null, { type: "object", properties: { template_id: {} } }])
    await expect(getConsumerMarketingTemplateQuote("fixture-private-access", hero, costs, { presetId: hero.id, prompt: "" }, null, { fetch: fixtureSession({ create }).fetch, resolveMedia: async () => "" })).rejects.toMatchObject({ code: "contract_unverified" });
  await expect(getConsumerMarketingTemplateQuote("fixture-private-access", hero, costs, input, source, { fetch: f.fetch, resolveMedia: async () => "" })).rejects.toMatchObject({ code: "invalid_input" });
});

test("submission re-checks wallet, contract and price, admits once, sends exactly one create and keeps ambiguous replies uncertain", async () => {
  const params = consumerMarketingTemplateParams(input, media);
  const shape = { nested: false, getCost: false };
  const f = fixtureSession();
  let admitted = 0;
  const accepted = await submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, params, shape, wallet, 40, { fetch: f.fetch, admit: async () => { admitted++; } });
  expect(accepted).toMatchObject({ state: "accepted", providerJobId: jobId });
  expect(admitted).toBe(1);
  expect(f.paid()).toHaveLength(1);
  expect(f.paid()[0].params.arguments).toEqual(params);
  await expect(submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, params, shape, wallet, 41, { fetch: fixtureSession().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "quote_changed" });
  await expect(submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, params, shape, randomUUID(), 40, { fetch: fixtureSession().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "workspace_changed" });
  const poor = fixtureSession({ change: (p) => (p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 1 }] } : undefined) });
  await expect(submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, params, shape, wallet, 40, { fetch: poor.fetch, admit: async () => {} })).rejects.toMatchObject({ code: "insufficient_credits" });
  expect(poor.paid()).toEqual([]);
  const changed = fixtureSession({ create: flatSchema(true) });
  await expect(submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, params, shape, wallet, 40, { fetch: changed.fetch, admit: async () => {} })).rejects.toMatchObject({ code: "contract_unverified" });
  expect(changed.paid()).toEqual([]);
  const refused = fixtureSession();
  await expect(submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, params, shape, wallet, 40, { fetch: refused.fetch, admit: async () => { throw new Error("CLAIMED"); } })).rejects.toThrow("CLAIMED");
  expect(refused.paid()).toEqual([]);
  const vague = fixtureSession({ change: (p) => (p.params.name === "marketing_studio_v2_create" ? { status: "queued", message: "Accepted" } : undefined) });
  expect(await submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, params, shape, wallet, 40, { fetch: vague.fetch, admit: async () => {} })).toMatchObject({ state: "uncertain", raw: { status: "queued" } });
  const lost = fixtureSession({ change: (p) => (p.params.name === "marketing_studio_v2_create" ? new Error("socket closed") : undefined) });
  expect((await submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, params, shape, wallet, 40, { fetch: lost.fetch, admit: async () => {} })).state).toBe("uncertain");
  await expect(submitConsumerMarketingTemplate("fixture-private-access", studio, costs, input, { ...params, prompt: "Other" }, shape, wallet, 40, { fetch: fixtureSession().fetch, admit: async () => {} })).rejects.toMatchObject({ code: "invalid_input" });
});

test("status reads take the identifier argument from the status tool's schema and never call a generating tool", async () => {
  const f = fixtureSession();
  const status = await readConsumerMarketingTemplateJob("fixture-private-access", jobId, wallet, { fetch: f.fetch });
  expect(status).toEqual({ jobId, raw: { job_id: jobId, status: "processing", poll_after_seconds: 20 }, pollAfterSeconds: 20 });
  expect(f.reads().at(-1)).toEqual(["marketing_studio_v2_status", { job_id: jobId }]);
  const byId = fixtureSession({ status: { type: "object", properties: { params: { type: "object", properties: { id: {} } } } } });
  await readConsumerMarketingTemplateJob("fixture-private-access", jobId, wallet, { fetch: byId.fetch });
  expect(byId.reads().at(-1)).toEqual(["marketing_studio_v2_status", { params: { id: jobId } }]);
  await expect(readConsumerMarketingTemplateJob("fixture-private-access", jobId, wallet, { fetch: fixtureSession({ status: null }).fetch })).rejects.toMatchObject({ code: "contract_unverified" });
  await expect(readConsumerMarketingTemplateJob("fixture-private-access", jobId, randomUUID(), { fetch: fixtureSession().fetch })).rejects.toMatchObject({ code: "workspace_changed" });
  await expect(readConsumerMarketingTemplateJob("fixture-private-access", "job-1", wallet, { fetch: fixtureSession().fetch })).rejects.toMatchObject({ code: "invalid_job" });
  expect(f.paid()).toEqual([]);
});
