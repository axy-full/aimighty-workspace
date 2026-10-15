import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
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
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-lipsync-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.SYNC_ENABLED; delete process.env.REKOGNITION_ENABLED; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
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
async function upload(label: string, mediaKind: "video" | "audio" | "image", seconds: number | null = null): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const ext = mediaKind === "video" ? "mp4" : mediaKind === "audio" ? "mp3" : "png";
  const mime = mediaKind === "video" ? "video/mp4" : mediaKind === "audio" ? "audio/mpeg" : "image/png";
  const bytes = Buffer.from(`sample-${mediaKind}-${id}`);
  await storeUpload(id, ext, bytes, mime);
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.${ext}`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind,duration_s) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.${ext}`, mime, ext, bytes.length, "x", `uploads/${id}.${ext}`, Date.now(), mediaKind, seconds] });
  return id;
}
async function consent(projectId: string, subjectKey: string, over: { voice?: boolean; revoked?: boolean } = {}): Promise<string> {
  const { db } = await import("../../lib/db");
  const { consentsReady } = await import("../../lib/security/consent");
  await consentsReady();
  const id = uid("consent");
  await db().execute({
    sql: `INSERT INTO identity_consents (id, project_id, subject_key, subject_label, person_name, covers_face, covers_voice, uses_json, other_use, until_at, recording_id, attested, recorded_by, recorded_at, revoked_at)
          VALUES (?,?,?,?,?,1,?,?,'',?,?,1,'u_test',?,?)`,
    args: [id, projectId, subjectKey, "", "Sample Person", over.voice ? 1 : 0, JSON.stringify(["production", "ads"]), Date.now() + 86_400_000, "rec_1", Date.now(), over.revoked ? Date.now() : null],
  });
  return id;
}
async function project(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, id] });
}
const passing = (consentId = "consent_seam") => async (_cast: string, face: Buffer) => ({ consentId, similarity: 99, matched: true as const, checkedAt: Date.now(), faceSha256: `sha_${face.length}` });
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

type World = { projectId: string; cast: string; consentId: string; clip: string; voice: string; face: string; body: Record<string, unknown> };
/** A production, a cast member with a live face consent, a 4 s clip, a 5 s voice that is a real person's (an upload), and a still of the face. */
async function world(seconds = { clip: 4, voice: 5 }, voiceConsent = true): Promise<World> {
  const projectId = uid("prod"), cast = uid("cast");
  await project(projectId);
  const consentId = await consent(projectId, cast, { voice: voiceConsent });
  const clip = await upload("clip", "video", seconds.clip), voice = await upload("voice", "audio", seconds.voice), face = await upload("face", "image");
  return { projectId, cast, consentId, clip, voice, face, body: { clipUploadId: clip, audioUploadId: voice, castMemberId: cast, faceFrameUploadId: face, projectId, use: "production" } };
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

async function admit(w: World, extra: Record<string, unknown> = {}, seams: { consent?: ReturnType<typeof passing>; voices?: () => Promise<{ id: string; category: string }[]> } = { consent: passing(w.consentId) }) {
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

test("the quote: the audio's length for cut_off, else the longer track, at the plan's recorded per-second rate, through the price path; no figure of ours in a customer's words", async () => {
  const { SYNC_RATES } = await import("../../lib/vendorRates");
  const { quotedSeconds, lipSyncUsd } = await import("../../lib/lipSync");
  /* The recorded provider prices (docs/plans/provider-adapters.md § 1): dollars per output second, to confirm against the plan bought. */
  /* sync.so's page rounds the per-second figures; the exact per-minute fractions ($5 and $8 a minute) are used so a quote is never under it. */
  expect(SYNC_RATES.models).toEqual({ "lipsync-2": 0.05, "lipsync-2-pro": 5 / 60, "sync-3": 8 / 60 });
  expect(SYNC_RATES.models["lipsync-2-pro"]).toBeGreaterThan(0.083);
  expect(SYNC_RATES.models["sync-3"]).toBeGreaterThan(0.133);
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/TO CONFIRM[\s\S]{0,400}SYNC_RATES|SYNC_RATES[\s\S]{0,200}models: \{ "lipsync-2"/);
  expect(quotedSeconds(4, 5, "bounce")).toBe(5);
  expect(quotedSeconds(8, 5, "loop")).toBe(8);
  expect(quotedSeconds(8, 5, "cut_off")).toBe(5);
  expect(lipSyncUsd(5, "lipsync-2-pro")).toBeCloseTo(0.416667, 6);
  /* Rounded UP to the micro-dollar, never down. */
  for (const model of ["lipsync-2", "lipsync-2-pro", "sync-3"] as const) for (const seconds of [1, 3.3, 5, 7.77]) expect(lipSyncUsd(seconds, model)).toBeGreaterThanOrEqual(seconds * SYNC_RATES.models[model] - 1e-12);
  expect(lipSyncUsd(5, "sync-3")).toBeCloseTo(0.666667, 6);
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const before = (await meterRows()).length;
    const quote = await admit(w, { quoteOnly: true });
    expect(quote.status).toBe(200);
    /* The house is judged at cost in dollars: 5 s of lipsync-2-pro, default model. */
    expect(quote.body).toMatchObject({ seconds: 5, model: "lipsync-2-pro", syncMode: "bounce", unit: "usd", estimatedCredits: 5 });
    expect(Number(quote.body.price)).toBeCloseTo(0.416667, 6);
    expect(quote.body.needs).toEqual(["castMemberId", "faceFrameUploadId", "projectId", "use"]);
    expect(await admit(w, { quoteOnly: true, model: "sync-3", syncMode: "cut_off" })).toMatchObject({ status: 200, body: { seconds: 5, model: "sync-3", syncMode: "cut_off" } });
    /* A quote writes nothing and reserves nothing. */
    expect((await meterRows()).length).toBe(before);
    expect(deferred.length).toBe(0);
    for (const bad of [{ model: "lipsync-9" }, { syncMode: "stretch" }]) expect((await admit(w, { quoteOnly: true, ...bad })).status, JSON.stringify(bad)).toBe(400);
  });
});

test("off: with the engine's switch off, or a customer workspace not on the list, there is no tool, no row and nothing metered", async () => {
  const { lipSyncTools } = await import("../../lib/lipSync");
  await asTenant(house(), async () => {
    const w = await world();
    const before = (await meterRows()).length;
    delete process.env.SYNC_ENABLED;
    expect(await lipSyncTools()).toEqual([]);
    const off = await admit(w, { maxCredits: 100 });
    expect(off).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    expect((await meterRows()).length).toBe(before);
    /* On, the tool is declared for the house only where the face gate can run: with REKOGNITION_ENABLED off it is not offered. */
    process.env.SYNC_ENABLED = "1";
    expect(await lipSyncTools()).toEqual([]);
    process.env.REKOGNITION_ENABLED = "1";
    expect(await lipSyncTools()).toEqual([expect.objectContaining({ id: "lip_sync", kind: "engine", provider: "syncso", route: "/api/lipsync", models: ["lipsync-2", "lipsync-2-pro", "sync-3"] })]);
  });
  /* A customer workspace: not the house, not on the list. */
  process.env.SYNC_ENABLED = "1";
  await asTenant(tenant("ws_lipsync_customer"), async () => {
    expect(await lipSyncTools()).toEqual([]);
    expect(await admit(await world(), { quoteOnly: true })).toMatchObject({ status: 404 });
  });
});

test("approval and the consent fields: the price must be approved, and a lip-sync without a production, cast member, use or face still is refused before anything is read or sent", async () => {
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    const before = (await meterRows()).length;
    let seamCalls = 0;
    const seams = { consent: async (...args: Parameters<ReturnType<typeof passing>>) => { seamCalls++; return passing()(...args); } };
    expect((await admit(w, {}, seams)).status).toBe(409);
    expect((await admit(w, { maxCredits: 1 }, seams)).status).toBe(409);
    for (const bad of [{ castMemberId: "" }, { use: "identity" }, { use: undefined }, { faceFrameUploadId: "up_nope" }, { faceFrameUploadId: w.clip }, { projectId: undefined }]) {
      const reply = await admit(w, { maxCredits: 100, ...bad }, seams);
      expect(reply.status, JSON.stringify(bad)).toBe(400);
    }
    expect(seamCalls).toBe(0);
    expect((await meterRows()).length).toBe(before);
    expect(deferred.length).toBe(0);
  });
});

test("the consent gate: the real gate refuses every lip-sync today (no consent record holds a face reference), nothing is created, and a voice that is not a stock one needs its own consent first", async () => {
  process.env.SYNC_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    /* The public admission, no seams: a live face consent exists, and still every check is refused ("no face reference yet"). */
    const w = await world();
    const { executeLipSyncAdmission } = await import("../../lib/lipSync");
    const real = await executeLipSyncAdmission({ ...w.body, maxCredits: 100 }, OWNER, options());
    expect(real).toMatchObject({ status: 409, body: { code: "no-reference", error: "This person's consent has no face reference yet." } });
    expect((await meterRows()).length).toBe(before);
    expect(deferred.length).toBe(0);
    /* A real person's voice with no voice consent: refused before the face check is even asked. */
    const noVoice = await world({ clip: 4, voice: 5 }, false);
    let seamCalls = 0;
    const reply = await admit(noVoice, { maxCredits: 100 }, { consent: async (...a) => { seamCalls++; return passing()(...a); } });
    expect(reply).toMatchObject({ status: 409, body: { code: "no-voice-consent" } });
    expect(seamCalls).toBe(0);
    /* The face gate's own refusals pass straight through (a withdrawn consent, here: none live). */
    const withdrawn = await world();
    const { ConsentMatchError } = await import("../../lib/consentMatch");
    const refused = await admit(withdrawn, { maxCredits: 100 }, { consent: async () => { throw new ConsentMatchError("no-match", "This face doesn't look like the person who gave consent. A person needs to look at it.", 409); } });
    expect(refused).toMatchObject({ status: 409, body: { code: "no-match" } });
    expect((await meterRows()).length).toBe(before);
  });
});

test("submit, poll, store, settle, delete: the whole job on mocks, at the real provider cost, then the vendor's copy is gone", async () => {
  const { SYNC_RATES } = await import("../../lib/vendorRates");
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
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(5 * SYNC_RATES.models["lipsync-2-pro"], 6);
    const vendor = fakeVendor({ outputDuration: 4.2 });
    const lip = await run(genId, vendor.deps, 4);
    expect(lip).toMatchObject({ status: "done", settled: 1, vendorDeleted: 1, cleanupDue: 0, syncId: null, videoAsset: null, audioAsset: null });
    expect(vendor.calls).toEqual(["upload", "upload", "submit:lipsync-2-pro:bounce", "status", "status", "download", "store", "deleteJob:job_1", "deleteAsset:asset_1", "deleteAsset:asset_2"]);
    const take = await gen(genId);
    expect(take).toMatchObject({ status: "succeeded", stored_url: `stored/${genId}.mp4` });
    /* The delivered length (4.2 s, under the quote) at the model's rate: the real cost on the take and on the ledger line. */
    expect(Number(take.cost_usd)).toBeCloseTo((4.2 * 5) / 60, 6);
    const settled = (await meterRows()).slice(before);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: genId, status: "succeeded" });
    expect(Number(settled[0].engine_cost_usd)).toBeCloseTo((4.2 * 5) / 60, 6);
    expect(Number(settled[0].billed_credits ?? 0)).toBe(0);
    /* Only ids and figures are on the row: no face image, no frame, no name. The consent is named by id. */
    expect(take.lip).toMatchObject({ consentId: w.consentId, castMemberId: w.cast, use: "production", model: "lipsync-2-pro", seconds: 5 });
    expect(JSON.stringify(take.lip)).not.toMatch(/Sample Person|base64|http/);
    /* Another step on a finished job does nothing: no second submit, no second delete. */
    const again = fakeVendor();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
  });
});

test("the delivered length never costs past the quote; a vendor that gives no length settles at the input voice track's length, never the bare quote", async () => {
  const { lipSyncUsd } = await import("../../lib/lipSync");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    /* clip 4 s, voice 5 s: quote 5 s. clip 8 s, voice 5 s: quote 8 s, and with no length from the vendor 5 s (the voice track), not 8. */
    for (const [clip, voice, duration, expectedSeconds] of [[4, 5, 9, 5], [4, 5, undefined, 5], [4, 5, 3, 3], [8, 5, undefined, 5], [8, 5, 7, 7]] as const) {
      const w = await world({ clip, voice });
      const genId = String((await admit(w, { maxCredits: 100 })).body.id);
      await run(genId, fakeVendor({ outputDuration: duration }).deps, 4);
      expect(Number((await gen(genId)).cost_usd), `${clip}/${voice}/${duration}`).toBeCloseTo(lipSyncUsd(expectedSeconds, "lipsync-2-pro"), 9);
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

test("consent withdrawn while the job waited: nothing is sent and nothing is billed", async () => {
  const { db } = await import("../../lib/db");
  process.env.SYNC_ENABLED = "1";
  await asTenant(house(), async () => {
    const w = await world();
    /* The seam names a real record, so its withdrawal is what the workflow reads at the moment of sending. */
    const genId = String((await admit(w, { maxCredits: 100 })).body.id);
    await db().execute({ sql: "UPDATE identity_consents SET revoked_at=? WHERE id=?", args: [Date.now(), w.consentId] });
    const vendor = fakeVendor();
    await run(genId, vendor.deps, 2);
    expect(vendor.calls).toEqual([]);
    expect(await gen(genId)).toMatchObject({ status: "failed" });
    expect(String((await gen(genId)).error)).toMatch(/consent no longer holds/);
    expect(Number((await gen(genId)).cost_usd)).toBe(0);
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
    await run(genId, fakeVendor({ failWith: "could not lip-sync this clip", reportedCostUsd: 0.07 }).deps, 3);
    const take = await gen(genId);
    expect(take.status).toBe("failed");
    expect(String(take.error)).toMatch(/Nothing was billed/);
    expect(Number(take.cost_usd)).toBeCloseTo(0.07, 6);
    const row = (await meterRows()).find((r) => r.id === genId)!;
    expect(row).toMatchObject({ status: "failed" });
    expect(Number(row.engine_cost_usd)).toBeCloseTo(0.07, 6);
    expect(Number(row.billed_credits ?? 0)).toBe(0);
    expect(take.lip).toMatchObject({ reconcile: 0 });
  });
});

test("an output address we will not fetch, after the job completed: settled once as a charged failure (the take reads 'Nothing billed', the ledger line records the cost unbilled and marked to reconcile), never retried, the vendor's copy deleted", async () => {
  const { SyncOutputRefused } = await import("../../lib/syncso");
  const { lipSyncUsd } = await import("../../lib/lipSync");
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
    expect(Number(take.cost_usd)).toBeCloseTo(lipSyncUsd(4, "lipsync-2-pro"), 6);
    const line = (await meterRows()).slice(before).find((r) => r.id === genId)!;
    expect(line).toMatchObject({ status: "failed" });
    expect(Number(line.engine_cost_usd)).toBeCloseTo(lipSyncUsd(4, "lipsync-2-pro"), 6);
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
    let faceCalls = 0;
    const seams = { consent: async (...a: Parameters<ReturnType<typeof passing>>) => { faceCalls++; return passing(w.consentId)(...a); } };
    const press = (actor: AdmissionActor, extra: Record<string, unknown> = {}) => admitLipSync({ ...w.body, shotId, maxCredits: 100000, ...extra }, actor, options(), seams);
    try {
      await setRule("cap", 1);
      const before = { rows: await rows(), meter: (await meterRows()).length, handed: deferred.length };
      for (const extra of [{ quoteOnly: true }, {}]) {
        const refused = await press(MEMBER, extra);
        expect(refused, JSON.stringify(extra)).toMatchObject({ status: 403, body: { needsAdmin: true } });
        expect(String(refused.body.error)).toMatch(/S01/);
      }
      expect(faceCalls).toBe(0);
      expect(await rows()).toBe(before.rows);
      expect((await meterRows()).length).toBe(before.meter);
      expect(deferred.length).toBe(before.handed);
      /* An admin's goes through; so does a member's take on a shot with no code to speak of, a request with no shot, and any rule but "cap". */
      await runInTenant(house(), async () => { expect((await press(OWNER, { quoteOnly: true })).status).toBe(200); }, OWNER as never);
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

test("a voice is a stock one of ours only when ElevenLabs lists every voice in it as premade: cloned, professional, generated, unknown, another vendor's, a dub and a voice change need the person's voice consent", async () => {
  const { db } = await import("../../lib/db");
  process.env.SYNC_ENABLED = "1";
  const listed = [{ id: "v_premade", category: "premade" }, { id: "v_premade2", category: "premade" }, { id: "v_cloned", category: "cloned" }, { id: "v_pro", category: "professional" }, { id: "v_gen", category: "generated" }];
  const voices = async () => listed;
  await asTenant(house(), async () => {
    const take = async (over: { provider?: string; task?: string; voiceId?: string; lines?: { voiceId: string }[] }) => {
      const id = uid("gen_voice");
      const params = { task: over.task ?? "speech", ...(over.voiceId ? { voiceId: over.voiceId } : {}), ...(over.lines ? { lines: over.lines } : {}) };
      await db().execute({ sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,task,stored_url,bytes,duration_s) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [id, "audio", over.provider ?? "elevenlabs", "m", "line", JSON.stringify(params), "succeeded", Date.now(), Date.now(), "generate", `x/${id}.mp3`, 10, 5] });
      return id;
    };
    const ask = async (audioGenId: string, seams: { voices?: typeof voices } = { voices }) => {
      const w = await world({ clip: 4, voice: 5 }, false);
      let faceCalls = 0;
      const reply = await admit(w, { maxCredits: 100, audioUploadId: undefined, audioGenId }, { consent: async (...a) => { faceCalls++; return passing(w.consentId)(...a); }, ...seams });
      return { reply, faceCalls };
    };
    /* Premade, alone or all of a dialogue: no voice consent asked; the face gate still runs. */
    /* A Sarvam speech take is a stock voice too (that engine offers no cloning). */
    for (const id of [await take({ voiceId: "v_premade" }), await take({ task: "dialogue", lines: [{ voiceId: "v_premade" }, { voiceId: "v_premade2" }] }), await take({ provider: "sarvam", task: "sarvam_speech" })]) {
      const { reply, faceCalls } = await ask(id);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(faceCalls).toBe(1);
    }
    /* Everything else is refused for the voice consent, before the face check is even asked. */
    const refused: [string, string][] = [
      ["cloned", await take({ voiceId: "v_cloned" })], ["professional", await take({ voiceId: "v_pro" })], ["generated", await take({ voiceId: "v_gen" })],
      ["unknown voice", await take({ voiceId: "v_not_listed" })], ["no voice id", await take({})],
      ["one cloned in a dialogue", await take({ task: "dialogue", lines: [{ voiceId: "v_premade" }, { voiceId: "v_cloned" }] })],
      ["another vendor", await take({ provider: "xai", voiceId: "v_premade" })], ["a dub", await take({ task: "dub", voiceId: "v_premade" })],
      ["a voice change", await take({ task: "voiceChange", voiceId: "v_premade" })],
    ];
    for (const [label, id] of refused) {
      const { reply, faceCalls } = await ask(id);
      expect(reply, label).toMatchObject({ status: 409, body: { code: "no-voice-consent" } });
      expect(faceCalls, label).toBe(0);
    }
    /* A voice list that cannot be read fails closed. */
    const { reply, faceCalls } = await ask(await take({ voiceId: "v_premade" }), { voices: async () => { throw new Error("ElevenLabs is down"); } });
    expect(reply).toMatchObject({ status: 409, body: { code: "no-voice-consent" } });
    expect(faceCalls).toBe(0);
  });
});

test("engine on, a workspace at its own $0 cap: refused 429 in the cap's words, with nothing held, written or sent, and the face gate never asked", async () => {
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
      let faceCalls = 0;
      const reply = await admit(w, { maxCredits: 100000 }, { consent: async (...a) => { faceCalls++; return passing(w.consentId)(...a); } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(429);
      expect(String(reply.body.error)).toMatch(/monthly cap on the platform's engines/);
      expect(String(reply.body.error)).not.toMatch(/\$|\d/);
      expect(faceCalls).toBe(0);
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
    const reply = await admitLipSync({ ...w.body, maxCredits: 100 }, OWNER, { defer: async () => {}, checkpoint: (value) => { captured = value; return admissionReply({ prepared: true }); } }, { consent: passing(w.consentId) });
    expect(reply.body).toEqual({ prepared: true });
    expect((captured!.compiled.funding as { engine: string }).engine).toBe("syncso");
  });
});

test("what a person reads of a lip-sync take: its state, model, mode and length, and none of the vendor's ids, links, claims, consent ids, face hash or rates", async () => {
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
    expect(Object.keys(rawParams.lipsync)).toEqual(expect.arrayContaining(["syncId", "videoAsset", "audioAsset", "consentId", "faceSha256", "rateUsdPerSecond", "pollUntil", "claimedAt"]));
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

test("structure: the seams stay internal, the route is the one door, the consent gate is called before any row, and the settings are the plan's names", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitLipSync\b/)).toEqual(["lib/lipSync.ts"]);
  expect(reachers(/\badvanceLipSyncJobWith\b/)).toEqual(["lib/lipSync.ts"]);
  expect(reachers(/@\/lib\/lipSync["']/)).toEqual(["app/api/lipsync/route.ts"]);
  const flow = readFileSync("lib/lipSync.ts", "utf8");
  /* The face gate and the voice check come before the row is inserted and before anything is reserved. */
  const at = (needle: string) => flow.indexOf(needle);
  expect(at("(seams.consent ?? requireConsentMatch)(")).toBeGreaterThan(0);
  expect(at("(seams.consent ?? requireConsentMatch)(")).toBeLessThan(at("INSERT INTO generations"));
  expect(at("liveVoiceConsentFor(")).toBeLessThan(at("(seams.consent ?? requireConsentMatch)("));
  expect(at("INSERT INTO generations")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (deps.submit ?? submitLipSync)("));
  /* The consent gate takes no override from the admission's public face. */
  expect(flow).toContain("admitLipSync(input, got, options, {})");
  /* Prices come from the rate table and the margin path: no dollar literal in the workflow. */
  expect(flow).not.toMatch(/0\.0\d+|0\.1\d+/);
  expect(flow).toContain("quotedCredits(usd, model)");
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
