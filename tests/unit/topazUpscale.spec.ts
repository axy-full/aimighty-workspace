import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";
import type { TopazDeps, TopazParams } from "../../lib/topazUpscale";

/**
 * Topaz upscale, direct (lib/topazDirect.ts, lib/topazUpscale.ts). Mocked: every adapter call is a function this file hands the workflow (the internal seams `admitTopaz` and
 * `advanceTopazJobWith`, which the public route and the cron do not offer), or the in-process fixture under ENGINE_MOCK=1; no request leaves this process and no provider is paid.
 * Local temporary databases only. Neutral sample names.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-topaz-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.TOPAZ_DIRECT_ENABLED; delete process.env.TOPAZ_API_KEY; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] };
let n = 0;
const uid = (label: string) => `${label}_${Date.now().toString(36)}_${++n}`;
const made: string[] = [];
test.afterAll(async () => { for (const f of made) await unlink(f).catch(() => {}); });
async function asTenant(ws: TenantWorkspace, fn: () => Promise<void>): Promise<void> {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, fn, OWNER as never);
}
const deferred: (() => Promise<unknown>)[] = [];
const options = (): AdmissionExecution => ({ defer: async (work) => { deferred.push(work); } });
const SETTINGS = { model: "High Fidelity V2", factor: 2, faceEnhancement: false, faceStrength: 0.5 };
const ASTRA = { creativity: 0.5, realism: 0.5, sharpness: 0.5, fps: 30 };

/** A real still of this workspace (a PNG of the size asked), stored as an upload. */
async function still(label: string, width = 2000, height = 1000): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  const sharp = (await import("sharp")).default;
  await ready();
  const id = uid(label);
  const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 40, g: 80, b: 120 } } }).png().toBuffer();
  const stored = await storeUpload(id, "png", bytes, "image/png");
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.png`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.png`, "image/png", "png", bytes.length, "x", width, height, stored.url, Date.now(), "image"] });
  return id;
}
/** The 720 x 1280, 1.5 second clip of tests/fixtures, stored as an upload. */
async function clip(label: string): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const bytes = readFileSync("tests/fixtures/astra-source.mp4");
  const stored = await storeUpload(id, "mp4", bytes, "video/mp4");
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.mp4`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,duration_s) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.mp4`, "video/mp4", "mp4", bytes.length, "x", 720, 1280, stored.url, Date.now(), "video", 1.5] });
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
  return (await platformDb().execute("SELECT id,workspace_id,status,engine_cost_usd,overrun_usd,billed_credits,paid_by_platform FROM meter_events WHERE engine='topaz' ORDER BY created_at, id")).rows;
}
async function gen(id: string) {
  const { db } = await import("../../lib/db");
  const r = (await db().execute({ sql: "SELECT kind,model,provider,status,stored_url,bytes,cost_usd,error,source_gen_id,duration_s,provider_outcome,json_extract(params,'$.topaz') AS topaz FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
  return { ...r, topaz: JSON.parse(String(r.topaz)) as TopazParams } as { kind: string; model: string; provider: string; status: string; stored_url: string | null; bytes: number | null; cost_usd: number | null; error: string | null; source_gen_id: string | null; duration_s: number | null; provider_outcome: string | null; topaz: TopazParams };
}
async function admit(input: Record<string, unknown>) {
  const { admitTopaz } = await import("../../lib/topazUpscale");
  return admitTopaz(input, OWNER, options());
}
const approved = { maxCredits: 100000 };

/** An in-memory Topaz: records every call, answers as asked. */
function fakeTopaz(over: { credits?: number | null; failCredits?: number | null; fail?: string; imageSubmitError?: Error; createError?: Error; uploadError?: Error; completeError?: Error; estimateHigh?: number; deleteFails?: number; noUrlPolls?: number; polls?: number; downloadError?: Error } = {}) {
  const calls: string[] = [];
  const sent: { submit?: Record<string, unknown>; create?: Record<string, unknown> } = {};
  let polls = 0, noUrl = over.noUrlPolls ?? 0, deleteFails = over.deleteFails ?? 0;
  const ready = over.polls ?? 2;
  const credits = over.credits === undefined ? undefined : over.credits;
  const deps: TopazDeps = {
    submitImage: async (input) => { calls.push("submit"); sent.submit = { filename: input.filename, mime: input.mime, width: input.width, height: input.height, model: input.settings.model, factor: input.settings.factor, bytes: input.bytes.length }; if (over.imageSubmitError) throw over.imageSubmitError; return { id: "topaz_img_1", outputMegapixels: 8, credits: 1 }; },
    imageStatus: async () => { polls++; calls.push("status"); if (over.fail) return { id: "topaz_img_1", status: "failed" as const, error: over.fail, ...(over.failCredits != null ? { credits: over.failCredits } : {}) }; return polls < ready ? { id: "topaz_img_1", status: "processing" as const } : { id: "topaz_img_1", status: "completed" as const, ...(credits != null ? { credits } : {}) }; },
    downloadImage: async () => { calls.push("download"); if (over.downloadError) throw over.downloadError; return Buffer.from("upscaled-image"); },
    createVideo: async (input) => { calls.push("create"); sent.create = { sizeBytes: input.source.sizeBytes, width: input.source.width, height: input.source.height, fps: input.settings.fps }; if (over.createError) throw over.createError; return { id: "topaz_vid_1", estimatedCredits: over.estimateHigh != null ? { low: 1, high: over.estimateHigh } : { low: 6, high: 8 }, output: { width: 1216, height: 2160, frameRate: input.settings.fps } }; },
    accept: async () => { calls.push("accept"); return { uploadUrls: ["https://topaz-up.s3.amazonaws.com/p1"] }; },
    uploadParts: async (urls, bytes) => { calls.push("upload"); if (over.uploadError) throw over.uploadError; return urls.map((_, i) => ({ partNum: i + 1, eTag: `t${i}` + bytes.length })); },
    complete: async () => { calls.push("complete"); if (over.completeError) throw over.completeError; },
    videoStatus: async () => {
      polls++; calls.push("status");
      if (over.fail) return { id: "topaz_vid_1", status: "failed" as const, error: over.fail, ...(over.failCredits != null ? { credits: over.failCredits } : {}) };
      if (polls < ready) return { id: "topaz_vid_1", status: "processing" as const };
      if (noUrl-- > 0) return { id: "topaz_vid_1", status: "completed" as const, ...(credits != null ? { credits } : {}) };
      return { id: "topaz_vid_1", status: "completed" as const, downloadUrl: "https://dl.topazlabs.com/out.mp4", ...(credits != null ? { credits } : {}) };
    },
    downloadVideo: async () => { calls.push("download"); if (over.downloadError) throw over.downloadError; return Buffer.from("upscaled-clip"); },
    deleteMedia: async () => { calls.push("delete"); if (deleteFails-- > 0) throw new Error("not yet"); return true; },
    cancel: async () => { calls.push("cancel"); return true; },
    store: async (genId, bytes, kind) => { calls.push("store"); return { url: `stored/${genId}.${kind === "image" ? "png" : "mp4"}`, bytes: bytes.length }; },
  };
  return { deps, calls, sent };
}
async function run(genId: string, deps: TopazDeps, times = 5) {
  const { advanceTopazJobWith } = await import("../../lib/topazUpscale");
  let last = null;
  for (let i = 0; i < times; i++) last = await advanceTopazJobWith(genId, deps);
  return last;
}

test("off: with the switch off, or a workspace not on the list, there is no tool, no door and nothing metered; listed or the house, with the switch exactly 1, both tools are offered", async () => {
  const { topazTools } = await import("../../lib/topazUpscale");
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    delete process.env.TOPAZ_DIRECT_ENABLED;
    expect(await topazTools()).toEqual([]);
    expect(await admit({ tool: "image", ...approved })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    process.env.TOPAZ_DIRECT_ENABLED = "on";
    expect(await topazTools()).toEqual([]);
    process.env.TOPAZ_DIRECT_ENABLED = "1";
    const on = await topazTools();
    expect(on.map((t) => t.id)).toEqual(["topaz_upscale_image", "topaz_upscale_video"]);
    expect(on.every((t) => t.provider === "topaz" && t.route === "/api/topaz" && t.needs.join() === "TOPAZ_API_KEY,TOPAZ_DIRECT_ENABLED")).toBe(true);
    expect((await meterRows()).length).toBe(before);
  });
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  await asTenant(tenant("ws_topaz_unlisted"), async () => {
    expect(await topazTools()).toEqual([]);
    expect(await admit({ tool: "image", quoteOnly: true })).toMatchObject({ status: 404 });
  });
});

test("the quote: the credits of the output size or the output frames at Developer's dearer reading, through the margin path keyed by the model; a quote writes nothing; every input refused in words first", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  const { quotedCredits } = await import("../../lib/credits");
  const { db } = await import("../../lib/db");
  await asTenant(house(), async () => {
    const { ready } = await import("../../lib/db");
    await ready();
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    /* A still: 2000 x 1000 at 2x is 8 MP (1 credit, $0.10); 3500 x 2000 at 2x is 28 MP (2 credits); 4000 x 3000 at 2x is 48 MP (3 credits). */
    for (const [w, h, credits] of [[2000, 1000, 1], [3500, 2000, 2], [4000, 3000, 3]] as const) {
      const src = await still("q", w, h);
      const q = await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, quoteOnly: true });
      expect(q.status, JSON.stringify(q.body)).toBe(200);
      expect(q.body).toMatchObject({ tool: "image", model: "fal-ai/topaz/upscale/image", outputWidth: w * 2, outputHeight: h * 2 });
      expect(q.body.estimatedCredits).toBe(quotedCredits(credits * 0.1, "fal-ai/topaz/upscale/image"));
    }
    /* A clip: 720 x 1280 for 1.5 s to 4K (1216 x 2160) at 30 fps is 8 credits (7.5 rounded up); 60 fps is 15. */
    const video = await clip("q");
    const q30 = await admit({ tool: "video", sourceUploadId: video, astra: ASTRA, quoteOnly: true });
    expect(q30.body).toMatchObject({ tool: "video", model: "topaz/upscale/video/creative", outputWidth: 1216, outputHeight: 2160, seconds: 1.5, fps: 30 });
    expect(q30.body.estimatedCredits).toBe(quotedCredits(0.8, "topaz/upscale/video/creative"));
    const q60 = await admit({ tool: "video", sourceUploadId: video, astra: { ...ASTRA, fps: 60 }, quoteOnly: true });
    expect(q60.body.estimatedCredits).toBe(quotedCredits(1.5, "topaz/upscale/video/creative"));
    /* Refusals, in words, before anything is reserved. */
    const src = await still("r");
    const refused: [Record<string, unknown>, number, RegExp][] = [
      [{ tool: "audio" }, 400, /image or video/],
      [{ tool: "image", topaz: SETTINGS }, 400, /one image original/],
      [{ tool: "image", sourceUploadId: src, sourceGenId: "g1", topaz: SETTINGS }, 400, /one image original/],
      [{ tool: "image", sourceUploadId: "../x", topaz: SETTINGS }, 400, /not valid/],
      [{ tool: "image", sourceUploadId: "up_missing", topaz: SETTINGS }, 404, /not in this workspace/],
      [{ tool: "image", sourceUploadId: src }, 400, /supported Topaz model/],
      [{ tool: "image", sourceUploadId: src, topaz: { ...SETTINGS, factor: 3 } }, 400, /supported Topaz model/],
      [{ tool: "image", sourceUploadId: await still("big", 6000, 4000), topaz: SETTINGS }, 400, /48 megapixels|smaller scale/],
      [{ tool: "video", sourceUploadId: video }, 400, /30 or 60 fps/],
      [{ tool: "video", sourceUploadId: video, astra: { ...ASTRA, fps: 24 } }, 400, /30 or 60 fps/],
      [{ tool: "video", sourceUploadId: src, astra: ASTRA }, 404, /not in this workspace/],
      [{ tool: "video", sourceUploadId: video, sourceGenId: "g1", astra: ASTRA }, 400, /one clip/],
      [{ tool: "video", sourceUploadId: video, astra: ASTRA, projectId: "prod_missing" }, 404, /not in this workspace/],
    ];
    for (const [body, status, words] of refused) { const r = await admit({ ...body, quoteOnly: true }); expect(r.status, JSON.stringify(body)).toBe(status); expect(String(r.body.error), JSON.stringify(body)).toMatch(words); }
    /* Neither a quote nor a refusal wrote a row or a meter line. */
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
  });
});

test("approval: a price that is not approved, or is above the approved amount, runs and writes nothing", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  await asTenant(house(), async () => {
    const { db } = await import("../../lib/db");
    const src = await still("a");
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    for (const bad of [{}, { maxCredits: 0 }, { maxCredits: "5" }, { maxCredits: 1.5 }]) expect((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...bad })).status, JSON.stringify(bad)).toBe(409);
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
  });
});

test("a still: funded at the quote, the original's bytes go up as data at the size the server measured, the output is stored under the workspace, the take is linked to its original and settled at the credits Topaz reports; never above the quote; its vendor copy has no endpoint, and the row says so", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  await asTenant(house(), async () => {
    await project("p_topaz");
    const src = await still("s", 2000, 1000);
    const before = (await meterRows()).length;
    const handedOff = deferred.length;
    const reply = await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, projectId: "p_topaz", ...approved });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(deferred.length).toBe(handedOff + 1);
    const genId = String(reply.body.id);
    const held = (await meterRows()).slice(before);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: genId, status: "running" });
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(0.1, 6);
    const vendor = fakeTopaz({ credits: 1 });
    const t = await run(genId, vendor.deps, 4);
    expect(t).toMatchObject({ status: "done", settled: 1, cleanupDue: 0, vendorDeleted: 0 });
    expect(vendor.calls).toEqual(["submit", "status", "status", "download", "store"]);
    expect(vendor.sent.submit).toMatchObject({ width: 2000, height: 1000, model: "High Fidelity V2", factor: 2 });
    expect(Number(vendor.sent.submit!.bytes)).toBeGreaterThan(0);
    const take = await gen(genId);
    expect(take).toMatchObject({ kind: "image", model: "fal-ai/topaz/upscale/image", provider: "topaz", status: "succeeded", stored_url: `stored/${genId}.png`, source_gen_id: null });
    expect(Number(take.cost_usd)).toBeCloseTo(0.1, 6);
    expect(take.topaz.reconcile).toBe(0);
    const settled = (await meterRows()).slice(before);
    expect(settled[0]).toMatchObject({ id: genId, status: "succeeded" });
    expect(Number(settled[0].engine_cost_usd)).toBeCloseTo(0.1, 6);
    expect(Number(settled[0].billed_credits ?? 0)).toBe(0);
    /* Another step on a finished job does nothing. */
    const again = fakeTopaz();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
    /* Topaz reports less: that is the cost. More than the quote: billed at the quote, the excess the overrun, marked to reconcile. None reported: the quote, marked to reconcile. */
    for (const [credits, expected, over, reconcile] of [[0, 0, null, 0], [4, 0.1, 0.3, 1], [null, 0.1, null, 1]] as const) {
      const id = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...approved })).body.id);
      await run(id, fakeTopaz({ credits }).deps, 4);
      const done = await gen(id);
      expect(Number(done.cost_usd), String(credits)).toBeCloseTo(expected, 6);
      expect(done.topaz.reconcile, String(credits)).toBe(reconcile);
      const line = (await meterRows()).find((r) => r.id === id)!;
      expect(Number(line.engine_cost_usd), String(credits)).toBeCloseTo(expected, 6);
      if (over === null) expect(line.overrun_usd ?? null).toBeNull(); else expect(Number(line.overrun_usd)).toBeCloseTo(over, 6);
      expect(Number(line.billed_credits ?? 0)).toBe(0);
    }
  });
});

test("a clip: request, accept, parts and the completed upload, then the output stored, the take settled at Topaz's credits (never above the quote), linked to its source with its length, and the vendor's copy deleted after storing", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  await asTenant(house(), async () => {
    const source = await clip("v");
    const before = (await meterRows()).length;
    const reply = await admit({ tool: "video", sourceUploadId: source, astra: { ...ASTRA, fps: 60 }, ...approved });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const genId = String(reply.body.id);
    expect(Number((await meterRows()).slice(before)[0].engine_cost_usd)).toBeCloseTo(1.5, 6);
    const vendor = fakeTopaz({ credits: 10 });
    const t = await run(genId, vendor.deps, 5);
    expect(t).toMatchObject({ status: "done", settled: 1, cleanupDue: 0, vendorDeleted: 1 });
    expect(vendor.calls).toEqual(["create", "accept", "upload", "complete", "status", "status", "download", "store", "delete"]);
    expect(vendor.sent.create).toMatchObject({ width: 720, height: 1280, fps: 60 });
    const take = await gen(genId);
    expect(take).toMatchObject({ kind: "video", model: "topaz/upscale/video/creative", provider: "topaz", status: "succeeded", stored_url: `stored/${genId}.mp4` });
    expect(Number(take.duration_s)).toBeCloseTo(1.5, 3);
    expect(Number(take.cost_usd)).toBeCloseTo(1.0, 6);
    const line = (await meterRows()).find((r) => r.id === genId)!;
    expect(Number(line.engine_cost_usd)).toBeCloseTo(1.0, 6);
    expect(Number(line.billed_credits ?? 0)).toBe(0);
    /* A finished clip with no download address yet is asked again; a delete that fails is retried by the cron and never fails the take. */
    const id2 = String((await admit({ tool: "video", sourceUploadId: source, astra: ASTRA, ...approved })).body.id);
    const slow = fakeTopaz({ credits: 5, noUrlPolls: 2, deleteFails: 1 });
    const mid = await run(id2, slow.deps, 3);
    expect(mid?.status).toBe("submitted");
    expect(slow.calls.includes("download")).toBe(false);
    const finished = await run(id2, slow.deps, 3);
    expect(finished).toMatchObject({ status: "done", cleanupDue: 1, cleanupTries: 1 });
    const { recoverTopazJobs } = await import("../../lib/topazUpscale");
    await recoverTopazJobs({ limit: 10 }, slow.deps);
    expect((await gen(id2)).topaz).toMatchObject({ cleanupDue: 0, vendorDeleted: 1 });
    expect((await gen(id2)).status).toBe("succeeded");
  });
});

test("a clip whose own estimate is above the approved price uploads nothing, is cancelled at Topaz and costs nothing; an upload that fails before the work starts does the same", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  const { TopazError } = await import("../../lib/topazDirect");
  await asTenant(house(), async () => {
    const source = await clip("e");
    const before = (await meterRows()).length;
    for (const [label, over, words] of [["estimate", { estimateHigh: 99 }, /above the approved price/], ["upload", { uploadError: new TopazError("Topaz did not take the upload (403).", 403, null, true) }, /did not take the upload/], ["accept-less create", { createError: new TopazError("Topaz refused the request: no", 422, null, true) }, /refused the request/]] as const) {
      const id = String((await admit({ tool: "video", sourceUploadId: source, astra: ASTRA, ...approved })).body.id);
      const vendor = fakeTopaz(over);
      await run(id, vendor.deps, 3);
      const take = await gen(id);
      expect(take.status, label).toBe("failed");
      expect(String(take.error), label).toMatch(words);
      expect(String(take.error), label).toMatch(/Nothing was billed/);
      expect(Number(take.cost_usd ?? 0), label).toBe(0);
      expect(vendor.calls.includes("complete"), label).toBe(false);
      if (label === "estimate") expect(vendor.calls.includes("upload") || vendor.calls.includes("accept"), label).toBe(false);
      if (label !== "accept-less create") expect(vendor.calls.at(-1), label).toBe("cancel");
      const line = (await meterRows()).find((r) => r.id === id)!;
      expect(Number(line.engine_cost_usd ?? 0), label).toBe(0);
    }
    expect((await meterRows()).length).toBe(before + 3);
  });
});

test("a failure bills nothing: Topaz says failed (what it reports charged is recorded on the ledger line, unbilled; nothing reported is nothing, marked to reconcile), or refuses before work; the person reads 'Nothing billed'", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  const { TopazError } = await import("../../lib/topazDirect");
  await asTenant(house(), async () => {
    const src = await still("f");
    const video = await clip("f");
    for (const [tool, body] of [["image", { sourceUploadId: src, topaz: SETTINGS }], ["video", { sourceUploadId: video, astra: ASTRA }]] as const) {
      /* Charged: reported credits on a failure. */
      let id = String((await admit({ tool, ...body, ...approved })).body.id);
      await run(id, fakeTopaz({ fail: "unsupported codec", failCredits: 2 }).deps, 5);
      let take = await gen(id);
      expect(take.status, tool).toBe("failed");
      expect(String(take.error), tool).toMatch(/unsupported codec[\s\S]*Nothing was billed/);
      expect(take.topaz.reconcile, tool).toBe(0);
      let line = (await meterRows()).find((r) => r.id === id)!;
      expect(Number(line.engine_cost_usd), tool).toBeCloseTo(0.2, 6);
      expect(Number(line.billed_credits ?? 0), tool).toBe(0);
      /* Nothing reported: recorded as nothing and marked to reconcile. */
      id = String((await admit({ tool, ...body, ...approved })).body.id);
      await run(id, fakeTopaz({ fail: "bad" }).deps, 5);
      take = await gen(id);
      expect(take.topaz.reconcile, tool).toBe(1);
      line = (await meterRows()).find((r) => r.id === id)!;
      expect(Number(line.engine_cost_usd ?? 0), tool).toBe(0);
    }
    /* Refused before work (a still's submit answered 4xx): the whole reservation comes back. */
    const id = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...approved })).body.id);
    await run(id, fakeTopaz({ imageSubmitError: new TopazError("Topaz refused the request: bad image", 422, null, true) }).deps, 3);
    const take = await gen(id);
    expect(take.status).toBe("failed");
    expect(String(take.error)).toMatch(/Nothing was billed/);
    expect(JSON.parse(String(take.provider_outcome)).provider).toBe("topaz");
    expect(Number((await meterRows()).find((r) => r.id === id)!.engine_cost_usd ?? 0)).toBe(0);
  });
});

test("a lost acknowledgement is never sent again: a still's submit and a clip's completed upload end 'uncertain' and hold the reservation; a job that never reached them settles at nothing", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  await asTenant(house(), async () => {
    const src = await still("l");
    const video = await clip("l");
    for (const [tool, body, over, sentCall] of [["image", { sourceUploadId: src, topaz: SETTINGS }, { imageSubmitError: new Error("socket hang up") }, "submit"], ["video", { sourceUploadId: video, astra: ASTRA }, { completeError: new Error("socket hang up") }, "complete"]] as const) {
      const id = String((await admit({ tool, ...body, ...approved })).body.id);
      const vendor = fakeTopaz(over);
      expect((await run(id, vendor.deps, 1))?.status, tool).toBe("uncertain");
      const again = fakeTopaz();
      await run(id, again.deps, 3);
      expect(again.calls, tool).toEqual([]);
      expect(vendor.calls.filter((c) => c === sentCall), tool).toHaveLength(1);
      const take = await gen(id);
      expect(take.status, tool).toBe("running");
      expect(String(take.error), tool).toMatch(/will not be sent again/);
      const line = (await meterRows()).find((r) => r.id === id)!;
      expect(line.status, tool).toBe("running");
    }
    /* A claim that never reached the sending step (the worker died first) is judged by the clock: nothing was sent, so it settles at nothing. */
    const { advanceTopazJobWith } = await import("../../lib/topazUpscale");
    const { db } = await import("../../lib/db");
    const id = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...approved })).body.id);
    await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.topaz.claimedAt',?) WHERE id=?", args: [Date.now() - 11 * 60_000, id] });
    const stale = fakeTopaz();
    await advanceTopazJobWith(id, { ...stale.deps, clock: () => Date.now() });
    expect(stale.calls).toEqual([]);
    expect((await gen(id)).status).toBe("failed");
    expect(String((await gen(id)).error)).toMatch(/Nothing was submitted/);
  });
});

test("the shot cap is judged at the press, as the fal path judges it: a member past the shot's cap is refused 403 with no row, no hold and no failed take; an admin is not", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  const { admitTopaz } = await import("../../lib/topazUpscale");
  const { setSetting } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  await asTenant(house(), async () => {
    await ready();
    await project("p_topaz_cap");
    const shotId = uid("shot");
    await db().execute({ sql: "INSERT INTO shots(id,project_id,code,created_at,updated_at) VALUES(?,?,'SH010',1,1)", args: [shotId, "p_topaz_cap"] });
    const src = await still("cap", 4000, 3000);
    const member: AdmissionActor = { user: { ...OWNER.user, id: "member_1", role: "member", owner: false } as AdmissionActor["user"] };
    const { runInTenant } = await import("../../lib/tenant");
    const asMember = (fn: () => Promise<void>) => runInTenant(house(), fn, member as never);
    try {
      await setSetting("approvalRule", "cap", "admin");
      await setSetting("shotCapCredits", "1", "admin");
      const before = (await meterRows()).length;
      const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      const input = { tool: "image", sourceUploadId: src, topaz: SETTINGS, shotId, ...approved };
      await asMember(async () => {
        const refused = await admitTopaz(input, member, options());
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body).toMatchObject({ needsAdmin: true });
        expect(String(refused.body.error)).toMatch(/SH010/);
        /* A quote says so too. */
        expect((await admitTopaz({ ...input, quoteOnly: true }, member, options())).status).toBe(403);
      });
      /* Nothing was written, held or handed off. */
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
      expect((await meterRows()).length).toBe(before);
      expect(deferred.length).toBe(handedOff);
      /* An admin's own take goes through. */
      expect((await admitTopaz(input, OWNER, options())).status).toBe(200);
      /* A member's take under the cap goes through. */
      await setSetting("shotCapCredits", "100000", "admin");
      await asMember(async () => { expect((await admitTopaz(input, member, options())).status).toBe(200); });
    } finally { await setSetting("approvalRule", "anyone", "admin"); }
  });
});

test("the original goes up under its real name and type (PNG, JPEG or WebP), not always original.png", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  const { imageFileOf } = await import("../../lib/topazUpscale");
  expect(imageFileOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toEqual({ filename: "original.jpg", mime: "image/jpeg" });
  expect(imageFileOf(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toEqual({ filename: "original.webp", mime: "image/webp" });
  expect(imageFileOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ filename: "original.png", mime: "image/png" });
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  const sharp = (await import("sharp")).default;
  await asTenant(house(), async () => {
    await ready();
    for (const [ext, mime, filename] of [["jpg", "image/jpeg", "original.jpg"], ["webp", "image/webp", "original.webp"], ["png", "image/png", "original.png"]] as const) {
      const id = uid("fmt");
      const img = sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 1, g: 2, b: 3 } } });
      const bytes = await (ext === "jpg" ? img.jpeg() : ext === "webp" ? img.webp() : img.png()).toBuffer();
      const stored = await storeUpload(id, ext, bytes, mime);
      made.push(path.join(process.cwd(), ".data", "uploads", `${id}.${ext}`));
      await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.${ext}`, mime, ext, bytes.length, "x", 2000, 1000, stored.url, Date.now(), "image"] });
      const genId = String((await admit({ tool: "image", sourceUploadId: id, topaz: SETTINGS, ...approved })).body.id);
      const vendor = fakeTopaz({ credits: 1 });
      await run(genId, vendor.deps, 1);
      expect(vendor.sent.submit, ext).toMatchObject({ filename, mime });
    }
  });
});

test("a finished output that cannot be collected is not retried for ever: asked again inside the grace, then settled as a charged failure (recorded at what Topaz reported, billed to nobody), a clip's vendor copy deleted, the reason plain on the take", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  const { advanceTopazJobWith } = await import("../../lib/topazUpscale");
  await asTenant(house(), async () => {
    const src = await still("g");
    const video = await clip("g");
    for (const [tool, body, credits, usd] of [["image", { sourceUploadId: src, topaz: SETTINGS }, 1, 0.1], ["video", { sourceUploadId: video, astra: ASTRA }, 5, 0.5]] as const) {
      const id = String((await admit({ tool, ...body, ...approved })).body.id);
      const vendor = fakeTopaz({ credits, downloadError: new Error("the download was refused") });
      /* Inside the grace the pass fails and the job is kept to try again; nothing is settled. */
      for (let i = 0; i < 4; i++) await advanceTopazJobWith(id, vendor.deps).catch(() => {});
      expect((await gen(id)).status, tool).toBe("running");
      expect((await gen(id)).topaz.settled, tool).toBe(0);
      /* Past the grace it ends: settled once, charged at the reported credits, billed to nobody. */
      const late = { ...vendor.deps, clock: () => Date.now() + 31 * 60_000 };
      const done = await advanceTopazJobWith(id, late);
      expect(done, tool).toMatchObject({ status: "failed", settled: 1 });
      const take = await gen(id);
      expect(take.status, tool).toBe("failed");
      expect(String(take.error), tool).toBe("The upscale was ready but could not be saved in time. Nothing was billed.");
      expect(take.topaz.reconcile, tool).toBe(0);
      expect(JSON.parse(String(take.provider_outcome)), tool).toMatchObject({ provider: "topaz" });
      const line = (await meterRows()).find((r) => r.id === id)!;
      expect(line, tool).toMatchObject({ status: "failed" });
      expect(Number(line.engine_cost_usd), tool).toBeCloseTo(usd, 6);
      expect(Number(line.billed_credits ?? 0), tool).toBe(0);
      if (tool === "video") {
        /* The clip's vendor copy is deleted; a still has no endpoint. */
        expect(vendor.calls).toContain("delete");
        expect((await gen(id)).topaz).toMatchObject({ vendorDeleted: 1, cleanupDue: 0 });
      } else expect(vendor.calls).not.toContain("delete");
      /* Settled once: later passes do nothing. */
      const calls = vendor.calls.length;
      await advanceTopazJobWith(id, late);
      expect(vendor.calls.length, tool).toBe(calls);
    }
    /* Not reported: the quote, marked to reconcile. */
    const id = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...approved })).body.id);
    const quiet = fakeTopaz({ credits: null, downloadError: new Error("host not on the list") });
    for (let i = 0; i < 4; i++) await advanceTopazJobWith(id, quiet.deps).catch(() => {});
    await advanceTopazJobWith(id, { ...quiet.deps, clock: () => Date.now() + 31 * 60_000 });
    const take = await gen(id);
    expect(take.status).toBe("failed");
    expect(take.topaz.reconcile).toBe(1);
    expect(Number((await meterRows()).find((r) => r.id === id)!.engine_cost_usd)).toBeCloseTo(0.1, 6);
  });
});

test("two workers at once submit once; a storage failure keeps the job and the next pass finishes it", async () => {
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  await asTenant(house(), async () => {
    const src = await still("w");
    const id = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...approved })).body.id);
    const vendor = fakeTopaz({ credits: 1 });
    const slowSubmit = vendor.deps.submitImage!;
    vendor.deps.submitImage = async (input) => { await new Promise((r) => setTimeout(r, 50)); return slowSubmit(input); };
    await Promise.all([run(id, vendor.deps, 1), run(id, vendor.deps, 1)]);
    expect(vendor.calls.filter((c) => c === "submit")).toHaveLength(1);
    const flaky = fakeTopaz({ credits: 1 });
    let failedOnce = false;
    const store = flaky.deps.store!;
    flaky.deps.store = async (genId, bytes, kind) => { if (!failedOnce) { failedOnce = true; throw new Error("the disk is full"); } return store(genId, bytes, kind); };
    const id2 = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...approved })).body.id);
    const { advanceTopazJobWith } = await import("../../lib/topazUpscale");
    for (let i = 0; i < 6; i++) await advanceTopazJobWith(id2, flaky.deps).catch(() => {});
    expect((await gen(id2)).status).toBe("succeeded");
    expect(flaky.calls.filter((c) => c === "submit")).toHaveLength(1);
  });
});

test("a listed customer workspace pays exactly the quote in credits, once, and a failure refunds it; at its own $0 cap it is refused 429 with nothing held, written or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState, quotedCredits } = await import("../../lib/credits");
  const { db, ready } = await import("../../lib/db");
  const { TopazError } = await import("../../lib/topazDirect");
  await platformReady();
  const listed = "ws_topaz_listed", capped = "ws_topaz_cap0";
  for (const [id, cap] of [[listed, null], [capped, 0]] as const) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`, cap] });
    await grantCredits(id, 500, "Test", "owner", "manual");
  }
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [listed, capped] })] });
    process.env.TOPAZ_DIRECT_ENABLED = "1";
    await asTenant((await getWorkspace(listed))!, async () => {
      const src = await still("c");
      const expected = quotedCredits(0.1, "fal-ai/topaz/upscale/image");
      expect(await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, quoteOnly: true })).toMatchObject({ body: { unit: "cr", estimatedCredits: expected } });
      const start = (await creditState())!.balance;
      expect((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, maxCredits: expected - 1 })).status).toBe(409);
      expect((await creditState())!.balance).toBe(start);
      const id = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, maxCredits: expected })).body.id);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      await run(id, fakeTopaz({ credits: 1 }).deps, 4);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      const mine = (await meterRows()).filter((r) => r.workspace_id === listed);
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].billed_credits)).toBe(expected);
      /* A failure refunds it. */
      const bad = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, maxCredits: expected })).body.id);
      await run(bad, fakeTopaz({ imageSubmitError: new TopazError("Topaz refused the request: no", 422, null, true) }).deps, 2);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
    });
    await asTenant((await getWorkspace(capped))!, async () => {
      await ready();
      const src = await still("cap");
      const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      const reply = await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...approved });
      expect(reply.status, JSON.stringify(reply.body)).toBe(429);
      expect(String(reply.body.error)).toMatch(/monthly cap on the platform's engines/);
      expect(String(reply.body.error)).not.toMatch(/\$|\d/);
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
      expect((await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=?", args: [capped] })).rows).toEqual([]);
      expect(deferred.length).toBe(handedOff);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("the generate route's two Topaz models go to the direct door while the engine is on (the same quote, approval and price), and carry on with fal, unchanged, while it is off", async () => {
  const { imageUpscaleBody, videoUpscaleBody } = await import("../../lib/shell/upscale");
  const { topazBodyFromGenerate, TOPAZ_TASK } = await import("../../lib/topazUpscale");
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  /* The mapping is exact for the bodies the panels send, and a door body replays as it was captured. */
  expect(topazBodyFromGenerate(imageUpscaleBody({ origin: "upload", sourceId: "up_1" }, "p_1", SETTINGS as never))).toEqual({ tool: "image", sourceUploadId: "up_1", topaz: SETTINGS, projectId: "p_1" });
  expect(topazBodyFromGenerate(imageUpscaleBody({ origin: "generation", sourceId: "g_1" }, null, SETTINGS as never))).toMatchObject({ tool: "image", sourceGenId: "g_1" });
  expect(topazBodyFromGenerate(videoUpscaleBody({ origin: "generation", sourceId: "g_2" }, "p_1", ASTRA as never))).toEqual({ tool: "video", sourceGenId: "g_2", astra: ASTRA, projectId: "p_1" });
  expect(topazBodyFromGenerate({ tool: "video", sourceUploadId: "x", astra: ASTRA })).toEqual({ tool: "video", sourceUploadId: "x", astra: ASTRA });
  expect(topazBodyFromGenerate({ model: "dreamina-seedance-2-0-260128", prompt: "a tree" })).toBeNull();
  expect(topazBodyFromGenerate(imageUpscaleBody(null, null, SETTINGS as never))).toMatchObject({ tool: "image" });
  await asTenant(house(), async () => {
    const src = await still("g");
    const video = await clip("g");
    const before = (await meterRows()).length;
    process.env.TOPAZ_DIRECT_ENABLED = "1";
    const image = await prepareGeneration(imageUpscaleBody({ origin: "upload", sourceId: src }, null, SETTINGS as never), OWNER);
    expect(image.ok, JSON.stringify(image)).toBe(true);
    if (image.ok) expect(image.value).toMatchObject({ kind: "image", compiled: { task: TOPAZ_TASK, tool: "image" }, request: { maxCredits: image.value.quote.estimatedCredits } });
    const clipQuote = await prepareGeneration(videoUpscaleBody({ origin: "upload", sourceId: video }, null, ASTRA as never), OWNER);
    expect(clipQuote.ok, JSON.stringify(clipQuote)).toBe(true);
    if (clipQuote.ok) expect(clipQuote.value).toMatchObject({ kind: "video", compiled: { task: TOPAZ_TASK, tool: "video" } });
    /* A quote writes nothing. */
    expect((await meterRows()).length).toBe(before);
    /* Off: the same body goes down the fal path (which answers in its own words), never into the direct door. */
    delete process.env.TOPAZ_DIRECT_ENABLED;
    const off = await prepareGeneration(imageUpscaleBody({ origin: "upload", sourceId: src }, null, SETTINGS as never), OWNER);
    if (off.ok) expect(JSON.stringify(off.value.compiled)).not.toContain(TOPAZ_TASK); else expect(String(off.body.error ?? "")).not.toBe("There is no such tool here.");
  });
});

test("what a person may read of a Topaz take is the take's own words; the workflow's ids, claims and figures stay in the row", async () => {
  const { publicDirectParams } = await import("../../lib/directEnginePublic");
  const params = { task: "topaz_upscale", job: "fix", sourceGenId: "g_1", topaz: { status: "done", tool: "video", model: "topaz/upscale/video/creative", outputWidth: 3840, outputHeight: 2160, outputMegapixels: 0, seconds: 5, fps: 30, vendorId: "vendor-request-1", statedCredits: 24, reservedUsd: 2.5, quoteCredits: 25, claimedAt: 1, settled: 1, source: { kind: "generation", id: "g_1" }, settings: { creativity: 0.5 } } };
  const shown = publicDirectParams(params) as { topaz: Record<string, unknown> };
  expect(Object.keys(shown.topaz).sort()).toEqual(["fps", "model", "outputHeight", "outputMegapixels", "outputWidth", "seconds", "status", "tool"]);
  expect(JSON.stringify(shown)).not.toMatch(/vendor-request-1|reservedUsd|statedCredits|quoteCredits/);
  expect(publicDirectParams({ task: "topaz_upscale" })).not.toHaveProperty("topaz");
});

test("the declarations: both tools are declared with no draft (an upscale is a finishing step and always asks a person), follow the engine gate, send the panel's own defaults as flat arguments a prepared job can carry, and the door reads them", async () => {
  const { TOPAZ_DIRECT_TOOLS, TOPAZ_UPSCALE_IMAGE, TOPAZ_UPSCALE_VIDEO } = await import("../../lib/topazMcp");
  expect(TOPAZ_DIRECT_TOOLS.map((t) => t.def.name)).toEqual(["topaz_upscale_image", "topaz_upscale_video"]);
  expect(TOPAZ_DIRECT_TOOLS.every((t) => !("draft" in t))).toBe(true);
  expect(TOPAZ_UPSCALE_IMAGE.request({ source_take_id: "g_1" })).toEqual({ path: "/api/topaz", body: { tool: "image", sourceUploadId: undefined, sourceGenId: "g_1", projectId: undefined, preset: "High Fidelity V2", factor: 2, faceEnhancement: false, faceStrength: 0.5 } });
  expect(TOPAZ_UPSCALE_VIDEO.request({ source_upload_id: "up_1", fps: 60, creativity: 0.2 }).body).toMatchObject({ tool: "video", sourceUploadId: "up_1", creativity: 0.2, realism: 0.5, sharpness: 0.5, fps: 60 });
  /* Flat, so the prepared-jobs door takes them (its arguments are words, numbers and yes/no); the door reads them as the nested settings. */
  const { cleanEngineJob } = await import("../../lib/security/prepared-jobs");
  for (const tool of TOPAZ_DIRECT_TOOLS) { const { body } = tool.request({ source_take_id: "g_1" }); expect(() => cleanEngineJob({ engine: tool.def.name, args: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), prompt: tool.prepared(body) })).not.toThrow(); }
  await asTenant(house(), async () => {
    process.env.TOPAZ_DIRECT_ENABLED = "1";
    const src = await still("flat");
    const q = await admit({ ...TOPAZ_UPSCALE_IMAGE.request({ source_upload_id: src }).body, quoteOnly: true });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body).toMatchObject({ tool: "image", outputWidth: 4000, outputHeight: 2000 });
    delete process.env.TOPAZ_DIRECT_ENABLED;
  });
  expect(JSON.stringify(TOPAZ_DIRECT_TOOLS.map((t) => t.def))).not.toMatch(/maxCredits|max_credits/);
  await asTenant(house(), async () => {
    delete process.env.TOPAZ_DIRECT_ENABLED;
    expect(await Promise.all(TOPAZ_DIRECT_TOOLS.map((t) => t.present()))).toEqual([false, false]);
    process.env.TOPAZ_DIRECT_ENABLED = "1";
    expect(await Promise.all(TOPAZ_DIRECT_TOOLS.map((t) => t.present()))).toEqual([true, true]);
  });
});

test("the fixture end to end (ENGINE_MOCK): the default adapter submits, polls, downloads and cleans up in process, with the network forbidden", async () => {
  const { driveTopaz } = await import("../../lib/topazUpscale");
  process.env.TOPAZ_DIRECT_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const src = await still("m");
      const video = await clip("m");
      const img = String((await admit({ tool: "image", sourceUploadId: src, topaz: SETTINGS, ...approved })).body.id);
      await driveTopaz(img, { budgetMs: 20_000, pauseMs: 0 });
      expect(await gen(img)).toMatchObject({ status: "succeeded" });
      made.push(path.join(process.cwd(), ".data", "generations", `${img}.png`));
      const vid = String((await admit({ tool: "video", sourceUploadId: video, astra: ASTRA, ...approved })).body.id);
      await driveTopaz(vid, { budgetMs: 20_000, pauseMs: 0 });
      const done = await gen(vid);
      expect(done).toMatchObject({ status: "succeeded" });
      expect(done.topaz).toMatchObject({ vendorDeleted: 1, cleanupDue: 0 });
      made.push(path.join(process.cwd(), ".data", "generations", `${vid}.mp4`));
      expect(outbound).toBe(0);
    });
  } finally { globalThis.fetch = original; }
});

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out.push(p.split(path.sep).join("/")); } };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

test("structure: the seams stay internal, the route is the one door, the reservation comes before the row's first vendor call, the price is the table's and the margin path's, the settings are the two names", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitTopaz\b/)).toEqual(["lib/topazUpscale.ts"]);
  expect(reachers(/\badvanceTopazJobWith\b/)).toEqual(["lib/topazUpscale.ts"]);
  expect(reachers(/@\/lib\/topazUpscale["']/)).toEqual(["app/api/topaz/route.ts", "lib/generationAdmission.ts"]);
  expect(reachers(/\bfrom "\.\/topazDirect"/)).toEqual(["lib/topazMcp.ts", "lib/topazUpscale.ts"].filter((f) => /\.\/topazDirect"/.test(readFileSync(f, "utf8"))));
  const flow = readFileSync("lib/topazUpscale.ts", "utf8");
  const at = (needle: string) => flow.indexOf(needle);
  expect(flow).toContain("admitTopaz(input, got, options)");
  expect(at("Approve the price first")).toBeLessThan(at("INSERT INTO generations"));
  expect(at("INSERT INTO generations")).toBeLessThan(at("await reserveGenerationSpend("));
  for (const call of ["await (deps.submitImage ?? submitImageUpscale)(", "await (deps.createVideo ?? createVideoRequest)(", "await (deps.accept ?? acceptVideo)(", "await (deps.uploadParts ?? uploadVideoParts)(", "await (deps.complete ?? completeVideoUpload)("]) expect(at("await reserveGenerationSpend("), call).toBeLessThan(at(call));
  /* The output is downloaded, stored and settled in that order; settled never above the quote. */
  expect(at("(deps.downloadVideo ?? downloadVideo)(")).toBeLessThan(at("(deps.store ?? defaultStore)("));
  expect(at("(deps.store ?? defaultStore)(")).toBeLessThan(at('await settleTopaz(genId, "done"'));
  expect(flow).toContain("Math.min(outcome.costUsd, t.reservedUsd)");
  expect(flow).toContain("quotedCredits(usd, model)");
  const logic = flow.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  expect(logic).not.toMatch(/\b0\.\d+/);
  expect(logic).not.toMatch(/\bfetch\(|redirect|https?:\/\//);
  expect(logic).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
  const adapter = readFileSync("lib/topazDirect.ts", "utf8");
  expect([...new Set([...adapter.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))]).toEqual(["TOPAZ_API_KEY"]);
  expect(adapter).toContain('export const TOPAZ_SWITCH = "TOPAZ_DIRECT_ENABLED";');
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  /* The generate route hands the models over only behind the engine gate, and falls through otherwise. */
  const admission = readFileSync("lib/generationAdmission.ts", "utf8");
  expect(admission).toContain("if (topazDoor && (await engineEnabled(TOPAZ_SWITCH))) return executeTopazAdmission(topazDoor, got, options);");
});
