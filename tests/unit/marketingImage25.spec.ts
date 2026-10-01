import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { StillRenderRequest } from "../../lib/engines/types";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-marketing-25-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-marketing-25-secret-unit-test-keyring";
const presetId = "067e9e94-0bea-4acd-b82a-071a264d8e26";
const requestId = "217e9e94-0bea-4acd-b82a-071a264d8e26";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const originalFetch = globalThis.fetch;
test.beforeEach(() => {
  process.env.ENGINE_MOCK = "0";
  process.env.HF_CREDENTIALS = "marketing-25-test:secret-test";
  globalThis.fetch = async () => {
    throw new Error("Unexpected external request");
  };
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.ENGINE_MOCK = "0";
});
function workspace(name: string, patch: Partial<TenantWorkspace> = {}): TenantWorkspace {
  return {
    id: `ws_${name}`, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null,
    suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 8, rendersPerHour: null, storageQuotaBytes: null,
    deletedAt: null, ...patch,
  };
}
type Settings = NonNullable<StillRenderRequest["marketing"]>;
async function request(marketing: Settings, size = "2k"): Promise<StillRenderRequest> {
  const { getModel, MARKETING_IMAGE_MODEL_ID } = await import("../../lib/models");
  const { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  return {
    kind: "image", genId: "gen_marketing_25", model: getModel(MARKETING_IMAGE_MODEL_ID), prompt: "A product on a studio plinth",
    ratio: "3:4", size, references: [], marketing, higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(),
  };
}
/** The approximate quote for a request with no references, as admission prices it. */
async function quoteOf(req: StillRenderRequest): Promise<number> {
  const { marketing25Usd, marketingInput, marketingSettings } = await import("../../lib/higgsfieldMarketing");
  return marketing25Usd(marketingInput(req.prompt, req.ratio, req.size, marketingSettings(req.marketing), []));
}

test("the 2.5 builds add extra-high and max, keep quality with a preset, and each has its own route; 2.0 Alpha is unchanged", async () => {
  const { marketingSettings, marketingPath, marketingInput } = await import("../../lib/higgsfieldMarketing");
  // A take saved before the 2.5 builds names none: it is 2.0 Alpha.
  expect(marketingSettings(undefined).variant).toBeUndefined();
  expect(marketingPath(marketingSettings(undefined))).toBe("marketing-studio/image");
  expect(marketingPath(marketingSettings({ variant: "alpha" }))).toBe("marketing-studio/image");
  expect(marketingPath(marketingSettings({ variant: "flare" }))).toBe("marketing-studio/image/flare");
  expect(marketingPath(marketingSettings({ variant: "sunburst" }))).toBe("marketing-studio/image/sunburst");
  for (const quality of ["xhigh", "max"]) {
    expect(() => marketingSettings({ quality })).toThrow(/2\.5 builds only/);
    expect(() => marketingSettings({ variant: "alpha", quality })).toThrow(/2\.5 builds only/);
    expect(marketingSettings({ variant: "flare", quality }).quality).toBe(quality);
    expect(marketingSettings({ variant: "sunburst", quality }).quality).toBe(quality);
  }
  // 2.0 enhancement runs at high only; a 2.5 build keeps the quality chosen.
  expect(() => marketingSettings({ enhancePrompt: true, presetId, quality: "low" })).toThrow(/high quality/);
  expect(marketingSettings({ variant: "sunburst", enhancePrompt: true, presetId, quality: "low" })).toMatchObject({ quality: "low", enhancePrompt: true });
  expect(() => marketingSettings({ variant: "flare", enhancePrompt: true })).toThrow(/requires a preset/);
  expect(() => marketingSettings({ variant: "flare", presetId })).toThrow(/requires a preset/);
  expect(() => marketingSettings({ variant: "gold" })).toThrow();
  // The body is the same shape on every build: the build is the route, never a body field.
  expect(marketingInput("A product", "3:4", "4k", marketingSettings({ variant: "flare", quality: "max" }), [])).toEqual({
    prompt: "A product", image_urls: [], quality: "max", moderation: "auto", resolution: "4k", aspect_ratio: "3:4", enhance_prompt: false,
  });
});

test("a 2.5 quote is approximate: the published per-token rates on the request, with no provider read; 2.0 Alpha still reads its live estimate", async () => {
  const { estimateMarketingInput, marketingInput, marketingSettings, marketing25Usd } = await import("../../lib/higgsfieldMarketing");
  const { MARKETING_IMAGE_25_TOKEN_USD: rate } = await import("../../lib/vendorRates");
  const refs = ["https://image.example/a.png", "https://image.example/b.png"];
  const input = (settings: Record<string, unknown>, size = "2k", images: string[] = []) =>
    marketingInput("A".repeat(400), "1:1", size, marketingSettings({ variant: "flare", ...settings }), images);
  // A 400-character prompt is about 100 text tokens in; high quality is about 6,000 image tokens a megapixel out.
  const high = await estimateMarketingInput(input({ quality: "high" }), "flare");
  expect(high).toBeCloseTo(100 * rate.textIn + Math.ceil(6_000 * 4.194304) * rate.imageOut, 12);
  // Sunburst is priced by the same published text.
  expect(await estimateMarketingInput(input({ quality: "high" }), "sunburst")).toBe(high);
  // More quality, more pixels, more money.
  const byQuality = await Promise.all(["low", "medium", "high", "xhigh", "max"].map(quality => estimateMarketingInput(input({ quality }), "flare")));
  expect([...byQuality].sort((a, b) => a - b)).toEqual(byQuality);
  expect(new Set(byQuality).size).toBe(5);
  const bySize = await Promise.all(["1k", "2k", "4k"].map(size => estimateMarketingInput(input({ quality: "high" }, size), "flare")));
  expect(bySize[0]).toBeLessThan(bySize[1]);
  expect(bySize[1]).toBeLessThan(bySize[2]);
  // Each reference image is image tokens in; a preset's prompt rewrite is text in and out.
  expect(marketing25Usd(input({ quality: "high" }, "2k", refs)) - high).toBeCloseTo(2 * 2_000 * rate.imageIn, 12);
  const plain = marketing25Usd(input({ quality: "high" }, "2k", refs.slice(0, 1)));
  const enhanced = marketing25Usd(input({ quality: "high", enhancePrompt: true, presetId }, "2k", refs.slice(0, 1)));
  expect(enhanced - plain).toBeCloseTo(1_000 * rate.textIn + 1_000 * rate.textOut, 12);
  // The delivered image's own pixels replace the tier's.
  expect(marketing25Usd(input({ quality: "high" }), 1.5)).toBeCloseTo(100 * rate.textIn + 9_000 * rate.imageOut, 12);
  // 2.0 Alpha: the provider's live figure for exactly this input, on its own route.
  const alpha = marketingInput("A product", "3:4", "2k", marketingSettings({ quality: "medium" }), []);
  const reads: string[] = [];
  globalThis.fetch = async (url) => {
    reads.push(String(url));
    return Response.json({ usd: "0.345", credits: "9999" });
  };
  expect(await estimateMarketingInput(alpha)).toBe(0.345);
  expect(await estimateMarketingInput(input({ quality: "max" }), "sunburst")).toBeGreaterThan(0);
  expect(reads).toEqual(["https://api.higgsfield.ai/estimate/marketing-studio/image"]);
});

test("a 2.5 take settles at the provider's stated charge or the delivered image's figure, only within a sane band of the quote", async () => {
  const { marketing25SettlementUsd } = await import("../../lib/higgsfieldMarketing");
  expect(marketing25SettlementUsd(1, 0.9)).toBe(0.9);
  expect(marketing25SettlementUsd(1, 2.5)).toBe(2.5);
  expect(marketing25SettlementUsd(1, 0.5)).toBe(0.5);
  expect(marketing25SettlementUsd(1, 3)).toBe(3);
  expect(marketing25SettlementUsd(1, 0.9, 1.2)).toBe(1.2);
  expect(marketing25SettlementUsd(1, 0.9, 40)).toBe(0.9);
  for (const wrong of [0.49, 3.01, 1e6, 0, -1, Number.NaN, Infinity, null])
    expect(marketing25SettlementUsd(1, wrong as number | null), String(wrong)).toBe(1);
});

test("a 403 is an insufficient balance: neutral on the platform's key with a platform log, plain on a workspace's own key; a 401 is still access", async () => {
  const { estimateMarketingInput, marketingInput, marketingSettings, MarketingError } = await import("../../lib/higgsfieldMarketing");
  const { runInTenant } = await import("../../lib/tenant");
  const input = marketingInput("A product", "3:4", "2k", marketingSettings({}), []);
  globalThis.fetch = async () => new Response("PRIVATE BALANCE DETAIL", { status: 403 });
  const warnings: string[] = [], warn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    await runInTenant(workspace("m25_own_key", { keys: { higgsfield: "own-key:own-secret" } }), async () => {
      const error = await estimateMarketingInput(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MarketingError);
      expect(error).toMatchObject({
        message: "The connected account's API balance is too low for this request. Top it up, then try again. Nothing was submitted.",
        status: 503, code: "insufficient_balance",
      });
    });
    expect(warnings).toEqual([]);
    await runInTenant(workspace("m25_platform_key", { legacy: false, usesPlatformKeys: true }), async () => {
      const error = await estimateMarketingInput(input).catch((e: unknown) => e);
      expect(error).toMatchObject({ message: "This engine is unavailable right now; try again shortly. Nothing was submitted.", status: 503, code: "provider_unavailable" });
      expect(String((error as Error).message)).not.toMatch(/balance|PRIVATE/);
    });
    expect(warnings.map(w => JSON.parse(w))).toEqual([expect.objectContaining({ event: "higgsfield.insufficient_balance", surface: "marketing-studio" })]);
  } finally { console.warn = warn; }
  globalThis.fetch = async () => new Response("PRIVATE CREDENTIAL", { status: 401 });
  await expect(estimateMarketingInput(input)).rejects.toThrow("This connected account cannot access Marketing Studio.");
});

test("a 2.5 take re-prices from the same formula before its sole POST, sends it to its build's route and never reads the estimate", async () => {
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const { higgsfieldSubmissionRejected, HiggsfieldHttpError } = await import("../../lib/higgsfield");
  const req = await request({ variant: "flare", quality: "xhigh", enhancePrompt: false });
  req.higgsfieldVendorCostUsd = await quoteOf(req);
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({ quality: "xhigh", moderation: "auto", enhance_prompt: false, image_urls: [] });
      return Response.json({ request_id: requestId, status_url: statusUrl });
    }
    return Response.json({ request_id: requestId, status: "completed", images: [{ url: "https://images.higgs.ai/master.png" }] });
  };
  const out = await higgsfield.render(req);
  if (!("handle" in out)) throw new Error("missing handle");
  expect(out.handle).toMatchObject({ model: req.model.id, ref: requestId });
  expect((await higgsfield.poll!(out.handle)).status).toBe("succeeded");
  expect(calls).toEqual(["POST https://api.higgsfield.ai/marketing-studio/image/flare", `GET ${statusUrl}`]);
  // A kept quote that no longer matches the formula, or none, never submits.
  let submits = 0;
  globalThis.fetch = async () => { submits++; return Response.json({}); };
  for (const usd of [req.higgsfieldVendorCostUsd * 1.01, 0, undefined]) {
    const error = await higgsfield.render({ ...req, higgsfieldVendorCostUsd: usd }).catch((e: unknown) => e);
    expect(higgsfieldSubmissionRejected(error)).toBe(true);
  }
  expect(submits).toBe(0);
  // A 403 on the paid POST is an insufficient balance: not accepted, so its reservation is released.
  globalThis.fetch = async () => new Response("PRIVATE BALANCE DETAIL", { status: 403 });
  const refused = await higgsfield.render(req).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(HiggsfieldHttpError);
  expect(higgsfieldSubmissionRejected(refused)).toBe(true);
  expect((refused as Error).message).toBe("The connected account's API balance is too low for this request. Top it up, then try again. The request was not accepted.");
});

test("a collected 2.5 take settles on the delivered image within the band, a stated charge wins, and 2.0 Alpha keeps its live estimate", async () => {
  process.env.ENGINE_MOCK = "1";
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { loadJob, produce, reconcileHiggsfieldImage } = await import("../../lib/renderWork");
  const { getGeneration } = await import("../../lib/jobs");
  const { engineFor } = await import("../../lib/engines");
  const { fixtureUrl } = await import("../../lib/mock");
  const { marketing25Usd, marketingInput, marketingSettings } = await import("../../lib/higgsfieldMarketing");
  const engine = engineFor("higgsfield"), poll = engine.poll, fetchMaster = engine.fetchMaster;
  const png = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 40, g: 80, b: 120 } } }).png().toBuffer();
  const made: string[] = [];
  async function take(name: string, marketing: Settings, size: string, delivered: [number, number], statedUsd?: number) {
    const genId = `gen_m25_${name}_${path.basename(dir)}`;
    made.push(genId);
    return runInTenant(workspace(`m25_settle_${name}`), async () => {
      await ready();
      const req = await request(marketing, size);
      const quoteUsd = (marketing.variant ?? "alpha") === "alpha" ? 0.25 : await quoteOf(req);
      const params = { marketing, higgsfieldCredentialFingerprint: req.higgsfieldCredentialFingerprint, higgsfieldVendorCostUsd: quoteUsd,
        ratio: req.ratio, resolution: size, references: [] };
      await db().execute({
        sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','higgsfield',?,?,?,'running',?,?)",
        args: [genId, req.model.id, req.prompt, JSON.stringify(params), Date.now(), Date.now()],
      });
      engine.poll = async () => { throw new Error("Temporary poll failure"); };
      expect(await produce((await loadJob(genId))!)).toBeNull();
      engine.poll = async () => ({ status: "succeeded", videoUrl: null, imageUrl: fixtureUrl("still.png"), totalTokens: null, error: null,
        vendorStartedAt: null, vendorEndedAt: null, raw: {}, ...(statedUsd == null ? {} : { costUsd: statedUsd }) });
      const bytes = await png(...delivered);
      engine.fetchMaster = async () => bytes;
      await reconcileHiggsfieldImage(genId);
      const generation = (await getGeneration(genId))!;
      expect(generation.status).toBe("succeeded");
      const meter = (await platformDb().execute({ sql: "SELECT engine_cost_usd FROM meter_events WHERE id=?", args: [genId] })).rows[0];
      expect(Number(meter.engine_cost_usd)).toBe(generation.costUsd);
      const deliveredUsd = marketing25Usd(marketingInput(req.prompt, req.ratio, size, marketingSettings(marketing), []), (delivered[0] * delivered[1]) / 1e6);
      return { quoteUsd, settledUsd: generation.costUsd, deliveredUsd };
    });
  }
  try {
    // Larger than the quoted tier, within the band: it settles on what was delivered.
    const larger = await take("larger", { variant: "flare", quality: "high", enhancePrompt: false }, "1k", [1536, 1024]);
    expect(larger.settledUsd).toBeCloseTo(larger.deliveredUsd, 12);
    expect(larger.settledUsd).toBeGreaterThan(larger.quoteUsd);
    // A charge the provider states for the job wins while it is sane; one far off is ignored.
    const sunburst: Settings = { variant: "sunburst", quality: "medium", enhancePrompt: false };
    const sunburstQuote = await quoteOf(await request(sunburst, "2k"));
    const stated = await take("stated", sunburst, "2k", [1536, 2048], sunburstQuote * 1.1);
    expect(stated.settledUsd).toBeCloseTo(sunburstQuote * 1.1, 12);
    const statedWrong = await take("stated_wrong", sunburst, "2k", [1536, 2048], sunburstQuote * 40);
    expect(statedWrong.settledUsd).toBeCloseTo(statedWrong.deliveredUsd, 12);
    expect(statedWrong.settledUsd).toBeLessThan(sunburstQuote);
    // A delivered image far off its tier reads as a measurement mistake: the quote stands.
    const tiny = await take("tiny", { variant: "flare", quality: "high", enhancePrompt: false }, "2k", [256, 256]);
    expect(tiny.settledUsd).toBe(tiny.quoteUsd);
    // 2.0 Alpha settles at its live estimate, whatever was delivered.
    const alpha = await take("alpha", { quality: "high", enhancePrompt: false }, "2k", [1536, 1024]);
    expect(alpha.settledUsd).toBe(0.25);
  } finally {
    engine.poll = poll;
    engine.fetchMaster = fetchMaster;
    await Promise.all(made.map(id => unlink(path.join(process.cwd(), ".data", "generations", `${id}.png`)).catch(() => {})));
  }
});

test("the pricing watch covers both 2.5 builds on their own routes; 2.0 Alpha is priced live and never watched", async () => {
  // The watch itself is covered in higgsfieldPricingWatch.spec.ts.
  const { MARKETING_25_PRICING_WATCH } = await import("../../lib/higgsfieldMarketing");
  expect(Object.keys(MARKETING_25_PRICING_WATCH).sort()).toEqual(["flare", "sunburst"]);
  expect(MARKETING_25_PRICING_WATCH.flare).toMatchObject({ model: "higgsfield/marketing-studio-image:flare", path: "marketing-studio/image/flare" });
  expect(MARKETING_25_PRICING_WATCH.sunburst).toMatchObject({ model: "higgsfield/marketing-studio-image:sunburst", path: "marketing-studio/image/sunburst" });
  for (const watch of Object.values(MARKETING_25_PRICING_WATCH)) {
    expect(watch.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(watch.body).toEqual({ prompt: expect.any(String) });
  }
});
