import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";
import type { CatalogModel } from "../../lib/catalog";

/**
 * Direct text is billed from the provider's usage and the price snapshot
 * (P4b PR 3), for every direct door: Anthropic, Google and xAI as OpenAI
 * already was. Each call here goes to a stubbed fetch; the keys are fixtures
 * and never leave the process.
 */
const dir = mkdtempSync(path.join(tmpdir(), "paid-text-direct-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
delete process.env.PLATFORM_ALLOWANCE_USD;

const KEYS = { ANTHROPIC_API_KEY: "test-anthropic-key-never-sent", GEMINI_API_KEY: "test-gemini-key-never-sent", XAI_API_KEY: "test-xai-key-never-sent", AI_GATEWAY_API_KEY: "test-gateway-key-never-sent" };
const ENV = ["ENGINE_MOCK", "TEXT_DIRECT", "OPENAI_API_KEY", "MODEL_CATALOG", "REFINE_PROVIDER", "PROMPT_MODELS", "GATEWAY_PROMPT_MODELS", "ANTHROPIC_AUTH_TOKEN", ...Object.keys(KEYS)] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const realFetch = globalThis.fetch;
test.beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  Object.assign(process.env, KEYS);
  globalThis.fetch = async () => { throw new Error("No real provider call is allowed in this test."); };
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
});

const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } };

/** The checked-in snapshot entry, as the catalogue serves it. */
async function snapshot(id: string): Promise<CatalogModel> {
  const { snapshotModels } = await import("../../lib/catalog");
  const found = snapshotModels().find((model) => model.id === id);
  if (!found) throw new Error(`${id} is not in the snapshot`);
  const { providerId, ...model } = found;
  void providerId;
  return model;
}

/* Provider replies, as each API sends them. */
const anthropicReply = { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 25 } };
const googleReply = { candidates: [{ content: { parts: [{ text: '{"ok":true}' }], role: "model" }, finishReason: "STOP", index: 0 }],
  usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 50, cachedContentTokenCount: 120, totalTokenCount: 280 }, modelVersion: "gemini-2.5-flash", responseId: "resp_google_fixture" };
const xaiReply = { id: "resp_xai_fixture", object: "response", created_at: 1, model: "grok-4.6", status: "completed",
  output: [{ type: "message", id: "msg_xai_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }],
  usage: { input_tokens: 150, input_tokens_details: { cached_tokens: 100 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 190, cost_in_usd_ticks: 12345 } };

/**
 * One row per direct vendor: a snapshot model, its provider's reply, and what
 * that reply costs at the snapshot, worked by hand.
 */
const VENDORS = [
  { vendor: "anthropic", model: "anthropic/claude-sonnet-4.6", origin: "https://api.anthropic.com", reply: anthropicReply,
    refusal: { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "Fixture." } } },
    // 100 uncached × $3/M + 60 cache reads × $0.30/M + 40 cache writes × $3.75/M + 25 out × $15/M
    usd: 100 * 0.000003 + 60 * 0.0000003 + 40 * 0.00000375 + 25 * 0.000015 },
  { vendor: "google", model: "google/gemini-2.5-flash", origin: "https://generativelanguage.googleapis.com", reply: googleReply,
    refusal: { status: 400, body: { error: { code: 400, message: "Fixture.", status: "INVALID_ARGUMENT" } } },
    // 80 uncached × $0.30/M + 120 cache reads × $0.03/M + (30 answer + 50 thought) out × $2.50/M
    usd: 80 * 0.0000003 + 120 * 0.00000003 + 80 * 0.0000025 },
  { vendor: "xai", model: "spacexai/grok-4.6", origin: "https://api.x.ai", reply: xaiReply,
    refusal: { status: 403, body: { code: "forbidden", error: "Fixture." } },
    // 50 uncached × $2/M + 100 cache reads × $0.50/M + 40 out (reasoning included) × $6/M, first context tier
    usd: 50 * 0.000002 + 100 * 0.0000005 + 40 * 0.000006 },
] as const;

function stub(origin: string, reply: () => Response) {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => {
    urls.push(String(url));
    expect(new URL(String(url)).origin).toBe(origin);
    return reply();
  };
  return { urls, fetch };
}

let seq = 0;
async function inWorkspace(fn: (ws: string) => Promise<void>) {
  const ws = `ws_ptd_${++seq}`;
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`],
  });
  await grantCredits(ws, 1000, "Test", "owner", "manual");
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws] })).rows[0]);
  await runInTenant(row, async () => { await ready(); await fn(ws); }, OWNER);
}

async function state(ws: string, id: string) {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const job = (await db().execute({ sql: "SELECT * FROM paid_text_jobs WHERE id=?", args: [id] })).rows[0];
  const spend = (await db().execute({ sql: "SELECT * FROM atomik_spend WHERE id=?", args: [id] })).rows[0];
  const meter = (await platformDb().execute({ sql: "SELECT * FROM meter_events WHERE workspace_id=? AND id=?", args: [ws, id] })).rows[0];
  return { job, spend, meter };
}
async function balance(ws: string) {
  const { billingStateFor } = await import("../../lib/billingLedger");
  return (await billingStateFor(ws)).credits.balance;
}
async function age(id: string) {
  const { db } = await import("../../lib/db");
  await db().execute({ sql: "UPDATE paid_text_jobs SET updated_at=updated_at-?, created_at=created_at-? WHERE id=?", args: [31 * 60_000, 31 * 60_000, id] });
}
const request = (model: string, id: string) => ({ id, model, messages: [{ role: "user", content: "A lone tree in steady rain." }], maxTokens: 600, kind: "idea", createdBy: "owner" });
/** The production transport: the router, on the stubbed fetch. */
const through = (fetch: typeof globalThis.fetch) => async (req: { body: string; auth?: Record<string, string> }) => {
  const { textPost } = await import("../../lib/textDirect");
  return textPost(req.body, { auth: req.auth, fetch });
};

/* ── The arithmetic, per vendor ─────────────────────────────────────── */

for (const row of VENDORS) test(`${row.vendor}: the provider's raw usage settles at tokens × the snapshot price, cache and thought tokens included, never above the quote`, async () => {
  const { directTextUsage } = await import("../../lib/textDirect");
  const { directTextCostUsd } = await import("../../lib/openai-direct");
  const { textQuoteCostUsd } = await import("../../lib/catalog");
  const model = await snapshot(row.model);
  const raw = row.vendor === "anthropic" ? anthropicReply.usage : row.vendor === "google" ? googleReply.usageMetadata : xaiReply.usage;
  const usage = directTextUsage(row.vendor, { raw });
  expect(directTextCostUsd(model, usage)).toBeCloseTo(row.usd, 15);

  /* The quote is the most a call can cost: every split of its input into fresh, cached and newly cached
     tokens, and any output up to the ceiling, settles at or under it. */
  const inTokens = 4000, outTokens = 600;
  const quote = textQuoteCostUsd(model, inTokens, outTokens, true)!;
  expect(quote).toBeGreaterThan(0);
  const writes = row.vendor === "anthropic";
  for (const [read, write] of [[0, 0], [inTokens, 0], [0, writes ? inTokens : 0], [1000, writes ? 3000 : 0], [2000, writes ? 1000 : 0]])
    for (const out of [0, 1, outTokens]) {
      const cost = directTextCostUsd(model, { prompt_tokens: inTokens, completion_tokens: out, prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } });
      expect(cost, `${read}/${write}/${out}`).not.toBeNull();
      expect(cost!).toBeLessThanOrEqual(quote + 1e-15);
    }
  // Anthropic's cold cache write (1.25×) is inside the quote: higher than ordinary input alone.
  if (writes) expect(quote).toBeGreaterThan(textQuoteCostUsd(model, inTokens, outTokens, false)!);
});

test("a cache the snapshot has no price for is unpriced: no quote, and a call that used it is never billed at 0", async () => {
  const { directTextCostUsd } = await import("../../lib/openai-direct");
  const { textQuoteCostUsd } = await import("../../lib/catalog");
  for (const row of VENDORS) {
    const full = await snapshot(row.model);
    const pricing = { ...full.pricing } as Record<string, unknown>;
    for (const key of Object.keys(pricing)) if (key.startsWith("input_cache_read")) delete pricing[key];
    const noRead = { ...full, pricing };
    // The vendor bills cache reads, so the snapshot cannot set a ceiling without their price.
    expect(textQuoteCostUsd(noRead, 1000, 100, true), row.vendor).toBeNull();
    // Settled: a call that read from the cache cannot be priced; one that did not is priced as usual.
    expect(directTextCostUsd(noRead, { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } }), row.vendor).toBeNull();
    // A cache count the vendor did not report stays unknown, never zero.
    expect(directTextCostUsd(full, { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: {} }), row.vendor).toBeNull();
    expect(directTextCostUsd(full, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }), row.vendor).toBeNull();
  }
  const claude = await snapshot("anthropic/claude-sonnet-4.6");
  const pricing = { ...claude.pricing } as Record<string, unknown>;
  delete pricing.input_cache_write;
  expect(textQuoteCostUsd({ ...claude, pricing }, 1000, 100, true)).toBeNull();
  expect(directTextCostUsd({ ...claude, pricing }, { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 40 } })).toBeNull();
});

test("the meter engine and the ledger are the vendor for a direct door, the gateway's otherwise", async () => {
  const { textEngine, textKeyName, isDirectText } = await import("../../lib/openai-direct");
  for (const row of VENDORS) {
    expect(textEngine(row.model)).toBe("vercel");
    expect(isDirectText(row.model)).toBe(false);
  }
  process.env.TEXT_DIRECT = "anthropic,google,xai";
  for (const row of VENDORS) {
    expect(textEngine(row.model)).toBe(row.vendor);
    expect(isDirectText(row.model)).toBe(true);
  }
  expect(textKeyName("anthropic/claude-sonnet-4.6")).toBe("anthropic");
  expect(textKeyName("google/gemini-2.5-flash")).toBe("gemini");
  expect(textKeyName("spacexai/grok-4.6")).toBe("xai");
  process.env.OPENAI_API_KEY = "test-openai-key-never-sent";
  expect(textEngine("openai/gpt-5-mini")).toBe("openai");
});

/* ── The money path, end to end, per vendor ─────────────────────────── */

for (const row of VENDORS) test(`${row.vendor}: paid text quotes, reserves, sends once and settles at usage × snapshot on the vendor's ledger`, async () => {
  process.env.TEXT_DIRECT = "anthropic,google,xai";
  await inWorkspace(async (ws) => {
    const { runPaidText, quotePaidText } = await import("../../lib/paidText");
    const { billCredits } = await import("../../lib/creditTerms");
    const model = await snapshot(row.model);
    const before = await balance(ws);
    const quote = await quotePaidText(request(row.model, "q"), model);
    const transport = stub(row.origin, () => Response.json(row.reply));
    const id = `direct_${row.vendor}`;
    const result = await runPaidText(request(row.model, id), { model, submit: through(transport.fetch) });
    expect(transport.urls).toHaveLength(1);
    expect(result.costUsd).toBeCloseTo(row.usd, 15);
    expect(result.engine).toBe(row.vendor);
    expect(quote.estimateUsd!).toBeGreaterThanOrEqual(result.costUsd);
    const { job, spend, meter } = await state(ws, id);
    expect(job).toMatchObject({ status: "succeeded" });
    expect(Number(job.cost_usd)).toBeCloseTo(row.usd, 15);
    // The price the call was approved at travels with the job.
    expect(JSON.parse(String(job.request_body)).pricingModel.pricing).toEqual(model.pricing);
    expect(meter).toMatchObject({ engine: row.vendor, status: "succeeded", paid_by_platform: 1, billed_credits: billCredits(row.usd, "text") });
    expect(Number(meter.engine_cost_usd)).toBeCloseTo(row.usd, 15);
    expect(spend).toMatchObject({ ledger: row.vendor });
    expect(Number(spend.cost_usd)).toBeCloseTo(row.usd, 15);
    expect(result.credits).toBe(billCredits(row.usd, "text"));
    expect(await balance(ws)).toBe(before - billCredits(row.usd, "text"));
  });
});

for (const row of VENDORS) test(`${row.vendor}: usage above the estimate is held for review: the answer is saved, the estimate stays charged, nothing is refunded or replayed`, async () => {
  process.env.TEXT_DIRECT = "anthropic,google,xai";
  await inWorkspace(async (ws) => {
    const { runPaidText, reconcilePaidTextJobs } = await import("../../lib/paidText");
    const { billCredits } = await import("../../lib/creditTerms");
    const model = await snapshot(row.model);
    const id = `over_${row.vendor}`;
    let calls = 0;
    const submit = async () => { calls++; return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "A paid answer." } }],
      usage: { prompt_tokens: 900_000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }) }; };
    await expect(runPaidText(request(row.model, id), { model, submit })).rejects.toThrow("retained for review");
    await expect(runPaidText(request(row.model, id), { model, submit })).rejects.toThrow("already has a paid claim");
    expect(calls).toBe(1);
    const { job, meter } = await state(ws, id);
    expect(job.status).toBe("uncertain");
    expect(String(job.response_json)).toContain("A paid answer.");
    expect(job.cost_usd).toBe(job.estimate_usd);
    expect(meter).toMatchObject({ engine: row.vendor, status: "failed", billed_credits: billCredits(Number(job.estimate_usd), "text") });
    // Held, not refunded: the cron's pass leaves a job with a saved answer for review.
    await age(id);
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 0 });
  });
});

/* Today's direct rule for a reply without usage (lib/paidText.ts): a readable reply is saved and its estimate held for
   review; a reply the provider's SDK cannot read (xAI's requires its counts) is an uncertain call at its estimate,
   refunded by the cron's pass like any other. Either way it is never billed at 0 and never sent again. */
for (const row of VENDORS) test(`${row.vendor}: missing usage keeps today's direct rule: the estimate is held, never billed at 0`, async () => {
  process.env.TEXT_DIRECT = "anthropic,google,xai";
  await inWorkspace(async (ws) => {
    const { runPaidText } = await import("../../lib/paidText");
    const model = await snapshot(row.model);
    // The provider's reply with its usage counts taken out.
    const reply = row.vendor === "anthropic" ? { ...anthropicReply, usage: { input_tokens: 100, output_tokens: 25 } }
      : row.vendor === "google" ? { ...googleReply, usageMetadata: { promptTokenCount: 200, totalTokenCount: 280 } }
      : { ...xaiReply, usage: { input_tokens: 150, total_tokens: 190 } };
    const transport = stub(row.origin, () => Response.json(reply));
    const id = `missing_${row.vendor}`;
    const unreadable = row.vendor === "xai";
    await expect(runPaidText(request(row.model, id), { model, submit: through(transport.fetch) })).rejects.toThrow(unreadable ? "interrupted after submission" : "retained for review");
    await expect(runPaidText(request(row.model, id), { model, submit: through(transport.fetch) })).rejects.toThrow("already has a paid claim");
    expect(transport.urls).toHaveLength(1);
    const { job, meter } = await state(ws, id);
    expect(job.status).toBe("uncertain");
    if (unreadable) expect(job.response_json).toBeNull(); else expect(job.response_json).not.toBeNull();
    expect(job.cost_usd).toBe(job.estimate_usd);
    expect(meter).toMatchObject({ engine: row.vendor, status: "failed" });
    expect(Number(meter.engine_cost_usd)).toBe(Number(job.estimate_usd));
  });
});

for (const row of VENDORS) test(`${row.vendor}: a provider refusal (4xx) settles at 0 credits and is never retried`, async () => {
  process.env.TEXT_DIRECT = "anthropic,google,xai";
  await inWorkspace(async (ws) => {
    const { runPaidText } = await import("../../lib/paidText");
    const model = await snapshot(row.model);
    const before = await balance(ws);
    const transport = stub(row.origin, () => Response.json(row.refusal.body, { status: row.refusal.status }));
    const id = `refused_${row.vendor}`;
    await expect(runPaidText(request(row.model, id), { model, submit: through(transport.fetch) })).rejects.toThrow(`declined this request (${row.refusal.status})`);
    expect(transport.urls).toHaveLength(1);
    const { job, spend, meter } = await state(ws, id);
    expect(job).toMatchObject({ status: "failed", cost_usd: 0 });
    expect(spend).toMatchObject({ cost_usd: 0, ledger: row.vendor });
    expect(meter).toMatchObject({ engine: row.vendor, status: "failed", engine_cost_usd: 0, billed_credits: 0 });
    expect(await balance(ws)).toBe(before);
  });
});

for (const row of VENDORS) test(`${row.vendor}: a call lost after sending is uncertain at its estimate, then refunded once by reconcilePaidTextJobs`, async () => {
  process.env.TEXT_DIRECT = "anthropic,google,xai";
  await inWorkspace(async (ws) => {
    const { runPaidText, reconcilePaidTextJobs } = await import("../../lib/paidText");
    const model = await snapshot(row.model);
    const before = await balance(ws);
    let sent = 0;
    const lost: typeof globalThis.fetch = async () => { sent++; throw new TypeError("fetch failed"); };
    const id = `lost_${row.vendor}`;
    await expect(runPaidText(request(row.model, id), { model, submit: through(lost) })).rejects.toThrow("interrupted after submission");
    expect(sent).toBe(1);
    let { job, meter } = await state(ws, id);
    expect(job.status).toBe("uncertain");
    expect(job.response_json).toBeNull();
    expect(meter).toMatchObject({ engine: row.vendor, status: "failed" });
    expect(Number(meter.billed_credits)).toBeGreaterThan(0);
    expect(await balance(ws)).toBe(before - Number(meter.billed_credits));
    await age(id);
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 1, released: 0, failed: 0 });
    ({ job, meter } = await state(ws, id));
    expect(job.status).toBe("refunded");
    expect(meter).toMatchObject({ engine: row.vendor, status: "failed", billed_credits: 0 });
    expect(await balance(ws)).toBe(before);
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 0 });
  });
});

/* ── Adding ANTHROPIC_API_KEY alone changes nothing ─────────────────── */

test("ANTHROPIC_API_KEY set with TEXT_DIRECT empty: paid text, the meter, the ledger and the writer are exactly as without it", async () => {
  type Sent = { url: string; body: string; auth: string | null };
  const run = async (withKey: boolean) => {
    if (withKey) process.env.ANTHROPIC_API_KEY = KEYS.ANTHROPIC_API_KEY; else delete process.env.ANTHROPIC_API_KEY;
    const sent: Sent[] = [];
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), body: String(init?.body), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ choices: [{ message: { content: "A lone tree in steady rain.\nCAMERA: static" } }], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0004 } });
    };
    let out: Record<string, unknown> = {};
    await inWorkspace(async (ws) => {
      const { runPaidText } = await import("../../lib/paidText");
      const { refineProvider, activeWriter, enhancePrompt } = await import("../../lib/enhance");
      const { PROVIDERS, providerConfigured, providerVia } = await import("../../lib/providers");
      const { ENGINES } = await import("../../lib/engines");
      const { textEngine, textVendor } = await import("../../lib/openai-direct");
      const model = await snapshot("anthropic/claude-sonnet-4.6");
      const id = `text_same_${withKey}`;
      const result = await runPaidText(request(model.id, id), { model });
      const { meter, spend } = await state(ws, id);
      const anthropic = PROVIDERS.find((p) => p.id === "anthropic")!;
      const writer = await activeWriter();
      const refined = await enhancePrompt({ prompt: "A tree in rain.", citations: [], provider: "gateway" });
      out = { cost: result.costUsd, engine: result.engine, meterEngine: meter.engine, credits: meter.billed_credits, ledger: spend.ledger,
        route: textVendor(model.id), textEngine: textEngine(model.id), refineProvider: refineProvider(), writer,
        refined: { ...refined }, configured: providerConfigured(anthropic), via: providerVia(anthropic), adapter: ENGINES.anthropic.configured() };
    });
    return { sent, out };
  };
  const without = await run(false);
  const withKey = await run(true);
  expect(withKey).toEqual(without);
  expect(without.out).toMatchObject({ cost: 0.0004, engine: "vercel", meterEngine: "vercel", ledger: "vercel", route: "gateway", refineProvider: "gateway",
    writer: { provider: "gateway", model: "anthropic/claude-sonnet-5", via: "Model gateway (API key)", configured: true }, refined: { ledger: "vercel", costUsd: 0.0004 }, configured: false, via: null, adapter: false });
  // Both calls went to the gateway, on the gateway's key.
  expect(without.sent.map((s) => [new URL(s.url).host, s.auth])).toEqual([["ai-gateway.vercel.sh", `Bearer ${KEYS.AI_GATEWAY_API_KEY}`], ["ai-gateway.vercel.sh", `Bearer ${KEYS.AI_GATEWAY_API_KEY}`]]);
});

test("the writer's model list is PROMPT_MODELS, still reading GATEWAY_PROMPT_MODELS; the legacy Claude call only when REFINE_PROVIDER forces it", async () => {
  const { PROMPT_MODELS, refineProvider } = await import("../../lib/enhance");
  expect(PROMPT_MODELS()).toEqual(["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"]);
  process.env.GATEWAY_PROMPT_MODELS = "anthropic/claude-haiku-4.5";
  expect(PROMPT_MODELS()).toEqual(["anthropic/claude-haiku-4.5"]);
  process.env.PROMPT_MODELS = "google/gemini-2.5-flash, anthropic/claude-sonnet-4.6";
  expect(PROMPT_MODELS()).toEqual(["google/gemini-2.5-flash", "anthropic/claude-sonnet-4.6"]);
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token-never-sent";
  expect(refineProvider()).toBe("gateway");
  process.env.REFINE_PROVIDER = "anthropic";
  expect(refineProvider()).toBe("anthropic");
});

test("the inline writer on a direct door: priced at usage × snapshot, on the vendor's ledger", async () => {
  process.env.TEXT_DIRECT = "anthropic";
  process.env.MODEL_CATALOG = "static";
  const transport = stub("https://api.anthropic.com", () => Response.json({ ...anthropicReply, content: [{ type: "text", text: "A lone tree in steady rain.\nCAMERA: static" }] }));
  globalThis.fetch = transport.fetch;
  await inWorkspace(async () => {
    const { enhancePrompt, activeWriter } = await import("../../lib/enhance");
    // The platform's enhance writer (DEFAULT_TEXT_MODELS), now on Anthropic's own API.
    expect(await activeWriter()).toMatchObject({ provider: "gateway", model: "anthropic/claude-sonnet-5", via: "Model provider, direct", configured: true });
    const refined = await enhancePrompt({ prompt: "A tree in rain.", citations: [], provider: "gateway" });
    expect(transport.urls).toHaveLength(1);
    expect(refined).toMatchObject({ text: "A lone tree in steady rain.", move: "static", ledger: "anthropic", model: "anthropic/claude-sonnet-5" });
    // Claude Sonnet 5 at the snapshot: 100 × $2/M + 60 reads × $0.20/M + 40 writes × $2.50/M + 25 out × $10/M.
    expect(refined.costUsd).toBeCloseTo(100 * 0.000002 + 60 * 0.0000002 + 40 * 0.0000025 + 25 * 0.00001, 15);
  });
});

/* ── Ledgers and Usage lines ────────────────────────────────────────── */

test("ledgers read old gateway rows as before and new rows on their vendor's line", async () => {
  await inWorkspace(async () => {
    const { db } = await import("../../lib/db");
    const { atomikTextSpend, spendSince, computedSpendUpTo, PROMPT_LEDGER } = await import("../../lib/reconcile");
    const before = 1_000, reading = 2_000, after = 3_000;
    const take = `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,provider,cost_usd,refine_model,refine_cost_usd,refine_ledger,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`;
    await db().batch([
      // Before direct text: no ledger recorded, a vendor/model writer was gateway text.
      { sql: take, args: ["g_old", "dreamina-seedance-2-5-260628", "a", "{}", "succeeded", before, before, "video", "byteplus", 1, "anthropic/claude-sonnet-4.6", 0.05, null] },
      { sql: take, args: ["g_seed", "dreamina-seedance-2-5-260628", "b", "{}", "succeeded", after, after, "video", "byteplus", 1, "seed-text-test", 0.02, null] },
      // After: each on the balance that paid.
      { sql: take, args: ["g_direct", "dreamina-seedance-2-5-260628", "c", "{}", "succeeded", after, after, "video", "byteplus", 1, "anthropic/claude-sonnet-4.6", 0.07, "anthropic"] },
      { sql: take, args: ["g_gateway", "dreamina-seedance-2-5-260628", "d", "{}", "succeeded", after, after, "video", "byteplus", 1, "google/gemini-2.5-flash", 0.01, "vercel"] },
      { sql: `INSERT INTO atomik_messages(id,chat_id,role,cost_usd,created_at,ledger) VALUES('m_old','c','assistant',0.3,?,NULL),('m_new','c','assistant',0.2,?,'anthropic'),('m_grok','c','assistant',0.04,?,'xai')`, args: [before, after, after] },
      { sql: `INSERT INTO atomik_spend(id,kind,cost_usd,created_at,ledger) VALUES('s_old','idea',0.1,?,NULL),('s_new','idea',0.06,?,'google')`, args: [after, after] },
    ]);
    const lines = new Map((await db().execute(`SELECT ${PROMPT_LEDGER} AS ledger, SUM(refine_cost_usd) AS spend FROM generations WHERE refine_model IS NOT NULL GROUP BY ledger`)).rows.map((r) => [String(r.ledger), Number(r.spend)]));
    expect(Object.fromEntries(lines)).toEqual({ vercel: 0.05 + 0.01, byteplus: 0.02, anthropic: 0.07 });
    const atomik = await atomikTextSpend();
    expect(atomik.usd).toBeCloseTo(0.3 + 0.2 + 0.04 + 0.1 + 0.06, 9);
    expect(atomik.byLedger.vercel).toBeCloseTo(0.4, 9);
    expect(atomik.byLedger.anthropic).toBeCloseTo(0.2, 9);
    expect(atomik.byLedger.google).toBeCloseTo(0.06, 9);
    expect(atomik.byLedger.xai).toBeCloseTo(0.04, 9);
    // Reading-anchored figures: the gateway keeps old rows and its own new ones; each vendor sees only its own.
    expect((await spendSince("vercel", reading)).usd).toBeCloseTo(0.01 + 0.1, 9);
    expect((await computedSpendUpTo("vercel", reading)).usd).toBeCloseTo(0.05 + 0.3, 9);
    expect((await spendSince("anthropic", reading)).usd).toBeCloseTo(0.07 + 0.2, 9);
    expect((await spendSince("google", reading)).usd).toBeCloseTo(0.06, 9);
    expect((await spendSince("xai", reading)).usd).toBeCloseTo(0.04, 9);
    expect((await spendSince("byteplus", reading)).usd).toBeCloseTo(4 + 0.02 - 1, 9);
  });
});

test("platform spend counts each text record on the key that paid it, and the vendor spend lines name Anthropic", async () => {
  await inWorkspace(async () => {
    const { db } = await import("../../lib/db");
    const { platformSpendRecordsSince, vendorKeyNameFor } = await import("../../lib/platformSpend");
    const { currentTenant } = await import("../../lib/tenant");
    const { PROVIDERS } = await import("../../lib/providers");
    await db().execute({ sql: `INSERT INTO atomik_spend(id,kind,cost_usd,created_at,ledger) VALUES('t_old','idea',0.5,100,NULL),('t_claude','idea',0.25,100,'anthropic'),('t_gemini','idea',0.125,100,'google')`, args: [] });
    const records = async () => Object.fromEntries(await platformSpendRecordsSince(0));
    expect(await records()).toEqual({ t_old: 0.5, t_claude: 0.25, t_gemini: 0.125 });
    // A workspace holding its own key for one vendor pays that vendor's text itself; the rest stays the platform's.
    const ws = currentTenant()!.workspace!;
    ws.keys.anthropic = "own-key-never-sent";
    expect(await records()).toEqual({ t_old: 0.5, t_gemini: 0.125 });
    ws.keys.gateway = "own-key-never-sent";
    expect(await records()).toEqual({ t_gemini: 0.125 });
    delete ws.keys.anthropic; delete ws.keys.gateway;
    expect(vendorKeyNameFor("anthropic")).toBe("anthropic");
    expect(PROVIDERS.map((p) => p.id)).toContain("anthropic");
    expect(PROVIDERS.find((p) => p.id === "google")!.serves).toContain("Gemini text");
    expect(PROVIDERS.find((p) => p.id === "xai")!.serves).toContain("Grok text");
  });
});

test("Usage lines for a credits workspace: an old gateway row and a new direct row of one model read as two lines", async () => {
  const { usageRows } = await import("../../lib/shell/workspace-view");
  const rows = usageRows({ unit: "credits", spentCredits: 3, byModel: [
    { model: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", provider: "vercel", kind: "text", n: 1, credits: 1 },
    { model: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", provider: "anthropic", kind: "text", n: 2, credits: 2 },
  ] });
  expect(rows.rows.map((r) => [r.label, r.amount])).toEqual([["Claude Sonnet 4.6 · vercel", 1], ["Claude Sonnet 4.6 · anthropic", 2]]);
  expect(rows.total).toBe(3);
});
