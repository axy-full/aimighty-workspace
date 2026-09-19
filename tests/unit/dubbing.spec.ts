import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * Dubbing (PR C2, part 3): a durable asynchronous workflow. Admission
 * reserves whole minutes × the mode's per-minute price for one language;
 * the machine submits once, polls, downloads and settles on the reserved
 * amount; a lost acknowledgement is uncertain and never resubmitted.
 * The vendor is a fake here; nothing reaches the network.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-dubbing-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const originalFetch = globalThis.fetch;
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

async function workspace(id: string) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: `INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 200, "Test funds", "owner", "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}
/** Local upload storage lives under the checkout's .data; the files written here carry this run's stamp and are removed after. */
const UPLOADS = path.join(process.cwd(), ".data", "uploads");
const stamp = `dub${Date.now().toString(36)}`;
const tone = readFileSync(path.resolve("public/fixtures/tone.mp3"));
const written: string[] = [];
test.afterAll(() => { for (const file of written) rmSync(file, { force: true }); });
/** A stored source with a known (recorded) length: 150 s → 3 started minutes; its bytes on disk are the fixture tone. */
async function seedSource(name = "main", seconds: number | null = 150, kind = "audio", bytes: Buffer = tone) {
  const { db } = await import("../../lib/db");
  const uploadId = `${stamp}-${name}`;
  await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Project',0)");
  mkdirSync(UPLOADS, { recursive: true });
  const file = path.join(UPLOADS, `${uploadId}.mp3`);
  writeFileSync(file, bytes);
  written.push(file);
  await db().execute({
    sql: "INSERT OR IGNORE INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,?,?)",
    args: [uploadId, "Interview.mp3", "audio/mpeg", "mp3", bytes.length, "x", `/api/uploads/${uploadId}`, kind, seconds, Date.now()],
  });
  return uploadId;
}
const noop = { defer: async () => {} };

test("a dub is quoted per started minute for one language at the mode's rate, and refused without a length or a target", async () => {
  const { ELEVENLABS_RATES, OFFERED_DUBBING_MODES } = await import("../../lib/vendorRates");
  const { dubbingUsd } = await import("../../lib/elevenlabs");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { executeDubbingAdmission } = await import("../../lib/dubbing");
  const { billCredits } = await import("../../lib/creditTerms");
  expect(ELEVENLABS_RATES.dubbing.modes).toEqual({ "v1-watermark": 0.33, v1: 0.5, v2: 2.2 });
  expect(OFFERED_DUBBING_MODES).toEqual(["v1", "v1-watermark"]);
  expect(dubbingUsd(150, "v1")).toBe(1.5);
  expect(dubbingUsd(150, "v1-watermark")).toBe(0.99);
  expect(dubbingUsd(30, "v2")).toBe(2.2);
  const ws = await workspace("dub-quote");
  await runInTenant(ws, async () => {
    await ready();
    const src = await seedSource();
    const unknownSrc = await seedSource("unknown", null);
    const brokenSrc = await seedSource("broken", null, "audio", Buffer.from("plainly not audio ".repeat(40)));
    const videoSrc = await seedSource("video", 61, "video");
    const quote = await executeDubbingAdmission({ sourceUploadId: src, targetLang: "es", projectId: "project", quoteOnly: true }, actor, noop);
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ estimatedCredits: billCredits(1.5, "elevenlabs"), unit: "cr", sourceSeconds: 150, minutes: 3, mode: "v1" });
    const marked = await executeDubbingAdmission({ sourceUploadId: src, targetLang: "es", mode: "v1-watermark", quoteOnly: true }, actor, noop);
    expect(marked.body).toMatchObject({ estimatedCredits: billCredits(0.99, "elevenlabs"), mode: "v1-watermark" });
    // v2 is priced but not offered: an unknown mode falls back to the default.
    expect((await executeDubbingAdmission({ sourceUploadId: src, targetLang: "es", mode: "v2", quoteOnly: true }, actor, noop)).body).toMatchObject({ mode: "v1" });
    // A video original is a dub source too.
    expect((await executeDubbingAdmission({ sourceUploadId: videoSrc, targetLang: "fr", quoteOnly: true }, actor, noop)).body).toMatchObject({ minutes: 2 });
    // No recorded length: measured from the stored file on first read (the three-second tone), then persisted.
    const measured = await executeDubbingAdmission({ sourceUploadId: unknownSrc, targetLang: "es", quoteOnly: true }, actor, noop);
    expect(measured.status).toBe(200);
    expect(measured.body).toMatchObject({ minutes: 1, estimatedCredits: billCredits(0.5, "elevenlabs") });
    expect(Number((await db().execute({ sql: "SELECT duration_s FROM uploads WHERE id=?", args: [unknownSrc] })).rows[0].duration_s)).toBeGreaterThan(2.5);
    // No length and nothing readable: refused with the reason, and no project is ever priced from a guess.
    const unknown = await executeDubbingAdmission({ sourceUploadId: brokenSrc, targetLang: "es", quoteOnly: true }, actor, noop);
    expect(unknown.status).toBe(422);
    expect(String(unknown.body.error)).toMatch(/no measured length/);
    expect((await executeDubbingAdmission({ sourceUploadId: src, quoteOnly: true }, actor, noop)).status).toBe(400);
    expect((await executeDubbingAdmission({ sourceUploadId: src, targetLang: "xx", quoteOnly: true }, actor, noop)).status).toBe(400);
    expect((await executeDubbingAdmission({ sourceUploadId: src, sourceLang: "es", targetLang: "es", quoteOnly: true }, actor, noop)).status).toBe(400);
    expect((await executeDubbingAdmission({ sourceUploadId: "missing", targetLang: "es", quoteOnly: true }, actor, noop)).status).toBe(404);
    expect((await executeDubbingAdmission({ sourceUploadId: src, targetLang: "es", maxCredits: 1 }, actor, noop)).status).toBe(409);
    expect((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n).toBe(0);
    expect((await db().execute("SELECT COUNT(*) AS n FROM dubbing_jobs")).rows[0].n).toBe(0);
  }, actor);
});

test("submission funds one project, then submit → poll → download → settle on the reserved amount, never submitting twice", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { executeDubbingAdmission, advanceDubbingJob, dubbingJob, dubbingJobForGeneration, recoverDubbingJobs } = await import("../../lib/dubbing");
  const { billingStateFor } = await import("../../lib/billingLedger");
  const { platformDb } = await import("../../lib/platform");
  const { billCredits } = await import("../../lib/creditTerms");
  const ws = await workspace("dub-lifecycle");
  const before = (await billingStateFor(ws.id)).credits.balance;
  await runInTenant(ws, async () => {
    await ready();
    const src = await seedSource();
    const deferred: (() => Promise<unknown>)[] = [];
    // Through the same durable request claim the route uses, so a replay of the key answers with this job.
    const { withGenerationRequestData } = await import("../../lib/generationRequests");
    const { admissionResponse } = await import("../../lib/admissionSupport");
    const response = await withGenerationRequestData({ userId: "owner", key: "dub-request-1", fingerprint: "fp" }, async (requestClaim) =>
      admissionResponse(await executeDubbingAdmission(
        { sourceUploadId: src, sourceLang: "en", targetLang: "es", mode: "v1", projectId: "project", maxCredits: billCredits(1.5, "elevenlabs") },
        actor, { defer: async (work) => { deferred.push(work); }, requestClaim },
      )),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; jobId: string; status: string; minutes: number; estimatedCredits: number };
    expect(body).toMatchObject({ status: "running", minutes: 3, estimatedCredits: billCredits(1.5, "elevenlabs") });
    const genId = body.id, jobId = body.jobId;
    expect(deferred).toHaveLength(1); // no queue in tests: the work runs in the request's continuation
    const gen = (await db().execute({ sql: "SELECT status,model,title,prompt,params,shot_id FROM generations WHERE id=?", args: [genId] })).rows[0];
    expect(gen.status).toBe("running");
    expect(gen.model).toBe("eleven_dubbing_v1");
    expect(gen.title).toBe("Interview · dubbed (Spanish)");
    expect(JSON.parse(String(gen.params))).toMatchObject({ task: "dub", dubbingStatus: "queued", sourceUploadId: src, sourceSeconds: 150, minutes: 3, targetLang: "es", mode: "v1", usdPerMinute: 0.5, estUsd: 1.5 });
    const job = (await dubbingJob(jobId))!;
    expect(job).toMatchObject({ generation_id: genId, status: "queued", funded: 1, minutes: 3, reserved_usd: 1.5, usd_per_minute: 0.5, target_lang: "es", source_lang: "en", settled: 0 });
    expect((await dubbingJobForGeneration(genId))?.id).toBe(jobId);
    // The reservation is the whole price, in the ledger, before anything is sent.
    expect((await platformDb().execute({ sql: "SELECT status,engine_cost_usd FROM meter_events WHERE id=?", args: [genId] })).rows[0]).toMatchObject({ status: "running", engine_cost_usd: 1.5 });

    // The fake vendor: submit once, "dubbing" on the first poll, "dubbed" after, then a track to download.
    const submits: Parameters<typeof import("../../lib/elevenlabs").submitDubbing>[0][] = [];
    let polls = 0;
    const deps = {
      submit: async (opts: Parameters<typeof import("../../lib/elevenlabs").submitDubbing>[0]) => { submits.push(opts); return { dubbingId: "dub-vendor-1", expectedDurationSec: 90 }; },
      status: async () => ({ status: (++polls < 2 ? "dubbing" : "dubbed") as "dubbing" | "dubbed", error: null, targetLanguages: ["es"] }),
      download: async (id: string, lang: string) => { expect(id).toBe("dub-vendor-1"); expect(lang).toBe("es"); return { bytes: Buffer.from("ID3dubbed"), mime: "audio/mpeg" }; },
      store: async (id: string, bytes: Buffer) => ({ url: `/api/media/${id}`, bytes: bytes.length }),
    };
    let row = (await advanceDubbingJob(jobId, deps))!;
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({ filename: "Interview.mp3", mime: "audio/mpeg", sourceLang: "en", targetLang: "es", watermark: false });
    expect(submits[0].file.equals(tone)).toBe(true);
    expect(row.status).toBe("dubbing");
    expect(row.dubbing_id).toBe("dub-vendor-1");
    expect(row.expected_seconds).toBe(90);
    expect(JSON.parse(String((await db().execute({ sql: "SELECT params FROM generations WHERE id=?", args: [genId] })).rows[0].params)).dubbingStatus).toBe("dubbing");
    // A second delivery does not submit again; the poll lease is held for the interval, so it is a no-op here.
    row = (await advanceDubbingJob(jobId, deps))!;
    expect(submits).toHaveLength(1);
    // Past the lease: the next ask finds it dubbed, downloads, stores and settles at the reserved flat rate.
    await db().execute({ sql: "UPDATE dubbing_jobs SET poll_until=NULL WHERE id=?", args: [jobId] });
    row = (await advanceDubbingJob(jobId, deps))!;
    expect(row.status).toBe("dubbed");
    expect(row.settled).toBe(1);
    expect(submits).toHaveLength(1);
    const done = (await db().execute({ sql: "SELECT status,stored_url,bytes,cost_usd,params FROM generations WHERE id=?", args: [genId] })).rows[0];
    expect(done).toMatchObject({ status: "succeeded", stored_url: `/api/media/${genId}`, bytes: 9, cost_usd: 1.5 });
    expect(JSON.parse(String(done.params))).toMatchObject({ dubbingStatus: "dubbed", rateUsdPerMinute: 0.5, minutes: 3 });
    expect((await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id=?", args: [genId] })).rows[0]).toMatchObject({ status: "succeeded", engine_cost_usd: 1.5, billed_credits: billCredits(1.5, "elevenlabs") });
    // Finished rows are left alone by every later pass.
    expect((await advanceDubbingJob(jobId, deps))!.status).toBe("dubbed");
    expect(await recoverDubbingJobs({}, { advance: async () => { throw new Error("must not touch a settled job"); } })).toEqual({ attempted: 0, failed: 0, deferred: 0 });
    // Idempotent request key: the same key replays the recorded answer, no second project.
    const replay = await withGenerationRequestData({ userId: "owner", key: "dub-request-1", fingerprint: "fp" }, async () => Response.json({ never: true }));
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toMatchObject({ id: genId, jobId });
    expect((await db().execute("SELECT COUNT(*) AS n FROM dubbing_jobs")).rows[0].n).toBe(1);
  }, actor);
  expect((await billingStateFor(ws.id)).credits.balance).toBe(before - billCredits(1.5, "elevenlabs"));
});

test("a vendor refusal refunds, a vendor failure keeps the reservation pending, and a lost acknowledgement is uncertain and never resubmitted", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { executeDubbingAdmission, advanceDubbingJob, dubbingJob, recoverDubbingJobs } = await import("../../lib/dubbing");
  const { ElevenLabsError } = await import("../../lib/elevenlabs");
  const { platformDb } = await import("../../lib/platform");
  const { billCredits } = await import("../../lib/creditTerms");
  const ws = await workspace("dub-failures");
  await runInTenant(ws, async () => {
    await ready();
    const src = await seedSource();
    const admit = async (key: string) => {
      const reply = await executeDubbingAdmission({ sourceUploadId: src, targetLang: "de", projectId: "project", maxCredits: billCredits(1.5, "elevenlabs") }, actor, { ...noop, requestClaim: { userId: "owner", key } });
      expect(reply.status).toBe(200);
      return { genId: String(reply.body.id), jobId: String(reply.body.jobId) };
    };
    const noStore = { store: async () => { throw new Error("nothing to store"); } };
    // 1. Refused before any work (422): failed, the whole reservation released.
    const refused = await admit("dub-refused");
    await advanceDubbingJob(refused.jobId, { ...noStore, submit: async () => { throw new ElevenLabsError(422, "ElevenLabs refused the request: unsupported language."); } });
    expect((await dubbingJob(refused.jobId))!).toMatchObject({ status: "failed", settled: 1 });
    expect((await db().execute({ sql: "SELECT status,cost_usd,error FROM generations WHERE id=?", args: [refused.genId] })).rows[0]).toMatchObject({ status: "failed", cost_usd: 0 });
    expect((await platformDb().execute({ sql: "SELECT status,engine_cost_usd FROM meter_events WHERE id=?", args: [refused.genId] })).rows[0]).toMatchObject({ status: "failed", engine_cost_usd: 0 });
    // 2. Submitted, then failed by the vendor: failed, the reservation kept (no receipt says the up-front charge came back).
    const failed = await admit("dub-vendor-failed");
    await advanceDubbingJob(failed.jobId, { ...noStore, submit: async () => ({ dubbingId: "dub-2", expectedDurationSec: 10 }), status: async () => ({ status: "failed" as const, error: "no speech detected", targetLanguages: [] }) });
    expect((await dubbingJob(failed.jobId))!).toMatchObject({ status: "failed", settled: 1, dubbing_id: "dub-2" });
    const failedGen = (await db().execute({ sql: "SELECT status,cost_usd,error FROM generations WHERE id=?", args: [failed.genId] })).rows[0];
    expect(failedGen.status).toBe("failed");
    expect(failedGen.cost_usd).toBeNull();
    expect(String(failedGen.error)).toMatch(/no speech detected/);
    expect((await platformDb().execute({ sql: "SELECT status,engine_cost_usd FROM meter_events WHERE id=?", args: [failed.genId] })).rows[0]).toMatchObject({ status: "failed", engine_cost_usd: 1.5 });
    // 3. The acknowledgement is lost (timeout): uncertain, and no later pass submits again.
    const lost = await admit("dub-lost");
    let submits = 0;
    const timeout = { ...noStore, submit: async () => { submits++; throw new Error("ElevenLabs did not answer within 120s. The outcome is unconfirmed; this request will not be submitted again automatically."); } };
    await advanceDubbingJob(lost.jobId, timeout);
    const uncertain = (await dubbingJob(lost.jobId))!;
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.settled).toBe(0);
    expect(String(uncertain.error)).toMatch(/not be submitted again/);
    const lostGen = (await db().execute({ sql: "SELECT status,params,error FROM generations WHERE id=?", args: [lost.genId] })).rows[0];
    expect(lostGen.status).toBe("running");
    expect(JSON.parse(String(lostGen.params)).dubbingStatus).toBe("uncertain");
    expect((await platformDb().execute({ sql: "SELECT status FROM meter_events WHERE id=?", args: [lost.genId] })).rows[0].status).toBe("running");
    await advanceDubbingJob(lost.jobId, timeout);
    await recoverDubbingJobs({}, { advance: async (id) => advanceDubbingJob(id, timeout) });
    expect(submits).toBe(1);
    expect((await dubbingJob(lost.jobId))!.status).toBe("uncertain");
    // 4. A claim that was taken but never acknowledged (a crash mid-submit) goes uncertain once its grace has passed; still no resubmission.
    const crashed = await admit("dub-crashed");
    await db().execute({ sql: "UPDATE dubbing_jobs SET submit_claimed_at=? WHERE id=?", args: [Date.now() - 11 * 60_000, crashed.jobId] });
    await advanceDubbingJob(crashed.jobId, { ...noStore, submit: async () => { throw new Error("must not submit under another claim"); } });
    expect((await dubbingJob(crashed.jobId))!.status).toBe("uncertain");
    // 5. A transport error on a poll keeps the id and the reservation for the next pass; the cron reports the failure.
    const flaky = await admit("dub-flaky");
    await advanceDubbingJob(flaky.jobId, { ...noStore, submit: async () => ({ dubbingId: "dub-5", expectedDurationSec: 5 }), status: async () => { throw new Error("Could not reach ElevenLabs: socket hang up"); } }).catch(() => {});
    let flakyRow = (await dubbingJob(flaky.jobId))!;
    expect(flakyRow).toMatchObject({ status: "submitted", dubbing_id: "dub-5", settled: 0 });
    expect(String(flakyRow.error)).toMatch(/socket hang up/);
    await db().execute({ sql: "UPDATE dubbing_jobs SET last_polled_at=NULL, poll_until=NULL WHERE id=?", args: [flaky.jobId] });
    const report = await recoverDubbingJobs({ limit: 10 }, { advance: async (id) => advanceDubbingJob(id, { ...noStore, status: async () => { throw new Error("still down"); } }) });
    expect(report.failed).toBe(1);
    // …and a recent poll is not repeated within the interval.
    flakyRow = (await dubbingJob(flaky.jobId))!;
    expect(Number(flakyRow.last_polled_at)).toBeGreaterThan(0);
    const skipped = await recoverDubbingJobs({ limit: 10 }, { advance: async () => { throw new Error("polled too soon"); } });
    expect(skipped).toEqual({ attempted: 0, failed: 0, deferred: 0 });
  }, actor);
});

test("recovery hands a funded queued job to the worker, advances it inline when there is no queue, and stops at the deadline", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  const { executeDubbingAdmission, recoverDubbingJobs, dubbingJob } = await import("../../lib/dubbing");
  const { billCredits } = await import("../../lib/creditTerms");
  const ws = await workspace("dub-recovery");
  await runInTenant(ws, async () => {
    await ready();
    const src = await seedSource();
    const reply = await executeDubbingAdmission({ sourceUploadId: src, targetLang: "it", projectId: "project", maxCredits: billCredits(1.5, "elevenlabs") }, actor, { ...noop, requestClaim: { userId: "owner", key: "dub-recover" } });
    const jobId = String(reply.body.jobId);
    const enqueued: string[] = [], advanced: string[] = [];
    expect(await recoverDubbingJobs({}, { enqueue: async (id) => { enqueued.push(id); return true; }, advance: async (id) => { advanced.push(id); return dubbingJob(id); } })).toEqual({ attempted: 1, failed: 0, deferred: 0 });
    expect(enqueued).toEqual([jobId]);
    expect(advanced).toEqual([]);
    expect(await recoverDubbingJobs({}, { enqueue: async () => false, advance: async (id) => { advanced.push(id); return dubbingJob(id); } })).toEqual({ attempted: 1, failed: 0, deferred: 0 });
    expect(advanced).toEqual([jobId]);
    expect(await recoverDubbingJobs({ deadlineAt: Date.now() - 1 }, { enqueue: async () => { throw new Error("past the deadline"); } })).toEqual({ attempted: 0, failed: 0, deferred: 1 });
    expect((await dubbingJob(jobId))!.status).toBe("queued");
  }, actor);
});
