import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { db, ready, now, id as newId } from "./db";
import { allowanceCheck } from "./allowance";
import { invalidate, PROJECTS_KEY } from "./cache";
import { billCredits } from "./creditTerms";
import { creditsApply } from "./credits";
import { requireTenant } from "./tenant";
import { getShot } from "./shots";
import { checkCap } from "./caps";
import { checkLimits, checkQuota } from "./limits";
import { queueSender, EVENTS } from "./inngest";
import { withRecoveryJob } from "./recovery";
import { withRetry } from "./providers";
import { storeAudioBytes } from "./storage";
import { bindGenerationRequest, reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import { elevenConfigured, submitDubbing, dubbingStatus, downloadDubbedAudio, dubbingUsd, dubbingUsdPerMinute, ElevenLabsError } from "./elevenlabs";
import { ELEVENLABS_RATES, OFFERED_DUBBING_MODES, type DubbingMode } from "./vendorRates";
import { findStoredSource, resolveStoredDuration, readStoredSourceBytes, inspectAudioBuffer, billableMinutes, SOURCE_BYTES_LIMIT, type StoredSource } from "./mediaSource.server";
import { DUBBING_SOURCE_AUTO, isDubbingLanguage, dubbingLanguageLabel } from "./workbench/dubbing-options";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";

/**
 * Dubbing: an ASYNCHRONOUS ElevenLabs project, kept as a durable workflow.
 *
 * A dub is not a render. The vendor takes the source file, answers with a
 * project id, works for minutes, and only then lets the dubbed track be
 * downloaded — so the row cannot be produced and sealed in one function
 * lifetime the way a spoken line is. Each job is therefore a row in
 * `dubbing_jobs` with a state machine:
 *
 *   queued     — admitted and funded (the reservation is the whole price:
 *                whole minutes of source × the mode's per-minute rate, one
 *                target language, charged by the vendor up front)
 *   submitted  — POST /v1/dubbing acknowledged with a project id
 *   dubbing    — the vendor reports work in progress
 *   dubbed     — the track is downloaded, stored as the generation's audio
 *                original and the reservation is settled at the flat rate
 *   failed     — refused before work (refunded), or failed by the vendor
 *                after submission (the reservation stays pending review:
 *                no receipt says whether the up-front charge came back)
 *   uncertain  — the submission's acknowledgement was lost. Nothing here
 *                ever submits a second time: a lost 202 may still be a
 *                charged project, and two projects are two bills.
 *
 * The generation row (kind audio, params.task "dub") is what Activity, the
 * job feed and the project library see; the panel places its stored track
 * on the dialogue lane when the feed reports it succeeded. Progress moves
 * through the native worker (`audio/dubbing.requested`) and the ten-minute
 * cron (`recoverDubbingJobs`), both single-attempt and idempotent against
 * the row: the permanent submit claim purchases at most one project.
 */

export const DUBBING_MODEL = "eleven_dubbing_v1";
export type DubbingJobStatus = "queued" | "submitted" | "dubbing" | "dubbed" | "failed" | "uncertain";
export type DubbingJobRow = {
  id: string; generation_id: string; owner: string; project_id: string | null; shot_id: string | null;
  source_kind: "upload" | "generation"; source_id: string; source_name: string; seconds: number; minutes: number;
  source_lang: string; target_lang: string; mode: DubbingMode; usd_per_minute: number; reserved_usd: number; estimate_credits: number;
  status: DubbingJobStatus; funded: number; submit_claimed_at: number | null; dubbing_id: string | null; expected_seconds: number | null;
  submitted_at: number | null; last_polled_at: number | null; poll_until: number | null; settled: number; error: string | null;
  created_at: number; updated_at: number;
};
export type DubbingDeps = {
  submit?: typeof submitDubbing;
  status?: typeof dubbingStatus;
  download?: typeof downloadDubbedAudio;
  store?: (genId: string, bytes: Buffer) => Promise<{ url: string; bytes: number }>;
  clock?: () => number;
};

const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A submit claim older than this without an acknowledgement is a lost one. */
const SUBMIT_GRACE_MS = 10 * 60_000;
const POLL_LEASE_MS = 120_000;
/** The vendor is asked no more often than this per job. */
export const DUBBING_POLL_INTERVAL_MS = 45_000;

const initialized = new WeakMap<Client, Promise<void>>();
export async function dubbingReady() {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(client, client.batch([
      `CREATE TABLE IF NOT EXISTS dubbing_jobs (
        id TEXT PRIMARY KEY, generation_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, project_id TEXT, shot_id TEXT,
        source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT NOT NULL, seconds REAL NOT NULL, minutes INTEGER NOT NULL,
        source_lang TEXT NOT NULL, target_lang TEXT NOT NULL, mode TEXT NOT NULL, usd_per_minute REAL NOT NULL, reserved_usd REAL NOT NULL,
        estimate_credits INTEGER NOT NULL, status TEXT NOT NULL, funded INTEGER NOT NULL DEFAULT 0, submit_claimed_at INTEGER,
        dubbing_id TEXT, expected_seconds INTEGER, submitted_at INTEGER, last_polled_at INTEGER, poll_until INTEGER,
        settled INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_dubbing_pending ON dubbing_jobs(settled, updated_at)`,
    ], "write").then(() => {}).catch((error) => { initialized.delete(client); throw error; }));
  await initialized.get(client);
}

export async function dubbingJob(id: string): Promise<DubbingJobRow | null> {
  await dubbingReady();
  return ((await db().execute({ sql: "SELECT * FROM dubbing_jobs WHERE id=?", args: [id] })).rows[0] as unknown as DubbingJobRow) ?? null;
}
export async function dubbingJobForGeneration(genId: string): Promise<DubbingJobRow | null> {
  await dubbingReady();
  return ((await db().execute({ sql: "SELECT * FROM dubbing_jobs WHERE generation_id=?", args: [genId] })).rows[0] as unknown as DubbingJobRow) ?? null;
}
export async function pendingDubbingJobs(limit = 4): Promise<DubbingJobRow[]> {
  await dubbingReady();
  return (await db().execute({
    sql: "SELECT * FROM dubbing_jobs WHERE settled=0 AND status IN ('queued','submitted','dubbing') ORDER BY updated_at ASC LIMIT ?",
    args: [Math.max(1, Math.min(50, limit))],
  })).rows as unknown as DubbingJobRow[];
}

const isMode = (value: unknown): value is DubbingMode => typeof value === "string" && (OFFERED_DUBBING_MODES as readonly string[]).includes(value);

/** The source: one stored audio or video original with a measured length. */
export async function resolveDubbingSource(body: { sourceUploadId?: unknown; sourceGenId?: unknown }): Promise<
  { source: StoredSource; seconds: number } | { error: string; status: number }
> {
  const uploadId = body.sourceUploadId ? String(body.sourceUploadId) : "";
  const genId = body.sourceGenId ? String(body.sourceGenId) : "";
  if ((!uploadId && !genId) || (uploadId && genId)) return { error: "Pick one audio or video original to dub.", status: 400 };
  if ((uploadId && !SOURCE_ID.test(uploadId)) || (genId && !SOURCE_ID.test(genId))) return { error: "That source is not valid.", status: 400 };
  const source = await findStoredSource(uploadId ? { uploadId } : { genId });
  if (!source) return { error: "That original is not in this workspace.", status: 404 };
  if (source.bytes > SOURCE_BYTES_LIMIT) return { error: "Dubbing takes a source up to 100 MB.", status: 400 };
  const length = await resolveStoredDuration(source);
  if (length.seconds == null)
    return { error: `This source has no measured length, so it cannot be priced per minute${length.reason ? `: ${length.reason}` : "."}`, status: 422 };
  return { source, seconds: length.seconds };
}

/** Admission: validate, measure, quote — and, unless quoteOnly, fund one project and hand it to the worker. */
export async function executeDubbingAdmission(
  input: Record<string, unknown>,
  got: AdmissionActor,
  options: AdmissionExecution,
): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  const body = structuredClone(input) as Record<string, unknown>;
  const quoteOnly = body.quoteOnly === true;
  await dubbingReady();
  const allowance = await allowanceCheck("elevenlabs");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });
  if (!elevenConfigured())
    return admissionReply({ error: "Sound isn't connected for this workspace. Ask the platform to connect it." }, { status: 400 });

  const resolved = await resolveDubbingSource(body);
  if ("error" in resolved) return admissionReply({ error: resolved.error }, { status: resolved.status });
  const { source, seconds } = resolved;
  const sourceLang = String(body.sourceLang ?? DUBBING_SOURCE_AUTO).trim().toLowerCase();
  const targetLang = String(body.targetLang ?? "").trim().toLowerCase();
  if (sourceLang !== DUBBING_SOURCE_AUTO && !isDubbingLanguage(sourceLang)) return admissionReply({ error: "Pick the source language, or let it be detected." }, { status: 400 });
  if (!isDubbingLanguage(targetLang)) return admissionReply({ error: "Pick the language to dub into." }, { status: 400 });
  if (sourceLang === targetLang) return admissionReply({ error: "Dub into a different language than the source." }, { status: 400 });
  const mode: DubbingMode = isMode(body.mode) ? body.mode : ELEVENLABS_RATES.dubbing.defaultMode;
  let projectId = body.projectId ? String(body.projectId) : null;
  const shotId = body.shotId ? String(body.shotId) : null;
  if (shotId) {
    const shot = await getShot(shotId);
    if (!shot) return admissionReply({ error: "That shot is gone." }, { status: 400 });
    if (projectId && shot.projectId && shot.projectId !== projectId) return admissionReply({ error: "That shot belongs to another production." }, { status: 400 });
    projectId ??= shot.projectId;
  }
  if (projectId && !(await db().execute({ sql: "SELECT id FROM projects WHERE id=?", args: [projectId] })).rows.length)
    return admissionReply({ error: "That production is not in this workspace." }, { status: 404 });

  const minutes = billableMinutes(seconds);
  const usdPerMinute = dubbingUsdPerMinute(mode);
  const reservedUsd = dubbingUsd(seconds, mode);
  const estimatedCredits = billCredits(reservedUsd, "elevenlabs");
  const inCredits = creditsApply(requireTenant());
  if (quoteOnly)
    return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : reservedUsd, unit: inCredits ? "cr" : "usd", sourceSeconds: seconds, minutes, mode });
  if (body.maxCredits != null && (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number)))
    return admissionReply({ error: "The dubbing estimate exceeds the approved credit amount. Review the price before submitting." }, { status: 409 });
  const wall = await allowanceCheck("elevenlabs", reservedUsd, "elevenlabs");
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, reservedUsd, "elevenlabs");
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const quota = await checkQuota(source.bytes);
  if (!quota.allow) return admissionReply({ error: quota.error }, { status: 507 });
  const title = `${source.name.replace(/\.[A-Za-z0-9]{1,8}$/, "")} · dubbed (${dubbingLanguageLabel(targetLang)})`.slice(0, 80);
  const compiled = { task: "dub", sourceKind: source.kind, sourceId: source.id, sourceSeconds: seconds, minutes, sourceLang, targetLang, mode, projectId, shotId };
  const stopped = admissionCheckpoint(options, body, got, "audio", reservedUsd, "elevenlabs", compiled);
  if (stopped) return stopped;

  const genId = newId("gen"), jobId = `dub_${randomUUID().replaceAll("-", "")}`, ts = now();
  const params = {
    task: "dub", dubbingStatus: "queued", dubbingJobId: jobId,
    ...(source.kind === "upload" ? { sourceUploadId: source.id } : { sourceGenId: source.id }),
    sourceName: source.name.slice(0, 200), sourceSeconds: seconds, minutes, sourceLang, targetLang, mode, usdPerMinute, estUsd: reservedUsd, estCredits: 0,
  };
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, "audio", DUBBING_MODEL, `Dub · ${source.name} → ${dubbingLanguageLabel(targetLang)}`.slice(0, 5000), JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "elevenlabs", "generate", title, "elevenlabs", shotId],
    },
    {
      sql: `INSERT INTO dubbing_jobs (id, generation_id, owner, project_id, shot_id, source_kind, source_id, source_name, seconds, minutes, source_lang, target_lang, mode, usd_per_minute, reserved_usd, estimate_credits, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
      args: [jobId, genId, got.user.id, projectId, shotId, source.kind, source.id, source.name.slice(0, 200), seconds, minutes, sourceLang, targetLang, mode, usdPerMinute, reservedUsd, estimatedCredits, ts, ts],
    },
  ], "write");
  if (options.requestClaim) await bindGenerationRequest(options.requestClaim, genId);
  invalidate(PROJECTS_KEY);
  try {
    await reserveGenerationSpend(
      { id: genId, kind: "audio", engine: "elevenlabs", model: DUBBING_MODEL, status: "running", engineCostUsd: reservedUsd, projectId, shotId, createdBy: got.user.id },
      { token: got.token },
    );
    await db().execute({ sql: "UPDATE dubbing_jobs SET funded=1, updated_at=? WHERE id=?", args: [now(), jobId] });
  } catch (e) {
    // Nothing was submitted. The row says so and the person can try again once funded.
    const message = e instanceof Error ? e.message : "The dubbing reservation could not be made.";
    await settleDubbing(jobId, "failed", { message, costUsd: 0 }).catch(() => {});
    return admissionReply({ error: message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }
  if (!(await enqueueDubbing(jobId))) await options.defer(() => advanceDubbingJob(jobId).then(() => {}));
  return admissionReply({ id: genId, jobId, status: "running", estimatedCredits, minutes, notices: capV.notice ? [capV.notice] : undefined });
}

/** The native/Inngest hand-off; false means "no queue — run it in this request's own continuation". */
export async function enqueueDubbing(jobId: string): Promise<boolean> {
  const send = queueSender();
  if (!send) return false;
  try {
    await send({ id: `dubbing-${jobId}`, name: EVENTS.dubbing, data: { jobId, workspaceId: requireTenant().id } });
    return true;
  } catch {
    return false;
  }
}

async function setStatus(row: DubbingJobRow, status: DubbingJobStatus, extra: { error?: string | null; fields?: Record<string, unknown> } = {}) {
  const fields = extra.fields ?? {};
  const sets = ["status=?", "updated_at=?", ...(extra.error !== undefined ? ["error=?"] : []), ...Object.keys(fields).map((k) => `${k}=?`)];
  const args: unknown[] = [status, now(), ...(extra.error !== undefined ? [extra.error] : []), ...Object.values(fields)];
  await db().batch([
    { sql: `UPDATE dubbing_jobs SET ${sets.join(",")} WHERE id=?`, args: [...args, row.id] as (string | number | null)[] },
    {
      sql: `UPDATE generations SET params=json_set(params,'$.dubbingStatus',?), error=?, updated_at=? WHERE id=? AND status IN ('queued','running') AND deleted=0`,
      args: [status, extra.error === undefined ? row.error : extra.error, now(), row.generation_id],
    },
  ], "write");
  invalidate(PROJECTS_KEY);
}

/** The terminal write: the generation's outcome and its bill commit together; delivery to the ledger is idempotent. */
export async function settleDubbing(
  jobId: string,
  status: "dubbed" | "failed",
  outcome: { message?: string; costUsd: number | null; storedUrl?: string; bytes?: number; seconds?: number | null },
) {
  const row = await dubbingJob(jobId);
  if (!row || row.settled) return;
  const ms = Math.max(0, now() - Number(row.created_at));
  const write = status === "dubbed"
    ? {
        sql: `UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, total_tokens=NULL, error=NULL, duration_ms=?, duration_s=?,
                params=json_set(params,'$.dubbingStatus','dubbed','$.rateUsdPerMinute',?,'$.minutes',?), updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [outcome.storedUrl ?? null, outcome.bytes ?? null, outcome.costUsd, ms, outcome.seconds ?? null, row.usd_per_minute, row.minutes, now(), row.generation_id],
      }
    : {
        sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=COALESCE(cost_usd,?),
                params=json_set(params,'$.dubbingStatus','failed'), updated_at=?
              WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
        args: [(outcome.message ?? "The dub failed.").slice(0, 600), ms, outcome.costUsd, now(), row.generation_id],
      };
  await writeGenerationOutcome(write, {
    id: row.generation_id, kind: "audio", engine: "elevenlabs", model: DUBBING_MODEL,
    status: status === "dubbed" ? "succeeded" : "failed", engineCostUsd: outcome.costUsd, durationMs: ms,
    projectId: row.project_id, shotId: row.shot_id, createdBy: row.owner,
  });
  await db().execute({
    sql: "UPDATE dubbing_jobs SET status=?, settled=1, error=?, updated_at=? WHERE id=?",
    args: [status, outcome.message ?? null, now(), row.id],
  });
  await deliverGenerationSettlement(row.generation_id);
  invalidate(PROJECTS_KEY);
}

/**
 * One step of the machine, safe to call from anywhere at any time:
 * submit a funded queued job (once), ask after a submitted one, collect a
 * finished one. Never throws for a vendor verdict; throws for transport
 * so the caller's log says so, after the row has recorded what it knows.
 */
export async function advanceDubbingJob(jobId: string, deps: DubbingDeps = {}): Promise<DubbingJobRow | null> {
  const clock = deps.clock ?? now;
  return withRecoveryJob(requireTenant().id, jobId, async () => {
    let row = await dubbingJob(jobId);
    if (!row || row.settled || row.status === "uncertain" || row.status === "failed" || row.status === "dubbed") return row;
    if (row.status === "queued") {
      if (!row.funded) return row;
      const claimed = await db().execute({
        sql: "UPDATE dubbing_jobs SET submit_claimed_at=?, updated_at=? WHERE id=? AND status='queued' AND funded=1 AND submit_claimed_at IS NULL",
        args: [clock(), clock(), jobId],
      });
      if (!claimed.rowsAffected) {
        // Someone holds the claim. A young claim is a submission in flight; an old one without an id is lost.
        if (row.submit_claimed_at && clock() - Number(row.submit_claimed_at) > SUBMIT_GRACE_MS)
          await setStatus(row, "uncertain", { error: "The dubbing submission's acknowledgement was lost. Its reservation is held for review; it will not be submitted again." });
        return dubbingJob(jobId);
      }
      row = (await dubbingJob(jobId))!;
      // The source is read before anything is sent: a file that cannot be read submits nothing and refunds everything.
      let file: { bytes: Buffer; name: string; mime: string };
      try {
        const source = await findStoredSource(row.source_kind === "upload" ? { uploadId: row.source_id } : { genId: row.source_id });
        if (!source) throw new Error("The dubbing source is no longer available in this workspace.");
        file = { bytes: await readStoredSourceBytes(source), name: source.name, mime: source.mime };
      } catch (error) {
        await settleDubbing(jobId, "failed", { message: `Nothing was submitted: ${error instanceof Error ? error.message : "the source could not be read."}`, costUsd: 0 });
        return dubbingJob(jobId);
      }
      let project: Awaited<ReturnType<typeof submitDubbing>>;
      try {
        project = await (deps.submit ?? submitDubbing)({
          file: file.bytes, filename: file.name, mime: file.mime,
          sourceLang: row.source_lang, targetLang: row.target_lang, watermark: row.mode === "v1-watermark",
        });
      } catch (error) {
        if (error instanceof ElevenLabsError && error.rejectedBeforeGeneration) {
          // Refused before any work: the whole reservation comes back.
          await settleDubbing(jobId, "failed", { message: error.message, costUsd: 0 });
          return dubbingJob(jobId);
        }
        // A timeout or a dropped connection: the vendor may hold a charged project under an id we never saw.
        await setStatus(row, "uncertain", { error: `${error instanceof Error ? error.message : "The dubbing submission did not complete."} The reservation is held for review; this request will not be submitted again.` });
        return dubbingJob(jobId);
      }
      await setStatus(row, "submitted", { error: null, fields: { dubbing_id: project.dubbingId, expected_seconds: project.expectedDurationSec, submitted_at: clock() } });
      row = (await dubbingJob(jobId))!;
    }
    if (!row.dubbing_id) return row;
    // One poller per job at a time; a poll is free, so a lost lease simply expires.
    const until = clock() + POLL_LEASE_MS;
    const lease = await db().execute({
      sql: "UPDATE dubbing_jobs SET poll_until=? WHERE id=? AND settled=0 AND COALESCE(poll_until,0)<?",
      args: [until, jobId, clock()],
    });
    if (!lease.rowsAffected) return row;
    try {
      // The attempt is recorded before the ask, so a vendor that is down is not asked again inside the interval.
      await db().execute({ sql: "UPDATE dubbing_jobs SET last_polled_at=?, updated_at=? WHERE id=?", args: [clock(), clock(), jobId] });
      const state = await (deps.status ?? dubbingStatus)(row.dubbing_id);
      if (state.status === "failed") {
        // The vendor ended it after submission. Whether the up-front charge came back is not stated anywhere we can read.
        await settleDubbing(jobId, "failed", { message: `The dub failed at the vendor${state.error ? `: ${state.error}` : "."} Its reservation stays pending reconciliation.`, costUsd: null });
        return dubbingJob(jobId);
      }
      if (state.status === "dubbing") {
        if (row.status !== "dubbing") await setStatus(row, "dubbing", { error: null });
        return dubbingJob(jobId);
      }
      const track = await (deps.download ?? downloadDubbedAudio)(row.dubbing_id, row.target_lang);
      const { value: stored } = await withRetry(() => (deps.store ?? storeAudioBytes)(row!.generation_id, track.bytes), { max: 3 });
      const seconds = await inspectAudioBuffer(track.bytes).then((m) => Math.round(m.seconds * 1000) / 1000).catch(() => null);
      await settleDubbing(jobId, "dubbed", { costUsd: row.reserved_usd, storedUrl: stored.url, bytes: stored.bytes, seconds });
      return dubbingJob(jobId);
    } catch (error) {
      // Transport or storage: keep the id and the reservation; the next pass asks again. Nothing is resubmitted.
      await db().execute({ sql: "UPDATE dubbing_jobs SET error=?, updated_at=? WHERE id=? AND settled=0", args: [(error instanceof Error ? error.message : "The dub could not be checked.").slice(0, 600), clock(), jobId] });
      throw error;
    } finally {
      await db().execute({ sql: "UPDATE dubbing_jobs SET poll_until=NULL WHERE id=? AND poll_until=?", args: [jobId, until] }).catch(() => {});
    }
  });
}

/**
 * The cron's reconciliation stage, shaped like recoverAstraRenders: a queued
 * job is handed to the worker (or advanced here when there is no queue), a
 * submitted one is asked after when its last check is old enough; uncertain
 * and terminal rows are left alone.
 */
export async function recoverDubbingJobs(
  options: { limit?: number; deadlineAt?: number } = {},
  deps: { enqueue?: typeof enqueueDubbing; advance?: typeof advanceDubbingJob; clock?: () => number } = {},
) {
  const clock = deps.clock ?? now;
  const jobs = await pendingDubbingJobs(options.limit ?? 4);
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  let attempted = 0, failed = 0, deferred = 0;
  for (const job of jobs) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    if (job.status !== "queued" && job.last_polled_at && clock() - Number(job.last_polled_at) < DUBBING_POLL_INTERVAL_MS) continue;
    attempted++;
    try {
      if (job.status === "queued" && job.funded && !job.submit_claimed_at && (await (deps.enqueue ?? enqueueDubbing)(job.id))) continue;
      await (deps.advance ?? advanceDubbingJob)(job.id);
    } catch {
      failed++;
    }
  }
  return { attempted, failed, deferred };
}
