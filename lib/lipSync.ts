import { fundedOutcome } from "./providerFailure";
import { directErrorOutcome, serializeOutcome, silentOutcome, type ProviderOutcome } from "./providerOutcome";
import { db, ready, now, id as newId } from "./db";
import { allowanceCheck } from "./allowance";
import { invalidate, PROJECTS_KEY } from "./cache";
import { creditsApply, quotedCredits } from "./credits";
import { currentTenant, requireTenant } from "./tenant";
import { getShot } from "./shots";
import { checkCap } from "./caps";
import { checkLimits, checkQuota } from "./limits";
import { withRecoveryJob } from "./recovery";
import { withRetry } from "./providers";
import { readUploadBytes, storeVideoBytes } from "./storage";
import { claimBinding, reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import { findStoredSource, resolveStoredDuration, readStoredSourceBytes, SOURCE_BYTES_LIMIT, type StoredSource } from "./mediaSource.server";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow, shotCapGate } from "./shotCap";
import { currentViewer, uploadOpenableBy } from "./uploadAccess";
import { engineEnabled } from "./engineGate";
import { SYNC_RATES, type SyncMode, type SyncModel } from "./vendorRates";
import { SYNC_SWITCH, SyncError, SyncOutputRefused, deleteAsset, deleteGeneration, downloadOutput, generationStatus, isSyncMode, isSyncModel, submitLipSync, syncConfigured, uploadAsset } from "./syncso";
import { ConsentMatchError, faceCheckAvailable, requireConsentMatch, type ConsentMatch, type ConsentScope } from "./consentMatch";
import { liveVoiceConsentFor, getConsent } from "./security/consent";
import { consentLive } from "./security/consent-words";

/**
 * Lip-sync, DIRECT through sync.so (lib/syncso.ts): a clip and a voice track in, the clip with its mouth matched to the words out. An ASYNCHRONOUS
 * vendor job kept as a durable workflow in the take's own row (generations.params.lipsync; no new table), shaped like dubbing (lib/dubbing.ts):
 *
 *   queued      admitted, consent passed, funded (the reservation is the whole price: output seconds x the model's per-second rate)
 *   submitted   the job is with sync.so (an id)
 *   processing  sync.so reports work in progress
 *   done        the clip is downloaded, STORED under the workspace's own prefix, the row settled at the delivered length, and the vendor's copy deleted
 *   failed      refused before work or failed after: settled at NOTHING ("Nothing billed"), the vendor's copy (if any) deleted
 *   uncertain   the submission's acknowledgement was lost. Nothing here ever submits a second time: a lost reply may still be a charged job
 *
 * THE CONSENT GATE. A face image passes `requireConsentMatch` (lib/consentMatch.ts) BEFORE anything is reserved or sent: a still the caller chooses (an image
 * upload of this workspace), with the cast member, the production and the use named. **What is checked is that chosen image against the cast member's consent
 * reference. It is NOT proven to come from the clip**: Particl cannot decode a clip's frames on the server today, so a caller could name a still of one person
 * and a clip of another. That gap is the owner's to close (an extracted frame, or a face check inside the clip); until then it is stated, not hidden. A voice that is not a stock synthesized one (an upload, anything but a
 * speech, dialogue or dub take) also needs a live consent covering the VOICE. Today the face gate refuses every check (no consent record holds a face
 * reference yet, lib/consentReference.ts) and it runs for the house workspace only, so no lip-sync is admitted until the owner chooses that source.
 * Because "real" cannot be known from a clip, there is no "this face is not real" exemption: every lip-sync passes the gate.
 *
 * MONEY. Quote: the output seconds (the audio's length for cut_off, else the longer track) x the rate in lib/vendorRates.ts SYNC_RATES (the plan's
 * recorded provider prices, to confirm), through the margin table (quotedCredits) as every engine; reserved at the quote on the meter; settled at the
 * delivered output length (never past the quote) x the rate, which is the real provider cost on the ledger line; at nothing on any failure.
 * A person approves: `maxCredits` must cover the quote.
 *
 * PRIVACY. Both inputs go up to sync.so as assets from bytes read on the server (our storage links never leave Particl). Once the output is stored, the
 * job's own copy and the two input assets are deleted at the vendor (owner, 14 Oct: "Delete the vendor's copy once we've stored the output"); a failed
 * delete is retried by the cron up to CLEANUP_MAX_TRIES times and never blocks the take. Only ids and figures are written to the row.
 */
export const LIPSYNC_TASK = "lipsync";
export const LIPSYNC_MAX_SECONDS = 600;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENTITY_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const SUBMIT_GRACE_MS = 10 * 60_000;
const POLL_LEASE_MS = 120_000;
export const LIPSYNC_POLL_INTERVAL_MS = 15_000;
export const CLEANUP_MAX_TRIES = 5;
/** What a take of Particl's own may be, to be a synthesized stock voice with no real person's: ElevenLabs speech or dialogue, with EVERY voice a `premade` one. */
const SYNTHETIC_AUDIO_TASKS = ["speech", "dialogue"];
/** The uses a lip-synced face may be for. */
const LIPSYNC_USES = ["production", "ads", "social"] as const;

export type LipSyncState = "queued" | "submitted" | "processing" | "done" | "failed" | "uncertain";
export type LipSyncParams = {
  status: LipSyncState; model: SyncModel; syncMode: SyncMode;
  videoSource: { kind: "upload" | "generation"; id: string }; audioSource: { kind: "upload" | "generation"; id: string };
  seconds: number; audioSeconds: number; rateUsdPerSecond: number; reservedUsd: number; estimateCredits: number;
  consentId: string; castMemberId: string; use: string; faceSha256: string; voiceConsentId: string | null;
  funded: number; claimedAt: number | null; syncId: string | null; videoAsset: string | null; audioAsset: string | null;
  submittedAt: number | null; lastPolledAt: number | null; pollUntil: number | null; settled: number;
  cleanupDue: number; cleanupTries: number; vendorDeleted: number; reconcile: number;
};
type Row = { id: string; project_id: string | null; shot_id: string | null; created_by: string | null; status: string; created_at: number; params: string };
type Job = { row: Row; lip: LipSyncParams; model: SyncModel };

/** The workflow's adapter seams, for tests. Public callers (the route, the cron) pass none. */
export type LipSyncDeps = {
  upload?: typeof uploadAsset; submit?: typeof submitLipSync; status?: typeof generationStatus; download?: typeof downloadOutput;
  store?: (genId: string, bytes: Buffer) => Promise<{ url: string; bytes: number }>;
  deleteJob?: typeof deleteGeneration; deleteAsset?: typeof deleteAsset; clock?: () => number;
};

/* ── The row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

async function load(genId: string, opts: { any?: boolean } = {}): Promise<Job | null> {
  await ready();
  const row = (await db().execute({
    sql: `SELECT id, project_id, shot_id, created_by, status, created_at, params FROM generations WHERE id=? AND json_extract(params,'$.task')=?${opts.any ? "" : " AND deleted=0"}`,
    args: [genId, LIPSYNC_TASK],
  })).rows[0] as unknown as Row | undefined;
  if (!row) return null;
  let lip: LipSyncParams | undefined;
  try { lip = (JSON.parse(row.params) as { lipsync?: LipSyncParams }).lipsync; } catch { /* unreadable */ }
  return lip && isSyncModel(lip.model) ? { row, lip, model: lip.model } : null;
}

/** Writes some of the job's own fields, optionally only while a guard holds (an atomic claim). Returns whether a row changed. */
async function patch(genId: string, fields: Partial<LipSyncParams>, guard?: { sql: string; args?: (string | number)[] }): Promise<boolean> {
  const entries = Object.entries(fields);
  const sets = entries.map(() => "?,?").join(",");
  const args: (string | number | null)[] = [];
  for (const [k, v] of entries) args.push(`$.lipsync.${k}`, v === undefined ? null : (v as string | number | null));
  const rs = await db().execute({
    sql: `UPDATE generations SET params=json_set(params,${sets}), updated_at=? WHERE id=? AND json_extract(params,'$.task')=?${guard ? ` AND ${guard.sql}` : ""}`,
    args: [...args, now(), genId, LIPSYNC_TASK, ...(guard?.args ?? [])],
  });
  return rs.rowsAffected > 0;
}

/* ── The quote ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The output seconds a lip-sync is quoted at: the audio's length for cut_off, otherwise the longer of the two tracks (the most any mode returns). */
export const quotedSeconds = (videoSeconds: number, audioSeconds: number, syncMode: SyncMode): number =>
  Math.round((syncMode === "cut_off" ? audioSeconds : Math.max(videoSeconds, audioSeconds)) * 1000) / 1000;
/** Dollars at the model's per-second rate, to the micro-dollar. */
export const lipSyncUsd = (seconds: number, model: SyncModel): number => Math.ceil(seconds * SYNC_RATES.models[model] * 1e6 - 1e-6) / 1e6;

/* ── Admission ──────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** What the face gate and the admission may be handed in a test. The public admission passes none. */
export type LipSyncSeams = { consent?: (castMemberId: string, face: Buffer, scope: ConsentScope) => Promise<ConsentMatch>; voices?: () => Promise<{ id: string; category: string }[]> };

type SourceFound = { source: StoredSource; seconds: number };
async function resolveSource(kind: "video" | "audio", uploadId: unknown, genId: unknown): Promise<SourceFound | { error: string; status: number }> {
  const up = uploadId ? String(uploadId) : "", gen = genId ? String(genId) : "";
  if ((!up && !gen) || (up && gen)) return { error: `Pick one ${kind} original.`, status: 400 };
  if ((up && !SOURCE_ID.test(up)) || (gen && !SOURCE_ID.test(gen))) return { error: "That source is not valid.", status: 400 };
  const source = await findStoredSource(up ? { uploadId: up } : { genId: gen });
  if (!source || source.mediaKind !== kind) return { error: `That ${kind} original is not in this workspace.`, status: 404 };
  if (source.bytes > SOURCE_BYTES_LIMIT) return { error: "Lip-sync takes sources up to 100 MB each.", status: 400 };
  const length = await resolveStoredDuration(source);
  if (length.seconds == null) return { error: `This ${kind} has no measured length, so it cannot be priced per second${length.reason ? `: ${length.reason}` : "."}`, status: 422 };
  return { source, seconds: length.seconds };
}

/**
 * Is the voice a synthesized stock one of Particl's own? Only an ElevenLabs speech or dialogue take whose every voice ElevenLabs lists as `premade`. A cloned,
 * professional or generated voice, any other vendor's take, a dub, a voice change, music, and an upload are a real person's or unknown: they need a live consent
 * covering the voice. Anything that cannot be read (the take, its voices, the voice list) is "not synthetic": fail closed.
 */
async function audioIsSynthetic(source: StoredSource, voices: NonNullable<LipSyncSeams["voices"]>): Promise<boolean> {
  if (source.kind !== "generation") return false;
  const row = (await db().execute({ sql: "SELECT provider, json_extract(params,'$.task') AS task, json_extract(params,'$.voiceId') AS voice, json_extract(params,'$.lines') AS lines FROM generations WHERE id=?", args: [source.id] })).rows[0];
  /* A Sarvam speech take (lib/sarvamTools.ts) is a stock voice: that engine offers and calls no voice cloning (a test pins it). */
  if (row?.provider === "sarvam" && row.task === "sarvam_speech") return true;
  if (!row || row.provider !== "elevenlabs" || !SYNTHETIC_AUDIO_TASKS.includes(String(row.task))) return false;
  let ids: unknown[] = [];
  if (row.task === "speech") ids = [row.voice];
  else { try { ids = (JSON.parse(String(row.lines)) as { voiceId?: unknown }[]).map((l) => l?.voiceId); } catch { return false; } }
  if (!ids.length || ids.some((id) => typeof id !== "string" || !id)) return false;
  try {
    const listed = await voices();
    return ids.every((id) => listed.find((v) => v.id === id)?.category === "premade");
  } catch { return false; }
}

/** Admission: validate, measure, quote, pass the consent gate, and (unless quoteOnly) fund one job and hand it to the worker. */
export const executeLipSyncAdmission = (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> => admitLipSync(input, got, options, {});

/** The same with the test seams. Internal: only the tests import it (tests/unit/lipSync.spec.ts says so by reading the source). */
export async function admitLipSync(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: LipSyncSeams): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not on the engine list): the tool is simply not here. */
  if (!(await engineEnabled(SYNC_SWITCH))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const quoteOnly = body.quoteOnly === true;
  await ready();
  if (!syncConfigured()) return admissionReply({ error: "Lip-sync is not set up: SYNC_API_KEY is needed." }, { status: 400 });
  const allowance = await allowanceCheck("sync");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  if (body.model != null && !isSyncModel(body.model)) return admissionReply({ error: "Pick lipsync-2, lipsync-2-pro or sync-3." }, { status: 400 });
  if (body.syncMode != null && !isSyncMode(body.syncMode)) return admissionReply({ error: "Pick how a length mismatch is handled: bounce, loop, cut_off, silence or remap." }, { status: 400 });
  const model: SyncModel = isSyncModel(body.model) ? body.model : SYNC_RATES.defaultModel;
  const syncMode: SyncMode = isSyncMode(body.syncMode) ? body.syncMode : SYNC_RATES.defaultSyncMode;
  const video = await resolveSource("video", body.clipUploadId, body.clipGenId);
  if ("error" in video) return admissionReply({ error: video.error }, { status: video.status });
  const audio = await resolveSource("audio", body.audioUploadId, body.audioGenId);
  if ("error" in audio) return admissionReply({ error: audio.error }, { status: audio.status });
  const seconds = quotedSeconds(video.seconds, audio.seconds, syncMode);
  if (!(seconds > 0) || seconds > LIPSYNC_MAX_SECONDS) return admissionReply({ error: `Lip-sync takes up to ${LIPSYNC_MAX_SECONDS / 60} minutes at a time.` }, { status: 400 });

  let projectId = body.projectId ? String(body.projectId) : null;
  const shotId = body.shotId ? String(body.shotId) : null;
  let shotCode: string | null = null;
  if (shotId) {
    const shot = await getShot(shotId);
    if (!shot) return admissionReply({ error: "That shot is gone." }, { status: 400 });
    shotCode = shot.code;
    if (projectId && shot.projectId && shot.projectId !== projectId) return admissionReply({ error: "That shot belongs to another production." }, { status: 400 });
    projectId ??= shot.projectId;
  }
  if (projectId && !(await db().execute({ sql: "SELECT id FROM projects WHERE id=?", args: [projectId] })).rows.length)
    return admissionReply({ error: "That production is not in this workspace." }, { status: 404 });

  const usd = lipSyncUsd(seconds, model);
  /* The approval unit (lib/credits.ts quotedCredits), through the margin table, keyed by the model. No figure of ours. */
  const estimatedCredits = quotedCredits(usd, model);
  const inCredits = creditsApply(requireTenant());
  /* Guardrail 4 at the quote, before any row is written. */
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "sync", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  /* The cost approval rule (brief 2.2): with a cap per shot, a member's take past it needs an admin. Refused here, on the quote and the press, before any row is written, so no failed take is left in the Library. */
  if (shotId && shotCode) {
    const stop = await shotCapGate({ shotId, code: shotCode, takeUsd: usd, modelId: model, isAdmin: got.user.role === "admin" });
    if (stop) return admissionReply({ error: stop, needsAdmin: true }, { status: 403 });
  }
  if (quoteOnly)
    return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", seconds, model, syncMode, needs: ["castMemberId", "faceFrameUploadId", "projectId", "use"] });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the lip-sync estimate is above the approved credit amount." }, { status: 409 });
  const wall = await allowanceCheck("sync", usd, model);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, model);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const quota = await checkQuota(video.source.bytes + audio.source.bytes);
  if (!quota.allow) return admissionReply({ error: quota.error }, { status: 507 });
  const compiled = { task: LIPSYNC_TASK, model, syncMode, video: { kind: video.source.kind, id: video.source.id }, audio: { kind: audio.source.kind, id: audio.source.id }, seconds, projectId, shotId };
  const stopped = admissionCheckpoint(options, body, got, "video", usd, model, compiled, { engine: "syncso" });
  if (stopped) return stopped;

  /* ── The consent gate: every real face, and a real voice, BEFORE a row is written or a cent reserved. ── */
  const use = typeof body.use === "string" && (LIPSYNC_USES as readonly string[]).includes(body.use) ? (body.use as (typeof LIPSYNC_USES)[number]) : null;
  const castMemberId = typeof body.castMemberId === "string" ? body.castMemberId : "";
  if (!projectId || !use || !ENTITY_ID.test(castMemberId)) return admissionReply({ error: "Name the production, the cast member and what it is for (production, ads or social): a lip-sync needs the person's consent on record.", code: "bad-input" }, { status: 400 });
  const faceUploadId = typeof body.faceFrameUploadId === "string" ? body.faceFrameUploadId : "";
  const faceRow = SOURCE_ID.test(faceUploadId) ? (await db().execute({ sql: "SELECT ext, mime, stored_url, bytes FROM uploads WHERE id=? LIMIT 1", args: [faceUploadId] })).rows[0] : undefined;
  /* A person's request reads only an upload they may open (lib/uploadAccess.ts), as the video and the voice are read. */
  const viewer = currentViewer();
  const openable = !faceRow || !viewer || (await uploadOpenableBy(faceUploadId, viewer));
  if (!faceRow || !openable || !String(faceRow.mime ?? "").startsWith("image/")) return admissionReply({ error: "Add a still of the face in the clip (an image from this workspace).", code: "bad-input" }, { status: 400 });
  /* A real person's voice needs the voice covered; a stock synthesized voice of ours raises no question (docs/plans/provider-adapters.md § 1). */
  let voiceConsentId: string | null = null;
  if (!(await audioIsSynthetic(audio.source, seams.voices ?? (async () => (await import("./elevenlabs")).listVoices())))) {
    const voice = await liveVoiceConsentFor(castMemberId, { projectId, use });
    if (!voice) return admissionReply({ error: "This voice isn't one of ours, so it needs the person's consent on record, covering the voice. Record it on the Cast card first.", code: "no-voice-consent" }, { status: 409 });
    voiceConsentId = voice.id;
  }
  let match: ConsentMatch;
  try {
    const faceBytes = await readUploadBytes(faceUploadId, String(faceRow.ext), String(faceRow.stored_url), 5 * 1024 * 1024);
    match = await (seams.consent ?? requireConsentMatch)(castMemberId, faceBytes, { projectId, use });
  } catch (error) {
    if (error instanceof ConsentMatchError) return admissionReply({ error: error.message, code: error.code }, { status: error.status });
    return admissionReply({ error: "The face check could not be done. Nothing was billed.", code: "unavailable" }, { status: 503 });
  }

  const title = `${video.source.name.replace(/\.[A-Za-z0-9]{1,8}$/, "")} · lip-synced`.slice(0, 80);
  const genId = newId("gen"), ts = now();
  const lip: LipSyncParams = {
    status: "queued", model, syncMode,
    videoSource: { kind: video.source.kind, id: video.source.id }, audioSource: { kind: audio.source.kind, id: audio.source.id },
    seconds, audioSeconds: audio.seconds, rateUsdPerSecond: SYNC_RATES.models[model], reservedUsd: usd, estimateCredits: estimatedCredits,
    consentId: match.consentId, castMemberId, use, faceSha256: match.faceSha256, voiceConsentId,
    funded: 0, claimedAt: null, syncId: null, videoAsset: null, audioAsset: null, submittedAt: null, lastPolledAt: null, pollUntil: null, settled: 0,
    cleanupDue: 0, cleanupTries: 0, vendorDeleted: 0, reconcile: 0,
  };
  const params = { task: LIPSYNC_TASK, job: "fix", lipsync: lip, sourceName: video.source.name.slice(0, 200), estUsd: usd, estCredits: 0 };
  const binding = await claimBinding(options.requestClaim, genId);
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, "video", model, `Lip-sync · ${video.source.name}`.slice(0, 5000), JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "syncso", "generate", title, "syncso", shotId],
    },
    // The claim is bound in the same write: a claim naming no job proves there is none.
    ...binding,
  ], "write");
  invalidate(PROJECTS_KEY);
  try {
    await reserveGenerationSpend(
      { id: genId, kind: "video", engine: "syncso", model, status: "running", engineCostUsd: usd, projectId, shotId, createdBy: got.user.id },
      { token: got.token },
    );
    await patch(genId, { funded: 1 });
  } catch (e) {
    // Nothing was submitted. The row says so; the person can try again once funded.
    const message = e instanceof Error ? e.message : "The lip-sync reservation could not be made.";
    await settleLipSync(genId, "failed", { message, costUsd: 0 }).catch(() => {});
    return admissionReply({ error: message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }
  /* No queue here: the job runs in this request's continuation, polling for a while, and the ten-minute cron picks up whatever is still running. */
  await options.defer(() => driveLipSync(genId).then(() => {}));
  return admissionReply({ id: genId, status: "running", estimatedCredits, seconds, model, notices: capV.notice ? [capV.notice] : undefined });
}

/* ── Settling ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The terminal write: the take's outcome and its bill commit together; delivery to the ledger is idempotent. A failure settles at nothing. */
export async function settleLipSync(
  genId: string, status: "done" | "failed",
  outcome: { message?: string; costUsd: number; storedUrl?: string; bytes?: number; seconds?: number | null; said?: ProviderOutcome | null; reconcile?: boolean },
): Promise<void> {
  const job = await load(genId);
  if (!job || job.lip.settled) return;
  const { row, lip, model } = job;
  const said = status === "failed" && outcome.said ? await fundedOutcome(outcome.said, genId, "syncso").catch(() => outcome.said ?? null) : null;
  const ms = Math.max(0, now() - Number(row.created_at));
  const succeeded = status === "done";
  const write = succeeded
    ? {
        sql: `UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, error=NULL, duration_ms=?, duration_s=?,
                params=json_set(params,'$.lipsync.status','done','$.lipsync.settled',1,'$.lipsync.cleanupDue',1), updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [outcome.storedUrl ?? null, outcome.bytes ?? null, outcome.costUsd, ms, outcome.seconds ?? null, now(), genId],
      }
    : {
        sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=?,
                provider_outcome=COALESCE(?,provider_outcome),
                params=json_set(params,'$.lipsync.status','failed','$.lipsync.settled',1,'$.lipsync.cleanupDue',?,'$.lipsync.reconcile',?), updated_at=?
              WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
        args: [(outcome.message ?? "The lip-sync failed.").slice(0, 600), ms, outcome.costUsd, said ? serializeOutcome(said) : null, lip.syncId || lip.videoAsset || lip.audioAsset ? 1 : 0, outcome.reconcile ? 1 : 0, now(), genId],
      };
  await writeGenerationOutcome(write, {
    id: genId, kind: "video", engine: "syncso", model, status: succeeded ? "succeeded" : "failed", engineCostUsd: outcome.costUsd, durationMs: ms,
    projectId: row.project_id, shotId: row.shot_id, createdBy: row.created_by,
    /* A failure the vendor charged us for is recorded at its cost on the ledger line and billed to nobody: the workspace still reads "Nothing billed". */
    ...(!succeeded && outcome.costUsd > 0 ? { unbilled: true } : {}),
    ...(said ? { providerOutcome: said } : {}),
  });
  await deliverGenerationSettlement(genId);
  invalidate(PROJECTS_KEY);
}

/* ── The machine ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback).slice(0, 300);

/**
 * One step, safe to call from anywhere at any time: submit a funded queued job (once), ask after a submitted one, collect a finished one. Never throws for
 * a vendor verdict; throws for transport after the row has recorded what it knows. Public: no seams (the cron and the continuation call this one).
 */
export const advanceLipSyncJob = (genId: string): Promise<LipSyncParams | null> => advanceLipSyncJobWith(genId, {});

/** The same with the adapter seams. Internal: only the tests import it. */
export async function advanceLipSyncJobWith(genId: string, deps: LipSyncDeps): Promise<LipSyncParams | null> {
  const clock = deps.clock ?? now;
  return withRecoveryJob(requireTenant().id, genId, async () => {
    let job = await load(genId);
    if (!job) return null;
    if (job.lip.settled || job.lip.status === "uncertain" || job.lip.status === "failed" || job.lip.status === "done") return job.lip;
    if (job.lip.status === "queued") {
      if (!job.lip.funded) return job.lip;
      const claimed = await patch(genId, { claimedAt: clock() }, { sql: "json_extract(params,'$.lipsync.status')='queued' AND json_extract(params,'$.lipsync.funded')=1 AND json_extract(params,'$.lipsync.claimedAt') IS NULL AND status='running'" });
      if (!claimed) {
        // Someone holds the claim. A young claim is a submission in flight; an old one with no job id is a lost acknowledgement.
        const held = (await load(genId))?.lip;
        if (held && held.status === "queued" && held.claimedAt && clock() - Number(held.claimedAt) > SUBMIT_GRACE_MS) {
          /* The two inputs are uploaded before the submit, so a claim that never got both assets up never reached it: nothing was sent, settle at nothing. Only a claim with both assets and no job id is a lost acknowledgement. */
          if (!held.videoAsset || !held.audioAsset) {
            await settleLipSync(genId, "failed", { message: "Nothing was submitted: the job stopped before it was sent. Nothing was billed.", costUsd: 0 });
            await cleanupLipSyncVendor(genId, deps).catch(() => {});
          } else await patch(genId, { status: "uncertain" });
        }
        return (await load(genId))?.lip ?? null;
      }
      job = (await load(genId))!;
      const { lip, model } = job;
      /* Consent is judged again at the moment of sending: a record withdrawn or ended while the job waited stops it, and nothing has been sent. */
      const stillLive = async (id: string | null): Promise<boolean> => { if (!id) return true; const c = await getConsent(id).catch(() => null); return Boolean(c) && consentLive(c!); };
      if (!(await stillLive(lip.consentId)) || !(await stillLive(lip.voiceConsentId))) {
        await settleLipSync(genId, "failed", { message: "Nothing was sent: the person's consent no longer holds. Nothing was billed.", costUsd: 0 });
        return (await load(genId, { any: true }))?.lip ?? null;
      }
      // The sources are read before anything is sent: a file that cannot be read submits nothing and refunds everything.
      let files: { video: { bytes: Buffer; name: string; mime: string }; audio: { bytes: Buffer; name: string; mime: string } };
      try {
        const [v, a] = await Promise.all([findStoredSource(lip.videoSource.kind === "upload" ? { uploadId: lip.videoSource.id } : { genId: lip.videoSource.id }), findStoredSource(lip.audioSource.kind === "upload" ? { uploadId: lip.audioSource.id } : { genId: lip.audioSource.id })]);
        if (!v || !a) throw new Error("A lip-sync source is no longer available in this workspace.");
        files = { video: { bytes: await readStoredSourceBytes(v), name: v.name, mime: v.mime || "video/mp4" }, audio: { bytes: await readStoredSourceBytes(a), name: a.name, mime: a.mime || "audio/mpeg" } };
      } catch (error) {
        await settleLipSync(genId, "failed", { message: `Nothing was submitted: ${messageOf(error, "a source could not be read.")} Nothing was billed.`, costUsd: 0 });
        return (await load(genId, { any: true }))?.lip ?? null;
      }
      /* The two uploads: their ids are written as soon as they exist, so a failure after one still deletes it. */
      try {
        const videoAsset = await (deps.upload ?? uploadAsset)({ bytes: files.video.bytes, filename: files.video.name, mime: files.video.mime });
        await patch(genId, { videoAsset });
        const audioAsset = await (deps.upload ?? uploadAsset)({ bytes: files.audio.bytes, filename: files.audio.name, mime: files.audio.mime });
        await patch(genId, { audioAsset });
      } catch (error) {
        await settleLipSync(genId, "failed", { message: `Nothing was submitted: ${messageOf(error, "the upload did not complete.")} Nothing was billed.`, costUsd: 0, said: error instanceof SyncError && error.status ? directErrorOutcome("syncso", error.status, error.message) : silentOutcome("syncso", "submit", "upload_failed", messageOf(error, "")) });
        await cleanupLipSyncVendor(genId, deps).catch(() => {});
        return (await load(genId, { any: true }))?.lip ?? null;
      }
      job = (await load(genId))!;
      try {
        const sent = await (deps.submit ?? submitLipSync)({ model, videoAssetId: job.lip.videoAsset!, audioAssetId: job.lip.audioAsset!, syncMode: lip.syncMode });
        await patch(genId, { status: "submitted", syncId: sent.id, submittedAt: clock() });
      } catch (error) {
        if (error instanceof SyncError && error.rejectedBeforeGeneration) {
          // Refused before any work: the whole reservation comes back.
          await settleLipSync(genId, "failed", { message: `${error.message} Nothing was billed.`, costUsd: 0, said: directErrorOutcome("syncso", error.status ?? 400, error.message) });
          await cleanupLipSyncVendor(genId, deps).catch(() => {});
          return (await load(genId, { any: true }))?.lip ?? null;
        }
        // A timeout or a dropped connection: sync.so may hold a charged job under an id we never saw. Held for review, never sent again.
        await patch(genId, { status: "uncertain" });
        await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [`${messageOf(error, "The lip-sync submission did not complete.")} The reservation is held for review; this request will not be sent again.`, now(), genId] });
        return (await load(genId))?.lip ?? null;
      }
      job = (await load(genId))!;
    }
    const lip = job.lip;
    if (!lip.syncId) return lip;
    // One poller per job at a time; a poll is free, so a lost lease simply expires.
    const until = clock() + POLL_LEASE_MS;
    const leased = await patch(genId, { pollUntil: until }, { sql: "json_extract(params,'$.lipsync.settled')=0 AND COALESCE(json_extract(params,'$.lipsync.pollUntil'),0)<?", args: [clock()] });
    if (!leased) return lip;
    try {
      await patch(genId, { lastPolledAt: clock() });
      const state = await (deps.status ?? generationStatus)(lip.syncId);
      if (state.status === "failed") {
        // Whether sync.so bills a failed or rejected job is not stated on its billing page: settled at nothing, absorbed by the platform.
        /* Whatever sync.so reports it charged is the ledger line's cost (nobody is billed it); none reported: recorded as 0 and marked to reconcile against sync.so's invoice. */
        const reported = state.reportedCostUsd != null && state.reportedCostUsd > 0 ? state.reportedCostUsd : 0;
        await settleLipSync(genId, "failed", { message: `The lip-sync failed at sync.so${state.error ? `: ${state.error}` : "."} Nothing was billed.`, costUsd: reported, reconcile: state.reportedCostUsd == null, said: silentOutcome("syncso", "run", "failed", state.error) });
        await cleanupLipSyncVendor(genId, deps).catch(() => {});
        return (await load(genId, { any: true }))?.lip ?? null;
      }
      if (state.status !== "completed") {
        if (lip.status !== "processing") await patch(genId, { status: "processing" });
        return (await load(genId))?.lip ?? null;
      }
      let bytes: Buffer;
      try { bytes = await (deps.download ?? downloadOutput)({ id: lip.syncId, url: state.outputUrl }); }
      catch (error) {
        /* sync.so made the clip and named an address we will not fetch (off its allow-list, none, or too large): that never becomes fetchable, so it is not retried. sync.so charged for it: the take reads
           "Nothing billed", and the ledger line records the delivered length at the model's rate, unbilled and marked to reconcile (the figure is ours). */
        if (!(error instanceof SyncOutputRefused)) throw error;
        const seconds = state.outputDuration && state.outputDuration > 0 ? Math.min(state.outputDuration, lip.seconds) : Math.min(lip.seconds, lip.audioSeconds);
        await settleLipSync(genId, "failed", { message: "The lip-sync finished but its clip could not be fetched safely. Nothing was billed.", costUsd: lipSyncUsd(seconds, job.model), reconcile: true, said: silentOutcome("syncso", "run", "not_kept", "output address refused") });
        await cleanupLipSyncVendor(genId, deps).catch(() => {});
        return (await load(genId, { any: true }))?.lip ?? null;
      }
      const { value: stored } = await withRetry(() => (deps.store ?? storeVideoBytes)(genId, bytes), { max: 3 });
      /* The real cost: the delivered length (never past the quote) at the model's per-second rate. No length from the vendor reads as the input voice track's length (never the bare quote). */
      const delivered = state.outputDuration && state.outputDuration > 0 ? Math.min(state.outputDuration, lip.seconds) : Math.min(lip.seconds, lip.audioSeconds);
      await settleLipSync(genId, "done", { costUsd: lipSyncUsd(delivered, job.model), storedUrl: stored.url, bytes: stored.bytes, seconds: Math.round(delivered * 1000) / 1000 });
      /* Stored and settled: the vendor's copy goes. A failure is retried by the cron and never blocks the take. */
      await cleanupLipSyncVendor(genId, deps).catch(() => {});
      return (await load(genId, { any: true }))?.lip ?? null;
    } catch (error) {
      // Transport or storage: keep the id and the reservation; the next pass asks again. Nothing is resubmitted.
      await db().execute({ sql: "UPDATE generations SET error=?, updated_at=? WHERE id=? AND status='running'", args: [messageOf(error, "The lip-sync could not be checked."), now(), genId] });
      throw error;
    } finally {
      await patch(genId, { pollUntil: null }, { sql: "json_extract(params,'$.lipsync.pollUntil')=?", args: [until] }).catch(() => {});
    }
  });
}

/**
 * Deletes the vendor's copies: the finished job and the two input assets. Runs once the output is stored (or the job failed). A copy that cannot be
 * deleted is tried again by the cron, up to CLEANUP_MAX_TRIES times; it never blocks, fails or re-bills the take.
 */
export async function cleanupLipSyncVendor(genId: string, deps: LipSyncDeps = {}): Promise<void> {
  const job = await load(genId, { any: true });
  if (!job || !job.lip.cleanupDue) return;
  const { lip } = job;
  let allGone = true;
  const attempt = async (id: string | null, remove: (id: string) => Promise<boolean>, field: "syncId" | "videoAsset" | "audioAsset") => {
    if (!id) return;
    try { if (await remove(id)) await patch(genId, { [field]: null } as Partial<LipSyncParams>); else allGone = false; }
    catch { allGone = false; }
  };
  /* The job first: sync.so refuses to delete one that is still processing, and we only get here once it is over. */
  await attempt(lip.syncId, (id) => (deps.deleteJob ?? deleteGeneration)(id), "syncId");
  await attempt(lip.videoAsset, (id) => (deps.deleteAsset ?? deleteAsset)(id), "videoAsset");
  await attempt(lip.audioAsset, (id) => (deps.deleteAsset ?? deleteAsset)(id), "audioAsset");
  if (allGone) await patch(genId, { cleanupDue: 0, vendorDeleted: 1 });
  else {
    const tries = lip.cleanupTries + 1;
    await patch(genId, tries >= CLEANUP_MAX_TRIES ? { cleanupTries: tries, cleanupDue: 0 } : { cleanupTries: tries });
    if (tries >= CLEANUP_MAX_TRIES) console.error(JSON.stringify({ level: "error", event: "lipsync.vendor_copy_not_deleted", generation: genId }));
  }
}

/** Runs a job in this request's own continuation: steps and short pauses until it ends or the time is up; the cron takes over after. */
export async function driveLipSync(genId: string, options: { budgetMs?: number; pauseMs?: number } = {}): Promise<void> {
  const until = Date.now() + (options.budgetMs ?? 240_000);
  for (;;) {
    const lip = await advanceLipSyncJob(genId).catch(() => null);
    if (!lip || lip.settled || lip.status === "uncertain" || lip.status === "done" || lip.status === "failed" || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 8000));
  }
}

/**
 * The cron's stage: queued and running jobs are advanced when their last check is old enough, and finished jobs whose vendor copy is still there are
 * cleaned up. Uncertain and terminal rows are left alone.
 */
export async function recoverLipSyncJobs(options: { limit?: number; deadlineAt?: number } = {}, deps: LipSyncDeps = {}): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  const clock = deps.clock ?? now;
  const limit = Math.max(1, Math.min(50, options.limit ?? 4));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const running = (await db().execute({
    sql: `SELECT id FROM generations WHERE deleted=0 AND status='running' AND json_extract(params,'$.task')=? AND json_extract(params,'$.lipsync.status') IN ('queued','submitted','processing')
          ORDER BY updated_at ASC LIMIT ?`,
    args: [LIPSYNC_TASK, limit],
  })).rows.map((r) => String(r.id));
  const cleaning = (await db().execute({
    sql: `SELECT id FROM generations WHERE json_extract(params,'$.task')=? AND json_extract(params,'$.lipsync.cleanupDue')=1 ORDER BY updated_at ASC LIMIT ?`,
    args: [LIPSYNC_TASK, limit],
  })).rows.map((r) => String(r.id));
  let attempted = 0, failed = 0, deferred = 0;
  for (const id of running) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    const job = await load(id);
    if (job && job.lip.status !== "queued" && job.lip.lastPolledAt && clock() - Number(job.lip.lastPolledAt) < LIPSYNC_POLL_INTERVAL_MS) continue;
    attempted++;
    try { await advanceLipSyncJobWith(id, deps); } catch { failed++; }
  }
  for (const id of cleaning) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await cleanupLipSyncVendor(id, deps); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tool ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * `lip_sync`, declared beside its handler (docs/particl-sow-2026-10-04.md § 4.3). The button, Make, a board card, Atomik, a saved skill and an outside agent
 * over MCP all reach the one route (POST /api/lipsync), at the same price, through the same approval and the same consent gate. Anyone may PREPARE it (a
 * quote); a person approves the price (`maxCredits`); the person's consent is recorded by a person alone and only read here.
 */
export const LIP_SYNC_TOOL = {
  id: "lip_sync",
  kind: "engine" as const,
  provider: "syncso",
  /** The settings it needs; a tool without them says so and cannot run. */
  needs: ["SYNC_API_KEY", "SYNC_ENABLED"],
  models: Object.keys(SYNC_RATES.models) as SyncModel[],
  route: "/api/lipsync",
  inputs: {
    clipUploadId: "a video from this workspace (or clipGenId: one of its takes)", audioUploadId: "a voice track from this workspace (or audioGenId)",
    model: "lipsync-2, lipsync-2-pro (default) or sync-3", syncMode: "bounce (default), loop, cut_off, silence or remap",
    castMemberId: "who is in the clip", faceFrameUploadId: "a still of the face in the clip", projectId: "the production", use: "production, ads or social", maxCredits: "the approved price",
  },
  /** Priced by the quote route (quoteOnly) through the margin table; never a figure here. */
  price: { quote: "POST /api/lipsync { quoteOnly: true }" },
  who: "prepare: anyone; approve: a person" as const,
  gate: "a live consent record for the face (lib/consentMatch.ts) and, for a voice that is not a stock one, for the voice",
};

/** The tools present for a workspace: none unless the engine is on for it AND the face gate can run there (the house workspace today). */
export async function lipSyncTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<(typeof LIP_SYNC_TOOL)[]> {
  return (await engineEnabled(SYNC_SWITCH, workspace)) && (await faceCheckAvailable(workspace)) ? [LIP_SYNC_TOOL] : [];
}

