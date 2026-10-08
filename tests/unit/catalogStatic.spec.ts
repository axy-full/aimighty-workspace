import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildCatalogSnapshot, catalog, catalogSource, gatewayCatalog, staticCatalog, snapshotModels, textCostUsd, textQuoteCostUsd,
  CATALOG_PROVIDER_OF_OWNER, type CatalogModel, type CatalogSnapshot,
} from "../../lib/catalog";
import { directTextCostUsd } from "../../lib/openai-direct";
import { textRequestEstimate } from "../../lib/paidText";
import { ATOMIK_MODEL_IDS } from "../../lib/atomikModelPolicy";
import { ENHANCER_MODELS } from "../../lib/shell/enhancer";
import { DEFAULT_TEXT_MODELS } from "../../lib/platformLayer";
import { ASTRA_BLENDER_MODEL } from "../../lib/astra-blender/scene";
import { OFFERED_CATALOG_IDS, PRICED_TEXT_IDS, SNAPSHOT_CATALOG_IDS, STILL_CATALOG_IDS } from "../../lib/catalogOffered";
import { DROPPED_MODEL_IDS } from "../../lib/modelAliases";
import committedJson from "../../lib/modelCatalog.json";

/*
 * lib/modelCatalog.json freezes the gateway's public /v1/models for the ids we
 * offer (scripts/ops/snapshot-catalog.mjs). Prices feed billing, so the snapshot
 * must price every model a feature can pick, and must serve exactly what the
 * live read serves. The fixture is the verbatim excerpt, for every offered id,
 * of the same saved response the snapshot was written from (2026-10-08):
 * refresh the two together (snapshot-catalog.mjs --from=<saved> --priced-at=<day>).
 */
const committed = committedJson as unknown as CatalogSnapshot;
const fixture = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/gateway-models-2026-10-08.json"), "utf8")) as { data: unknown[] };
const SOURCE = "https://ai-gateway.vercel.sh/v1/models";
const MAX_AGE_DAYS = 120;
/* The live list also carries models we do not offer; the snapshot must drop them. */
const UNOFFERED = [
  { id: "google/veo-3.1-generate-001", type: "video", pricing: { video_duration_pricing: [{ resolution: "1080p", cost_per_second: "0.4" }] } },
  { id: "bfl/flux-2-pro", type: "image", pricing: { image: "0.03" } },
];
const gatewayData = [...fixture.data, ...UNOFFERED];

const ENV_KEYS = ["ENGINE_MOCK", "MODEL_CATALOG", "AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "ATOMIK_MAX_REQUEST_USD", "TEXT_DIRECT", "VERCEL", "VERCEL_OIDC_TOKEN"] as const;
let saved: Record<string, string | undefined> = {};
let realFetch: typeof fetch;
let openAIListed: string[] = [];

test.beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    AI_GATEWAY_API_KEY: "gw-unit-static", OPENAI_API_KEY: "sk-unit-static", ANTHROPIC_API_KEY: "ak-unit-static",
    GEMINI_API_KEY: "gm-unit-static", XAI_API_KEY: "xai-unit-static",
  });
  openAIListed = (fixture.data as { id: string }[]).filter((m) => m.id.startsWith("openai/")).map((m) => m.id.slice("openai/".length));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === SOURCE) return new Response(JSON.stringify({ object: "list", data: gatewayData }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "https://api.openai.com/v1/models") return new Response(JSON.stringify({ data: openAIListed.map((id) => ({ id })) }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const priceOf = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

test("every model a feature can pick has input and output prices and a provider in the snapshot", () => {
  const mustPrice = [...new Set<string>([
    ...ATOMIK_MODEL_IDS, ...Object.values(ENHANCER_MODELS).flat(), ...Object.values(DEFAULT_TEXT_MODELS), ASTRA_BLENDER_MODEL,
  ])];
  expect([...PRICED_TEXT_IDS].sort()).toEqual([...mustPrice].sort());
  const byId = new Map(committed.models.map((m) => [m.id, m]));
  const problems: string[] = [];
  for (const id of mustPrice) {
    const m = byId.get(id);
    if (!m) { problems.push(`${id}: not in the snapshot`); continue; }
    if (m.providerId !== CATALOG_PROVIDER_OF_OWNER[m.owner]) problems.push(`${id}: provider ${m.providerId}`);
    if (m.type !== "language") problems.push(`${id}: type ${m.type}`);
    if (priceOf(m.pricing?.input) == null) problems.push(`${id}: no input price`);
    if (priceOf(m.pricing?.output) == null) problems.push(`${id}: no output price`);
    const quote = textQuoteCostUsd(m, 10_000, 1_000);
    if (quote == null || !(quote > 0)) problems.push(`${id}: no quote`);
  }
  expect(problems).toEqual([]);
  expect(committed.missing.filter((id) => mustPrice.includes(id))).toEqual([]);

  // Already true on the live catalogue, and unchanged by the snapshot: the
  // gateway lists no cached-input price for these, so the direct-OpenAI quote
  // (which must cover a cache read) refuses them. Listed so a refresh that
  // changes the set is seen in review.
  const directUnquoted = mustPrice.filter((id) => {
    const m = byId.get(id);
    return m?.owner === "openai" && textQuoteCostUsd(m, 10_000, 1_000, true) == null;
  });
  // Those were the Pro models and gpt-oss-20b, which no feature offers since
  // 8 October 2026 (lib/modelAliases.ts): every OpenAI model a feature can pick
  // now quotes on the direct key.
  expect(directUnquoted.sort()).toEqual([]);
});

test("the snapshot is dated, covers every offered id, and names a provider for each", () => {
  expect(committed.source).toBe(SOURCE);
  // Offered, plus the dropped ids kept only so old ledger rows keep a price.
  expect([...SNAPSHOT_CATALOG_IDS].sort()).toEqual([...new Set([...OFFERED_CATALOG_IDS, ...DROPPED_MODEL_IDS])].sort());
  for (const id of DROPPED_MODEL_IDS) expect(OFFERED_CATALOG_IDS, id).not.toContain(id);
  expect(committed.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const ids = committed.models.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids, ...committed.missing].sort()).toEqual([...SNAPSHOT_CATALOG_IDS].sort());
  for (const m of committed.models) {
    expect(m.pricedAt, m.id).toBe(committed.pricedAt);
    expect(m.providerId, m.id).toBe(CATALOG_PROVIDER_OF_OWNER[m.owner]);
    expect(m.pricing, m.id).not.toBeNull();
  }
  // Stills are listed too, so their door keeps its catalogue entry.
  expect(STILL_CATALOG_IDS.filter((id) => !ids.includes(id))).toEqual([]);
  expect(snapshotModels().length).toBe(committed.models.length);
});

test(`the snapshot's prices are at most ${MAX_AGE_DAYS} days old`, () => {
  const ageDays = (Date.now() - Date.parse(`${committed.pricedAt}T00:00:00Z`)) / 86_400_000;
  expect(Number.isFinite(ageDays), `pricedAt ${committed.pricedAt} is not a date`).toBe(true);
  expect(ageDays,
    `lib/modelCatalog.json was priced on ${committed.pricedAt}, ${Math.floor(ageDays)} days ago. ` +
    "Run `node scripts/ops/snapshot-catalog.mjs --check`, review every price that changed, then refresh the snapshot " +
    "and tests/fixtures/gateway-models-*.json together.").toBeLessThanOrEqual(MAX_AGE_DAYS);
});

test("the static catalogue serves exactly what the gateway read serves", async () => {
  const live = await gatewayCatalog(true);
  const offered = live.filter((m) => SNAPSHOT_CATALOG_IDS.includes(m.id));
  expect(live.length).toBe(offered.length + UNOFFERED.length);
  // Every priced entry is compared, not a sample.
  expect(offered.map((m) => m.id).sort()).toEqual(committed.models.map((m) => m.id).sort());
  const snapshot = JSON.parse(JSON.stringify(buildCatalogSnapshot(gatewayData, SNAPSHOT_CATALOG_IDS, "2026-10-08", SOURCE))) as CatalogSnapshot;
  const served = staticCatalog(snapshot);
  expect(served).toEqual(offered);
  expect(JSON.stringify(served)).toBe(JSON.stringify(offered));

  // The committed file holds the same entries the live read made of the fixture.
  const committedById = new Map(staticCatalog().map((m) => [m.id, m]));
  for (const m of offered) expect(JSON.stringify(committedById.get(m.id)), m.id).toBe(JSON.stringify(m));

  // And catalog() hands callers the same objects either way.
  const viaGateway = await catalog(true);
  process.env.MODEL_CATALOG = "static";
  const viaStatic = new Map((await catalog(true)).map((m) => [m.id, m]));
  for (const m of viaGateway.filter((x) => SNAPSHOT_CATALOG_IDS.includes(x.id)))
    expect(JSON.stringify(viaStatic.get(m.id)), m.id).toBe(JSON.stringify(m));
});

test("OpenAI models and stills are served on their provider's key; ENGINE_MOCK serves everything", async () => {
  const snapshot = buildCatalogSnapshot(gatewayData, SNAPSHOT_CATALOG_IDS, "2026-10-08", SOURCE);
  const ids = () => new Set(staticCatalog(snapshot).map((m) => m.id));
  expect(ids()).toEqual(new Set(snapshot.models.map((m) => m.id)));
  delete process.env.OPENAI_API_KEY;
  expect([...ids()].filter((id) => id.startsWith("openai/"))).toEqual([]);
  // Stills go direct on their own key; the gateway keeps carrying Gemini and Grok text.
  delete process.env.GEMINI_API_KEY;
  delete process.env.XAI_API_KEY;
  let now = ids();
  for (const id of ["google/gemini-3-pro-image", "google/gemini-3.1-flash-image", "spacexai/grok-imagine-image", "spacexai/grok-imagine-image-2.0"])
    expect(now.has(id), id).toBe(false);
  for (const id of ["google/gemini-3.5-flash", "spacexai/grok-4.7", "anthropic/claude-sonnet-4.6"]) expect(now.has(id), id).toBe(true);
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  expect(staticCatalog(snapshot)).toEqual([]);
  // Under ENGINE_MOCK every entry is served, keys or not, as the live read does.
  process.env.ENGINE_MOCK = "1";
  expect(staticCatalog(snapshot).length).toBe(snapshot.models.length);
  delete process.env.ENGINE_MOCK;

  // An entry whose provider does not match its owner is never served.
  const tampered = JSON.parse(JSON.stringify(snapshot)) as CatalogSnapshot;
  tampered.models[0].providerId = tampered.models[0].providerId === "openai" ? "google" : "openai";
  Object.assign(process.env, { AI_GATEWAY_API_KEY: "gw-unit-static", OPENAI_API_KEY: "sk-unit-static", GEMINI_API_KEY: "gm-unit-static", ANTHROPIC_API_KEY: "ak-unit-static" });
  now = new Set(staticCatalog(tampered).map((m) => m.id));
  expect(now.has(snapshot.models[0].id)).toBe(false);
});

test("with the static catalogue, OpenAI text still needs an id the key can list; OpenAI stills do not", async () => {
  process.env.MODEL_CATALOG = "static";
  delete process.env.AI_GATEWAY_API_KEY;
  process.env.TEXT_DIRECT = "anthropic,xai";
  openAIListed = ["gpt-6-astra"];
  const ids = (await catalog(true)).map((m) => m.id);
  expect(ids.filter((id) => id.startsWith("openai/gpt-6") || id === "openai/gpt-5-mini")).toEqual(["openai/gpt-6-astra"]);
  expect(ids).toContain("openai/gpt-image-2");
  expect(ids).toContain("anthropic/claude-sonnet-4.6");
  expect(ids).toContain("spacexai/grok-4.7");
  expect(ids).not.toContain("google/veo-3.1-generate-001");
});

test("in static mode Claude, Gemini and Grok text is offered where its calls will go: direct needs the key, the gateway needs only the gateway", () => {
  const snapshot = buildCatalogSnapshot(gatewayData, SNAPSHOT_CATALOG_IDS, "2026-10-08", SOURCE);
  const textOf = (owner: string) => snapshot.models.filter((m) => m.owner === owner && !m.outputModalities?.includes("image")).map((m) => m.id);
  const claude = textOf("anthropic"), gemini = textOf("google"), grok = textOf("spacexai");
  expect(claude.length && gemini.length && grok.length).toBeTruthy();
  const offered = (ids: string[]) => { const served = new Set(staticCatalog(snapshot).map((m) => m.id)); return ids.filter((id) => served.has(id)); };
  const gateway = (up: boolean) => { if (up) process.env.AI_GATEWAY_API_KEY = "gw-unit-static"; else delete process.env.AI_GATEWAY_API_KEY; };

  // 1. Direct with key: offered even with the gateway down.
  gateway(false);
  process.env.TEXT_DIRECT = "anthropic";
  expect(offered(claude)).toEqual(claude);

  // 2. Direct without key: hidden, even with the gateway up (the call would not go there).
  gateway(true);
  delete process.env.ANTHROPIC_API_KEY;
  expect(offered(claude)).toEqual([]);

  // 3. Gateway up without key, vendor not direct: offered, exactly as today.
  delete process.env.TEXT_DIRECT;
  expect(offered(claude)).toEqual(claude);
  expect(offered(gemini)).toEqual(gemini);
  expect(offered(grok)).toEqual(grok);

  // 4. Gateway down without direct: hidden, keys or not.
  gateway(false);
  process.env.ANTHROPIC_API_KEY = "ak-unit-static";
  expect(offered([...claude, ...gemini, ...grok])).toEqual([]);

  // Each vendor follows its own route; unknown names in TEXT_DIRECT are ignored.
  process.env.TEXT_DIRECT = " anthropic ,nobody,xai";
  expect(offered(claude)).toEqual(claude);
  expect(offered(grok)).toEqual(grok);
  expect(offered(gemini)).toEqual([]);
});

test("MODEL_CATALOG: only the exact value static reads the snapshot; an unknown value warns once and reads the gateway", () => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    expect(catalogSource()).toBe("gateway");
    for (const value of ["", "gateway"]) {
      process.env.MODEL_CATALOG = value;
      expect(catalogSource()).toBe("gateway");
    }
    process.env.MODEL_CATALOG = "static";
    expect(catalogSource()).toBe("static");
    expect(warnings).toEqual([]);

    for (const value of ["Static", " static", "statik"]) {
      process.env.MODEL_CATALOG = value;
      expect(catalogSource()).toBe("gateway");
      expect(catalogSource()).toBe("gateway");
    }
    expect(warnings.length).toBe(3);
    for (const line of warnings) expect(line).toContain("MODEL_CATALOG");
  } finally {
    console.warn = realWarn;
  }
});

test("textCostUsd and the quote functions give the same numbers on both catalogues", async () => {
  const live = (await gatewayCatalog(true)).filter((m) => m.type === "language" && SNAPSHOT_CATALOG_IDS.includes(m.id));
  const committedById = new Map(staticCatalog().map((m) => [m.id, m]));
  const fromFixture = new Map(staticCatalog(JSON.parse(JSON.stringify(buildCatalogSnapshot(gatewayData, SNAPSHOT_CATALOG_IDS, "2026-10-08", SOURCE)))).map((m) => [m.id, m]));
  expect(live.length).toBeGreaterThan(8);
  const sizes: [number, number][] = [[0, 0], [1, 1], [8_000, 1_800], [199_999, 4_000], [200_000, 4_000], [200_001, 4_000], [271_999, 1_000], [272_000, 1_000], [272_001, 1_000], [1_000_000, 32_000]];
  const numbers = (m: CatalogModel) => sizes.flatMap(([i, o]) => {
    const read = Math.floor(i / 2), write = Math.floor(i / 4);
    const estimate = (() => {
      try { return textRequestEstimate(m, [{ role: "user", content: "x".repeat(Math.min(i, 4_000)) }], Math.max(1, Math.min(o, 4_000)), true); }
      catch (e) { return `refused: ${(e as Error).message}`; }
    })();
    return [
      textCostUsd(m, i, o),
      textCostUsd(m, i, o, { cacheReadTokens: read, cacheWriteTokens: write }),
      textQuoteCostUsd(m, i, o, false),
      textQuoteCostUsd(m, i, o, true),
      directTextCostUsd(m, { prompt_tokens: i, completion_tokens: o, prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } }),
      directTextCostUsd(m, { prompt_tokens: i, completion_tokens: o }),
      estimate,
    ];
  });
  let priced = 0;
  for (const m of live) {
    const expected = numbers(m);
    priced += expected.filter((n) => typeof n === "number").length;
    expect(numbers(fromFixture.get(m.id)!), m.id).toEqual(expected);
    expect(numbers(committedById.get(m.id)!), m.id).toEqual(expected);
  }
  expect(priced).toBeGreaterThan(live.length * sizes.length); // the comparison is over real prices, not nulls
});
