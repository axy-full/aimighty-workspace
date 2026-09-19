import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readExplainerPresets, CONSUMER_MCP_URL } from "../../lib/higgsfield-consumer/mcp";
import { EXPLAINER_MODELS, explainerModelsListed, parseExplainerPresets } from "../../lib/higgsfield-consumer/explainer-presets";
import { parseConnectedCatalogue } from "../../lib/higgsfield-consumer/catalogue";

const capture = JSON.parse(readFileSync("tests/fixtures/connected-explainer-presets.json", "utf8")) as { tool: { name: string; inputSchema: Record<string, unknown> }; response: { items: Record<string, unknown>[] } };
type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
const bell = String.fromCharCode(7);

test("explainer styles keep only id, title and aspect; preview media and provider prompt text are dropped", () => {
  const parsed = parseExplainerPresets(capture.response, 5);
  expect(parsed).toEqual({ fetchedAt: 5, presets: [
    { id: "56fc6472-33b7-45dc-83ff-80c71d40aec6", title: "Editorial Motion Graphics", aspect: "9:16" },
    { id: "237dd06c-3729-4895-9672-1c623c4266e0", title: "Stickman Cartoon", aspect: "9:16" },
    { id: "b347d852-98fc-4013-92b7-6b0219fb21be", title: "Whiteboard Doodle", aspect: "9:16" },
  ] });
  expect(JSON.stringify(parsed)).not.toMatch(/example\.com|Create an explainer/);
  // Malformed entries are skipped; a malformed listing fails closed.
  expect(parseExplainerPresets({ items: [{ id: "x" }, { id: "56fc6472-33b7-45dc-83ff-80c71d40aec6", title: `A${bell}`, aspect: "4:3" }, { id: "56FC6472-33B7-45DC-83FF-80C71D40AEC6" }] }, 1).presets)
    .toEqual([{ id: "56fc6472-33b7-45dc-83ff-80c71d40aec6", title: "A", aspect: null }]);
  for (const bad of [null, {}, { items: "x" }, { items: Array.from({ length: 201 }, () => ({})) }]) expect(() => parseExplainerPresets(bad)).toThrow();
});

test("the captured connected catalogue lists no explainer job, so explainer generation has no price path", () => {
  const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8")), 1);
  expect([...EXPLAINER_MODELS]).toEqual(["video_explainer", "explainer_video"]);
  expect(explainerModelsListed(catalogue)).toEqual([]);
  expect(explainerModelsListed({ models: [{ id: "video_explainer" }] })).toEqual(["video_explainer"]);
});

test("the explainer listing calls only get_explainer_presets with no arguments, never resolve or a generating tool", async () => {
  const calls: Packet[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: p.params.name === "get_explainer_presets" ? capture.response : {} } });
  };
  const listing = await readExplainerPresets("fixture-private-access", { fetch: fetcher });
  expect(listing.presets).toHaveLength(3);
  expect(calls.filter((p) => p.method === "tools/call").map((p) => p.params)).toEqual([{ name: "get_explainer_presets", arguments: {} }]);
  const broken: typeof fetch = async (url, init) => {
    const p = JSON.parse(String(init?.body)) as Packet;
    if (p.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: { items: "nope" } } });
    return fetcher(url, init);
  };
  await expect(readExplainerPresets("fixture-private-access", { fetch: broken })).rejects.toMatchObject({ code: "preflight_unavailable" });
});
