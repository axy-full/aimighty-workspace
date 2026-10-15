import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * Runway, direct (lib/runway.ts, lib/runwayTools.ts): Act-Two (`performance`), Aleph 2 (`edit`) and Gen-4.5 / Gen-4 Turbo (`video`). Mocked: every adapter call is a function this
 * file hands the workflow (the internal seams `admitRunway` and `advanceRunwayJobWith`, which the public route and the cron do not offer), or the in-process fixture under
 * ENGINE_MOCK=1; no request leaves this process and no provider is paid. Local temporary databases only. Neutral sample names.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-runway-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
/* Every Runway tool passes the face gate, so the face check is on unless a test says otherwise. */
test.beforeEach(() => { process.env.REKOGNITION_ENABLED = "1"; });
test.afterEach(() => { delete process.env.RUNWAY_ENABLED; delete process.env.REKOGNITION_ENABLED; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] };
let n = 0;
const uid = (label: string) => `${label}_${Date.now().toString(36)}_${++n}`;
async function asTenant(ws: TenantWorkspace, fn: () => Promise<void>): Promise<void> {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, fn, OWNER as never);
}
const made: string[] = [];
test.afterAll(async () => { for (const f of made) await unlink(f).catch(() => {}); });
const deferred: (() => Promise<unknown>)[] = [];
const options = (): AdmissionExecution => ({ defer: async (work) => { deferred.push(work); } });

/** One upload of this workspace: a stored original with a known length (a video) or none (an image). */
async function upload(label: string, mediaKind: "video" | "image", seconds: number | null = null, bytesOver?: number): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const ext = mediaKind === "video" ? "mp4" : "png";
  const mime = mediaKind === "video" ? "video/mp4" : "image/png";
  const bytes = Buffer.from(`sample-${mediaKind}-${id}`);
  await storeUpload(id, ext, bytes, mime);
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.${ext}`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind,duration_s) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.${ext}`, mime, ext, bytesOver ?? bytes.length, "x", `uploads/${id}.${ext}`, Date.now(), mediaKind, seconds] });
  return id;
}
/** Each cast member's consent record, by cast id: the gate seam answers with the person's own record, so a job that is sent finds it live. */
const known = new Map<string, string>();
async function consent(projectId: string, subjectKey: string): Promise<string> {
  const { db } = await import("../../lib/db");
  const { consentsReady } = await import("../../lib/security/consent");
  await consentsReady();
  const id = uid("consent");
  await db().execute({
    sql: `INSERT INTO identity_consents (id, project_id, subject_key, subject_label, person_name, covers_face, covers_voice, uses_json, other_use, until_at, recording_id, attested, recorded_by, recorded_at, revoked_at)
          VALUES (?,?,?,?,?,1,0,?,'',?,?,1,'u_test',?,NULL)`,
    args: [id, projectId, subjectKey, "", "Sample Person", JSON.stringify(["production", "ads"]), Date.now() + 86_400_000, "rec_1", Date.now()],
  });
  known.set(subjectKey, id);
  return id;
}
async function project(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, id] });
}
const passing = (consentId = "consent_seam") => async (_cast: string, face: Buffer) => ({ consentId, similarity: 99, matched: true as const, checkedAt: Date.now(), faceSha256: `sha_${face.length}` });
/** The gate as it answers for people whose consent records exist: each cast member's own record. */
const passingFor = (consents: Record<string, string>) => async (cast: string, face: Buffer) => passing(consents[cast])(cast, face);
async function meterRows() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute("SELECT id,workspace_id,status,engine_cost_usd,overrun_usd,billed_credits,paid_by_platform FROM meter_events WHERE engine='runway' ORDER BY created_at, id")).rows;
}
async function gen(id: string) {
  const { db } = await import("../../lib/db");
  const r = (await db().execute({ sql: "SELECT status,stored_url,bytes,cost_usd,error,provider_outcome,duration_s,json_extract(params,'$.runway') AS rw FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
  return { status: r.status, stored_url: r.stored_url, bytes: r.bytes, cost_usd: r.cost_usd, error: r.error, provider_outcome: r.provider_outcome, duration_s: r.duration_s, rw: JSON.parse(String(r.rw)) as import("../../lib/runwayTools").RunwayParams };
}
const rowCount = async () => { const { db } = await import("../../lib/db"); return Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n); };

type Seams = { consent?: ReturnType<typeof passing>; houseOnly?: boolean };
async function admit(input: Record<string, unknown>, seams: Seams = {}) {
  const { admitRunway } = await import("../../lib/runwayTools");
  return admitRunway(input, OWNER, options(), { consent: async (cast, face) => passing(known.get(cast) ?? "consent_seam")(cast, face), ...seams });
}
/** The video tool's body: a start still (the face still checked), the cast member it shows, the production, the use and words. */
async function videoBody(extra: Record<string, unknown> = {}) {
  const projectId = uid("prod"), cast = uid("cast");
  await project(projectId);
  await consent(projectId, cast);
  return { tool: "video", startImageUploadId: await upload("still", "image"), castMemberId: cast, projectId, use: "production", prompt: "A crane lifts at dawn", duration: 5, ...extra };
}
type Act = { projectId: string; performerCast: string; characterCast: string; consents: Record<string, string>; body: Record<string, unknown> };
/** A production, two cast members, a 5 s performance clip, a character image (its own still) and the performer's face still. */
async function actWorld(over: { clipSeconds?: number } = {}): Promise<Act> {
  const projectId = uid("prod"), performerCast = uid("cast"), characterCast = uid("cast");
  await project(projectId);
  const consents = { [performerCast]: await consent(projectId, performerCast), [characterCast]: await consent(projectId, characterCast) };
  const body = {
    tool: "performance", performanceClipUploadId: await upload("perf", "video", over.clipSeconds ?? 5), characterUploadId: await upload("char", "image"),
    performerCastMemberId: performerCast, performerFaceUploadId: await upload("pface", "image"), characterCastMemberId: characterCast, projectId, use: "production",
  };
  return { projectId, performerCast, characterCast, consents, body };
}
async function editWorld(seconds = 5) {
  const projectId = uid("prod"), cast = uid("cast");
  await project(projectId);
  const consents = { [cast]: await consent(projectId, cast) };
  return { projectId, cast, consents, body: { tool: "edit", clipUploadId: await upload("clip", "video", seconds), prompt: "Make the sky grey", castMemberId: cast, faceFrameUploadId: await upload("face", "image"), projectId, use: "production" } };
}

type VendorOver = { runningPolls?: number; failWith?: string; costCredits?: number | null; submitError?: Error; fetchErrors?: number; storeError?: Error; deleteError?: boolean };
/** The adapter seams: a task that succeeds on the second poll, recording every call. */
function fakeRunway(over: VendorOver = {}) {
  const calls: string[] = [];
  const sent: import("../../lib/runway").RunwayRequest[] = [];
  let polls = 0, fetchErrors = over.fetchErrors ?? 0;
  const cost = over.costCredits === undefined ? null : over.costCredits;
  const deps = {
    submit: async (input: import("../../lib/runway").RunwayRequest) => { calls.push(`submit:${input.tool}`); sent.push(input); if (over.submitError) throw over.submitError; return { id: "task_1" }; },
    poll: async () => {
      polls++; calls.push("poll");
      if (over.failWith) return { status: "failed" as const, failure: over.failWith, costCredits: cost };
      return polls < (over.runningPolls ?? 2) ? { status: "running" as const } : { status: "succeeded" as const, outputUrl: "https://dnznrvs05pmza.cloudfront.net/out.mp4", costCredits: cost };
    },
    fetchClip: async () => { calls.push("fetch"); if (fetchErrors > 0) { fetchErrors--; throw new Error("the address did not answer"); } return Buffer.from("runway-clip"); },
    store: async (genId: string, bytes: Buffer) => { if (over.storeError) { const e = over.storeError; over.storeError = undefined; throw e; } calls.push("store"); return { url: `stored/${genId}.mp4`, bytes: bytes.length }; },
    deleteTask: async (id: string) => { calls.push(`delete:${id}`); if (over.deleteError) throw new Error("409 still running"); return true; },
  };
  return { deps, calls, sent };
}
async function run(genId: string, deps: ReturnType<typeof fakeRunway>["deps"] & { clock?: () => number }, times = 4) {
  const { advanceRunwayJobWith } = await import("../../lib/runwayTools");
  let last = null;
  for (let i = 0; i < times; i++) last = await advanceRunwayJobWith(genId, deps);
  return last;
}

test("the prices are Runway's published ones (verified 16 Oct 2026), per second in credits at $0.01; whole seconds round up; Aleph 2 has its minimum; the limits are checked in words", async () => {
  const { RUNWAY_RATES } = await import("../../lib/vendorRates");
  const { runwayUsd } = await import("../../lib/runwayTools");
  expect(RUNWAY_RATES.creditUsd).toBe(0.01);
  expect(RUNWAY_RATES.models).toEqual({
    act_two: { creditsPerSecond: 5, minCredits: 0, minSeconds: 3, maxSeconds: 30 },
    aleph2: { creditsPerSecond: 28, minCredits: 56, minSeconds: 2, maxSeconds: 30 },
    "gen4.5": { creditsPerSecond: 12, minCredits: 0, minSeconds: 2, maxSeconds: 10 },
    gen4_turbo: { creditsPerSecond: 5, minCredits: 0, minSeconds: 2, maxSeconds: 10 },
  });
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/Verified against Runway's pricing page[^\n]*16 Oct 2026; confirm against the first invoice[\s\S]{0,1400}export const RUNWAY_RATES/);
  expect(runwayUsd("act_two", 5)).toBeCloseTo(0.25, 6);
  expect(runwayUsd("gen4.5", 5)).toBeCloseTo(0.6, 6);
  expect(runwayUsd("gen4_turbo", 10)).toBeCloseTo(0.5, 6);
  expect(runwayUsd("aleph2", 2)).toBeCloseTo(0.56, 6);
  expect(runwayUsd("aleph2", 3)).toBeCloseTo(0.84, 6);
  expect(runwayUsd("act_two", 4.2)).toBeCloseTo(0.25, 6);
  process.env.RUNWAY_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const rows = (await Promise.all([
      admit({ ...(await videoBody()), quoteOnly: true }), admit({ ...(await videoBody({ model: "gen4_turbo", duration: 10 })), quoteOnly: true }),
    ]));
    expect(rows[0]).toMatchObject({ status: 200, body: { unit: "usd", model: "gen4.5", seconds: 5, needs: ["projectId", "use"] } });
    expect(Number(rows[0].body.price)).toBeCloseTo(0.6, 6);
    expect(Number(rows[1].body.price)).toBeCloseTo(0.5, 6);
    /* Limits and inputs, each in words, before anything is reserved. */
    for (const bad of [{ duration: 1 }, { duration: 11 }, { duration: 5.5 }, { model: "gen3" }, { prompt: "" }, { ratio: "wide" }, { seed: -1 }, { startImageUploadId: "up_nope" }, { castMemberId: "" }])
      expect((await admit({ ...(await videoBody()), ...bad, quoteOnly: true })).status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    expect((await admit({ tool: "other", quoteOnly: true })).status).toBe(400);
    const aleph = await editWorld(3);
    expect(await admit({ ...aleph.body, quoteOnly: true })).toMatchObject({ status: 200, body: { model: "aleph2", seconds: 3 } });
    for (const seconds of [1, 31]) expect((await admit({ ...(await editWorld(seconds)).body, quoteOnly: true })).status, String(seconds)).toBe(400);
    const act = await actWorld();
    const q = await admit({ ...act.body, quoteOnly: true });
    expect(q).toMatchObject({ status: 200, body: { model: "act_two", seconds: 5, needs: ["projectId", "use"] } });
    expect((await admit({ ...(await actWorld({ clipSeconds: 2 })).body, quoteOnly: true })).status).toBe(400);
    /* A quote writes nothing and reserves nothing. */
    expect((await meterRows()).length).toBe(before);
    expect(deferred.length).toBe(0);
  });
});

test("on standby: the house workspace only, and only with the switch on; a listed customer workspace is still refused, and has no tool", async () => {
  const { runwayTools } = await import("../../lib/runwayTools");
  const { platformReady, platformDb } = await import("../../lib/platform");
  await platformReady();
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    delete process.env.RUNWAY_ENABLED;
    expect(await runwayTools()).toEqual([]);
    expect(await admit({ ...(await videoBody()), maxCredits: 100000 })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    process.env.RUNWAY_ENABLED = "1";
    /* Every Runway tool passes the face gate, so with the face check off none is offered. */
    delete process.env.REKOGNITION_ENABLED;
    expect(await runwayTools()).toEqual([]);
    process.env.REKOGNITION_ENABLED = "1";
    const on = await runwayTools();
    expect(on.map((t) => t.id)).toEqual(["runway_performance", "runway_edit", "runway_video"]);
    expect(on.every((t) => t.provider === "runway" && t.route === "/api/runway")).toBe(true);
    expect((await meterRows()).length).toBe(before);
  });
  /* A customer workspace that is on the engine list: no tool, and the door answers as if there were none. */
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: ["ws_runway_listed"] })] });
    process.env.RUNWAY_ENABLED = "1";
    process.env.REKOGNITION_ENABLED = "1";
    await asTenant(tenant("ws_runway_listed"), async () => {
      expect(await runwayTools()).toEqual([]);
      expect(await admit({ ...(await videoBody()), quoteOnly: true })).toMatchObject({ status: 404 });
      expect(await admit({ ...(await videoBody()), maxCredits: 100000 })).toMatchObject({ status: 404 });
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("approval: the price must be approved, and every face-bearing tool is refused for a missing production, use, cast member or face still before anything is read or sent", async () => {
  process.env.RUNWAY_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const rows = await rowCount();
    let seamCalls = 0;
    const seams = { consent: async (...a: Parameters<ReturnType<typeof passing>>) => { seamCalls++; return passing()(...a); } };
    const video = await videoBody();
    expect((await admit(video, seams)).status).toBe(409);
    expect((await admit({ ...video, maxCredits: 1 }, seams)).status).toBe(409);
    for (const bad of [{ castMemberId: "" }, { castMemberId: undefined }, { use: "identity" }, { use: undefined }, { projectId: undefined }]) expect((await admit({ ...video, maxCredits: 100000, ...bad }, seams)).status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    const act = await actWorld();
    for (const bad of [{ performerCastMemberId: "" }, { characterCastMemberId: "" }, { use: "identity" }, { use: undefined }, { projectId: undefined }, { performerFaceUploadId: "up_nope" }, { performerFaceUploadId: act.body.performanceClipUploadId }, { characterUploadId: "up_nope" }, { expressionIntensity: 9 }, { bodyControl: "yes" }]) {
      const reply = await admit({ ...act.body, maxCredits: 100000, ...bad }, seams);
      expect(reply.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
    const edit = await editWorld();
    for (const bad of [{ castMemberId: "" }, { use: undefined }, { faceFrameUploadId: edit.body.clipUploadId }, { projectId: undefined }, { prompt: "" }]) {
      const reply = await admit({ ...edit.body, maxCredits: 100000, ...bad }, seams);
      expect(reply.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
    expect(seamCalls).toBe(0);
    expect((await meterRows()).length).toBe(before);
    expect(await rowCount()).toBe(rows);
    expect(deferred.length).toBe(0);
  });
});

test("the consent gates: Act-Two checks the performer AND the character, Aleph 2 the person, Gen-4 from a still none; the real gate refuses today and nothing is created", async () => {
  process.env.RUNWAY_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const rows = await rowCount();
    const { executeRunwayAdmission } = await import("../../lib/runwayTools");
    const { ConsentMatchError } = await import("../../lib/consentMatch");
    /* The public admission, no seams: a live consent exists, and still every check is refused ("no face reference yet"). */
    const act = await actWorld();
    expect(await executeRunwayAdmission({ ...act.body, maxCredits: 100000 }, OWNER, options())).toMatchObject({ status: 409, body: { code: "no-reference" } });
    const edit = await editWorld();
    expect(await executeRunwayAdmission({ ...edit.body, maxCredits: 100000 }, OWNER, options())).toMatchObject({ status: 409, body: { code: "no-reference" } });
    expect((await meterRows()).length).toBe(before);
    expect(await rowCount()).toBe(rows);
    /* The face check not available (REKOGNITION off): refused in words. */
    delete process.env.REKOGNITION_ENABLED;
    expect(await admit({ ...act.body, maxCredits: 100000 }, { consent: passing() })).toMatchObject({ status: 403 });
    process.env.REKOGNITION_ENABLED = "1";
    /* Act-Two: both faces are checked, with their own cast members, performer first. The second failing creates nothing. */
    const seen: string[] = [];
    const record = (fail?: string) => async (cast: string, face: Buffer) => { seen.push(cast); if (fail === cast) throw new ConsentMatchError("no-match", "This face doesn't look like the person who gave consent. A person needs to look at it.", 409); return passing()(cast, face); };
    expect(await admit({ ...act.body, maxCredits: 100000 }, { consent: record(act.characterCast) })).toMatchObject({ status: 409, body: { code: "no-match" } });
    expect(seen).toEqual([act.performerCast, act.characterCast]);
    expect(await rowCount()).toBe(rows);
    expect((await meterRows()).length).toBe(before);
    seen.length = 0;
    const ok = await admit({ ...act.body, maxCredits: 100000 }, { consent: record() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(seen).toEqual([act.performerCast, act.characterCast]);
    const take = await gen(String(ok.body.id));
    expect(take.rw.consents.map((c) => [c.role, c.castMemberId])).toEqual([["performer", act.performerCast], ["character", act.characterCast]]);
    expect(JSON.stringify(take.rw)).not.toMatch(/Sample Person|base64|http/);
    /* Aleph 2: one gate. */
    seen.length = 0;
    const e = await admit({ ...edit.body, maxCredits: 100000 }, { consent: record() });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(seen).toEqual([edit.cast]);
    /* Gen-4.5 / Gen-4 Turbo: the start still is the face still checked, for the cast member it shows (like a FLUX.2 edit's reference; no "shows nobody" exemption). */
    seen.length = 0;
    const video = await videoBody({ model: "gen4_turbo" });
    const v = await admit({ ...video, maxCredits: 100000 }, { consent: record() });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(seen).toEqual([video.castMemberId]);
    expect((await gen(String(v.body.id))).rw.consents.map((c) => [c.role, c.castMemberId])).toEqual([["subject", video.castMemberId]]);
    /* The real gate refuses it today, and the face check off refuses it in words. */
    expect(await executeRunwayAdmission({ ...(await videoBody()), maxCredits: 100000 }, OWNER, options())).toMatchObject({ status: 409, body: { code: "no-reference" } });
    delete process.env.REKOGNITION_ENABLED;
    expect(await admit({ ...(await videoBody()), maxCredits: 100000 }, { consent: record() })).toMatchObject({ status: 403 });
    expect(await rowCount()).toBe(rows + 3);
  });
});

test("a still made into a clip: reserved at the quote, submitted, polled, fetched, stored, settled at Runway's own figure, then the vendor's copy is deleted", async () => {
  const { RUNWAY_RATES } = await import("../../lib/vendorRates");
  process.env.RUNWAY_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    deferred.length = 0;
    const reply = await admit({ ...(await videoBody({ ratio: "1280:720", seed: 7 })), maxCredits: 100000 });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const genId = String(reply.body.id);
    expect(deferred.splice(0).length).toBe(1);
    const held = (await meterRows()).slice(before);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: genId, status: "running" });
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(5 * RUNWAY_RATES.models["gen4.5"].creditsPerSecond * RUNWAY_RATES.creditUsd, 6);
    const vendor = fakeRunway({ costCredits: 50 });
    const rw = await run(genId, vendor.deps, 4);
    expect(rw).toMatchObject({ status: "done", settled: 1, vendorDeleted: 1, cleanupDue: 0, reconcile: 0 });
    expect(vendor.calls).toEqual(["submit:video", "poll", "poll", "fetch", "store", "delete:task_1"]);
    const sent = vendor.sent[0] as Extract<import("../../lib/runway").RunwayRequest, { tool: "video" }>;
    expect(sent).toMatchObject({ tool: "video", model: "gen4.5", prompt: "A crane lifts at dawn", duration: 5, ratio: "1280:720", seed: 7 });
    expect(sent.image.mime).toBe("image/png");
    const take = await gen(genId);
    expect(take).toMatchObject({ status: "succeeded", stored_url: `stored/${genId}.mp4` });
    expect(Number(take.cost_usd)).toBeCloseTo(0.5, 6);
    const line = (await meterRows()).slice(before)[0];
    expect(line).toMatchObject({ id: genId, status: "succeeded" });
    expect(Number(line.engine_cost_usd)).toBeCloseTo(0.5, 6);
    expect(Number(line.billed_credits ?? 0)).toBe(0);
    /* Another step on a finished job does nothing. */
    const again = fakeRunway();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
  });
});

test("the figure: Runway's own when it reports one; none reported settles at the quote and is marked to reconcile; more than the quote is billed at the quote, the excess recorded as the overrun and marked", async () => {
  process.env.RUNWAY_ENABLED = "1";
  await asTenant(house(), async () => {
    for (const [reported, cost, overrun, reconcile] of [[50, 0.5, null, 0], [null, 0.6, null, 1], [0, 0, null, 0], [80, 0.6, 0.2, 1]] as const) {
      const id = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
      await run(id, fakeRunway({ costCredits: reported }).deps, 4);
      const take = await gen(id);
      expect(take.status, String(reported)).toBe("succeeded");
      expect(Number(take.cost_usd), String(reported)).toBeCloseTo(cost, 6);
      expect(take.rw.reconcile, String(reported)).toBe(reconcile);
      const line = (await meterRows()).find((r) => r.id === id)!;
      expect(Number(line.engine_cost_usd), String(reported)).toBeCloseTo(cost, 6);
      if (overrun === null) expect(line.overrun_usd ?? null).toBeNull(); else expect(Number(line.overrun_usd)).toBeCloseTo(overrun, 6);
      expect(Number(line.billed_credits ?? 0)).toBe(0);
    }
  });
});

test("a failure: the take reads 'Nothing billed' when it cost nothing; a charged one says what it cost and is recorded unbilled on the ledger line; none reported is recorded as nothing and marked to reconcile", async () => {
  process.env.RUNWAY_ENABLED = "1";
  await asTenant(house(), async () => {
    const failedBy = async (over: VendorOver) => {
      const id = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
      const vendor = fakeRunway({ failWith: "The input could not be used.", ...over });
      await run(id, vendor.deps, 3);
      return { id, vendor, take: await gen(id), line: (await meterRows()).find((r) => r.id === id)! };
    };
    const free = await failedBy({ costCredits: 0 });
    expect(free.take.status).toBe("failed");
    expect(String(free.take.error)).toMatch(/Nothing was billed/);
    expect(Number(free.take.cost_usd)).toBe(0);
    expect(free.take.rw.reconcile).toBe(0);
    expect(JSON.parse(String(free.take.provider_outcome))).toMatchObject({ provider: "runway", stage: "run", billing: { state: "unknown" } });
    expect(free.vendor.calls).not.toContain("fetch");
    expect(free.vendor.calls).toContain("delete:task_1");
    expect(Number(free.line.engine_cost_usd)).toBe(0);
    const unknown = await failedBy({ costCredits: null });
    expect(Number(unknown.take.cost_usd)).toBe(0);
    expect(unknown.take.rw.reconcile).toBe(1);
    const charged = await failedBy({ costCredits: 20 });
    expect(charged.take.status).toBe("failed");
    /* The workspace reads "Nothing billed" and no vendor credit; the charge is on the platform ledger line only. */
    expect(String(charged.take.error)).toMatch(/Nothing was billed/);
    expect(String(charged.take.error)).not.toMatch(/credit|charged|\$/i);
    expect(Number(charged.take.cost_usd)).toBeCloseTo(0.2, 6);
    expect(charged.line).toMatchObject({ status: "failed" });
    expect(Number(charged.line.engine_cost_usd)).toBeCloseTo(0.2, 6);
    expect(Number(charged.line.billed_credits ?? 0)).toBe(0);
    /* Never above the quote, whatever is reported. */
    const huge = await failedBy({ costCredits: 5000 });
    expect(Number(huge.line.engine_cost_usd)).toBeCloseTo(0.6, 6);
    /* The excess over the quote is recorded as the overrun on a charged failure too (50 - 0.6 dollars), and marked to reconcile; an in-quote charge has none. */
    expect(Number(huge.line.overrun_usd)).toBeCloseTo(49.4, 6);
    expect(huge.take.rw.reconcile).toBe(1);
    expect(charged.line.overrun_usd ?? null).toBeNull();
    expect(String(huge.take.error)).not.toMatch(/credit|charged|\$/i);
  });
});

test("refused before work, or never sent: nothing billed; a refusal that may have taken the task, or a lost reply, is held and never sent again", async () => {
  const { RunwayError } = await import("../../lib/runway");
  const { recoverRunwayJobs, advanceRunwayJobWith } = await import("../../lib/runwayTools");
  const { db } = await import("../../lib/db");
  process.env.RUNWAY_ENABLED = "1";
  await asTenant(house(), async () => {
    const a = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
    await run(a, fakeRunway({ submitError: new RunwayError("Runway refused the request: bad image", 422, true) }).deps, 2);
    expect(await gen(a)).toMatchObject({ status: "failed" });
    expect(Number((await gen(a)).cost_usd)).toBe(0);
    expect(String((await gen(a)).error)).toMatch(/Nothing was billed/);
    expect(JSON.parse(String((await gen(a)).provider_outcome))).toMatchObject({ provider: "runway", stage: "submit", code: "http_422" });
    /* A throttle (429), a timeout and a dropped connection may have taken the task: held with the reservation, never sent again. */
    for (const error of [new RunwayError("Runway refused the request: slow down", 429, false), new RunwayError("Runway did not answer.")]) {
      const id = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
      expect(await run(id, fakeRunway({ submitError: error }).deps, 1)).toMatchObject({ status: "uncertain", settled: 0 });
      expect(String((await gen(id)).error)).toMatch(/will not be sent again/);
      expect((await meterRows()).find((r) => r.id === id)).toMatchObject({ status: "running" });
      const again = fakeRunway();
      await run(id, again.deps, 3);
      await recoverRunwayJobs({ limit: 50 }, again.deps);
      /* (The cron may advance other queued jobs in this shared database; this one is untouched.) */
      expect(await gen(id)).toMatchObject({ status: "running", rw: { status: "uncertain", taskId: null, settled: 0 } });
    }
    /* A claim older than the grace with no task id: never past the instant before the request it sent nothing and settles at nothing; past it, it is a lost acknowledgement. */
    for (const [sendingAt, want] of [[null, "failed"], [1, "uncertain"]] as const) {
      const id = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.runway.claimedAt',1,'$.runway.sendingAt',?) WHERE id=?", args: [sendingAt, id] });
      const vendor = fakeRunway();
      expect(await advanceRunwayJobWith(id, { ...vendor.deps, clock: () => Date.now() + 3_600_000 }), String(sendingAt)).toMatchObject({ status: want });
      expect(vendor.calls).toEqual([]);
    }
    /* An input that cannot be read submits nothing. */
    const gone = await videoBody();
    const id = String((await admit({ ...gone, maxCredits: 100000 })).body.id);
    await db().execute({ sql: "DELETE FROM uploads WHERE id=?", args: [String(gone.startImageUploadId)] });
    const vendor = fakeRunway();
    await run(id, vendor.deps, 2);
    expect(vendor.calls).toEqual([]);
    expect(await gen(id)).toMatchObject({ status: "failed" });
    expect(String((await gen(id)).error)).toMatch(/Nothing was submitted/);
  });
});

test("consent withdrawn while the job waited: nothing is sent and nothing is billed", async () => {
  const { db } = await import("../../lib/db");
  process.env.RUNWAY_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await asTenant(house(), async () => {
    const act = await actWorld();
    const consentId = await consent(act.projectId, act.performerCast);
    const id = String((await admit({ ...act.body, maxCredits: 100000 }, { consent: passing(consentId) })).body.id);
    await db().execute({ sql: "UPDATE identity_consents SET revoked_at=? WHERE id=?", args: [Date.now(), consentId] });
    const vendor = fakeRunway();
    await run(id, vendor.deps, 2);
    expect(vendor.calls).toEqual([]);
    expect(await gen(id)).toMatchObject({ status: "failed" });
    expect(String((await gen(id)).error)).toMatch(/consent no longer holds/);
    expect(Number((await gen(id)).cost_usd)).toBe(0);
  });
});

test("the shot cap is judged at the quote and the press, before any face is checked or row written: a member past it is refused 403 (needs an admin) with no take left, for each tool; an admin, no shot and a rule that is not 'cap' go through", async () => {
  const { admitRunway } = await import("../../lib/runwayTools");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const { runInTenant } = await import("../../lib/tenant");
  process.env.RUNWAY_ENABLED = "1";
  const MEMBER: AdmissionActor = { user: { ...OWNER.user, id: "member_1", role: "member", owner: false } as AdmissionActor["user"] };
  await runInTenant(house(), async () => {
    await ready();
    const setRule = async (rule: string | null, cap?: number) => {
      for (const [key, value] of [["approvalRule", rule], ["shotCapCredits", cap == null ? null : String(cap)]] as const) {
        if (value === null) await db().execute({ sql: "DELETE FROM settings WHERE key=?", args: [key] }); else await setSetting(key, value, "admin");
      }
      invalidateSettings();
    };
    const video = await videoBody();
    const act = await actWorld();
    const edit = await editWorld();
    const shotId = uid("shot");
    await db().execute({ sql: "INSERT INTO shots (id, project_id, code, title, created_at, updated_at) VALUES (?,?,?,?,0,0)", args: [shotId, video.projectId, "S01", "A shot"] });
    /* The shot already holds a take (a dollar of an image, ten credits), so even a one-credit line takes it past a cap of one. */
    await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,shot_id,cost_usd,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,0)", args: [uid("gen_prior"), "image", "gemini-3.1-flash-image", "A prior still", "{}", "succeeded", shotId, 1] });
    let faceCalls = 0;
    const seams = { consent: async (c: string, face: Buffer) => { faceCalls++; return passing(known.get(c) ?? "consent_seam")(c, face); } };
    const bodies: Record<string, Record<string, unknown>> = { video: { ...video, projectId: video.projectId }, performance: { ...act.body, projectId: video.projectId }, edit: { ...edit.body, projectId: video.projectId } };
    const press = (tool: string, actor: AdmissionActor, extra: Record<string, unknown> = {}) => admitRunway({ ...bodies[tool], shotId, maxCredits: 100000, ...extra }, actor, options(), seams);
    const rows = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    try {
      await setRule("cap", 1);
      const before = { rows: await rows(), meter: (await meterRows()).length, handed: deferred.length };
      for (const tool of Object.keys(bodies)) for (const extra of [{ quoteOnly: true }, {}]) {
        const refused = await press(tool, MEMBER, extra);
        expect(refused, `${tool} ${JSON.stringify(extra)}`).toMatchObject({ status: 403, body: { needsAdmin: true } });
        expect(String(refused.body.error)).toMatch(/S01/);
      }
      expect(faceCalls).toBe(0);
      expect(await rows()).toBe(before.rows);
      expect((await meterRows()).length).toBe(before.meter);
      expect(deferred.length).toBe(before.handed);
      await runInTenant(house(), async () => { expect((await press("video", OWNER, { quoteOnly: true })).status).toBe(200); }, OWNER as never);
      expect((await press("video", MEMBER, { quoteOnly: true, shotId: undefined })).status).toBe(200);
      await setRule("ask");
      expect((await press("video", MEMBER, { quoteOnly: true })).status).toBe(200);
      await setRule("cap", 100000);
      expect((await press("video", MEMBER, { quoteOnly: true })).status).toBe(200);
      const made = await press("video", MEMBER);
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      expect(faceCalls).toBe(1);
      expect(await rows()).toBe(before.rows + 1);
      /* (Run to the end, so the cron in a later test finds nothing of ours waiting.) */
      await run(String(made.body.id), fakeRunway({ costCredits: 60 }).deps, 4);
    } finally { await setRule(null); }
  }, MEMBER as never);
});

test("the output address lives a day: a fetch that fails is retried in time; past the window the clip is lost, recorded at what Runway charged (reported, else the quote), billed to nobody, and said so", async () => {
  const { RUNWAY_RESULT_LIFETIME_MS } = await import("../../lib/runway");
  const { advanceRunwayJobWith } = await import("../../lib/runwayTools");
  process.env.RUNWAY_ENABLED = "1";
  await asTenant(house(), async () => {
    const a = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
    const flaky = fakeRunway({ runningPolls: 1, fetchErrors: 1, costCredits: 50 });
    await expect(advanceRunwayJobWith(a, flaky.deps)).rejects.toThrow();
    expect((await gen(a)).status).toBe("running");
    await run(a, flaky.deps, 3);
    expect((await gen(a)).status).toBe("succeeded");
    for (const [reported, cost, reconcile] of [[null, 0.6, 1], [40, 0.4, 0]] as const) {
      const b = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
      const dead = fakeRunway({ runningPolls: 1, fetchErrors: 99, costCredits: reported });
      await expect(advanceRunwayJobWith(b, dead.deps)).rejects.toThrow();
      expect((await gen(b)).rw.readyAt).not.toBeNull();
      expect(await advanceRunwayJobWith(b, { ...dead.deps, clock: () => Date.now() + RUNWAY_RESULT_LIFETIME_MS })).toMatchObject({ status: "failed", settled: 1 });
      const lost = await gen(b);
      expect(String(lost.error)).toMatch(/could not be saved in time\. Nothing was billed/);
      expect(Number(lost.cost_usd), String(reported)).toBeCloseTo(cost, 6);
      expect(lost.rw.reconcile).toBe(reconcile);
      const line = (await meterRows()).find((r) => r.id === b)!;
      expect(line).toMatchObject({ status: "failed" });
      expect(Number(line.engine_cost_usd)).toBeCloseTo(cost, 6);
      expect(Number(line.billed_credits ?? 0)).toBe(0);
    }
  });
});

test("the vendor's copy: a delete that fails is retried by the cron up to five times and never fails the take; two workers submit once; a storage failure keeps the job", async () => {
  const { recoverRunwayJobs, advanceRunwayJobWith, CLEANUP_MAX_TRIES } = await import("../../lib/runwayTools");
  process.env.RUNWAY_ENABLED = "1";
  await asTenant(house(), async () => {
    const id = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
    const vendor = fakeRunway({ deleteError: true });
    const rw = await run(id, vendor.deps, 4);
    expect(rw).toMatchObject({ status: "done", vendorDeleted: 0, cleanupDue: 1, cleanupTries: 1 });
    expect((await gen(id)).status).toBe("succeeded");
    for (let i = 1; i < CLEANUP_MAX_TRIES; i++) await recoverRunwayJobs({ limit: 50 }, vendor.deps);
    expect((await gen(id)).rw).toMatchObject({ cleanupDue: 0, cleanupTries: CLEANUP_MAX_TRIES, vendorDeleted: 0 });
    const ok = fakeRunway();
    await recoverRunwayJobs({ limit: 50 }, ok.deps);
    expect((await gen(id)).rw).toMatchObject({ cleanupDue: 0, cleanupTries: CLEANUP_MAX_TRIES });
    /* Two workers at once submit once. */
    const two = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
    const racing = fakeRunway({ runningPolls: 1, storeError: new Error("storage is busy") });
    await Promise.allSettled([advanceRunwayJobWith(two, racing.deps), advanceRunwayJobWith(two, racing.deps)]);
    expect(racing.calls.filter((c) => c.startsWith("submit")).length).toBe(1);
    await run(two, racing.deps, 3);
    expect((await gen(two)).status).toBe("succeeded");
    expect(racing.calls.filter((c) => c.startsWith("submit")).length).toBe(1);
  });
});

test("Act-Two and Aleph 2 send their inputs as data, and the take's record names the people by id and hash only", async () => {
  process.env.RUNWAY_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await asTenant(house(), async () => {
    const act = await actWorld();
    const id = String((await admit({ ...act.body, bodyControl: true, expressionIntensity: 4, maxCredits: 100000 }, { consent: passingFor(act.consents) })).body.id);
    const vendor = fakeRunway({ costCredits: 25 });
    await run(id, vendor.deps, 4);
    const sent = vendor.sent[0] as Extract<import("../../lib/runway").RunwayRequest, { tool: "performance" }>;
    expect(sent).toMatchObject({ tool: "performance", bodyControl: true, expressionIntensity: 4 });
    expect(sent.character.kind).toBe("image");
    expect(Buffer.isBuffer(sent.reference.bytes)).toBe(true);
    expect(sent.reference.mime).toBe("video/mp4");
    expect((await gen(id)).status).toBe("succeeded");
    const edit = await editWorld(3);
    const eid = String((await admit({ ...edit.body, maxCredits: 100000 }, { consent: passingFor(edit.consents) })).body.id);
    const ev = fakeRunway({ costCredits: 84 });
    await run(eid, ev.deps, 4);
    expect(ev.sent[0]).toMatchObject({ tool: "edit", prompt: "Make the sky grey" });
    expect(Number((await gen(eid)).cost_usd)).toBeCloseTo(0.84, 6);
  });
});

test("a listed customer workspace (the house-only wall lifted for the test) pays exactly the quote in credits, once, and a failure refunds it; at its own $0 cap it is refused 429 with nothing held, written or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  const { billCredits } = await import("../../lib/creditTerms");
  const { db, ready } = await import("../../lib/db");
  const { RunwayError } = await import("../../lib/runway");
  await platformReady();
  const listed = "ws_runway_paid", capped = "ws_runway_cap0";
  for (const [id, cap] of [[listed, null], [capped, 0]] as const) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, cap] });
    await grantCredits(id, 500, "Test", "owner", "manual");
  }
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  const open = { houseOnly: false };
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [listed, capped] })] });
    process.env.RUNWAY_ENABLED = "1";
    await asTenant((await getWorkspace(listed))!, async () => {
      const expected = billCredits(0.6, "gen4.5");
      const body = await videoBody();
      expect(await admit({ ...body, quoteOnly: true }, open)).toMatchObject({ body: { unit: "cr", estimatedCredits: expected } });
      const start = (await creditState())!.balance;
      expect((await admit({ ...body, maxCredits: expected - 1 }, open)).status).toBe(409);
      expect((await creditState())!.balance).toBe(start);
      const id = String((await admit({ ...body, maxCredits: expected }, open)).body.id);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      await run(id, fakeRunway({ costCredits: 60 }).deps, 4);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      const mine = (await meterRows()).filter((r) => r.workspace_id === listed);
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].billed_credits)).toBe(expected);
      const bad = String((await admit({ ...body, maxCredits: expected }, open)).body.id);
      await run(bad, fakeRunway({ submitError: new RunwayError("Runway refused the request: no", 422, true) }).deps, 2);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
    });
    await asTenant((await getWorkspace(capped))!, async () => {
      await ready();
      const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      let faceCalls = 0;
      const reply = await admit({ ...(await videoBody()), maxCredits: 100000 }, { ...open, consent: async (...a) => { faceCalls++; return passing()(...a); } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(429);
      expect(String(reply.body.error)).toMatch(/monthly cap on the platform's engines/);
      expect(String(reply.body.error)).not.toMatch(/\$|\d/);
      expect(faceCalls).toBe(0);
      expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
      expect((await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=?", args: [capped] })).rows).toEqual([]);
      expect(deferred.length).toBe(handedOff);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("the adapter: the requests it makes, the statuses it reads, the base address and the output hosts it accepts, and no redirect is ever followed", async () => {
  const runway = await import("../../lib/runway");
  delete process.env.ENGINE_MOCK;
  const calls: { url: string; method: string; headers: Record<string, string>; body: string; redirect?: string }[] = [];
  const reply = (status: number, json: unknown) => (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? init.body : "", redirect: init?.redirect });
    return new Response(status === 204 ? null : typeof json === "string" ? json : JSON.stringify(json), { status });
  }) as never;
  const before = { key: process.env.RUNWAY_API_KEY, base: process.env.RUNWAY_BASE_URL };
  const png = { bytes: Buffer.from("still"), mime: "image/png" };
  try {
    process.env.RUNWAY_API_KEY = "test-runway-key-not-real";
    delete process.env.RUNWAY_BASE_URL;
    expect(runway.runwayBase()).toBe("https://api.dev.runwayml.com/v1");
    const sent = await runway.submitTask({ tool: "video", model: "gen4.5", image: png, prompt: "a tree", duration: 5, ratio: "1280:720", seed: 3 }, { fetch: reply(200, { id: "task_9" }) });
    expect(sent).toEqual({ id: "task_9" });
    expect(calls[0]).toMatchObject({ url: "https://api.dev.runwayml.com/v1/image_to_video", method: "POST", redirect: "error" });
    expect(calls[0].headers).toMatchObject({ authorization: "Bearer test-runway-key-not-real", "x-runway-version": runway.RUNWAY_VERSION });
    expect(JSON.parse(calls[0].body)).toEqual({ model: "gen4.5", promptImage: `data:image/png;base64,${png.bytes.toString("base64")}`, promptText: "a tree", duration: 5, ratio: "1280:720", seed: 3 });
    expect(runway.runwayRequestOf({ tool: "edit", video: { bytes: Buffer.from("v"), mime: "video/mp4" }, prompt: "grey" })).toMatchObject({ path: "/video_to_video", body: { model: "aleph2", promptText: "grey" } });
    expect(runway.runwayRequestOf({ tool: "performance", character: { ...png, kind: "image" }, reference: { bytes: Buffer.from("v"), mime: "video/mp4" }, bodyControl: false, expressionIntensity: 3 })).toMatchObject({ path: "/character_performance", body: { model: "act_two", character: { type: "image" }, reference: { type: "video" } } });
    /* A reply naming no task, or one that is not a plain id, is a failure. */
    for (const bad of [{}, { id: "../x" }, { id: 5 }]) expect(await runway.submitTask({ tool: "video", model: "gen4.5", image: png, prompt: "x", duration: 5 }, { fetch: reply(200, bad) }).then(() => null, (e) => e), JSON.stringify(bad)).toBeInstanceOf(runway.RunwayError);
    /* Polling: every status word, the cost, and only an allow-listed output. */
    const at = (json: unknown) => runway.pollTask("task_9", { fetch: reply(200, json) });
    expect(await at({ status: "PENDING" })).toEqual({ status: "pending" });
    expect(await at({ status: "THROTTLED" })).toEqual({ status: "pending" });
    expect(await at({ status: "RUNNING" })).toEqual({ status: "running" });
    expect(await at({ status: "SomethingNew" })).toEqual({ status: "pending" });
    expect(await at({ status: "SUCCEEDED", output: ["https://dnznrvs05pmza.cloudfront.net/o.mp4?sig=1"], cost: { credits: 60 } })).toEqual({ status: "succeeded", outputUrl: "https://dnznrvs05pmza.cloudfront.net/o.mp4?sig=1", costCredits: 60 });
    expect(await at({ status: "SUCCEEDED", output: ["https://files.runwayml.com/o.mp4"] })).toMatchObject({ status: "succeeded", costCredits: null });
    expect(await at({ status: "SUCCEEDED", output: ["https://evil.example.com/o.mp4"] })).toMatchObject({ status: "failed" });
    expect(await at({ status: "FAILED", failure: "bad input", cost: { credits: 0 } })).toEqual({ status: "failed", failure: "bad input", costCredits: 0 });
    expect(await at({ status: "CANCELLED" })).toMatchObject({ status: "failed", costCredits: null });
    expect(await runway.pollTask("../x", { fetch: reply(200, {}) }).then(() => null, (e) => e)).toBeInstanceOf(runway.RunwayError);
    /* The output hosts: https, no port or credentials, runwayml.com or its one distribution; the key is never sent there. */
    const results = calls.length;
    expect((await runway.fetchOutput("https://dnznrvs05pmza.cloudfront.net/o.mp4", { fetch: reply(200, "mp4-bytes") })).toString()).toBe("mp4-bytes");
    expect(calls.at(-1)!.headers.authorization).toBeUndefined();
    for (const bad of ["https://evil.example.com/o.mp4", "https://runwayml.com.evil.com/o.mp4", "https://other.cloudfront.net/o.mp4", "http://dnznrvs05pmza.cloudfront.net/o.mp4", "https://user@dnznrvs05pmza.cloudfront.net/o.mp4", "https://dnznrvs05pmza.cloudfront.net:8443/o.mp4"]) {
      expect(runway.runwayResultUrl(bad), bad).toBeNull();
      expect(await runway.fetchOutput(bad, { fetch: reply(200, "x") }).then(() => null, (e) => e), bad).toBeInstanceOf(runway.RunwayError);
    }
    expect(calls.length).toBe(results + 1);
    /* Deleting a task: gone is gone (a 404 too); other failures are raised for the retry. */
    expect(await runway.deleteTask("task_9", { fetch: reply(204, "") })).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://api.dev.runwayml.com/v1/tasks/task_9" });
    expect(await runway.deleteTask("task_9", { fetch: reply(404, {}) })).toBe(true);
    expect(await runway.deleteTask("task_9", { fetch: reply(409, { error: "running" }) }).then(() => null, (e) => e)).toBeInstanceOf(runway.RunwayError);
    /* A refusal is a clear 4xx; a 408, a 429 and a 5xx may have taken the task. */
    for (const [status, early] of [[400, true], [402, true], [422, true], [408, false], [429, false], [500, false], [503, false]] as const) {
      const failed = await runway.submitTask({ tool: "video", model: "gen4.5", image: png, prompt: "x", duration: 5 }, { fetch: reply(status, { error: "nope" }) }).then(() => null, (e) => e);
      expect(failed.rejectedBeforeGeneration, String(status)).toBe(early);
    }
    expect(await runway.submitTask({ tool: "video", model: "gen4.5", image: png, prompt: "x", duration: 5 }, { fetch: (async () => { throw new Error("socket hang up"); }) as never }).then(() => null, (e) => e)).toMatchObject({ rejectedBeforeGeneration: false });
    /* No request follows a redirect (the key is a header, and undici forwards custom headers to another origin): each is sent with redirect "error", and a redirecting server's answer is a failure. */
    const seen: (string | undefined)[] = [];
    const redirecting = (async (_url: unknown, init?: RequestInit) => { seen.push(init?.redirect); if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect"); return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }); }) as never;
    for (const go of [
      () => runway.submitTask({ tool: "video", model: "gen4.5", image: png, prompt: "x", duration: 5 }, { fetch: redirecting }),
      () => runway.pollTask("task_9", { fetch: redirecting }),
      () => runway.fetchOutput("https://dnznrvs05pmza.cloudfront.net/o.mp4", { fetch: redirecting }),
      () => runway.deleteTask("task_9", { fetch: redirecting }),
    ]) expect(await go().then(() => null, (e) => e)).toBeInstanceOf(runway.RunwayError);
    expect(seen).toEqual(["error", "error", "error", "error"]);
    expect(calls.every((c) => c.redirect === "error" || c.method === "GET" && !c.headers.authorization)).toBe(true);
    /* The base address, if set: an https runwayml.com host with /v1 and nothing more. */
    process.env.RUNWAY_BASE_URL = "https://api.runwayml.com/v1";
    expect(runway.runwayBase()).toBe("https://api.runwayml.com/v1");
    for (const bad of ["https://api.runwayml.com.evil.com/v1", "http://api.runwayml.com/v1", "https://evil.example.com/v1", "http://127.0.0.1:9999/v1", "https://api.runwayml.com", "https://user@api.runwayml.com/v1", "https://api.runwayml.com:8443/v1", "ftp://api.runwayml.com/v1"]) {
      process.env.RUNWAY_BASE_URL = bad;
      expect(() => runway.runwayBase(), bad).toThrow(/runwayml\.com/);
    }
    delete process.env.RUNWAY_BASE_URL; delete process.env.RUNWAY_API_KEY;
    const none = await runway.submitTask({ tool: "video", model: "gen4.5", image: png, prompt: "x", duration: 5 }, { fetch: reply(200, { id: "t" }) }).then(() => null, (e) => e);
    expect(String(none.message)).toContain("RUNWAY_API_KEY");
  } finally {
    if (before.key === undefined) delete process.env.RUNWAY_API_KEY; else process.env.RUNWAY_API_KEY = before.key;
    if (before.base === undefined) delete process.env.RUNWAY_BASE_URL; else process.env.RUNWAY_BASE_URL = before.base;
  }
});

test("the fixture end to end (ENGINE_MOCK): the default adapter submits, polls, fetches and deletes in process, with the network forbidden", async () => {
  const { driveRunway } = await import("../../lib/runwayTools");
  process.env.RUNWAY_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const genId = String((await admit({ ...(await videoBody()), maxCredits: 100000 })).body.id);
      made.push(path.join(process.cwd(), ".data", "generations", `${genId}.mp4`));
      await driveRunway(genId, { budgetMs: 20_000, pauseMs: 0 });
      const take = await gen(genId);
      expect(take).toMatchObject({ status: "succeeded" });
      expect(take.rw).toMatchObject({ status: "done", vendorDeleted: 1 });
      expect(outbound).toBe(0);
    });
  } finally { globalThis.fetch = original; }
});

test("what a person reads of a Runway take: its state, tool, model and length, and none of the vendor's ids, claims, consent ids, face hashes or figures", async () => {
  const { db } = await import("../../lib/db");
  const { rowToGeneration } = await import("../../lib/jobs");
  const { publicDirectParams } = await import("../../lib/directEnginePublic");
  process.env.RUNWAY_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await asTenant(house(), async () => {
    const act = await actWorld();
    const genId = String((await admit({ ...act.body, maxCredits: 100000 }, { consent: passingFor(act.consents) })).body.id);
    await run(genId, fakeRunway({ costCredits: 25, deleteError: true }).deps, 4);
    const raw = (await db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [genId] })).rows[0];
    const rawParams = JSON.parse(String(raw.params));
    expect(Object.keys(rawParams.runway)).toEqual(expect.arrayContaining(["taskId", "consents", "inputs", "reservedUsd", "statedUsd", "pollUntil", "claimedAt", "reconcile"]));
    const read = rowToGeneration({ ...raw, project_name: null }) as unknown as { params: Record<string, unknown> };
    expect(read.params.runway).toEqual({ status: "done", tool: "performance", model: "act_two", seconds: 5 });
    expect(JSON.stringify(read.params.runway)).not.toMatch(/task_1|consent|faceSha|cast_|up_|usd|poll|claim|cleanup|reconcile|inputs/i);
    expect(publicDirectParams({ task: "runway_video" })).toEqual({ task: "runway_video" });
    expect(publicDirectParams({ task: "other", runway: { taskId: "kept" } })).toEqual({ task: "other", runway: { taskId: "kept" } });
  });
});

test("over MCP: the tools are listed only where Runway is on (the house) and the face gate can run; Ask prepares and starts nothing, Auto starts only at or under the per-job line, the caller cannot approve", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const { jobApprovalLineCredits } = await import("../../lib/approvalRule");
  const { creditUsd } = await import("../../lib/creditTerms");
  const line = jobApprovalLineCredits(creditUsd());
  const spend = async (value: string | null) => { if (value === null) await db().execute("DELETE FROM settings WHERE key='spendWithoutAsking'"); else await setSetting("spendWithoutAsking", value, "admin"); invalidateSettings(); };
  let credits = 6;
  const calls: Record<string, unknown>[] = [];
  const call = async (_p: string, init: { body?: unknown } = {}) => { const body = init.body as Record<string, unknown>; calls.push(body); if (_p === "/api/prepared-jobs") return { job: { id: "prep_r1" } }; return body.quoteOnly === true ? { estimatedCredits: credits, price: credits / 10, unit: "usd" } : { id: "gen_r1" }; };
  const VIDEO = { start_image_upload_id: "up_still", cast_member_id: "c1", project_id: "p", use: "production", prompt: "A crane lifts", duration: 5, model: "gen4_turbo" };
  await asTenant(house(), async () => {
    await ready();
    delete process.env.RUNWAY_ENABLED;
    expect((await directEngineMcpTools()).map((t) => t.name)).not.toContain("runway_video");
    await expect(runDirectEngineTool("runway_video", VIDEO, call)).rejects.toThrow("There is no such tool here.");
    process.env.RUNWAY_ENABLED = "1";
    const names = async () => (await directEngineMcpTools()).map((t) => t.name);
    expect(await names()).toEqual(expect.arrayContaining(["runway_performance", "runway_edit", "runway_video"]));
    /* Every Runway tool passes the face gate: with the face check off none is listed or callable. */
    delete process.env.REKOGNITION_ENABLED;
    expect((await names()).filter((n) => n.startsWith("runway_"))).toEqual([]);
    await expect(runDirectEngineTool("runway_video", VIDEO, call)).rejects.toThrow("There is no such tool here.");
    process.env.REKOGNITION_ENABLED = "1";
    const HERO = { ...VIDEO, model: "gen4.5" };
    try {
      for (const mode of [null, "ask", "AUTO"]) {
        await spend(mode); calls.length = 0;
        const text = await runDirectEngineTool("runway_video", HERO, call);
        expect(text, String(mode)).toMatch(/^Priced and prepared, not started\.\n\nprice: \$0\.60\nprepared: gen4\.5 clip of 5 s\nprepared job: prep_r1\n\nThis needs a person's approval: nothing was started or spent/);
        expect(calls.map((c) => [c.quoteOnly === true, c.maxCredits ?? null])).toEqual([[true, null], [false, null]]);
        expect(calls[1]).toMatchObject({ engine: "runway_video", args: { tool: "video", startImageUploadId: "up_still", castMemberId: "c1", model: "gen4.5" } });
        expect(JSON.stringify(calls[1])).not.toMatch(/maxCredits|quoteOnly/i);
      }
      /* Auto runs only a draft (gen4_turbo); the hero model gen4.5, Aleph 2 and Act-Two always ask, at any price. */
      await spend("auto");
      credits = 1; calls.length = 0;
      expect(await runDirectEngineTool("runway_video", HERO, call)).toMatch(/not started[\s\S]*prepared job: prep_r1/);
      expect(calls.some((c) => c.maxCredits !== undefined)).toBe(false);
      calls.length = 0;
      expect(await runDirectEngineTool("runway_edit", { clip_upload_id: "up_k", prompt: "grey sky", cast_member_id: "c1", face_frame_upload_id: "up_f", project_id: "p", use: "production" }, call)).toMatch(/not started/);
      expect(await runDirectEngineTool("runway_performance", { performance_clip_upload_id: "up_p", character_upload_id: "up_c", performer_cast_member_id: "c1", performer_face_upload_id: "up_f1", character_cast_member_id: "c2", project_id: "p", use: "production" }, call)).toMatch(/not started/);
      expect(calls.some((c) => c.maxCredits !== undefined)).toBe(false);
      credits = 6;
      for (const c of [6, line]) {
        credits = c; calls.length = 0;
        expect(await runDirectEngineTool("runway_video", VIDEO, call), String(c)).toMatch(/^Video started\.\n\nid: gen_r1/);
        expect(calls.map((x) => [x.quoteOnly === true, x.maxCredits ?? null, x.tool])).toEqual([[true, null, "video"], [false, c, "video"]]);
      }
      for (const c of [line + 1, 900]) {
        credits = c; calls.length = 0;
        expect(await runDirectEngineTool("runway_video", VIDEO, call), String(c)).toMatch(/not started[\s\S]*needs a person's approval/);
        expect(calls).toHaveLength(2);
      }
      credits = 6;
      for (const mode of ["ask", "auto"]) {
        await spend(mode); calls.length = 0;
        for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) await expect(runDirectEngineTool("runway_video", { ...VIDEO, ...bad }, call)).rejects.toThrow(/only a person approves/);
        expect(calls).toEqual([]);
      }
      await spend(null);
      calls.length = 0;
      const act = await runDirectEngineTool("runway_performance", { performance_clip_upload_id: "up_p", character_upload_id: "up_c", performer_cast_member_id: "c1", performer_face_upload_id: "up_f1", character_cast_member_id: "c2", project_id: "p", use: "production", body_control: true }, call);
      expect(calls[0]).toMatchObject({ tool: "performance", performanceClipUploadId: "up_p", characterUploadId: "up_c", performerCastMemberId: "c1", performerFaceUploadId: "up_f1", characterCastMemberId: "c2", bodyControl: true, quoteOnly: true });
      expect(act).toMatch(/prepared: Act-Two performance of up_p onto up_c for production p/);
      const edit = await runDirectEngineTool("runway_edit", { clip_upload_id: "up_k", prompt: "grey sky", cast_member_id: "c1", face_frame_upload_id: "up_f", project_id: "p", use: "production" }, call);
      expect(edit).toMatch(/prepared: Aleph 2 edit of up_k for production p/);
      expect(calls.filter((c) => c.quoteOnly === true).at(-1)).toMatchObject({ tool: "edit", clipUploadId: "up_k", castMemberId: "c1", quoteOnly: true });
    } finally { await spend(null); }
  });
});

/** Every source file under lib, app and components. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out.push(p.split(path.sep).join("/")); } };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

test("structure: the seams stay internal, the route is the one door, both gates come before the row and the reservation before the submit, the settings are the plan's names", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitRunway\b/)).toEqual(["lib/runwayTools.ts"]);
  expect(reachers(/\badvanceRunwayJobWith\b/)).toEqual(["lib/runwayTools.ts"]);
  expect(reachers(/@\/lib\/runwayTools["']/)).toEqual(["app/api/runway/route.ts"]);
  const flow = readFileSync("lib/runwayTools.ts", "utf8");
  const at = (needle: string) => flow.indexOf(needle);
  expect(flow).toContain("admitRunway(input, got, options, {})");
  /* The wall: the house only, unless a test passes the seam; the public admission passes none. */
  expect(flow).toContain("seams.houseOnly !== false && !isHouseWorkspace(workspace)");
  expect(at("(seams.consent ?? requireConsentMatch)(")).toBeGreaterThan(0);
  expect(at("Approve the price first")).toBeLessThan(at("(seams.consent ?? requireConsentMatch)("));
  expect(at("(seams.consent ?? requireConsentMatch)(")).toBeLessThan(at("INSERT INTO generations"));
  expect(at("INSERT INTO generations")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (deps.submit ?? submitTask)("));
  /* Both faces of an Act-Two are in the list the gate walks. */
  expect(flow).toContain('face("performer"');
  expect(flow).toContain('face("character"');
  /* Fetched, stored, settled, then the vendor's copy deleted, in that order. */
  expect(at("(deps.fetchClip ?? fetchOutput)(")).toBeLessThan(at("(deps.store ?? storeVideoBytes)("));
  expect(at("(deps.store ?? storeVideoBytes)(")).toBeLessThan(at('await settleRunway(genId, "done"'));
  expect(flow).toContain("Math.min(Math.max(0, outcome.costUsd), runway.reservedUsd)");
  expect(flow).toContain("quotedCredits(usd, model)");
  expect(flow.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/0\.0\d+|0\.1\d+/);
  const adapter = readFileSync("lib/runway.ts", "utf8");
  const names = new Set([...adapter.matchAll(/process\.env\.(RUNWAY_[A-Z_]+)/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual(["RUNWAY_API_KEY", "RUNWAY_BASE_URL"]);
  expect(adapter).toContain('export const RUNWAY_SWITCH = "RUNWAY_ENABLED";');
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  /* Every request in the adapter refuses redirects. */
  expect([...adapter.matchAll(/\(deps\.fetch \?\? recoveryFetch\)\(/g)].length).toBe(readFileSync("lib/runway.ts", "utf8").split('redirect: "error"').length - 1);
  /* No new table: the job lives in the take's own row. */
  expect(flow).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
});
