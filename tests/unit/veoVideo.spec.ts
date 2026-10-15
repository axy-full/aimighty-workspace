import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * Veo 3.1 through the Gemini API (lib/veo.ts, lib/veoVideo.ts). Mocked: every adapter call is a function this file hands the workflow (the internal seams `admitVeo` and
 * `advanceVeoJobWith`, which the public route and the cron do not offer), or the in-process fixture under ENGINE_MOCK=1; no request leaves this process and no
 * provider is paid. Local temporary databases only. Neutral sample names.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-veo-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.VEO_ENABLED; delete process.env.REKOGNITION_ENABLED; process.env.ENGINE_MOCK = "1"; });

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

/** An image upload of this workspace, with a measured size. */
async function image(label: string, width = 1024, height = 1024): Promise<{ id: string; bytes: Buffer }> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const bytes = Buffer.from(`sample-image-${id}`);
  await storeUpload(id, "png", bytes, "image/png");
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.png`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.png`, "image/png", "png", bytes.length, "x", width, height, `uploads/${id}.png`, Date.now(), "image"] });
  return { id, bytes };
}
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
  return (await platformDb().execute("SELECT id,workspace_id,status,engine_cost_usd,overrun_usd,billed_credits,paid_by_platform FROM meter_events WHERE engine='veo' ORDER BY created_at, id")).rows;
}
async function gen(id: string) {
  const { db } = await import("../../lib/db");
  const r = (await db().execute({ sql: "SELECT status,stored_url,bytes,cost_usd,error,provider_outcome,json_extract(params,'$.veo') AS veo FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
  return { status: r.status, stored_url: r.stored_url, bytes: r.bytes, cost_usd: r.cost_usd, error: r.error, provider_outcome: r.provider_outcome, veo: JSON.parse(String(r.veo)) as import("../../lib/veoVideo").VeoParams };
}
const passing = (consentId: string) => async (_cast: string, face: Buffer) => ({ consentId, similarity: 99, matched: true as const, checkedAt: Date.now(), faceSha256: `sha_${face.length}` });
type Seams = { consent?: ReturnType<typeof passing> };
async function admit(input: Record<string, unknown>, seams: Seams = {}) {
  const { admitVeo } = await import("../../lib/veoVideo");
  return admitVeo(input, OWNER, options(), seams);
}
const approved = { maxCredits: 100000 };
const PRICE = 3.2; /* Veo 3.1 Standard, 8 s: 8 x 0.40 */

function fakeVeo(over: { readyAt?: number; fail?: string; submitError?: Error; fetchErrors?: number; storeError?: Error } = {}) {
  const calls: string[] = [];
  const sent: { prompt: string; model: string; durationSeconds: number; resolution: string; aspectRatio: string; firstFrame?: { bytes: Buffer; mime: string }; references?: { bytes: Buffer; mime: string }[]; seed?: number; negativePrompt?: string }[] = [];
  let polls = 0, fetchErrors = over.fetchErrors ?? 0;
  const deps = {
    submit: async (input: (typeof sent)[number]) => {
      calls.push(`submit:${input.model}`); sent.push(input);
      if (over.submitError) throw over.submitError;
      return { operation: "models/veo-3.1-generate-preview/operations/veo_job_1" };
    },
    poll: async () => { polls++; calls.push("poll"); if (over.fail) return { status: "failed" as const, failure: over.fail }; return polls < (over.readyAt ?? 2) ? { status: "pending" as const } : { status: "ready" as const, resultUrl: "https://generativelanguage.googleapis.com/v1beta/files/veo1:download?alt=media" }; },
    fetchClip: async () => { calls.push("fetch"); if (fetchErrors > 0) { fetchErrors--; throw new Error("the clip's address did not answer"); } return Buffer.from("veo-clip"); },
    store: async (genId: string, bytes: Buffer) => { if (over.storeError) { const e = over.storeError; over.storeError = undefined; throw e; } calls.push("store"); return { url: `stored/${genId}.mp4`, bytes: bytes.length }; },
  };
  return { deps, calls, sent };
}
async function run(genId: string, deps: ReturnType<typeof fakeVeo>["deps"] & { clock?: () => number }, times = 4) {
  const { advanceVeoJobWith } = await import("../../lib/veoVideo");
  let last = null;
  for (let i = 0; i < times; i++) last = await advanceVeoJobWith(genId, deps);
  return last;
}

test("the prices are Google's published ones, verified 16 Oct 2026: per second, by model and size; the table is the one rate source; 4k and Lite are not offered", async () => {
  const { VEO_RATES } = await import("../../lib/vendorRates");
  const { veoQuoteUsd } = await import("../../lib/veo");
  expect(VEO_RATES.models["veo-3.1-generate-preview"].usdPerSecond).toEqual({ "720p": 0.4, "1080p": 0.4 });
  expect(VEO_RATES.models["veo-3.1-fast-generate-preview"].usdPerSecond).toEqual({ "720p": 0.1, "1080p": 0.12 });
  expect(Object.keys(VEO_RATES.models)).toHaveLength(2);
  expect(VEO_RATES.resolutions).toEqual(["720p", "1080p"]);
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/Verified against Google's pricing page[\s\S]{0,200}16 Oct 2026; confirm against the first invoice[\s\S]{0,1800}export const VEO_RATES/);
  expect(veoQuoteUsd({ model: "veo-3.1-generate-preview", resolution: "720p", durationSeconds: 8 })).toBeCloseTo(3.2, 6);
  expect(veoQuoteUsd({ model: "veo-3.1-generate-preview", resolution: "1080p", durationSeconds: 8 })).toBeCloseTo(3.2, 6);
  expect(veoQuoteUsd({ model: "veo-3.1-generate-preview", resolution: "720p", durationSeconds: 4 })).toBeCloseTo(1.6, 6);
  expect(veoQuoteUsd({ model: "veo-3.1-fast-generate-preview", resolution: "720p", durationSeconds: 6 })).toBeCloseTo(0.6, 6);
  expect(veoQuoteUsd({ model: "veo-3.1-fast-generate-preview", resolution: "1080p", durationSeconds: 8 })).toBeCloseTo(0.96, 6);
});

test("off: with the switch off, or a workspace not on the list, there is no tool and nothing is metered; a listed workspace is offered the clip", async () => {
  const { veoTools } = await import("../../lib/veoVideo");
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    delete process.env.VEO_ENABLED;
    expect(await veoTools()).toEqual([]);
    expect(await admit({ tool: "video", prompt: "a tree", ...approved })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    for (const odd of ["0", "true", "yes", ""]) { process.env.VEO_ENABLED = odd; expect(await veoTools(), odd).toEqual([]); }
    process.env.VEO_ENABLED = "1";
    const on = await veoTools();
    expect(on.map((t) => t.id)).toEqual(["veo_video"]);
    expect(on.every((t) => t.provider === "google" && t.route === "/api/veo" && t.models.join() === "veo-3.1-generate-preview,veo-3.1-fast-generate-preview")).toBe(true);
    expect((await meterRows()).length).toBe(before);
  });
  process.env.VEO_ENABLED = "1";
  await asTenant(tenant("ws_veo_unlisted"), async () => {
    expect(await veoTools()).toEqual([]);
    expect(await admit({ tool: "video", prompt: "a tree", quoteOnly: true })).toMatchObject({ status: 404 });
  });
});

test("the quote, and every input refused in words before anything is reserved; a quote writes nothing", async () => {
  process.env.VEO_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const q = await admit({ tool: "video", prompt: "a paper boat on a puddle", quoteOnly: true });
    expect(q).toMatchObject({ status: 200, body: { tool: "video", model: "veo-3.1-generate-preview", durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", images: 0, unit: "usd", estimatedCredits: 32 } });
    expect(Number(q.body.price)).toBeCloseTo(PRICE, 6);
    const fast = await admit({ tool: "video", prompt: "a boat", model: "veo-3.1-fast-generate-preview", resolution: "1080p", quoteOnly: true });
    expect(Number(fast.body.price)).toBeCloseTo(0.96, 6);
    expect(Number((await admit({ tool: "video", prompt: "a boat", model: "veo-3.1-fast-generate-preview", durationSeconds: 4, quoteOnly: true })).body.price)).toBeCloseTo(0.4, 6);
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ tool: "image" }, /Pick video/],
      [{ tool: "video", prompt: "" }, /Write what to make/],
      [{ tool: "video", prompt: "x".repeat(5001) }, /5,000 characters/],
      [{ tool: "video", prompt: "a", model: "veo-4" }, /Pick veo-3.1-generate-preview or veo-3.1-fast-generate-preview/],
      [{ tool: "video", prompt: "a", durationSeconds: 5 }, /4, 6, 8 seconds/],
      [{ tool: "video", prompt: "a", durationSeconds: 6, resolution: "1080p" }, /1080p clips are 8 seconds/],
      [{ tool: "video", prompt: "a", resolution: "4k" }, /720p or 1080p/],
      [{ tool: "video", prompt: "a", aspectRatio: "1:1" }, /16:9 or 9:16/],
      [{ tool: "video", prompt: "a", seed: -1 }, /seed/],
      [{ tool: "video", prompt: "a", negativePrompt: "x".repeat(1001) }, /1,000 characters/],
      [{ tool: "video", prompt: "a", references: "u1" }, /list/],
      [{ tool: "video", prompt: "a", references: Array.from({ length: 4 }, (_, i) => ({ uploadId: `u${i}`, castMemberId: "c" })) }, /At most 3/],
      [{ tool: "video", prompt: "a", firstFrame: { uploadId: "u1", castMemberId: "c" }, references: [{ uploadId: "u2", castMemberId: "c" }] }, /not both/],
      [{ tool: "video", prompt: "a", firstFrame: { uploadId: "../x", castMemberId: "c" } }, /not valid/],
      [{ tool: "video", prompt: "a", firstFrame: { uploadId: "up_not_here", castMemberId: "c" } }, /PNG, JPEG or WebP/],
    ];
    for (const [input, words] of refused) {
      const reply = await admit({ ...input, quoteOnly: true });
      expect(reply.status, JSON.stringify(input)).toBeGreaterThanOrEqual(400);
      expect(String(reply.body.error), JSON.stringify(input)).toMatch(words);
    }
    const ref = await image("ref");
    expect(await admit({ tool: "video", prompt: "a", firstFrame: { uploadId: ref.id }, quoteOnly: true })).toMatchObject({ status: 400, body: { code: "bad-input" } });
    expect(await admit({ tool: "video", prompt: "a", firstFrame: { uploadId: ref.id, castMemberId: "cast_a" }, quoteOnly: true })).toMatchObject({ status: 200, body: { images: 1 } });
    /* References need 8 s: a six-second clip from them is refused, an eight-second one is quoted at the same price (a reference costs nothing extra). */
    const six = await admit({ tool: "video", prompt: "a", durationSeconds: 6, references: [{ uploadId: ref.id, castMemberId: "cast_a" }], quoteOnly: true });
    expect(six).toMatchObject({ status: 400 });
    expect(String(six.body.error)).toMatch(/8 seconds/);
    const refs = await admit({ tool: "video", prompt: "a", aspectRatio: "9:16", references: [{ uploadId: ref.id, castMemberId: "cast_a" }], quoteOnly: true });
    expect(refs).toMatchObject({ status: 200, body: { images: 1 } });
    expect(Number(refs.body.price)).toBeCloseTo(PRICE, 6);
    expect((await meterRows()).length).toBe(before);
  });
});

test("approval: a price that is not approved, or is above the approved amount, runs and writes nothing", async () => {
  process.env.VEO_ENABLED = "1";
  await asTenant(house(), async () => {
    const { db } = await import("../../lib/db");
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    for (const bad of [{}, { maxCredits: 0 }, { maxCredits: "5" }, { maxCredits: 1.5 }, { maxCredits: 31 }]) expect((await admit({ tool: "video", prompt: "a tree", ...bad })).status, JSON.stringify(bad)).toBe(409);
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
  });
});

test("a clip from words: submit, poll, fetch the moment it is done, store under the workspace, settle at the quote and mark it to reconcile; never above the quote", async () => {
  process.env.VEO_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const handedOff = deferred.length;
    const reply = await admit({ tool: "video", prompt: "a crane at dawn", seed: 11, negativePrompt: "text", ...approved });
    expect(reply.status).toBe(200);
    expect(deferred.length).toBe(handedOff + 1);
    const genId = String(reply.body.id);
    const held = (await meterRows()).slice(before);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: genId, status: "running" });
    expect(Number(held[0].engine_cost_usd)).toBeCloseTo(PRICE, 6);
    const vendor = fakeVeo();
    const veo = await run(genId, vendor.deps, 4);
    expect(veo).toMatchObject({ status: "done", settled: 1 });
    expect(vendor.calls).toEqual(["submit:veo-3.1-generate-preview", "poll", "poll", "fetch", "store"]);
    expect(vendor.sent[0]).toMatchObject({ prompt: "a crane at dawn", durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", seed: 11, negativePrompt: "text" });
    expect(vendor.sent[0].firstFrame).toBeUndefined();
    const take = await gen(genId);
    expect(take).toMatchObject({ status: "succeeded", stored_url: `stored/${genId}.mp4` });
    expect(Number(take.cost_usd)).toBeCloseTo(PRICE, 6);
    const settled = (await meterRows()).slice(before);
    expect(settled[0]).toMatchObject({ id: genId, status: "succeeded" });
    expect(Number(settled[0].engine_cost_usd)).toBeCloseTo(PRICE, 6);
    expect(Number(settled[0].billed_credits ?? 0)).toBe(0);
    /* Google states no figure: settled at the quote and marked to reconcile. */
    expect(take.veo.reconcile).toBe(1);
    const { db } = await import("../../lib/db");
    expect(Number((await db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [genId] })).rows[0].duration_s)).toBe(8);
    /* Another step on a finished job does nothing. */
    const again = fakeVeo();
    await run(genId, again.deps, 2);
    expect(again.calls).toEqual([]);
    /* Never billed above the quote: a figure past it settles at the quote, the excess recorded as the overrun and marked to reconcile. */
    const id = String((await admit({ tool: "video", prompt: "a crane", ...approved })).body.id);
    const { settleVeo } = await import("../../lib/veoVideo");
    await settleVeo(id, "done", { costUsd: 9, storedUrl: `stored/${id}.mp4`, bytes: 1 });
    const done = await gen(id);
    expect(Number(done.cost_usd)).toBeCloseTo(PRICE, 6);
    expect(done.veo.reconcile).toBe(1);
    const line = (await meterRows()).find((r) => r.id === id)!;
    expect(Number(line.engine_cost_usd)).toBeCloseTo(PRICE, 6);
    expect(Number(line.overrun_usd)).toBeCloseTo(9 - PRICE, 6);
    expect(Number(line.billed_credits ?? 0)).toBe(0);
  });
});

test("a failure bills nothing: a blocked or failed clip, a refusal before work (a throttle too); the person is told 'Nothing billed' and the ledger line records nothing, because Google charges only for a clip it generates", async () => {
  const { VeoError } = await import("../../lib/veo");
  process.env.VEO_ENABLED = "1";
  await asTenant(house(), async () => {
    const before = (await meterRows()).length;
    const failedBy = async (over: Parameters<typeof fakeVeo>[0]) => {
      const id = String((await admit({ tool: "video", prompt: "a crane", ...approved })).body.id);
      const vendor = fakeVeo(over);
      await run(id, vendor.deps, 3);
      return { id, vendor, take: await gen(id) };
    };
    const blocked = await failedBy({ fail: "Google's safety filter stopped this." });
    expect(blocked.take.status).toBe("failed");
    expect(String(blocked.take.error)).toMatch(/Nothing was billed/);
    expect(Number(blocked.take.cost_usd)).toBe(0);
    expect(blocked.take.veo.reconcile).toBe(0);
    expect(JSON.parse(String(blocked.take.provider_outcome))).toMatchObject({ provider: "google", stage: "run", billing: { state: "not_charged" } });
    expect(blocked.vendor.calls).not.toContain("fetch");
    const errored = await failedBy({ fail: "Google could not make this clip." });
    expect(errored.take.status).toBe("failed");
    expect(JSON.parse(String(errored.take.provider_outcome))).toMatchObject({ provider: "google", stage: "run" });
    const throttled = await failedBy({ submitError: new VeoError("Google refused the request: quota", 429, true) });
    expect(throttled.take.status).toBe("failed");
    expect(JSON.parse(String(throttled.take.provider_outcome))).toMatchObject({ provider: "google", stage: "submit", code: "http_429" });
    expect(String(throttled.take.error)).toMatch(/Nothing was billed/);
    const rows = (await meterRows()).slice(before);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "failed" && Number(r.engine_cost_usd) === 0 && Number(r.billed_credits ?? 0) === 0)).toBe(true);
  });
});

test("a lost acknowledgement is never sent again, and a job that never got to its submit settles at nothing", async () => {
  const { VeoError } = await import("../../lib/veo");
  const { recoverVeoJobs, advanceVeoJobWith } = await import("../../lib/veoVideo");
  const { db } = await import("../../lib/db");
  process.env.VEO_ENABLED = "1";
  await asTenant(house(), async () => {
    const id = String((await admit({ tool: "video", prompt: "a crane", ...approved })).body.id);
    const lost = fakeVeo({ submitError: new VeoError("Google did not answer.") });
    expect(await run(id, lost.deps, 1)).toMatchObject({ status: "uncertain", settled: 0 });
    expect(String((await gen(id)).error)).toMatch(/will not be sent again/);
    expect((await meterRows()).find((r) => r.id === id)).toMatchObject({ status: "running" });
    const again = fakeVeo();
    await run(id, again.deps, 3);
    await recoverVeoJobs({ limit: 50 }, again.deps);
    expect(again.calls).toEqual([]);
    for (const [sendingAt, want] of [[null, "failed"], [1, "uncertain"]] as const) {
      const id2 = String((await admit({ tool: "video", prompt: "a crane", ...approved })).body.id);
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.veo.claimedAt',1,'$.veo.sendingAt',?) WHERE id=?", args: [sendingAt, id2] });
      const vendor = fakeVeo();
      expect(await advanceVeoJobWith(id2, { ...vendor.deps, clock: () => Date.now() + 3_600_000 }), String(sendingAt)).toMatchObject({ status: want });
      expect(vendor.calls).toEqual([]);
      expect((await meterRows()).find((r) => r.id === id2)).toMatchObject({ status: want === "failed" ? "failed" : "running" });
    }
  });
});

test("the two days: a clip that is done is fetched at once; a fetch that fails is retried while its address lives; past the window it is lost, recorded at the quote (Google made it), billed to nobody, and said so; an operation that never finishes is let go at nothing", async () => {
  const { VEO_RESULT_LIFETIME_MS, VEO_OPERATION_LIMIT_MS, advanceVeoJobWith } = await import("../../lib/veoVideo");
  expect(VEO_RESULT_LIFETIME_MS).toBe(2 * 86_400_000);
  process.env.VEO_ENABLED = "1";
  await asTenant(house(), async () => {
    const a = String((await admit({ tool: "video", prompt: "a crane", ...approved })).body.id);
    const flaky = fakeVeo({ readyAt: 1, fetchErrors: 1 });
    await expect(advanceVeoJobWith(a, flaky.deps)).rejects.toThrow();
    expect((await gen(a)).status).toBe("running");
    expect((await gen(a)).veo.readyAt).not.toBeNull();
    await run(a, flaky.deps, 2);
    expect((await gen(a)).status).toBe("succeeded");
    const b = String((await admit({ tool: "video", prompt: "a crane", ...approved })).body.id);
    const dead = fakeVeo({ readyAt: 1, fetchErrors: 99 });
    await expect(advanceVeoJobWith(b, dead.deps)).rejects.toThrow();
    const late = await advanceVeoJobWith(b, { ...dead.deps, clock: () => Date.now() + VEO_RESULT_LIFETIME_MS });
    expect(late).toMatchObject({ status: "failed", settled: 1 });
    const lost = await gen(b);
    expect(String(lost.error)).toMatch(/could not be saved in time\. Nothing was billed/);
    expect(Number(lost.cost_usd)).toBeCloseTo(PRICE, 6);
    expect(lost.veo.reconcile).toBe(1);
    const line = (await meterRows()).find((r) => r.id === b)!;
    expect(line).toMatchObject({ status: "failed" });
    expect(Number(line.engine_cost_usd)).toBeCloseTo(PRICE, 6);
    expect(Number(line.billed_credits ?? 0)).toBe(0);
    /* Never finishes: pending past the limit, settled at nothing and marked to reconcile. */
    const c = String((await admit({ tool: "video", prompt: "a crane", ...approved })).body.id);
    const stuck = fakeVeo({ readyAt: 999 });
    await advanceVeoJobWith(c, stuck.deps);
    const gone = await advanceVeoJobWith(c, { ...stuck.deps, clock: () => Date.now() + VEO_OPERATION_LIMIT_MS + 1000 });
    expect(gone).toMatchObject({ status: "failed", settled: 1 });
    const never = await gen(c);
    expect(String(never.error)).toMatch(/did not finish this clip\. Nothing was billed/);
    expect(Number(never.cost_usd)).toBe(0);
    expect(never.veo.reconcile).toBe(1);
    expect(Number((await meterRows()).find((r) => r.id === c)!.engine_cost_usd)).toBe(0);
  });
});

test("two workers at once submit once; a storage failure keeps the job and the next pass finishes it", async () => {
  const { advanceVeoJobWith } = await import("../../lib/veoVideo");
  process.env.VEO_ENABLED = "1";
  await asTenant(house(), async () => {
    const id = String((await admit({ tool: "video", prompt: "a crane", ...approved })).body.id);
    const vendor = fakeVeo({ readyAt: 1, storeError: new Error("storage is busy") });
    await Promise.allSettled([advanceVeoJobWith(id, vendor.deps), advanceVeoJobWith(id, vendor.deps)]);
    expect(vendor.calls.filter((c) => c.startsWith("submit")).length).toBe(1);
    await run(id, vendor.deps, 3);
    expect((await gen(id)).status).toBe("succeeded");
    expect(vendor.calls.filter((c) => c.startsWith("submit")).length).toBe(1);
  });
});

test("an image: a first frame or reference passes the consent gate before a row or a cent; it goes up as data with its type; the take's record names it by id and by its hash only; a withdrawn consent stops the send", async () => {
  const { db } = await import("../../lib/db");
  const { rowToGeneration } = await import("../../lib/jobs");
  process.env.VEO_ENABLED = "1";
  process.env.REKOGNITION_ENABLED = "1";
  await asTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    await project(projectId);
    const consentId = await consent(projectId, cast);
    const a = await image("ref_a"), b = await image("ref_b");
    const refsInput = { tool: "video", prompt: "her, walking", references: [{ uploadId: a.id, castMemberId: cast }, { uploadId: b.id, castMemberId: cast }], projectId, use: "production", ...approved };
    const frameInput = { tool: "video", prompt: "her, walking", firstFrame: { uploadId: a.id, castMemberId: cast }, projectId, use: "production", ...approved };
    /* The real gate refuses today (no consent record holds a face reference): nothing is created or reserved, for a frame or for references. */
    const before = (await meterRows()).length;
    const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
    for (const input of [refsInput, frameInput]) expect(await admit(input)).toMatchObject({ status: 409, body: { code: "no-reference" } });
    expect((await meterRows()).length).toBe(before);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n)).toBe(gens);
    /* A missing production or use is refused before the gate. */
    let faceCalls = 0;
    const seams = { consent: async (...x: Parameters<ReturnType<typeof passing>>) => { faceCalls++; return passing(consentId)(...x); } };
    expect((await admit({ ...refsInput, use: undefined }, seams)).status).toBe(400);
    expect((await admit({ ...refsInput, projectId: undefined }, seams)).status).toBe(400);
    expect(faceCalls).toBe(0);
    /* Passing the gate (a seam): both references were checked, then the job runs and sends them as data. */
    const reply = await admit(refsInput, seams);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(faceCalls).toBe(2);
    const genId = String(reply.body.id);
    const vendor = fakeVeo();
    await run(genId, vendor.deps, 4);
    expect(vendor.sent[0].references?.map((r) => [r.bytes.toString(), r.mime])).toEqual([[a.bytes.toString(), "image/png"], [b.bytes.toString(), "image/png"]]);
    expect(vendor.sent[0].firstFrame).toBeUndefined();
    const take = await gen(genId);
    expect(take.status).toBe("succeeded");
    expect(Number(take.cost_usd)).toBeCloseTo(PRICE, 6);
    expect(take.veo.images.map((r) => [r.role, r.uploadId, r.castMemberId, r.consentId])).toEqual([["reference", a.id, cast, consentId], ["reference", b.id, cast, consentId]]);
    expect(JSON.stringify(take.veo)).not.toMatch(/base64|sample-image/);
    /* A first frame goes as the frame. */
    const framed = String((await admit(frameInput, seams)).body.id);
    const vf = fakeVeo();
    await run(framed, vf.deps, 4);
    expect(vf.sent[0].firstFrame?.bytes.toString()).toBe(a.bytes.toString());
    expect(vf.sent[0].references).toBeUndefined();
    /* A person reads none of the working record. */
    const raw = (await db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [genId] })).rows[0];
    const read = rowToGeneration({ ...raw, project_name: null }) as unknown as { params: Record<string, unknown> };
    expect(read.params.veo).toEqual({ status: "done", model: "veo-3.1-generate-preview", durationSeconds: 8, resolution: "720p", aspectRatio: "16:9" });
    expect(JSON.stringify(read.params.veo)).not.toMatch(/veo_job_1|operation|consent|faceSha|cast_|up_|ref_a|usd|seed|images|negative/i);
    /* Consent withdrawn while the job waited: nothing is sent, nothing is billed. */
    const second = String((await admit(refsInput, seams)).body.id);
    await db().execute({ sql: "UPDATE identity_consents SET revoked_at=? WHERE id=?", args: [Date.now(), consentId] });
    const idle = fakeVeo();
    await run(second, idle.deps, 2);
    expect(idle.calls).toEqual([]);
    expect(await gen(second)).toMatchObject({ status: "failed" });
    expect(String((await gen(second)).error)).toMatch(/consent no longer holds/);
    expect(Number((await gen(second)).cost_usd)).toBe(0);
  });
  /* A customer workspace on the list is offered the clip from words, and an image there is refused at the gate (the face check is the house's only). */
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  await platformReady();
  const ws = "ws_veo_image_listed";
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)", args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`] });
  await grantCredits(ws, 500, "Test", "owner", "manual");
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [ws] })] });
    await asTenant((await getWorkspace(ws))!, async () => {
      const projectId = uid("prod");
      await project(projectId);
      const ref = await image("ref_c");
      const refused = await admit({ tool: "video", prompt: "a", firstFrame: { uploadId: ref.id, castMemberId: "cast_x" }, projectId, use: "production", ...approved });
      expect(refused).toMatchObject({ status: 403, body: { code: "off" } });
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("a listed customer workspace pays exactly the quote in credits, once, and a failure refunds it; at its own $0 cap it is refused 429 with nothing held, written or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  const { billCredits } = await import("../../lib/creditTerms");
  const { db, ready } = await import("../../lib/db");
  const { VeoError } = await import("../../lib/veo");
  await platformReady();
  const listed = "ws_veo_listed", capped = "ws_veo_cap0";
  for (const [id, cap] of [[listed, null], [capped, 0]] as const) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, cap] });
    await grantCredits(id, 500, "Test", "owner", "manual");
  }
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [listed, capped] })] });
    process.env.VEO_ENABLED = "1";
    await asTenant((await getWorkspace(listed))!, async () => {
      const expected = billCredits(PRICE, "veo-3.1-generate-preview");
      expect(await admit({ tool: "video", prompt: "a crane", quoteOnly: true })).toMatchObject({ body: { unit: "cr", estimatedCredits: expected } });
      const start = (await creditState())!.balance;
      expect((await admit({ tool: "video", prompt: "a crane", maxCredits: expected - 1 })).status).toBe(409);
      expect((await creditState())!.balance).toBe(start);
      const id = String((await admit({ tool: "video", prompt: "a crane", maxCredits: expected })).body.id);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      await run(id, fakeVeo().deps, 4);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      const mine = (await meterRows()).filter((r) => r.workspace_id === listed);
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].billed_credits)).toBe(expected);
      /* A failure refunds it. */
      const bad = String((await admit({ tool: "video", prompt: "a crane", maxCredits: expected })).body.id);
      await run(bad, fakeVeo({ submitError: new VeoError("Google refused the request: no", 400, true) }).deps, 2);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
    });
    await asTenant((await getWorkspace(capped))!, async () => {
      await ready();
      const gens = Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n);
      const handedOff = deferred.length;
      const reply = await admit({ tool: "video", prompt: "a crane", ...approved });
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

test("the fixture end to end (ENGINE_MOCK): the default adapter submits, polls and fetches in process, with the network forbidden", async () => {
  const { driveVeo } = await import("../../lib/veoVideo");
  process.env.VEO_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const id = String((await admit({ tool: "video", prompt: "a crane at dawn", ...approved })).body.id);
      await driveVeo(id, { budgetMs: 20_000, pauseMs: 0 });
      expect(await gen(id)).toMatchObject({ status: "succeeded" });
      made.push(path.join(process.cwd(), ".data", "generations", `${id}.mp4`));
      const refused = String((await admit({ tool: "video", prompt: "[[mock-refuse]] a crane", ...approved })).body.id);
      await driveVeo(refused, { budgetMs: 20_000, pauseMs: 0 });
      expect(await gen(refused)).toMatchObject({ status: "failed" });
      const filtered = String((await admit({ tool: "video", prompt: "[[mock-filtered]] a crane", ...approved })).body.id);
      await driveVeo(filtered, { budgetMs: 20_000, pauseMs: 0 });
      expect(await gen(filtered)).toMatchObject({ status: "failed" });
      expect(String((await gen(filtered)).error)).toMatch(/safety filter/);
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

test("structure: the seams stay internal, the route is the one door, consent and the reservation come before the row and the submit, every vendor call is without a redirect, the settings are the plan's names", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitVeo\b/)).toEqual(["lib/veoVideo.ts"]);
  expect(reachers(/\badvanceVeoJobWith\b/)).toEqual(["lib/veoVideo.ts"]);
  expect(reachers(/@\/lib\/veoVideo["']/)).toEqual(["app/api/veo/route.ts"]);
  const flow = readFileSync("lib/veoVideo.ts", "utf8");
  const at = (needle: string) => flow.indexOf(needle);
  expect(flow).toContain("admitVeo(input, got, options, {})");
  expect(at("(seams.consent ?? requireConsentMatch)(")).toBeGreaterThan(0);
  expect(at("(seams.consent ?? requireConsentMatch)(")).toBeLessThan(at("INSERT INTO generations"));
  expect(at("Approve the price first")).toBeLessThan(at("(seams.consent ?? requireConsentMatch)("));
  expect(at("INSERT INTO generations")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (deps.submit ?? submitVideo)("));
  /* The clip is fetched, stored and settled in that order; settled never above the quote. */
  expect(at("(deps.fetchClip ?? fetchResult)(")).toBeLessThan(at("(deps.store ?? storeVideoBytes)("));
  expect(at("(deps.store ?? storeVideoBytes)(")).toBeLessThan(at('await settleVeo(genId, "done"'));
  expect(flow).toContain("Math.min(outcome.costUsd, veo.reservedUsd)");
  /* Prices come from the rate table and the margin path. */
  expect(flow).toContain("quotedCredits(usd, model)");
  expect(flow).toContain("veoQuoteUsd(");
  expect(flow).not.toMatch(/0\.\d{2,}/);
  const adapter = readFileSync("lib/veo.ts", "utf8");
  const code = adapter.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const names = new Set([...code.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual(["GEMINI_BASE_URL"]);
  expect(adapter).toContain('export const VEO_SWITCH = "VEO_ENABLED";');
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  /* Every request goes out without following a redirect on its own: calls refuse one, and the download follows only the hops it checks. */
  const calls = [...code.matchAll(/(?:\)|doFetch)\(url\.href, \{/g)].map((m) => code.slice(m.index!, m.index! + 330));
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const c of calls) expect(c).toMatch(/redirect: "(error|manual)"/);
  expect(code).not.toMatch(/redirect: "follow"/);
  /* No new table: the job lives in the take's own row. */
  expect(flow).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
});
