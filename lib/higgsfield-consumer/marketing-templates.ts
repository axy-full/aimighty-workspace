/**
 * Marketing Studio v2 template catalogue on the connected account (PR G).
 *
 * Pure module shared by the browser and the server: parses the read-only
 * `marketing_studio_v2_presets` feed and the versioned
 * `marketing_studio_v2_costs` document into bounded typed records, prices a
 * template from the cost table, validates the "create with template" input and
 * qualifies create acknowledgements and status envelopes.
 *
 * Contract evidence (19 September 2026): the presets read is advertised with
 * `{category,size}` (category tabs all · ugc · product-shot · motion · ads ·
 * posters · marketplace), the account returned 986 presets, and the costs read
 * returned a versioned pricing document. The item and cost *key names* below are
 * not captured from a live response: the parser accepts the spellings this
 * provider uses on its sibling tools (ids/names/previews/descriptions,
 * `next_cursor` pagination, `credits`/`credits_exact` pricing) and fails closed
 * on anything else. No paid run has qualified the create/status envelopes.
 */
import { z } from "zod";
import { consumerMediaIdentitySchema } from "./genjutsu-contract";
import { ConsumerVideoError, connectedListEntry } from "./video-contract";

export const MARKETING_TEMPLATE_CATEGORIES = ["all", "ugc", "product-shot", "motion", "ads", "posters", "marketplace"] as const;
export type MarketingTemplateCategory = (typeof MARKETING_TEMPLATE_CATEGORIES)[number];
export const MARKETING_TEMPLATE_PAGE_SIZE = 100;
/** 986 presets were observed; ten full pages plus headroom, never unbounded. */
export const MARKETING_TEMPLATE_PAGES = 12;
export const MARKETING_TEMPLATE_TTL_MS = 3_600_000;
export const MARKETING_TEMPLATE_LIMITS = {
  templates: 1200,
  inputs: 16,
  costs: 2000,
  text: 200,
  description: 2000,
  url: 2048,
  prompt: 2000,
  jsonBytes: 2_097_152,
} as const;
export const MARKETING_TEMPLATE_TOOLS = {
  presets: "marketing_studio_v2_presets",
  costs: "marketing_studio_v2_costs",
  create: "marketing_studio_v2_create",
  status: "marketing_studio_v2_status",
} as const;
export const TEMPLATE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const PROVIDER_NAME = /\bhiggsfield\b/gi;

export type MarketingTemplateOutputKind = "image" | "video";
export type MarketingTemplate = {
  id: string;
  /** Display name with provider names removed. */
  name: string;
  category: string;
  description: string;
  previewUrl: string | null;
  /** Declared by the preset when present; otherwise derived per category. */
  outputKind: MarketingTemplateOutputKind | null;
  /** Input names the preset declares (product/brand fields), when it does. */
  inputs: string[];
  /** Inline credit price when the feed carries one; the cost table wins. */
  credits: number | null;
};
export type MarketingTemplateCatalogue = {
  templates: MarketingTemplate[];
  /** The provider's declared total when it reports one. */
  total: number | null;
  /** False when the provider reported more pages than were read. */
  complete: boolean;
  fetchedAt: number;
};
export type MarketingTemplateCostEntry = { key: string; credits: number };
export type MarketingTemplateCosts = {
  version: string | null;
  entries: MarketingTemplateCostEntry[];
  fetchedAt: number;
};

export type MarketingTemplateErrorCode =
  | "invalid_catalogue"
  | "invalid_costs"
  | "template_unknown"
  | "price_unknown"
  | "contract_unverified";
export class MarketingTemplateError extends Error {
  readonly status: number;
  constructor(
    readonly code: MarketingTemplateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketingTemplateError";
    this.status = code === "template_unknown" ? 400 : code === "price_unknown" ? 409 : 502;
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalidCatalogue = (): never => {
  throw new MarketingTemplateError("invalid_catalogue", "The connected account returned an unusable template catalogue.");
};
const invalidCosts = (): never => {
  throw new MarketingTemplateError("invalid_costs", "The connected account returned an unusable template cost table.");
};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function text(value: unknown, max: number, fail: () => never): string {
  if (typeof value !== "string" || value.length > max) return fail();
  return value.replace(/\p{Cc}/gu, "").trim();
}
/** Product copy never names the provider; catalogue names are shown without it. */
export function templateDisplayName(value: string) {
  return value.replace(PROVIDER_NAME, "").replace(/\s{2,}/g, " ").trim();
}
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MARKETING_TEMPLATE_LIMITS.url) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.toString() : null;
  } catch {
    return null;
  }
}
const first = (record: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
};
const ITEM_KEYS = ["presets", "items", "templates"] as const;
const ID_KEYS = ["id", "preset_id"] as const;
const NAME_KEYS = ["name", "title"] as const;
const PREVIEW_KEYS = ["preview_url", "preview", "thumbnail_url", "thumbnail", "image_url", "cover_url"] as const;
const KIND_KEYS = ["output_type", "type", "media_type", "kind"] as const;
const PRICE_KEYS = ["credits", "cost", "price"] as const;
const TOTAL_KEYS = ["total", "count", "total_count"] as const;
export const NEXT_CURSOR_KEYS = ["next_cursor", "cursor", "next_page_token"] as const;
const VIDEO_CATEGORIES = new Set(["ugc", "motion", "ads"]);

function templateItem(value: unknown, seen: Set<string>): MarketingTemplate {
  if (!object(value)) return invalidCatalogue();
  const id = text(first(value, ID_KEYS), 120, invalidCatalogue);
  if (!TEMPLATE_ID.test(id) || seen.has(id)) return invalidCatalogue();
  seen.add(id);
  const name = templateDisplayName(text(first(value, NAME_KEYS) ?? id, MARKETING_TEMPLATE_LIMITS.text, invalidCatalogue)) || id;
  const category = text(value.category ?? "", MARKETING_TEMPLATE_LIMITS.text, invalidCatalogue).toLowerCase();
  const description = templateDisplayName(
    value.description === undefined ? "" : text(value.description, MARKETING_TEMPLATE_LIMITS.description, invalidCatalogue),
  );
  const preview = first(value, PREVIEW_KEYS);
  const previewUrl = object(preview) ? httpsUrl(preview.url) : httpsUrl(preview);
  const rawKind = first(value, KIND_KEYS);
  const kind = typeof rawKind === "string" ? rawKind.toLowerCase() : "";
  const outputKind: MarketingTemplateOutputKind | null = kind === "image" || kind === "video" ? kind : null;
  const declared = value.inputs;
  const inputs: string[] = [];
  if (declared !== undefined) {
    if (!Array.isArray(declared) || declared.length > MARKETING_TEMPLATE_LIMITS.inputs) return invalidCatalogue();
    for (const entry of declared) {
      const input = typeof entry === "string" ? entry : object(entry) ? first(entry, ["name", "key", "id"]) : undefined;
      if (typeof input !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input)) return invalidCatalogue();
      inputs.push(input);
    }
  }
  const price = first(value, PRICE_KEYS);
  const credits = price === undefined ? null : finite(price) && price > 0 && price <= Number.MAX_SAFE_INTEGER ? price : invalidCatalogue();
  return { id, name, category, description, previewUrl, outputKind, inputs, credits };
}
/** One page of the presets feed: its items and, when present, the next cursor. */
export function parseMarketingTemplatePage(raw: unknown): { items: unknown[]; total: number | null; next: string | number | null; hasMore: boolean | null } {
  const list = Array.isArray(raw) ? raw : object(raw) ? first(raw, ITEM_KEYS) : undefined;
  if (!Array.isArray(list) || list.length > MARKETING_TEMPLATE_LIMITS.templates) return invalidCatalogue();
  if (!object(raw)) return { items: list, total: null, next: null, hasMore: null };
  const total = first(raw, TOTAL_KEYS);
  if (total !== undefined && (!finite(total) || total < 0 || !Number.isInteger(total))) return invalidCatalogue();
  const cursor = first(raw, NEXT_CURSOR_KEYS);
  let next: string | number | null = null;
  if (cursor !== undefined) {
    if (typeof cursor === "string") {
      if (!/^[\x21-\x7e]{1,4096}$/.test(cursor)) return invalidCatalogue();
      next = cursor;
    } else if (finite(cursor) && cursor >= 0 && Number.isInteger(cursor)) next = cursor;
    else return invalidCatalogue();
  }
  const hasMore = raw.has_more === undefined ? null : typeof raw.has_more === "boolean" ? raw.has_more : invalidCatalogue();
  return { items: list, total: total === undefined ? null : total, next, hasMore };
}
/** The merged read (every page's items) parsed into bounded typed templates. */
export function parseMarketingTemplateCatalogue(
  raw: unknown,
  fetchedAt = Date.now(),
): MarketingTemplateCatalogue {
  if (!object(raw) || !Array.isArray(raw.items) || raw.items.length > MARKETING_TEMPLATE_LIMITS.templates) return invalidCatalogue();
  if (raw.total !== null && raw.total !== undefined && (!finite(raw.total) || raw.total < 0)) return invalidCatalogue();
  if (typeof raw.complete !== "boolean") return invalidCatalogue();
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) return invalidCatalogue();
  const seen = new Set<string>();
  return {
    templates: raw.items.map((item) => templateItem(item, seen)),
    total: raw.total === undefined || raw.total === null ? null : (raw.total as number),
    complete: raw.complete,
    fetchedAt,
  };
}
const VERSION_KEYS = ["version", "pricing_version", "costs_version"] as const;
const COST_LIST_KEYS = ["costs", "prices", "pricing", "items", "presets"] as const;
const COST_KEY_KEYS = ["preset_id", "id", "key", "category", "name"] as const;
function creditsOf(value: unknown): number | null {
  if (finite(value)) return value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : invalidCosts();
  if (!object(value)) return null;
  const credits = first(value, PRICE_KEYS);
  if (credits === undefined) return null;
  if (!finite(credits) || credits <= 0 || credits > Number.MAX_SAFE_INTEGER) return invalidCosts();
  // Rounded and exact billing amounts must agree, as with generation quotes.
  if (value.credits_exact !== undefined && value.credits_exact !== credits) return invalidCosts();
  return credits;
}
/** The versioned pricing document as a flat key → credits table. */
export function parseMarketingTemplateCosts(raw: unknown, fetchedAt = Date.now()): MarketingTemplateCosts {
  if (!object(raw)) return invalidCosts();
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) return invalidCosts();
  const rawVersion = first(raw, VERSION_KEYS);
  const version =
    rawVersion === undefined ? null : finite(rawVersion) ? String(rawVersion) : text(rawVersion, MARKETING_TEMPLATE_LIMITS.text, invalidCosts);
  const listed = first(raw, COST_LIST_KEYS);
  const entries: MarketingTemplateCostEntry[] = [];
  const seen = new Set<string>();
  const add = (rawKey: unknown, credits: number | null) => {
    if (credits === null) return;
    const key = text(rawKey, 120, invalidCosts).toLowerCase();
    if (!key || seen.has(key)) return invalidCosts();
    seen.add(key);
    entries.push({ key, credits });
    if (entries.length > MARKETING_TEMPLATE_LIMITS.costs) return invalidCosts();
  };
  if (Array.isArray(listed)) {
    if (listed.length > MARKETING_TEMPLATE_LIMITS.costs) return invalidCosts();
    for (const entry of listed) {
      if (!object(entry)) return invalidCosts();
      add(first(entry, COST_KEY_KEYS), creditsOf(entry));
    }
  } else {
    const table = object(listed) ? listed : raw;
    const keys = Object.keys(table);
    if (keys.length > MARKETING_TEMPLATE_LIMITS.costs) return invalidCosts();
    for (const key of keys) {
      if ((VERSION_KEYS as readonly string[]).includes(key) && table === raw) continue;
      add(key, creditsOf(table[key]));
    }
  }
  return { version, entries, fetchedAt };
}
/** Cost table first (by template id, then category, then a default entry),
 * the feed's inline price last. Null means the template cannot be priced. */
export function priceForTemplate(costs: MarketingTemplateCosts | null, template: MarketingTemplate): { credits: number; source: "cost_table" | "catalogue" } | null {
  if (costs) {
    const lookup = (key: string) => costs.entries.find((entry) => entry.key === key.toLowerCase())?.credits;
    for (const key of [template.id, template.category, "default", "*"]) {
      const credits = key ? lookup(key) : undefined;
      if (credits !== undefined) return { credits, source: "cost_table" };
    }
  }
  return template.credits === null ? null : { credits: template.credits, source: "catalogue" };
}
export function findMarketingTemplate(catalogue: MarketingTemplateCatalogue, id: string) {
  return catalogue.templates.find((template) => template.id === id) ?? null;
}
export function listMarketingTemplates(
  catalogue: MarketingTemplateCatalogue,
  options: { category?: string; search?: string } = {},
) {
  const category = options.category && options.category !== "all" ? options.category.toLowerCase() : null;
  const search = options.search?.trim().toLowerCase() ?? "";
  return catalogue.templates.filter(
    (template) =>
      (!category || template.category === category) &&
      (!search || `${template.name} ${template.description} ${template.category}`.toLowerCase().includes(search)),
  );
}
export function templateOutputKind(template: Pick<MarketingTemplate, "category" | "outputKind">): MarketingTemplateOutputKind {
  return template.outputKind ?? (VIDEO_CATEGORIES.has(template.category) ? "video" : "image");
}

/* ── Create with template ─────────────────────────────────────────────── */
export const consumerMarketingTemplateInputSchema = z
  .object({
    presetId: z.string().regex(TEMPLATE_ID),
    /** Product or brand description sent with the template. */
    prompt: z.string().max(MARKETING_TEMPLATE_LIMITS.prompt),
    brandName: z.string().max(120).optional(),
    /** One project original (upload or completed generation) as the product image. */
    productImage: consumerMediaIdentitySchema.optional(),
  })
  .strict();
export type ConsumerMarketingTemplateInput = z.infer<typeof consumerMarketingTemplateInputSchema>;
export function parseConsumerMarketingTemplateInput(value: unknown): ConsumerMarketingTemplateInput {
  const parsed = consumerMarketingTemplateInputSchema.safeParse(value);
  if (!parsed.success) throw new ConsumerVideoError("invalid_input");
  return parsed.data;
}
/** Provider arguments for `marketing_studio_v2_create`. The argument names are
 * checked against the tool's advertised input schema before any call. */
export type ConsumerMarketingTemplateParams = { preset_id: string; prompt?: string; brand_name?: string; product_image?: string };
export function consumerMarketingTemplateParams(input: ConsumerMarketingTemplateInput, productMediaId: string | null): ConsumerMarketingTemplateParams {
  const checked = parseConsumerMarketingTemplateInput(input);
  if (Boolean(checked.productImage) !== (productMediaId !== null)) throw new ConsumerVideoError("invalid_input");
  if (productMediaId !== null && !z.uuid().safeParse(productMediaId).success) throw new ConsumerVideoError("invalid_input");
  return {
    preset_id: checked.presetId,
    ...(checked.prompt.trim() ? { prompt: checked.prompt } : {}),
    ...(checked.brandName?.trim() ? { brand_name: checked.brandName } : {}),
    ...(productMediaId !== null ? { product_image: productMediaId.toLowerCase() } : {}),
  };
}
/** Where a tool's advertised schema declares our argument names: at the top
 * level or nested under `params`. Null when the contract cannot be verified. */
export function marketingTemplateArgumentShape(
  inputSchema: unknown,
  sent: readonly string[],
): { nested: boolean; getCost: boolean } | null {
  if (!object(inputSchema)) return null;
  const level = (schema: Record<string, unknown>) => {
    const properties = object(schema.properties) ? schema.properties : null;
    if (!properties) return null;
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
    if (!sent.every((key) => key in properties)) return null;
    if (required.some((key) => !sent.includes(key))) return null;
    return { getCost: "get_cost" in properties };
  };
  const top = level(inputSchema);
  if (top) return { nested: false, ...top };
  const properties = object(inputSchema.properties) ? inputSchema.properties : null;
  const params = properties && object(properties.params) ? properties.params : null;
  const nested = params ? level(params) : null;
  return nested ? { nested: true, ...nested } : null;
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const ACK_ID_KEYS = ["id", "job_id", "jobId", "job_set_id"] as const;
/** Exactly one structured job UUID is acceptance; prose, batches and
 * conflicting identifiers are not. */
export function consumerMarketingTemplateAcknowledgement(value: unknown): string | null {
  if (!object(value)) return null;
  const ids: string[] = [];
  let invalid = false;
  const add = (id: unknown) => {
    if (!uuid(id)) invalid = true;
    else ids.push(id.toLowerCase());
  };
  const entry = (item: unknown) => {
    if (typeof item === "string") return add(item);
    if (!object(item)) { invalid = true; return; }
    const keys = ACK_ID_KEYS.filter((key) => key in item);
    if (!keys.length) { invalid = true; return; }
    for (const key of keys) add(item[key]);
  };
  for (const key of ACK_ID_KEYS) if (key in value) add(value[key]);
  for (const key of ["jobs", "job_ids", "results"]) {
    if (!(key in value)) continue;
    const list = value[key];
    if (!Array.isArray(list) || list.length !== 1) invalid = true;
    else entry(list[0]);
  }
  if (object(value.raw_data)) entry(value.raw_data);
  if (object(value.generation)) entry(value.generation);
  return !invalid && new Set(ids).size === 1 ? ids[0] : null;
}
const FAILED = new Set(["failed", "canceled", "cancelled", "nsfw", "ip_detected", "error"]);
/**
 * The status envelope for exactly the acknowledged job. Nothing else is
 * evidence; unknown envelopes stay diagnostic.
 *
 * `marketing_studio_v2_status` is NOT advertised by the connection in use on
 * 20 September 2026 (the profile offers `show_marketing_studio_v2` and
 * `show_marketing_studio_generations` and none of the four
 * `marketing_studio_v2_*` tools), so its reply has never been observed and the
 * single-object keys below — `raw_data`, `generation` — remain the unverified
 * guesses this module was written with. What IS recorded, read-only and free,
 * is that every job envelope this provider does send nests the job in a
 * top-level ARRAY: `job_display` on a real completed `marketing_studio_video`
 * job returns `{"results":[{id,type,status,model,params,results:{rawUrl},
 * createdAt}]}`, and `show_marketing_studio_generations` returns that same
 * per-entry shape under `items`. So the list shape is searched too, bound to
 * the acknowledged id (`connectedListEntry`, video-contract.ts), rather than
 * guessing which of the two the status tool will use. Both are tolerated; one
 * of them is certainly what arrives.
 */
function statusEvidence(value: unknown, jobId: string): { status: string; body: Record<string, unknown> } | null {
  if (!object(value)) return null;
  const listed = connectedListEntry(value, jobId, ACK_ID_KEYS);
  const body = object(value.raw_data) ? value.raw_data : object(value.generation) ? value.generation : listed ?? value;
  // A listed entry is already bound by the exact acknowledged id; any other
  // body has to be bound through the acknowledgement, as before.
  if (body !== listed) {
    const found = consumerMarketingTemplateAcknowledgement(value);
    if (found !== null && found !== jobId) return null;
    if (found === null && ACK_ID_KEYS.some((key) => key in body)) return null;
  }
  const status = body.status ?? value.status;
  if (typeof status !== "string" || status.length > 64) return null;
  if (typeof value.status === "string" && value.status !== status) return null;
  return { status: status.toLowerCase(), body };
}
export function consumerMarketingTemplateOriginalResult(value: unknown, jobId: string): { url: string } | null {
  const evidence = statusEvidence(value, jobId);
  if (!evidence || evidence.status !== "completed") return null;
  const { body } = evidence;
  const candidates = [body.result_url, object(body.results) ? body.results.rawUrl : undefined, object(body.results) ? body.results.url : undefined];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const url = httpsUrl(candidate);
    return url && !new URL(url).hash ? { url } : null;
  }
  return null;
}
export function consumerMarketingTemplateFailureResult(value: unknown, jobId: string): string | null {
  const evidence = statusEvidence(value, jobId);
  if (!evidence || !FAILED.has(evidence.status)) return null;
  return evidence.status;
}
export function consumerMarketingTemplatePollAfter(value: unknown): number | undefined {
  if (!object(value)) return undefined;
  const wait = value.poll_after_seconds;
  if (wait === undefined) return undefined;
  if (!finite(wait) || wait < 0 || wait > 3600) throw new ConsumerVideoError("invalid_job");
  return Math.max(1, Math.ceil(wait));
}
