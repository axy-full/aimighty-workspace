import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  consumerMarketingTemplateAcknowledgement,
  consumerMarketingTemplateFailureResult,
  consumerMarketingTemplateOriginalResult,
  consumerMarketingTemplateParams,
  listMarketingTemplates,
  marketingTemplateArgumentShape,
  parseMarketingTemplateCatalogue,
  parseMarketingTemplateCosts,
  parseMarketingTemplatePage,
  priceForTemplate,
  templateOutputKind,
} from "../../lib/higgsfield-consumer/marketing-templates";

const fixture = JSON.parse(readFileSync("tests/fixtures/marketing-templates.json", "utf8"));
const merged = { items: fixture.pages.flatMap((page: { presets: unknown[] }) => page.presets), total: 6, complete: true };
const jobId = "40bcf565-b2c7-4c2a-81ca-bcf5e1d9e061";

test("the presets feed parses page by page into bounded typed templates with provider names removed", () => {
  const first = parseMarketingTemplatePage(fixture.pages[0]);
  expect(first).toMatchObject({ total: 6, next: "page-2", hasMore: null });
  expect(first.items).toHaveLength(3);
  expect(parseMarketingTemplatePage(fixture.pages[1]).next).toBeNull();
  expect(parseMarketingTemplatePage([{ id: "x" }]).items).toHaveLength(1);
  const catalogue = parseMarketingTemplateCatalogue(merged, 1000);
  expect(catalogue.templates).toHaveLength(6);
  expect(catalogue).toMatchObject({ total: 6, complete: true, fetchedAt: 1000 });
  const unboxing = catalogue.templates[0];
  expect(unboxing).toEqual({ id: "tpl_ugc_unboxing_01", name: "UGC unboxing", category: "ugc", description: "A creator unboxes the product on camera.",
    previewUrl: "https://previews.example.test/tpl_ugc_unboxing_01.jpg", outputKind: "video", inputs: ["product_image"], credits: null });
  expect(JSON.stringify(catalogue).toLowerCase()).not.toContain("higgsfield");
  // Nested preview objects and inline prices are read; insecure previews are dropped.
  expect(catalogue.templates[2].previewUrl).toBe("https://previews.example.test/tpl_motion_loop.jpg");
  expect(catalogue.templates[3].credits).toBe(120);
  expect(catalogue.templates[4].previewUrl).toBeNull();
  // Output kind: declared first, then the category heuristic.
  expect(catalogue.templates.map(templateOutputKind)).toEqual(["video", "image", "video", "video", "image", "image"]);
});

test("search and category filters narrow the catalogue without a provider call", () => {
  const catalogue = parseMarketingTemplateCatalogue(merged);
  expect(listMarketingTemplates(catalogue, { category: "ugc" }).map((t) => t.id)).toEqual(["tpl_ugc_unboxing_01"]);
  expect(listMarketingTemplates(catalogue, { category: "all", search: "poster" }).map((t) => t.id)).toEqual(["tpl_poster_launch"]);
  expect(listMarketingTemplates(catalogue, { search: "PRODUCT" })).toHaveLength(3);
});

test("the versioned cost table prices by template id, then category, then default, then the feed's inline price", () => {
  const costs = parseMarketingTemplateCosts(fixture.costs, 5);
  expect(costs).toEqual({ version: "2026-09-18", fetchedAt: 5, entries: [{ key: "tpl_product_shot_studio", credits: 40 }, { key: "ugc", credits: 75 }, { key: "default", credits: 30 }] });
  const catalogue = parseMarketingTemplateCatalogue(merged);
  const [unboxing, studio, motion, hero] = catalogue.templates;
  expect(priceForTemplate(costs, studio)).toEqual({ credits: 40, source: "cost_table" });
  expect(priceForTemplate(costs, unboxing)).toEqual({ credits: 75, source: "cost_table" });
  expect(priceForTemplate(costs, motion)).toEqual({ credits: 30, source: "cost_table" });
  const noDefault = parseMarketingTemplateCosts({ version: 3, prices: { tpl_ads_hero: { credits: 90, credits_exact: 90 } } });
  expect(noDefault.version).toBe("3");
  expect(priceForTemplate(noDefault, hero)).toEqual({ credits: 90, source: "cost_table" });
  expect(priceForTemplate(noDefault, motion)).toBeNull();
  expect(priceForTemplate(null, hero)).toEqual({ credits: 120, source: "catalogue" });
  // A flat record document is also a table; conflicting exact amounts fail closed.
  expect(parseMarketingTemplateCosts({ version: "v1", ugc: 12, ads: { credits: 8 } }).entries).toEqual([{ key: "ugc", credits: 12 }, { key: "ads", credits: 8 }]);
  expect(() => parseMarketingTemplateCosts({ costs: [{ id: "a", credits: 10, credits_exact: 11 }] })).toThrow(/cost table/);
  expect(() => parseMarketingTemplateCosts({ costs: [{ id: "a", credits: -1 }] })).toThrow(/cost table/);
});

test("malformed feeds fail closed instead of relaxing the contract", () => {
  for (const bad of [null, { presets: "x" }, { presets: [], next_cursor: {} }, { presets: [], has_more: "yes" }, { presets: [], total: -1 }])
    expect(() => parseMarketingTemplatePage(bad)).toThrow(/template catalogue/);
  for (const items of [[{ name: "no id" }], [{ id: "a" }, { id: "a" }], [{ id: "../x" }], [{ id: "a", inputs: [1] }], [{ id: "a", credits: "10" }], [{ id: "a", name: 4 }], ["a"]])
    expect(() => parseMarketingTemplateCatalogue({ items, total: null, complete: true })).toThrow(/template catalogue/);
  expect(() => parseMarketingTemplateCatalogue({ items: [], total: null })).toThrow(/template catalogue/);
  expect(() => parseMarketingTemplateCatalogue({ items: [{ id: "a" }], complete: true }, 0)).toThrow(/template catalogue/);
});

test("create arguments carry only the validated inputs and are checked against the advertised schema before any call", () => {
  const media = "8a3c1f26-4d5e-4c1a-9b2d-0f1e2d3c4b5a";
  const params = consumerMarketingTemplateParams({ presetId: "tpl_product_shot_studio", prompt: "A plain bottle.", brandName: "Our bottle", productImage: { uploadId: "still" } }, media);
  expect(params).toEqual({ preset_id: "tpl_product_shot_studio", prompt: "A plain bottle.", brand_name: "Our bottle", product_image: media });
  expect(consumerMarketingTemplateParams({ presetId: "tpl_ads_hero", prompt: "  " }, null)).toEqual({ preset_id: "tpl_ads_hero" });
  expect(() => consumerMarketingTemplateParams({ presetId: "tpl_ads_hero", prompt: "" }, media)).toThrow();
  expect(() => consumerMarketingTemplateParams({ presetId: "tpl_ads_hero", prompt: "", productImage: { uploadId: "still" } }, "not-a-uuid")).toThrow();
  const sent = Object.keys(params);
  expect(marketingTemplateArgumentShape({ type: "object", properties: { preset_id: {}, prompt: {}, brand_name: {}, product_image: {}, get_cost: {} }, required: ["preset_id"] }, sent)).toEqual({ nested: false, getCost: true });
  expect(marketingTemplateArgumentShape({ type: "object", properties: { params: { type: "object", properties: { preset_id: {}, prompt: {}, brand_name: {}, product_image: {} } } } }, sent)).toEqual({ nested: true, getCost: false });
  // Undeclared arguments, or declared required arguments we do not send, leave the contract unverified.
  expect(marketingTemplateArgumentShape({ type: "object", properties: { preset_id: {}, prompt: {} } }, sent)).toBeNull();
  expect(marketingTemplateArgumentShape({ type: "object", properties: { preset_id: {}, prompt: {}, brand_name: {}, product_image: {}, workspace_id: {} }, required: ["workspace_id"] }, sent)).toBeNull();
  expect(marketingTemplateArgumentShape(undefined, sent)).toBeNull();
});

test("only one structured job UUID is acceptance; status envelopes qualify exactly the acknowledged job", () => {
  expect(consumerMarketingTemplateAcknowledgement({ job_id: jobId })).toBe(jobId);
  expect(consumerMarketingTemplateAcknowledgement({ results: [{ id: jobId, status: "pending" }] })).toBe(jobId);
  expect(consumerMarketingTemplateAcknowledgement({ raw_data: { id: jobId.toUpperCase(), status: "queued" } })).toBe(jobId);
  expect(consumerMarketingTemplateAcknowledgement({ id: jobId, job_id: "11111111-1111-4111-8111-111111111111" })).toBeNull();
  expect(consumerMarketingTemplateAcknowledgement({ results: [{ id: jobId }, { id: jobId }] })).toBeNull();
  expect(consumerMarketingTemplateAcknowledgement({ message: `Accepted ${jobId}` })).toBeNull();
  expect(consumerMarketingTemplateAcknowledgement({ id: "job-1" })).toBeNull();
  const url = "https://media.example.test/original.png";
  expect(consumerMarketingTemplateOriginalResult({ id: jobId, status: "completed", result_url: url }, jobId)).toEqual({ url });
  expect(consumerMarketingTemplateOriginalResult({ raw_data: { id: jobId, status: "completed", result_url: url } }, jobId)).toEqual({ url });
  expect(consumerMarketingTemplateOriginalResult({ generation: { id: jobId, status: "completed", results: { rawUrl: url } } }, jobId)).toEqual({ url });
  expect(consumerMarketingTemplateOriginalResult({ status: "completed", result_url: url }, jobId)).toEqual({ url });
  expect(consumerMarketingTemplateOriginalResult({ id: "11111111-1111-4111-8111-111111111111", status: "completed", result_url: url }, jobId)).toBeNull();
  expect(consumerMarketingTemplateOriginalResult({ id: jobId, status: "completed", result_url: "http://media.example.test/x.png" }, jobId)).toBeNull();
  expect(consumerMarketingTemplateOriginalResult({ id: jobId, status: "completed", thumbnail_url: url }, jobId)).toBeNull();
  expect(consumerMarketingTemplateOriginalResult({ id: jobId, status: "processing", result_url: url }, jobId)).toBeNull();
  expect(consumerMarketingTemplateFailureResult({ id: jobId, status: "failed" }, jobId)).toBe("failed");
  expect(consumerMarketingTemplateFailureResult({ id: jobId, status: "processing" }, jobId)).toBeNull();
  expect(consumerMarketingTemplateFailureResult({ id: "11111111-1111-4111-8111-111111111111", status: "failed" }, jobId)).toBeNull();
});
