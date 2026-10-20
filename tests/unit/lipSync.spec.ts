import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * Lip-sync through sync.so (lib/lipSync.ts, lib/syncso.ts). Mocked: every adapter call is a function this file hands the workflow (the internal seams
 * `admitLipSync` and `advanceLipSyncJobWith`, which the public route and the cron do not offer), or the in-process fixture under ENGINE_MOCK=1; no request
 * leaves this process and no provider is paid. Local temporary databases only. Neutral sample names.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 *
 * PRICES. What sync.so charges is not in the repo: the server reads it from the private vendor price file (lib/vendorPriceFile.ts, VENDOR_PRICES_PATH).
 * This file writes its own price file in its temporary folder, with SYNTHETIC PLACEHOLDER rates (repeated digits) that are no vendor's price, and every
 * cost below is expected from those placeholders.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-lipsync-"));
/** Synthetic placeholder rates, US dollars per output second. Not a vendor's price. */
const PLACEHOLDER_RATE_USD_PER_SECOND = { "lipsync-2": 0.011111, "lipsync-2-pro": 0.022222, "sync-3": 0.033333 } as const;
/** A second set of synthetic placeholders, for a file edited after a job was quoted. */
const PLACEHOLDER_EDITED_RATE_USD_PER_SECOND = { "lipsync-2": 0.044444, "lipsync-2-pro": 0.055555, "sync-3": 0.066666 } as const;
/** What a fake vendor reply says a failed job cost: a synthetic placeholder. */
const PLACEHOLDER_REPORTED_COST_USD = 0.077777;
const PRICES_FORMAT = "particl-vendor-prices/1";
const priceFile = (rates: Record<string, number>) => JSON.stringify({ format: PRICES_FORMAT, engines: Object.fromEntries(Object.entries(rates).map(([id, costUsd]) => [id, { second: [{ costUsd }] }])) });
const PRICES = path.join(dir, "placeholder-vendor-prices.json");
writeFileSync(PRICES, priceFile(PLACEHOLDER_RATE_USD_PER_SECOND));
process.env.VENDOR_PRICES_PATH = PRICES;
/** Puts the placeholder price file back as it was, and makes the next quote read it again. */
async function restorePrices(): Promise<void> {
  writeFileSync(PRICES, priceFile(PLACEHOLDER_RATE_USD_PER_SECOND));
  process.env.VENDOR_PRICES_PATH = PRICES;
  (await import("../../lib/vendorPriceFile")).reloadVendorPrices();
}
/** Dollars to the micro-dollar, rounded up, as the quote rounds. */
const micro = (usd: number) => Math.ceil(usd * 1e6 - 1e-6) / 1e6;
const PRO = PLACEHOLDER_RATE_USD_PER_SECOND["lipsync-2-pro"];
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.SYNC_ENABLED; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = (over: Partial<TenantWorkspace> = {}) => tenant("ws_legacy", over);
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] };
let n = 0;
const uid = (label: string) => `${label}_${Date.now().toString(36)}_${++n}`;
/** Runs `fn` as the signed-in owner in a workspace (the admission reads its actor from the request, as the route's does). */
async function asTenant(ws: TenantWorkspace, fn: () => Promise<void>): Promise<void> {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, fn, OWNER as never);
}
const made: string[] = [];
test.afterAll(async () => { for (const f of made) await unlink(f).catch(() => {}); });

const deferred: (() => Promise<unknown>)[] = [];
const options = (): AdmissionExecution => ({ defer: async (work) => { deferred.push(work); } });

/** One upload of this workspace: a stored original with a known length. */
async function upload(label: string, mediaKind: "video" | "audio" | "image", seconds: number | null = null, uploader: string | null = null): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const ext = mediaKind === "video" ? "mp4" : mediaKind === "audio" ? "mp3" : "png";
  const mime = mediaKind === "video" ? "video/mp4" : mediaKind === "audio" ? "audio/mpeg" : "image/png";
  const bytes = Buffer.from(`sample-${mediaKind}-${id}`);
  await storeUpload(id, ext, bytes, mime);
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.${ext}`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind,duration_s,uploader_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.${ext}`, mime, ext, bytes.length, "x", `uploads/${id}.${ext}`, Date.now(), mediaKind, seconds, uploader] });
  return id;
}
async function project(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, id] });
}
async function meterRows() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute("SELECT id,status,engine_cost_usd,billed_credits,paid_by_platform FROM meter_events WHERE engine='syncso' ORDER BY created_at, id")).rows;
}
async function gen(id: string) {
  const { db } = await import("../../lib/db");
  const r = (await db().execute({ sql: "SELECT status,stored_url,bytes,cost_usd,error,provider_outcome,duration_s,json_extract(params,'$.lipsync') AS lip FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
  return { status: r.status, stored_url: r.stored_url, bytes: r.bytes, cost_usd: r.cost_usd, error: r.error, provider_outcome: r.provider_outcome, duration_s: r.duration_s, lip: JSON.parse(String(r.lip)) as import("../../lib/lipSync").LipSyncParams };
}

type World = { projectId: string; clip: string; voice: string; body: Record<string, unknown> };
/** A production, a 4 s clip and a 5 s voice track (an upload). No face, no consent record and no cast member is involved anywhere. */
async function world(seconds = { clip: 4, voice: 5 }): Promise<World> {
  const projectId = uid("prod");
  await project(projectId);
  const clip = await upload("clip", "video", seconds.clip), voice = await upload("voice", "audio", seconds.voice);
  return { projectId, clip, voice, body: { clipUploadId: clip, audioUploadId: voice, projectId } };
}

/** The adapter seams: a job that completes on the second poll, recording every call. */
function fakeVendor(over: { completeAt?: number; outputDuration?: number; failWith?: string; reportedCostUsd?: number; submitError?: Error; uploadError?: Error; storeError?: Error; deleteJobError?: boolean; downloadError?: Error } = {}) {
  const calls: string[] = [];
  let polls = 0, assetSeq = 0;
  const deps = {
    upload: async () => { if (over.uploadError) throw over.uploadError; calls.push("upload"); return `asset_${++assetSeq}`; },
    submit: async (input: { model: string; syncMode: string; videoAssetId: string; audioAssetId: string }) => { calls.push(`submit:${input.model}:${input.syncMode}`); if (over.submitError) throw over.submitError; return { id: "job_1" }; },
    status: async () => { polls++; calls.push("status"); if (over.failWith) return { id: "job_1", status: "failed" as const, error: over.failWith, ...(over.reportedCostUsd != null ? { reportedCostUsd: over.reportedCostUsd } : {}) }; return polls < (over.completeAt ?? 2) ? { id: "job_1", status: "processing" as const } : { id: "job_1", status: "completed" as const, outputUrl: "https://example.invalid/out.mp4", outputDuration: over.outputDuration }; },
    download: async () => { calls.push("download"); if (over.downloadError) throw over.downloadError; return Buffer.from("lip-synced-clip"); },
    store: async (genId: string, bytes: Buffer) => { if (over.storeError) { const e = over.storeError; over.storeError = undefined; throw e; } calls.push("store"); return { url: `stored/${genId}.mp4`, bytes: bytes.length }; },
    deleteJob: async (id: string) => { calls.push(`deleteJob:${id}`); if (over.deleteJobError) throw new Error("409 still processing"); return true; },
    deleteAsset: async (id: string) => { calls.push(`deleteAsset:${id}`); return true; },
  };
  return { deps, calls };
}

async function admit(w: World, extra: Record<string, unknown> = {}, seams: { houseOnly?: boolean } = {}) {
  const { admitLipSync } = await import("../../lib/lipSync");
  const reply = await admitLipSync({ ...w.body, ...extra }, OWNER, options(), seams);
  return reply;
}
async function run(genId: string, deps: ReturnType<typeof fakeVendor>["deps"], times = 4) {
  const { advanceLipSyncJobWith } = await import("../../lib/lipSync");
  let last = null;
  for (let i = 0; i < times; i++) last = await advanceLipSyncJobWith(genId, deps);
  return last;
}

test("the quote: the audio's length for cut_off, else the longer track, at the per-second rate in the server's price file, through the price path; no figure of ours in a customer's words", async () => {
  const { quotedSeconds, lipSyncQuoteUsd, lipSyncUsdAt } = await import("../../lib/lipSync");
  const { SYNC_MODELS, SYNC_DEFAULT_MODEL } = await import("../../lib/syncso");
  const { FILE_PRICED_UNITS } = await import("../../lib/vendorPriceFile");
  const { VENDOR_RATES } = await import("../../lib/vendorRates");
  const { billCreditsWith, creditUsd } = await import("../../lib/creditTerms");
  /* The models are names in code; their prices are only in the price file, per second. None is priced in lib/vendorRates.ts, which names no sync.so rate. */
  expect([...SYNC_MODELS]).toEqual(["lipsync-2", "lipsync-2-pro", "sync-3"]);
  expect(SYNC_DEFAULT_MODEL).toBe("lipsync-2-pro");
  for (const model of SYNC_MODELS) {
    expect(FILE_PRICED_UNITS[model], model).toBe("second");
    expect(Object.hasOwn(VENDOR_RATES, model), model).toBe(false);
  }
  expect(readFileSync("lib/vendorRates.ts", "utf8")).not.toMatch(/SYNC_RATES|lipsync|sync\.so/i);
  expect(readFileSync("lib/syncso.ts", "utf8")).not.toMatch(/\$\s?\d|\d\.\d+\s*(\/|a|per)\s*(s|sec|second|min|minute)\b/i);
  expect(quotedSeconds(4, 5, "bounce")).toBe(5);
  expect(quotedSeconds(8, 5, "loop")).toBe(8);
  expect(quotedSeconds(8, 5, "cut_off")).toBe(5);
  expect(lipSyncQuoteUsd(5, "lipsync-2-pro")).toEqual({ usd: micro(5 * PRO), rateUsdPerSecond: PRO });
  /* Rounded UP to the micro-dollar, never down. */
  for (const model of SYNC_MODELS) for (const seconds of [1, 3.3, 5, 7.77]) {
    expect(lipSyncQuoteUsd(seconds, model).usd).toBeGreaterThanOrEqual(seconds * PLACEHOLDER_RATE_USD_PER_SECOND[model] - 1e-12);
    expect(lipSyncUsdAt(seconds, PLACEHOLDER_RATE_USD_PER_SECOND[model])).toBe(lipSyncQuoteUsd(seconds, model).usd);
  }
  expect(lipSyncQuoteUsd(5, "sync-3").usd).toBe(micro(5 * PLACEHOLDER_RATE_USD_PER_SECOND["sync-3"]));
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const before = (await meterRows()).length;
    const quote = await admit(w, { quoteOnly: true });
    expect(quote.status).toBe(200);
    /* The house is judged at cost in dollars: 5 s of lipsync-2-pro, default model. */
    expect(quote.body).toMatchObject({ seconds: 5, model: "lipsync-2-pro", syncMode: "bounce", unit: "usd", estimatedCredits: billCreditsWith(micro(5 * PRO), 1, creditUsd()) });
    expect(Number(quote.body.price)).toBe(micro(5 * PRO));
    expect(quote.body).not.toHaveProperty("needs");
    expect(await admit(w, { quoteOnly: true, model: "sync-3", syncMode: "cut_off" })).toMatchObject({ status: 200, body: { seconds: 5, model: "sync-3", syncMode: "cut_off" } });
    /* A quote writes nothing and reserves nothing. */
    expect((await meterRows()).length).toBe(before);
    expect(deferred.length).toBe(0);
    for (const bad of [{ model: "lipsync-9" }, { syncMode: "stretch" }]) expect((await admit(w, { quoteOnly: true, ...bad })).status, JSON.stringify(bad)).toBe(400);
  });
});

test("no confirmed price, no quote: with the price file unset, missing, invalid, or without the model's row, the quote and the press are refused 503 'unpriced' before any row is written, with nothing reserved or sent", async () => {
  const { db } = await import("../../lib/db");
  const { reloadVendorPrices } = await import("../../lib/vendorPriceFile");
  process.env.SYNC_ENABLED = "1";
  const UNPRICED = { status: 503, body: { error: "This engine has no confirmed price.", code: "unpriced" } };
  try {
    await asTenant(house(), async () => {
      const w = await world();
      const rows = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const before = { rows: await rows(), meter: (await meterRows()).length, handed: deferred.length };
      const refusedEverywhere = async (label: string, models: (string | undefined)[] = [undefined, "lipsync-2", "sync-3"]) => {
        for (const model of models) for (const extra of [{ quoteOnly: true }, { maxCredits: 100000 }]) {
          const reply = await admit(w, { ...extra, ...(model ? { model } : {}) });
          expect(reply, `${label} ${String(model)} ${JSON.stringify(extra)}`).toMatchObject(UNPRICED);
          /* Nothing of the file's state, path or figures is in the answer. */
          expect(JSON.stringify(reply.body), label).not.toMatch(/VENDOR_PRICES|\/|\d/);
        }
      };
      /* No variable. */
      delete process.env.VENDOR_PRICES_PATH; reloadVendorPrices();
      await refusedEverywhere("unset");
      /* A path with no file at it. */
      process.env.VENDOR_PRICES_PATH = path.join(dir, "placeholder-no-such-prices.json"); reloadVendorPrices();
      await refusedEverywhere("missing");
      /* A file that does not parse, and one that breaks the format. */
      writeFileSync(PRICES, "{ half a paste"); process.env.VENDOR_PRICES_PATH = PRICES; reloadVendorPrices();
      await refusedEverywhere("not JSON");
      writeFileSync(PRICES, JSON.stringify({ format: PRICES_FORMAT, engines: { "lipsync-2-pro": { second: [{ costUsd: 0 }] } } })); reloadVendorPrices();
      await refusedEverywhere("invalid row");
      /* A valid file without the asked model's row: that model is refused; a model with its row still quotes. */
      writeFileSync(PRICES, priceFile({ "lipsync-2-pro": PRO })); reloadVendorPrices();
      await refusedEverywhere("no row", ["lipsync-2", "sync-3"]);
      expect(await admit(w, { quoteOnly: true })).toMatchObject({ status: 200, body: { model: "lipsync-2-pro", price: micro(5 * PRO) } });
      /* A row priced with settings the quote does not name is not a price for it. */
      writeFileSync(PRICES, JSON.stringify({ format: PRICES_FORMAT, engines: { "lipsync-2-pro": { second: [{ resolution: "1080p", costUsd: PRO }] } } })); reloadVendorPrices();
      await refusedEverywhere("row with settings", [undefined]);
      /* Nor is a band: the job settles at the rate it was quoted at, so a rate that depends on the quantity could not hold. */
      writeFileSync(PRICES, JSON.stringify({ format: PRICES_FORMAT, engines: { "lipsync-2-pro": { second: [{ upTo: 10, costUsd: PRO }, { upTo: 1000, costUsd: PLACEHOLDER_EDITED_RATE_USD_PER_SECOND["lipsync-2-pro"] }] } } })); reloadVendorPrices();
      await refusedEverywhere("banded rows", [undefined]);
      /* Through all of it: no take, no ledger line, nothing handed to the worker. */
      expect(await rows()).toBe(before.rows);
      expect((await meterRows()).length).toBe(before.meter);
      expect(deferred.length).toBe(before.handed);
      /* The file restored: priced again, with no restart. */
      await restorePrices();
      expect((await admit(w, { quoteOnly: true })).status).toBe(200);
    });
  } finally { await restorePrices(); }
});

test("the house's own monthly cap: set below the quote, the press is refused 429 in HOUSE_CAP_REACHED's words, with nothing reserved, written or handed to the worker", async () => {
  const { HOUSE_CAP_REACHED, houseSpendSince, houseMonthStart } = await import("../../lib/houseCap");
  const { db } = await import("../../lib/db");
  process.env.SYNC_ENABLED = "1";
  /* What the house has spent this month so far (other tests in this worker's platform database), read before; the cap leaves less headroom than the quote. */
  const quoteUsd = micro(5 * PRO);
  const spent = await houseSpendSince(houseMonthStart());
  for (const capUsd of [spent + quoteUsd / 2, 0]) {
    await asTenant(house({ allowanceUsd: capUsd }), async () => {
      const w = await world();
      const rows = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const before = { rows: await rows(), meter: (await meterRows()).length, handed: deferred.length };
      if (capUsd > 0) {
        /* Under the cap so far, so the quote answers (at the placeholder price); the press would pass it. */
        expect(await admit(w, { quoteOnly: true }), String(capUsd)).toMatchObject({ status: 200, body: { price: quoteUsd } });
      }
      const pressed = await admit(w, { maxCredits: 100000 });
      expect(pressed, String(capUsd)).toMatchObject({ status: 429, body: { error: HOUSE_CAP_REACHED } });
      /* The cap's words only: no figure, no vendor. */
      expect(JSON.stringify(pressed.body)).not.toMatch(/\d|\$|sync\.so/);
      expect(await rows()).toBe(before.rows);
      expect((await meterRows()).length).toBe(before.meter);
      expect(deferred.length).toBe(before.handed);
    });
  }
  /* The default cap (none set) leaves room for this placeholder-priced job: it goes through, and is run to its end so no job is left for the cron in later tests. */
  await asTenant(house(), async () => {
    const reply = await admit(await world(), { maxCredits: 100000 });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    deferred.splice(0);
    expect(await run(String(reply.body.id), fakeVendor({ outputDuration: 4 }).deps, 4)).toMatchObject({ status: "done", settled: 1 });
  });
});

test("a job settles at the rate it was quoted at: the price file edited, emptied or removed after the press neither breaks nor moves its charge", async () => {
  const { reloadVendorPrices } = await import("../../lib/vendorPriceFile");
  process.env.SYNC_ENABLED = "1";
  try {
    await asTenant(house(), async () => {
      /* Three jobs pressed at the placeholder rate; the file then changes under each before it runs. */
      const changes: [string, () => void][] = [
        ["edited", () => writeFileSync(PRICES, priceFile(PLACEHOLDER_EDITED_RATE_USD_PER_SECOND))],
        ["removed", () => unlinkSync(PRICES)],
        ["unset", () => { delete process.env.VENDOR_PRICES_PATH; }],
        ["broken", () => writeFileSync(PRICES, "{ half a paste")],
      ];
      for (const [label, change] of changes) {
        await restorePrices();
        const w = await world();
        const before = (await meterRows()).length;
        const reply = await admit(w, { maxCredits: 100 });
        expect(reply.status, label).toBe(200);
        const genId = String(reply.body.id);
        deferred.splice(0);
        expect((await gen(genId)).lip, label).toMatchObject({ rateUsdPerSecond: PRO, reservedUsd: micro(5 * PRO) });
        change(); reloadVendorPrices();
        /* The quote now reads the changed file (refused, or at the edited rate)... */
        const now = await admit(w, { quoteOnly: true });
        if (label === "edited") expect(now.body.price, label).toBe(micro(5 * PLACEHOLDER_EDITED_RATE_USD_PER_SECOND["lipsync-2-pro"]));
        else expect(now, label).toMatchObject({ status: 503, body: { code: "unpriced" } });
        /* ...but the job pressed before settles at the rate kept on its row: 4 s delivered at the placeholder rate. */
        const lip = await run(genId, fakeVendor({ outputDuration: 4 }).deps, 4);
        expect(lip, label).toMatchObject({ status: "done", settled: 1 });
        const take = await gen(genId);
        expect(take.status, label).toBe("succeeded");
        expect(Number(take.cost_usd), label).toBe(micro(4 * PRO));
        const line = (await meterRows()).slice(before).find((r) => r.id === genId)!;
        expect(line, label).toMatchObject({ status: "succeeded" });
        expect(Number(line.engine_cost_usd), label).toBe(micro(4 * PRO));
      }
      /* The same for a charged failure settled after the file is gone (an output address we will not fetch). */
      await restorePrices();
      const { SyncOutputRefused } = await import("../../lib/syncso");
      const w = await world();
      const genId = String((await admit(w, { maxCredits: 100 })).body.id);
      deferred.splice(0);
      unlinkSync(PRICES); reloadVendorPrices();
      await run(genId, fakeVendor({ outputDuration: 3, downloadError: new SyncOutputRefused("sync.so named no output we can download.") }).deps, 3);
      const take = await gen(genId);
      expect(take.status).toBe("failed");
      expect(Number(take.cost_usd)).toBe(micro(3 * PRO));
    });
  } finally { await restorePrices(); }
});

test("settling reads only the job's own record: the kept rate, never past the reservation; a row without a usable rate settles pro rata of what it reserved", async () => {
  const { lipSyncSettledUsd } = await import("../../lib/lipSync");
  const kept = { rateUsdPerSecond: PRO, reservedUsd: micro(5 * PRO), seconds: 5 };
  expect(lipSyncSettledUsd(kept, 4)).toBe(micro(4 * PRO));
  expect(lipSyncSettledUsd(kept, 5)).toBe(micro(5 * PRO));
  /* Never past what was reserved, whatever the length. */
  expect(lipSyncSettledUsd(kept, 50)).toBe(micro(5 * PRO));
  for (const rate of [0, -1, Number.NaN, undefined as unknown as number]) {
    expect(lipSyncSettledUsd({ ...kept, rateUsdPerSecond: rate }, 2.5), String(rate)).toBeCloseTo(micro(5 * PRO) / 2, 6);
    expect(lipSyncSettledUsd({ ...kept, rateUsdPerSecond: rate }, 2.5), String(rate)).toBeLessThanOrEqual(micro(5 * PRO));
  }
  expect(lipSyncSettledUsd({ rateUsdPerSecond: Number.NaN, reservedUsd: 0, seconds: 5 }, 3)).toBe(0);
});

test("off: with the engine's switch off, or any workspace but the house (a listed customer too), there is no tool, no row and nothing metered", async () => {
  const { lipSyncTools } = await import("../../lib/lipSync");
  await asTenant(house(), async () => {
    const w = await world();
    const before = (await meterRows()).length;
    delete process.env.SYNC_ENABLED;
    expect(await lipSyncTools()).toEqual([]);
    const off = await admit(w, { maxCredits: 100 });
    expect(off).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    expect((await meterRows()).length).toBe(before);
    /* On, the tool is declared for the house (no face check is involved). */
    process.env.SYNC_ENABLED = "1";
    expect(await lipSyncTools()).toEqual([expect.objectContaining({ id: "lip_sync", kind: "engine", provider: "syncso", route: "/api/lipsync", models: ["lipsync-2", "lipsync-2-pro", "sync-3"] })]);
  });
  /* A customer workspace: not the house. Lip-sync is house-only until counsel answers, so being on the engine list changes nothing. */
  process.env.SYNC_ENABLED = "1";
  await asTenant(tenant("ws_lipsync_customer"), async () => {
    expect(await lipSyncTools()).toEqual([]);
    expect(await admit(await world(), { quoteOnly: true })).toMatchObject({ status: 404 });
  });
  const { platformReady, platformDb } = await import("../../lib/platform");
  await platformReady();
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: ["ws_lipsync_listed"] })] });
    await asTenant(tenant("ws_lipsync_listed"), async () => {
      expect(await lipSyncTools()).toEqual([]);
      expect(await admit(await world(), { quoteOnly: true })).toMatchObject({ status: 404 });
      expect(await admit(await world(), { maxCredits: 100000 })).toMatchObject({ status: 404 });
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("approval: the price must be approved, and nothing about a face or a voice is asked for, matched, stored or refused (owner, 16 Oct 2026): an uploaded voice and no cast member go straight through the public door", async () => {
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const before = (await meterRows()).length;
    expect((await admit(w, {})).status).toBe(409);
    expect((await admit(w, { maxCredits: 1 })).status).toBe(409);
    expect((await meterRows()).length).toBe(before);
    expect(deferred.length).toBe(0);
    /* The public door, no seams: no face still, no cast member, no consent record, an uploaded voice. */
    expect(w.body).not.toHaveProperty("faceFrameUploadId");
    expect(w.body).not.toHaveProperty("castMemberId");
    const { executeLipSyncAdmission } = await import("../../lib/lipSync");
    const real = await executeLipSyncAdmission({ ...w.body, maxCredits: 100 }, OWNER, options());
    expect(real.status, JSON.stringify(real.body)).toBe(200);
    const genId = String(real.body.id);
    expect(deferred.splice(0).length).toBe(1);
    const { db } = await import("../../lib/db");
    const row = (await db().execute({ sql: "SELECT params FROM generations WHERE id=?", args: [genId] })).rows[0];
    expect(JSON.stringify(JSON.parse(String(row.params)).lipsync)).not.toMatch(/face|sha|similarity|consent|castMember/i);
    await run(genId, fakeVendor({ outputDuration: 4 }).deps, 4);
    expect((await meterRows()).length).toBe(before + 1);
  });
});

test("submit, poll, store, settle, delete: the whole job on mocks, at the real provider cost, then the vendor's copy is gone", async () => {
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const before = (await meterRows()).length;
    const reply = await admit(w, { maxCredits: 100, model: "lipsync-2-pro", syncMode: "bounce" });
    expect(reply.status).toBe(200);
    const genId = String(reply.body.id);
    expect(deferred.splice(0).length).toBe(1);
    /* Reserved at the quote, before anything is sent: one running row at 5 s x the rate, no credits (the house is billed none). */
    const held = (await meterRows()).slice(before);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: genId, status: "running" });
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(micro(5 * PRO), 9);
    const vendor = fakeVendor({ outputDuration: 4.2 });
    const lip = await run(genId, vendor.deps, 4);
    expect(lip).toMatchObject({ status: "done", settled: 1, vendorDeleted: 1, cleanupDue: 0, syncId: null, videoAsset: null, audioAsset: null });
    expect(vendor.calls).toEqual(["upload", "upload", "submit:lipsync-2-pro:bounce", "status", "status", "download", "store", "deleteJob:job_1", "deleteAsset:asset_1", "deleteAsset:asset_2"]);
    const take = await gen(genId);
    expect(take).toMatchObject({ status: "succeeded", stored_url: `stored/${genId}.mp4` });
    /* The delivered length (4.2 s, under the quote) at the model's rate: the real cost on the take and on the ledger line. */
    expect(Number(take.cost_usd)).toBeCloseTo(micro(4.2 * PRO), 9);
    const settled = (await meterRows()).slice(before);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: genId, status: "succeeded" });
    expect(Number(settled[0].engine_cost_usd)).toBeCloseTo(micro(4.2 * PRO), 9);
    expect(Number(settled[0].billed_credits ?? 0)).toBe(0);
    /* Only ids and figures are on the row: no face, no frame, no name, no consent. */
    expect(take.lip).toMatchObject({ model: "lipsync-2-pro", seconds: 5, rateUsdPerSecond: PRO, reservedUsd: micro(5 * PRO) });
    expect(JSON.stringify(take.lip)).not.toMatch(/Sample Person|base64|http/);
    /* Another step on a finished job does nothing: no second submit, no second delete. */
    const again = fakeVendor();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
  });
});

test("the delivered length never costs past the quote; a vendor that gives no length settles at the input voice track's length, never the bare quote", async () => {
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    /* clip 4 s, voice 5 s: quote 5 s. clip 8 s, voice 5 s: quote 8 s, and with no length from the vendor 5 s (the voice track), not 8. */
    for (const [clip, voice, duration, expectedSeconds] of [[4, 5, 9, 5], [4, 5, undefined, 5], [4, 5, 3, 3], [8, 5, undefined, 5], [8, 5, 7, 7]] as const) {
      const w = await world({ clip, voice });
      const genId = String((await admit(w, { maxCredits: 100 })).body.id);
      await run(genId, fakeVendor({ outputDuration: duration }).deps, 4);
      expect(Number((await gen(genId)).cost_usd), `${clip}/${voice}/${duration}`).toBeCloseTo(micro(expectedSeconds * PRO), 9);
    }
  });
});

test("a failure at sync.so settles at nothing: 'Nothing billed', a failed row, a zero ledger line, the provider's words, and the vendor's copy deleted", async () => {
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const genId = String((await admit(w, { maxCredits: 100 })).body.id);
    const vendor = fakeVendor({ failWith: "face not found in the video" });
    await run(genId, vendor.deps, 3);
    const take = await gen(genId);
    expect(take.status).toBe("failed");
    expect(String(take.error)).toMatch(/Nothing was billed/);
    expect(Number(take.cost_usd)).toBe(0);
    const outcome = JSON.parse(String(take.provider_outcome));
    expect(outcome).toMatchObject({ provider: "syncso", stage: "run", billing: { state: "unknown" } });
    const row = (await meterRows()).find((r) => r.id === genId)!;
    expect(row).toMatchObject({ status: "failed" });
    expect(Number(row.engine_cost_usd)).toBe(0);
    expect(Number(row.billed_credits ?? 0)).toBe(0);
    expect(vendor.calls).toEqual(expect.arrayContaining(["deleteJob:job_1", "deleteAsset:asset_1", "deleteAsset:asset_2"]));
    expect(vendor.calls).not.toContain("download");
    expect(take.lip).toMatchObject({ status: "failed", vendorDeleted: 1, reconcile: 1 });
  });
});

test("refused before work, or never sent: nothing billed, nothing left at the vendor, and the person is told", async () => {
  const { SyncError } = await import("../../lib/syncso");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    /* sync.so refuses the job (4xx before any work): the whole reservation comes back; the two uploaded inputs are deleted. */
    const a = await world();
    const genA = String((await admit(a, { maxCredits: 100 })).body.id);
    const refused = fakeVendor({ submitError: new SyncError("sync.so refused the request: the clip is too long", 422, null, true) });
    await run(genA, refused.deps, 2);
    expect(await gen(genA)).toMatchObject({ status: "failed" });
    expect(Number((await gen(genA)).cost_usd)).toBe(0);
    expect(refused.calls).toEqual(expect.arrayContaining(["deleteAsset:asset_1", "deleteAsset:asset_2"]));
    expect(JSON.parse(String((await gen(genA)).provider_outcome))).toMatchObject({ provider: "syncso", stage: "submit", code: "http_422" });
    /* The upload did not complete: nothing was submitted, nothing billed. */
    const b = await world();
    const genB = String((await admit(b, { maxCredits: 100 })).body.id);
    const noUpload = fakeVendor({ uploadError: new SyncError("sync.so did not take the upload.") });
    await run(genB, noUpload.deps, 2);
    expect(await gen(genB)).toMatchObject({ status: "failed" });
    expect(noUpload.calls).not.toContain("submit:lipsync-2-pro:bounce");
    expect(String((await gen(genB)).error)).toMatch(/Nothing was submitted/);
  });
});

test("a lost acknowledgement is never sent again: the job is held for review with its reservation, and the cron leaves it alone", async () => {
  const { SyncError } = await import("../../lib/syncso");
  const { recoverLipSyncJobs } = await import("../../lib/lipSync");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const genId = String((await admit(w, { maxCredits: 100 })).body.id);
    const vendor = fakeVendor({ submitError: new SyncError("sync.so did not answer.") });
    const lip = await run(genId, vendor.deps, 1);
    expect(lip).toMatchObject({ status: "uncertain", settled: 0 });
    expect(String((await gen(genId)).error)).toMatch(/will not be sent again/);
    expect((await meterRows()).find((r) => r.id === genId)).toMatchObject({ status: "running" });
    const again = fakeVendor();
    await run(genId, again.deps, 3);
    await recoverLipSyncJobs({ limit: 50 }, again.deps);
    expect(again.calls).toEqual([]);
  });
});

test("two workers at once submit once; a storage failure keeps the job and the next pass finishes it without a second submit", async () => {
  const { advanceLipSyncJobWith } = await import("../../lib/lipSync");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const genId = String((await admit(w, { maxCredits: 100 })).body.id);
    const vendor = fakeVendor({ completeAt: 1, storeError: new Error("storage is busy") });
    await Promise.allSettled([advanceLipSyncJobWith(genId, vendor.deps), advanceLipSyncJobWith(genId, vendor.deps)]);
    expect(vendor.calls.filter((c) => c.startsWith("submit")).length).toBe(1);
    /* The store failed once: the take is still running, not failed, not charged. */
    const mid = await gen(genId);
    expect(mid.status).toBe("running");
    expect((await meterRows()).find((r) => r.id === genId)).toMatchObject({ status: "running" });
    await run(genId, vendor.deps, 3);
    expect(await gen(genId)).toMatchObject({ status: "succeeded" });
    expect(vendor.calls.filter((c) => c.startsWith("submit")).length).toBe(1);
  });
});

test("the vendor's copy: a delete that fails is retried by the cron, up to five times, and never fails the take", async () => {
  const { recoverLipSyncJobs, CLEANUP_MAX_TRIES } = await import("../../lib/lipSync");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const genId = String((await admit(w, { maxCredits: 100 })).body.id);
    const vendor = fakeVendor({ deleteJobError: true });
    await run(genId, vendor.deps, 4);
    let take = await gen(genId);
    expect(take.status).toBe("succeeded");
    expect(take.lip).toMatchObject({ cleanupDue: 1, cleanupTries: 1, vendorDeleted: 0, syncId: "job_1" });
    for (let i = 0; i < CLEANUP_MAX_TRIES; i++) await recoverLipSyncJobs({ limit: 50 }, vendor.deps);
    take = await gen(genId);
    expect(take.status).toBe("succeeded");
    expect(take.lip).toMatchObject({ cleanupDue: 0, cleanupTries: CLEANUP_MAX_TRIES, vendorDeleted: 0 });
    /* Once the vendor lets it go, a fresh job's copy is deleted by the cron alone. */
    const w2 = await world();
    const gen2 = String((await admit(w2, { maxCredits: 100 })).body.id);
    const flaky = fakeVendor({ deleteJobError: true });
    await run(gen2, flaky.deps, 4);
    const healthy = fakeVendor();
    await recoverLipSyncJobs({ limit: 50 }, healthy.deps);
    expect(healthy.calls).toEqual(expect.arrayContaining(["deleteJob:job_1"]));
    expect((await gen(gen2)).lip).toMatchObject({ cleanupDue: 0, vendorDeleted: 1 });
  });
});

test("the fixture end to end (ENGINE_MOCK): the default adapter submits, polls, downloads and deletes in process, with no network", async () => {
  const { driveLipSync } = await import("../../lib/lipSync");
  process.env.SYNC_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const w = await world();
      const genId = String((await admit(w, { maxCredits: 100 })).body.id);
      await driveLipSync(genId, { budgetMs: 20_000, pauseMs: 0 });
      const take = await gen(genId);
      expect(take).toMatchObject({ status: "succeeded" });
      expect(take.lip).toMatchObject({ status: "done", vendorDeleted: 1 });
      expect(outbound).toBe(0);
    });
  } finally { globalThis.fetch = original; }
});

test("the adapter: the requests it makes, the statuses it reads, the base address it accepts, and what it refuses", async () => {
  const sync = await import("../../lib/syncso");
  delete process.env.ENGINE_MOCK;
  const calls: { url: string; method: string; headers: Record<string, string>; body: string; redirect?: string }[] = [];
  const reply = (status: number, json: unknown) => (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? init.body : "", redirect: init?.redirect });
    return new Response(status === 204 ? null : typeof json === "string" ? json : JSON.stringify(json), { status });
  }) as never;
  const before = { key: process.env.SYNC_API_KEY, base: process.env.SYNC_BASE_URL };
  try {
    process.env.SYNC_API_KEY = "test-sync-key-not-real";
    delete process.env.SYNC_BASE_URL;
    const sent = await sync.submitLipSync({ model: "lipsync-2-pro", videoAssetId: "va", audioAssetId: "aa", syncMode: "loop" }, { fetch: reply(201, { id: "job_9", status: "PENDING" }) });
    expect(sent).toEqual({ id: "job_9" });
    expect(calls[0]).toMatchObject({ url: "https://api.sync.so/v2/generate", method: "POST" });
    expect(calls[0].headers["x-api-key"]).toBe("test-sync-key-not-real");
    expect(JSON.parse(calls[0].body)).toEqual({ model: "lipsync-2-pro", input: [{ type: "video", assetId: "va" }, { type: "audio", assetId: "aa" }], options: { sync_mode: "loop" } });
    /* Statuses: the vendor's words, upper case; REJECTED is a failure; a word we do not know is "processing", never a verdict. */
    for (const [word, want] of [["PENDING", "pending"], ["PROCESSING", "processing"], ["COMPLETED", "completed"], ["FAILED", "failed"], ["REJECTED", "failed"], ["SOMETHING_NEW", "processing"]] as const)
      expect((await sync.generationStatus("job_9", { fetch: reply(200, { status: word, outputUrl: "https://cdn.sync.so/o.mp4", outputDuration: 4.5 }) })).status, word).toBe(want);
    expect(await sync.generationStatus("job_9", { fetch: reply(200, { status: "COMPLETED", outputUrl: "https://cdn.sync.so/o.mp4", outputDuration: 4.5 }) })).toEqual({ id: "job_9", status: "completed", outputUrl: "https://cdn.sync.so/o.mp4", outputDuration: 4.5 });
    /* A refusal before work is a 4xx (not 408/429); a 5xx, a timeout and a throttle are not. */
    for (const [status, early] of [[400, true], [422, true], [402, true], [408, false], [429, false], [500, false], [503, false]] as const) {
      const failed = await sync.submitLipSync({ model: "lipsync-2", videoAssetId: "va", audioAssetId: "aa", syncMode: "bounce" }, { fetch: reply(status, { message: "nope" }) }).then(() => null, (e) => e);
      expect(failed, String(status)).toBeInstanceOf(sync.SyncError);
      expect(failed.rejectedBeforeGeneration, String(status)).toBe(early);
    }
    expect(await sync.submitLipSync({ model: "lipsync-2", videoAssetId: "va", audioAssetId: "aa", syncMode: "bounce" }, { fetch: (async () => { throw new Error("socket hang up"); }) as never }).then(() => null, (e) => e)).toMatchObject({ rejectedBeforeGeneration: false });
    /* Deleting: 404 is "already gone". */
    expect(await sync.deleteGeneration("job_9", { fetch: reply(204, "") })).toBe(true);
    expect(await sync.deleteGeneration("job_9", { fetch: reply(404, { message: "no such job" }) })).toBe(true);
    expect(await sync.deleteGeneration("job_9", { fetch: reply(409, { message: "still processing" }) }).then(() => null, (e) => e)).toBeInstanceOf(sync.SyncError);
    expect(calls.at(-1)!.url).toBe("https://api.sync.so/v2/generations/job_9");
    /* The output is fetched from an https address only. */
    /* The output is fetched only from an https host on sync.so, no port or credentials, and never past a redirect. */
    const fetched = calls.length;
    for (const bad of ["http://cdn.sync.so/o.mp4", "https://cdn.example.invalid/o.mp4", "https://cdn.sync.so.evil.com/o.mp4", "https://evilsync.so/o.mp4", "https://user@cdn.sync.so/o.mp4", "https://cdn.sync.so:8443/o.mp4"])
      expect(await sync.downloadOutput({ id: "x", url: bad }, { fetch: reply(200, "bytes") }).then(() => null, (e) => e), bad).toBeInstanceOf(sync.SyncError);
    expect(calls.length).toBe(fetched);
    expect((await sync.downloadOutput({ id: "x", url: "https://cdn.sync.so/o.mp4" }, { fetch: reply(200, "bytes") })).toString()).toBe("bytes");
    expect((await sync.downloadOutput({ id: "x", url: "https://sync.so/o.mp4" }, { fetch: reply(200, "bytes") })).toString()).toBe("bytes");
    /* The upload: the address sync.so names must be on sync.so; both requests refuse redirects. */
    const up = async (host: string) => sync.uploadAsset({ bytes: Buffer.from("b"), filename: "a.mp4", mime: "video/mp4" }, { fetch: (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method), headers: (init?.headers ?? {}) as Record<string, string>, body: "", redirect: init?.redirect });
      return String(url).endsWith("/v2/assets/upload") ? new Response(JSON.stringify({ uploadUrl: host, assetId: "asset_9" }), { status: 200 }) : new Response(null, { status: 200 });
    }) as never });
    const beforeUp = calls.length;
    for (const bad of ["https://uploads.example.invalid/put", "http://uploads.sync.so/put", "https://uploads.sync.so.evil.com/put"]) expect(await up(bad).then(() => null, (e) => e), bad).toBeInstanceOf(sync.SyncError);
    expect(calls.length).toBe(beforeUp + 3);
    expect(await up("https://uploads.sync.so/put")).toBe("asset_9");
    expect(calls.at(-1)).toMatchObject({ method: "PUT", url: "https://uploads.sync.so/put", redirect: "error" });
    /* No request of this adapter follows a redirect: each is sent with redirect "error", and a redirecting server's answer is a failure, never followed. */
    expect(calls.every((c) => c.redirect === "error")).toBe(true);
    const redirecting = (async (_url: unknown, init?: RequestInit) => { if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect"); return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }); }) as never;
    expect(await sync.generationStatus("job_9", { fetch: redirecting }).then(() => null, (e) => e)).toBeInstanceOf(sync.SyncError);
    expect(await sync.deleteGeneration("job_9", { fetch: redirecting }).then(() => null, (e) => e)).toBeInstanceOf(sync.SyncError);
    expect(await sync.downloadOutput({ id: "x", url: "https://cdn.sync.so/o.mp4" }, { fetch: redirecting }).then(() => null, (e) => e)).toBeInstanceOf(sync.SyncError);
    /* The base address: https, or a local stand-in for a test; anything else is refused before a request. */
    process.env.SYNC_BASE_URL = "http://127.0.0.1:9999";
    await sync.generationStatus("job_9", { fetch: reply(200, { status: "PENDING" }) });
    expect(calls.at(-1)!.url).toBe("http://127.0.0.1:9999/v2/generate/job_9");
    const sentBefore = calls.length;
    for (const bad of ["http://evil.example.com", "ftp://api.sync.so", "https://api.sync.so/../x", "https://user@api.sync.so"]) {
      process.env.SYNC_BASE_URL = bad;
      expect(await sync.generationStatus("job_9", { fetch: reply(200, {}) }).then(() => null, (e) => e), bad).toBeInstanceOf(sync.SyncError);
    }
    expect(calls.length).toBe(sentBefore);
    /* No key: it says which setting, and calls nothing. */
    delete process.env.SYNC_API_KEY; delete process.env.SYNC_BASE_URL;
    const none = await sync.submitLipSync({ model: "lipsync-2", videoAssetId: "va", audioAssetId: "aa", syncMode: "bounce" }, { fetch: reply(200, {}) }).then(() => null, (e) => e);
    expect(String(none.message)).toContain("SYNC_API_KEY");
    expect(calls.length).toBe(sentBefore);
  } finally {
    if (before.key === undefined) delete process.env.SYNC_API_KEY; else process.env.SYNC_API_KEY = before.key;
    if (before.base === undefined) delete process.env.SYNC_BASE_URL; else process.env.SYNC_BASE_URL = before.base;
  }
});

test("a failure sync.so charged for: its figure is the ledger line's cost, nobody is billed, the take reads 'Nothing billed'; none reported is recorded as 0 and marked to reconcile", async () => {
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const genId = String((await admit(w, { maxCredits: 100 })).body.id);
    await run(genId, fakeVendor({ failWith: "could not lip-sync this clip", reportedCostUsd: PLACEHOLDER_REPORTED_COST_USD }).deps, 3);
    const take = await gen(genId);
    expect(take.status).toBe("failed");
    expect(String(take.error)).toMatch(/Nothing was billed/);
    expect(Number(take.cost_usd)).toBeCloseTo(PLACEHOLDER_REPORTED_COST_USD, 9);
    const row = (await meterRows()).find((r) => r.id === genId)!;
    expect(row).toMatchObject({ status: "failed" });
    expect(Number(row.engine_cost_usd)).toBeCloseTo(PLACEHOLDER_REPORTED_COST_USD, 9);
    expect(Number(row.billed_credits ?? 0)).toBe(0);
    expect(take.lip).toMatchObject({ reconcile: 0 });
  });
});

test("an output address we will not fetch, after the job completed: settled once as a charged failure (the take reads 'Nothing billed', the ledger line records the cost unbilled and marked to reconcile), never retried, the vendor's copy deleted", async () => {
  const { SyncOutputRefused } = await import("../../lib/syncso");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const before = (await meterRows()).length;
    const genId = String((await admit(w, { maxCredits: 100 })).body.id);
    const vendor = fakeVendor({ outputDuration: 4, downloadError: new SyncOutputRefused("sync.so named no output we can download.") });
    const lip = await run(genId, vendor.deps, 3);
    expect(lip).toMatchObject({ status: "failed", settled: 1, reconcile: 1 });
    const take = await gen(genId);
    expect(take.status).toBe("failed");
    expect(String(take.error)).toMatch(/could not be fetched safely\. Nothing was billed/);
    expect(String(take.error)).not.toMatch(/\$|\d+ ?cr|credit/i);
    expect(Number(take.cost_usd)).toBeCloseTo(micro(4 * PRO), 9);
    const line = (await meterRows()).slice(before).find((r) => r.id === genId)!;
    expect(line).toMatchObject({ status: "failed" });
    expect(Number(line.engine_cost_usd)).toBeCloseTo(micro(4 * PRO), 9);
    expect(Number(line.billed_credits ?? 0)).toBe(0);
    /* One download attempt only: the next passes do nothing, and the vendor's copy is gone. */
    expect(vendor.calls.filter((c) => c === "download")).toHaveLength(1);
    expect(vendor.calls).toEqual(expect.arrayContaining(["deleteJob:job_1"]));
    const again = fakeVendor();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
    /* A transient failure is still retried (the job is not settled by it). */
    const w2 = await world();
    const id2 = String((await admit(w2, { maxCredits: 100 })).body.id);
    const flaky = fakeVendor({ downloadError: new Error("socket hang up") });
    await expect(run(id2, flaky.deps, 3)).rejects.toThrow();
    expect((await gen(id2)).status).toBe("running");
  });
});

test("an upload is read only by a person who may open it, for an Atomik run (as its owner, a member) as for a person; with no person behind the request nothing is read", async () => {
  const { admitLipSync } = await import("../../lib/lipSync");
  const { runInTenant } = await import("../../lib/tenant");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  const { db, ready } = await import("../../lib/db");
  process.env.SYNC_ENABLED = "1";
  const agentUser = (runId: string) => ({ ...OWNER.user, id: `agent:${runId}`, role: "member", owner: false }) as AdmissionActor["user"];
  await runInTenant(house(), async () => {
    await ready(); await rigAgentReady();
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_lip_owned", "prod_x", "draft_x", "u_runner", "req_lip", "goal", "auto", "finished"] });
    const mine = { clip: await upload("clip", "video", 4, "u_runner"), voice: await upload("voice", "audio", 5, "u_runner") };
    const theirs = { clip: await upload("clip", "video", 4, "u_other"), voice: await upload("voice", "audio", 5, "u_other") };
    const ask = (actor: AdmissionActor, clip: string, voice: string) => admitLipSync({ clipUploadId: clip, audioUploadId: voice, quoteOnly: true }, actor, options(), {});
    const agent = (runId: string): AdmissionActor => ({ user: agentUser(runId) });
    /* The run acts for the person who started it: their own uploads, yes; another person's private one, no. */
    await runInTenant(house(), async () => {
      expect((await ask(agent("run_lip_owned"), mine.clip, mine.voice)).status).toBe(200);
      for (const [clip, voice] of [[theirs.clip, mine.voice], [mine.clip, theirs.voice]]) expect(await ask(agent("run_lip_owned"), clip, voice), `${clip} ${voice}`).toMatchObject({ status: 404, body: { error: expect.stringMatching(/not in this workspace/) } });
    }, { user: agentUser("run_lip_owned") } as never);
    /* No person behind the run (an unknown run), and nothing is read: refused before the sources are looked at. */
    await runInTenant(house(), async () => {
      expect(await ask(agent("run_none"), mine.clip, mine.voice)).toMatchObject({ status: 403, body: { error: "A person must be behind this request to use their uploads." } });
      expect(await ask(agent("run_none"), "../x", "../y")).toMatchObject({ status: 403 });
    }, { user: agentUser("run_none") } as never);
    /* A signed-in person is judged the same way: their own, yes; another person's private upload, no. */
    const person: AdmissionActor = { user: { ...OWNER.user, id: "u_runner", role: "member", owner: false } as AdmissionActor["user"] };
    await runInTenant(house(), async () => {
      expect((await ask(person, mine.clip, mine.voice)).status).toBe(200);
      expect((await ask(person, theirs.clip, mine.voice)).status).toBe(404);
    }, { user: person.user } as never);
  }, OWNER as never);
});

test("the shot cap is judged at the quote and the press, before any row is written: a member past it is refused 403 (needs an admin) with no take left; an admin, a shot under its cap, no shot, and a rule that is not 'cap' go through", async () => {
  const { admitLipSync } = await import("../../lib/lipSync");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  process.env.SYNC_ENABLED = "1";
  const MEMBER: AdmissionActor = { user: { ...OWNER.user, id: "member_1", role: "member", owner: false } as AdmissionActor["user"] };
  const { runInTenant } = await import("../../lib/tenant");
  /* The admission judges the actor against the request's own signed-in person, so the member's presses run as the member and the admin's as the admin. */
  await runInTenant(house(), async () => {
    await ready();
    const setRule = async (rule: string | null, cap?: number) => {
      for (const [key, value] of [["approvalRule", rule], ["shotCapCredits", cap == null ? null : String(cap)]] as const) {
        if (value === null) await db().execute({ sql: "DELETE FROM settings WHERE key=?", args: [key] }); else await setSetting(key, value, "admin");
      }
      invalidateSettings();
    };
    const w = await world();
    const shotId = uid("shot");
    await db().execute({ sql: "INSERT INTO shots (id, project_id, code, title, created_at, updated_at) VALUES (?,?,?,?,0,0)", args: [shotId, w.projectId, "S01", "A shot"] });
    const rows = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    const seams = {};
    const press = (actor: AdmissionActor, extra: Record<string, unknown> = {}) => admitLipSync({ ...w.body, shotId, maxCredits: 100000, ...extra }, actor, options(), seams);
    try {
      await setRule("cap", 1);
      const before = { rows: await rows(), meter: (await meterRows()).length, handed: deferred.length };
      for (const extra of [{ quoteOnly: true }, {}]) {
        const refused = await press(MEMBER, extra);
        expect(refused, JSON.stringify(extra)).toMatchObject({ status: 403, body: { needsAdmin: true } });
        expect(String(refused.body.error)).toMatch(/S01/);
      }
      expect(await rows()).toBe(before.rows);
      expect((await meterRows()).length).toBe(before.meter);
      expect(deferred.length).toBe(before.handed);
      /* An admin's goes through; so does a member's take on a shot with no code to speak of, a request with no shot, and any rule but "cap". */
      await runInTenant(house(), async () => { expect((await press(OWNER, { quoteOnly: true })).status).toBe(200); }, OWNER as never);
      /* An admin who is not a person at the press (a token, an agent, a step Atomik's Auto approved) never skips the cap. */
      const TOKEN = { id: "tok_admin", name: "Assistant", scope: "render" as const, capUsd: null };
      const ADMIN_TOKEN: AdmissionActor = { ...OWNER, token: TOKEN };
      const AGENT: AdmissionActor = { user: { ...OWNER.user, id: "agent:run_1" } as AdmissionActor["user"] };
      /* The run acts for a person (its owner), so the cap is what refuses it. */
      const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
      await rigAgentReady();
      await db().execute({ sql: "INSERT OR IGNORE INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_1", "prod_x", "draft_x", "u_runner", "req_cap", "goal", "auto", "finished"] });
      await runInTenant(house(), async () => {
        for (const extra of [{ quoteOnly: true }, {}]) expect(await press(ADMIN_TOKEN, extra), `token ${JSON.stringify(extra)}`).toMatchObject({ status: 403, body: { needsAdmin: true } });
      }, { user: ADMIN_TOKEN.user, token: TOKEN } as never);
      await runInTenant(house(), async () => {
        for (const extra of [{ quoteOnly: true }, {}]) expect(await press(AGENT, extra), `agent ${JSON.stringify(extra)}`).toMatchObject({ status: 403, body: { needsAdmin: true } });
      }, AGENT as never);
      await runInTenant(house(), async () => {
        for (const quoteOnly of [true, undefined]) expect(await admitLipSync({ ...w.body, shotId, maxCredits: 100000, quoteOnly }, OWNER, { ...options(), run: { auto: true } as never }, seams), `auto ${String(quoteOnly)}`).toMatchObject({ status: 403, body: { needsAdmin: true } });
      }, OWNER as never);
      expect((await press(MEMBER, { quoteOnly: true, shotId: undefined })).status).toBe(200);
      await setRule("ask");
      expect((await press(MEMBER, { quoteOnly: true })).status).toBe(200);
      await setRule("cap", 100000);
      expect((await press(MEMBER, { quoteOnly: true })).status).toBe(200);
      const made = await press(MEMBER);
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      expect(await rows()).toBe(before.rows + 1);
    } finally { await setRule(null); }
  }, MEMBER as never);
});

test("a claim that never got both inputs up never reached the submit and settles at nothing; one with both inputs and no job id is a lost acknowledgement, held", async () => {
  const { advanceLipSyncJobWith } = await import("../../lib/lipSync");
  const { db } = await import("../../lib/db");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const late = () => Date.now() + 60 * 60_000;
    for (const [assets, want] of [[{}, "failed"], [{ videoAsset: "va" }, "failed"], [{ videoAsset: "va", audioAsset: "aa" }, "uncertain"]] as const) {
      const w = await world();
      const genId = String((await admit(w, { maxCredits: 100 })).body.id);
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.lipsync.claimedAt',1,'$.lipsync.videoAsset',?,'$.lipsync.audioAsset',?) WHERE id=?", args: [(assets as { videoAsset?: string }).videoAsset ?? null, (assets as { audioAsset?: string }).audioAsset ?? null, genId] });
      const vendor = fakeVendor();
      const lip = await advanceLipSyncJobWith(genId, { ...vendor.deps, clock: late });
      expect(lip?.status, JSON.stringify(assets)).toBe(want);
      expect(vendor.calls.filter((c) => c.startsWith("submit"))).toEqual([]);
      const row = (await meterRows()).find((r) => r.id === genId)!;
      expect(row.status).toBe(want === "failed" ? "failed" : "running");
      if (want === "failed") expect(Number(row.engine_cost_usd)).toBe(0);
    }
  });
});

test("engine on, a workspace at its own $0 cap (the house-only wall lifted for the test): refused 429 in the cap's words, with nothing held, written or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  await platformReady();
  const ws = "ws_lipsync_cap0";
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,0)", args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`] });
  await grantCredits(ws, 500, "Test", "owner", "manual");
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  const setSite = (v: unknown) => platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify(v)] });
  try {
    await setSite({ enginesOnWorkspaces: [ws] });
    process.env.SYNC_ENABLED = "1";
    const row = (await getWorkspace(ws))!;
    expect(row.allowanceUsd).toBe(0);
    await asTenant(row, async () => {
      const w = await world();
      const before = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      /* (The house-only wall is lifted for this test, to prove the cap wall.) */
      const reply = await admit(w, { maxCredits: 100000 }, { houseOnly: false });
      expect(reply.status, JSON.stringify(reply.body)).toBe(429);
      expect(String(reply.body.error)).toMatch(/monthly cap on the platform's engines/);
      expect(String(reply.body.error)).not.toMatch(/\$|\d/);
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(before);
      const mine = (await (await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=?", args: [ws] })).rows);
      expect(mine).toEqual([]);
      expect(deferred.length).toBe(handedOff);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("the approval fingerprint names the engine that will be paid, not a guess from the model's provider", async () => {
  const { admitLipSync } = await import("../../lib/lipSync");
  const { admissionReply } = await import("../../lib/admissionSupport");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    let captured: { compiled: Record<string, unknown> } | null = null;
    const reply = await admitLipSync({ ...w.body, maxCredits: 100 }, OWNER, { defer: async () => {}, checkpoint: (value) => { captured = value; return admissionReply({ prepared: true }); } }, {});
    expect(reply.body).toEqual({ prepared: true });
    expect((captured!.compiled.funding as { engine: string }).engine).toBe("syncso");
  });
});

test("what a person reads of a lip-sync take: its state, model, mode and length, and none of the vendor's ids, links, claims, consent ids or rates", async () => {
  const { db } = await import("../../lib/db");
  const { rowToGeneration } = await import("../../lib/jobs");
  const { publicDirectParams } = await import("../../lib/directEnginePublic");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const genId = String((await admit(w, { maxCredits: 100 })).body.id);
    await run(genId, fakeVendor({ outputDuration: 4, deleteJobError: true }).deps, 4);
    const raw = (await db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [genId] })).rows[0];
    const rawParams = JSON.parse(String(raw.params));
    /* The row keeps the workflow's record in full (the proof there is something to hide)... */
    expect(Object.keys(rawParams.lipsync)).toEqual(expect.arrayContaining(["syncId", "videoAsset", "audioAsset", "rateUsdPerSecond", "pollUntil", "claimedAt"]));
    expect(rawParams.lipsync.syncId).toBe("job_1");
    /* ...and every read goes through the projection. */
    const read = rowToGeneration({ ...raw, project_name: null }) as unknown as { params: Record<string, unknown> };
    expect(read.params.lipsync).toEqual({ status: "done", model: "lipsync-2-pro", syncMode: "bounce", seconds: 5 });
    expect(JSON.stringify(read.params.lipsync)).not.toMatch(/job_1|asset|consent|faceSha|rate|castMember|poll|claim|usd|cleanup|reconcile/i);
    expect(publicDirectParams({ task: "other", x: { syncId: "kept" } })).toEqual({ task: "other", x: { syncId: "kept" } });
    expect(publicDirectParams({ task: "lipsync" })).toEqual({ task: "lipsync" });
  });
});

/** Every source file under lib, app and components. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out.push(p.split(path.sep).join("/")); } };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

test("structure: the seams stay internal, the route is the one door, no consent is checked, and the settings are the plan's names", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitLipSync\b/)).toEqual(["lib/lipSync.ts"]);
  expect(reachers(/\badvanceLipSyncJobWith\b/)).toEqual(["lib/lipSync.ts"]);
  expect(reachers(/@\/lib\/lipSync["']/)).toEqual(["app/api/lipsync/route.ts"]);
  const flow = readFileSync("lib/lipSync.ts", "utf8");
  /* No consent is checked, of a face or a voice (owner, 16 Oct 2026). */
  const at = (needle: string) => flow.indexOf(needle);
  expect(flow.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/consent|rekognition|faceSha256|faceFrame|castMember|voices/i);
  /* House only: the engine gate and the house wall. */
  expect(flow).toContain("seams.houseOnly !== false && !isHouseWorkspace(workspace)");
  expect(at("INSERT INTO generations")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (deps.submit ?? submitLipSync)("));
  /* The admission takes no override from the public face. */
  expect(flow).toContain("admitLipSync(input, got, options, {})");
  /* Prices come from the rate table and the margin path: no dollar literal in the workflow. */
  expect(flow).not.toMatch(/0\.0\d+|0\.1\d+/);
  expect(flow).toContain("quotedCredits(usd, model)");
  /* The price file is read once, at the quote; settling reads only the rate kept on the row. */
  expect(flow.match(/fileVendorQuote\(/g)).toHaveLength(1);
  expect(flow.match(/lipSyncQuoteUsd\(/g)).toHaveLength(1);
  expect(at("lipSyncQuoteUsd(seconds, model)")).toBeLessThan(at("INSERT INTO generations"));
  expect(flow).not.toMatch(/fileVendorCostUsd|vendorRates/);
  /* The only environment names: the plan's. */
  const names = new Set([...readFileSync("lib/syncso.ts", "utf8").matchAll(/process\.env\.(SYNC_[A-Z_]+)/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual(["SYNC_API_KEY", "SYNC_BASE_URL"]);
  expect(readFileSync("lib/syncso.ts", "utf8")).toContain('export const SYNC_SWITCH = "SYNC_ENABLED";');
  /* No AWS or other vendor SDK, and no log of a source, an asset or a key. */
  expect(readFileSync("lib/syncso.ts", "utf8")).not.toMatch(/console\.(log|error|info)|@aws-sdk/);
  /* The vendor's copy is deleted after the output is stored and the take settled, in that order. */
  expect(at("await (deps.store ?? storeVideoBytes)(")).toBeLessThan(at('await settleLipSync(genId, "done"'));
  expect(at('await settleLipSync(genId, "done"')).toBeLessThan(at("await cleanupLipSyncVendor(genId, deps).catch(() => {});\n      return (await load(genId, { any: true }))?.lip ?? null;\n    } catch (error) {"));
});
