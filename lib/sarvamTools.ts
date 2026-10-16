import { randomUUID } from "node:crypto";
import { fundedOutcome } from "./providerFailure";
import { directErrorOutcome, serializeOutcome, silentOutcome, type ProviderOutcome } from "./providerOutcome";
import { db, ready, now, id as newId } from "./db";
import { allowanceCheck } from "./allowance";
import { invalidate, PROJECTS_KEY } from "./cache";
import { creditsApply, quotedCredits } from "./credits";
import { marginKeyOf } from "./creditTerms";
import { currentTenant, requireTenant } from "./tenant";
import { getShot } from "./shots";
import { checkCap } from "./caps";
import { checkLimits } from "./limits";
import { platformDb, platformReady } from "./platform";
import { storeAudioBytes } from "./storage";
import { claimBinding, reserveGenerationSpend, SpendReservationError } from "./generationRequests";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import { meter, type MeterKind } from "./meter";
import { actingViewer, NO_ACTING_PERSON } from "./actingViewer";
import { uploadOpenableBy } from "./uploadAccess";
import { findStoredSource, resolveStoredDuration, readStoredSourceBytes, inspectAudioBuffer } from "./mediaSource.server";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "./admissionTypes";
import { admissionReply, admissionCheckpoint, assertAdmissionActor } from "./admissionSupport";
import { jobLineNow, shotCapAdmin, shotCapGate } from "./shotCap";
import { engineEnabled } from "./engineGate";
import { SARVAM_RATES, type SarvamSpeechModel, type SarvamTranslateModel } from "./vendorRates";
import {
  SARVAM_SHORT_AUDIO_SECONDS, SARVAM_SPEECH_MAX_CHARS, SARVAM_SWITCH, SARVAM_TRANSLATE_MAX_CHARS, SarvamError,
  isLanguageCode, isSpeechLanguage, isSpeechModel, isTranslateModel, isVoiceName, sarvamConfigured, speak, transcribe, translate,
} from "./sarvam";

/**
 * Sarvam's three tools, DIRECT (lib/sarvam.ts): `sarvam_speech` (Bulbul, an audio take), `sarvam_transcribe` (Saaras, a clip under about 30 s) and
 * `sarvam_translate` (text between English and Indian languages). One door for the button, Make, a board card, Atomik, a saved skill and an outside agent
 * (POST /api/sarvam { tool, ... }): the same quote, the same approval, the same price.
 *
 * Voices are not faces, so there is no face gate. **Stock voices only: no voice cloning** (the owner, "not now"): nothing here offers or calls it.
 * A transcript of a real person's speech, and a translation of what they said, are personal data: they are returned to the caller and written nowhere
 * here (a speech take's text is the take's own prompt, in this workspace's database like any take's).
 *
 * MONEY. Priced in rupees from the plan's recorded rate page (lib/vendorRates.ts SARVAM_RATES, to confirm) and converted ONLY at the owner's own rate
 * `SARVAM_USD_PER_INR` plus a 3% buffer (`SARVAM_RATES.fxBuffer`): with none (or a bad one) nothing is priced, the tools say so and cannot run. A customer's price is the dollars through the margin
 * table (`quotedCredits`, keyed as the reservation keys it); reserved at the quote on the meter and settled at the real cost (one request, so cost = quote);
 * a person approves (`maxCredits`). **Any failure settles at nothing ("Nothing billed")**: Sarvam's pages say nothing about billing a failed call, so the
 * outcome reads "billing unknown" and the platform absorbs it (plan § 2).
 *
 * LIMITS (v1, each refused in words rather than split): speech up to 2,500 characters, translation up to 2,000 (1,000 on mayura), transcription of a clip
 * under about 30 seconds. Long text, and batch transcription of long audio, are later.
 */
export const SARVAM_STALE_MS = 15 * 60_000;
export type SarvamToolId = "speech" | "transcribe" | "translate";

/** The owner's rupee rate: dollars per rupee, from SARVAM_USD_PER_INR. Null (nothing can be priced) unless it is a positive, finite number. */
export function usdPerInr(): number | null {
  const raw = process.env.SARVAM_USD_PER_INR;
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}
const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;
const chars = (text: string) => [...text].length;

/** What a call costs the platform, in dollars: the rupee cost at the owner's rupee rate plus the 3% buffer (SARVAM_RATES.fxBuffer); null when there is no rate. */
export function sarvamUsd(tool: SarvamToolId, units: { chars?: number; seconds?: number }, model: string): number | null {
  const fx = usdPerInr();
  if (fx == null) return null;
  let inr: number;
  if (tool === "speech") inr = ((units.chars ?? 0) / 10_000) * (SARVAM_RATES.speechInrPer10kChars[model as SarvamSpeechModel] ?? NaN);
  else if (tool === "translate") inr = ((units.chars ?? 0) / 10_000) * (SARVAM_RATES.translateInrPer10kChars[model as SarvamTranslateModel] ?? NaN);
  else inr = ((units.seconds ?? 0) / 3600) * SARVAM_RATES.transcribeInrPerHour;
  return Number.isFinite(inr) && inr > 0 ? micro(inr * fx * SARVAM_RATES.fxBuffer) : null;
}

const kindOf = (tool: SarvamToolId): MeterKind => (tool === "translate" ? "text" : "audio");
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * What a claim keeps of a reply (GenerationRequestOptions.recorded). A transcript of a real person's speech, and a translation of what they said, are personal
 * data: they are returned to the caller and written nowhere here, and that includes the idempotency claim, which would otherwise replay them. A replay of such a
 * request answers "done, not kept". Every other reply (a speech take's id, a quote, a refusal) is kept as it is.
 */
export function recordedSarvamReply(json: string): string {
  let body: unknown;
  try { body = JSON.parse(json); } catch { return json; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json;
  const reply = body as Record<string, unknown>;
  if (!("transcript" in reply) && !("text" in reply)) return json;
  const { transcript: _transcript, text: _text, ...rest } = reply;
  void _transcript; void _text;
  return JSON.stringify({ ...rest, kept: false, note: "Done. The text is not kept: run it again to get it." });
}

/** The adapter seams, for tests. The public admission passes none. */
export type SarvamSeams = { speak?: typeof speak; transcribe?: typeof transcribe; translate?: typeof translate };

/** The one reservation (the meter's one paid path): refused here means nothing was reserved and nothing was called. */
async function reserveCall(event: { id: string; kind: MeterKind; engine: string; model: string; projectId?: string | null; shotId?: string | null; createdBy?: string | null }, usd: number, got: AdmissionActor): Promise<AdmissionReply | null> {
  try { await reserveGenerationSpend({ ...event, status: "running", engineCostUsd: usd }, { token: got.token }); return null; }
  catch (e) { return admissionReply({ error: e instanceof Error ? e.message : "The reservation could not be made." }, { status: e instanceof SpendReservationError ? e.status : 503 }); }
}

/** Admission: validate, price, quote and (unless quoteOnly) approve, reserve, call once, store or return, settle. */
export const executeSarvamAdmission = (input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution): Promise<AdmissionReply> => admitSarvam(input, got, options, {});

/** The same with the adapter seams. Internal: only the tests import it (tests/unit/sarvam.spec.ts says so by reading the source). */
export async function admitSarvam(input: Record<string, unknown>, got: AdmissionActor, options: AdmissionExecution, seams: SarvamSeams): Promise<AdmissionReply> {
  const refusal = assertAdmissionActor(got);
  if (refusal) return refusal;
  /* Off for this workspace (the switch, or not on the engine list): the tool is simply not here. */
  if (!(await engineEnabled(SARVAM_SWITCH))) return admissionReply({ error: "There is no such tool here." }, { status: 404 });
  const body = structuredClone(input) as Record<string, unknown>;
  const tool = body.tool;
  if (tool !== "speech" && tool !== "transcribe" && tool !== "translate") return admissionReply({ error: "Pick speech, transcribe or translate." }, { status: 400 });
  const quoteOnly = body.quoteOnly === true;
  await ready();
  if (!sarvamConfigured()) return admissionReply({ error: "This is not set up: SARVAM_API_KEY is needed." }, { status: 400 });
  if (usdPerInr() == null) return admissionReply({ error: "Sarvam can't be priced here: SARVAM_USD_PER_INR is not set." }, { status: 503 });
  const allowance = await allowanceCheck("sarvam");
  if (!allowance.ok && allowance.status !== 402) return admissionReply({ error: allowance.error }, { status: allowance.status });

  /* ── What was asked, checked, and what it costs ── */
  let model: string, units: { chars?: number; seconds?: number };
  let text = "", language = "", source = "", voice: string | undefined, pace: number | undefined;
  let audio: { name: string; mime: string; seconds: number } | null = null;
  let stored: NonNullable<Awaited<ReturnType<typeof findStoredSource>>> | null = null;
  if (tool === "speech") {
    text = typeof body.text === "string" ? body.text.trim() : "";
    language = typeof body.language === "string" ? body.language : "";
    if (body.model != null && !isSpeechModel(body.model)) return admissionReply({ error: "Pick bulbul:v3 or bulbul:v4-flash." }, { status: 400 });
    model = isSpeechModel(body.model) ? body.model : SARVAM_RATES.defaultSpeechModel;
    if (!text) return admissionReply({ error: "Write what to say." }, { status: 400 });
    if (chars(text) > SARVAM_SPEECH_MAX_CHARS) return admissionReply({ error: `Speech takes up to ${SARVAM_SPEECH_MAX_CHARS.toLocaleString("en-US")} characters at a time.` }, { status: 400 });
    if (!isSpeechLanguage(language)) return admissionReply({ error: "Pick one of the eleven languages, such as hi-IN or en-IN." }, { status: 400 });
    if (body.voice != null && !isVoiceName(body.voice)) return admissionReply({ error: "That is not a stock voice's name." }, { status: 400 });
    if (body.voice != null) voice = body.voice as string;
    if (body.pace != null) { const p = Number(body.pace); if (!(p >= 0.5 && p <= 2)) return admissionReply({ error: "Pace is between 0.5 and 2." }, { status: 400 }); pace = p; }
    units = { chars: chars(text) };
  } else if (tool === "translate") {
    text = typeof body.text === "string" ? body.text.trim() : "";
    if (body.model != null && !isTranslateModel(body.model)) return admissionReply({ error: "Pick sarvam-translate:v1 or mayura:v1." }, { status: 400 });
    model = isTranslateModel(body.model) ? body.model : SARVAM_RATES.defaultTranslateModel;
    const limit = SARVAM_TRANSLATE_MAX_CHARS[model as SarvamTranslateModel];
    if (!text) return admissionReply({ error: "Write the text to translate." }, { status: 400 });
    if (chars(text) > limit) return admissionReply({ error: `${model} takes up to ${limit.toLocaleString("en-US")} characters at a time.` }, { status: 400 });
    source = typeof body.source === "string" ? body.source : "";
    language = typeof body.target === "string" ? body.target : "";
    if (!isLanguageCode(source) || !isLanguageCode(language) || source === language) return admissionReply({ error: "Name two different languages, such as en-IN and ta-IN." }, { status: 400 });
    units = { chars: chars(text) };
  } else {
    model = SARVAM_RATES.defaultTranscribeModel;
    if (body.language != null && !isLanguageCode(body.language)) return admissionReply({ error: "Name the language as a code such as hi-IN, or leave it to be detected." }, { status: 400 });
    language = typeof body.language === "string" ? body.language : "";
    const uploadId = body.sourceUploadId ? String(body.sourceUploadId) : "", genId = body.sourceGenId ? String(body.sourceGenId) : "";
    if ((!uploadId && !genId) || (uploadId && genId) || (uploadId && !SOURCE_ID.test(uploadId)) || (genId && !SOURCE_ID.test(genId))) return admissionReply({ error: "Pick one audio original to transcribe." }, { status: 400 });
    /* An upload is read only by a person who may open it: the signed-in person, or an Atomik run's owner. None behind the request, and nothing is read. */
    const viewer = await actingViewer();
    if (!viewer) return admissionReply({ error: NO_ACTING_PERSON }, { status: 403 });
    const found = await findStoredSource(uploadId ? { uploadId } : { genId });
    if (!found || found.mediaKind !== "audio" || (found.kind === "upload" && !(await uploadOpenableBy(found.id, viewer)))) return admissionReply({ error: "That audio original is not in this workspace." }, { status: 404 });
    const length = await resolveStoredDuration(found);
    if (length.seconds == null) return admissionReply({ error: `This audio has no measured length, so it cannot be priced${length.reason ? `: ${length.reason}` : "."}` }, { status: 422 });
    if (length.seconds > SARVAM_SHORT_AUDIO_SECONDS) return admissionReply({ error: `Transcription here takes a clip under ${SARVAM_SHORT_AUDIO_SECONDS} seconds; longer audio is a batch job, which is not offered yet.` }, { status: 400 });
    audio = { name: found.name, mime: found.mime || "audio/mpeg", seconds: length.seconds };
    units = { seconds: length.seconds };
    /* The bytes are read only after the price is approved and reserved, below. */
    source = found.id;
    stored = found;
  }
  const usd = sarvamUsd(tool, units, model);
  if (usd == null) return admissionReply({ error: "This can't be priced: it is too small to price, or SARVAM_USD_PER_INR is not set." }, { status: 503 });

  const kind = kindOf(tool);
  /* The approval unit, through the margin table keyed exactly as the reservation keys it (lib/creditTerms.ts marginKeyOf). No number of ours here. */
  const marginKey = marginKeyOf(kind, model);
  const estimatedCredits = quotedCredits(usd, marginKey);
  const inCredits = creditsApply(requireTenant());
  let projectId = body.projectId ? String(body.projectId) : null;
  const shotId = body.shotId ? String(body.shotId) : null;
  let shotCode: string | null = null;
  if (tool === "speech" && shotId) {
    const shot = await getShot(shotId);
    if (!shot) return admissionReply({ error: "That shot is gone." }, { status: 400 });
    shotCode = shot.code;
    if (projectId && shot.projectId && shot.projectId !== projectId) return admissionReply({ error: "That shot belongs to another production." }, { status: 400 });
    projectId ??= shot.projectId;
  }
  if (projectId && !(await db().execute({ sql: "SELECT id FROM projects WHERE id=?", args: [projectId] })).rows.length) return admissionReply({ error: "That production is not in this workspace." }, { status: 404 });
  const over = jobLineNow({ credits: estimatedCredits, usd, key: "sarvam", actor: got, auto: options.run?.auto === true });
  if (over) return admissionReply({ error: over, needsAdmin: true }, { status: 403 });
  /* The cost approval rule (brief 2.2), for the one tool that makes a take (speech): with a cap per shot, a member's take past it needs an admin. Refused on the quote and the press, before any row is written, so no failed take is left in the Library. A translation or a transcript makes no take and is not judged against a shot. */
  if (tool === "speech" && shotId && shotCode) {
    const stop = await shotCapGate({ shotId, code: shotCode, takeUsd: usd, modelId: marginKey, isAdmin: shotCapAdmin(got, options.run?.auto === true) });
    if (stop) return admissionReply({ error: stop, needsAdmin: true }, { status: 403 });
  }
  if (quoteOnly) return admissionReply({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", tool, model, ...units });
  if (!Number.isInteger(body.maxCredits) || (body.maxCredits as number) < 0 || estimatedCredits > (body.maxCredits as number))
    return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  const wall = await allowanceCheck("sarvam", usd, marginKey);
  if (!wall.ok) return admissionReply({ error: wall.error }, { status: wall.status });
  const capV = await checkCap(projectId, usd, marginKey);
  if (!capV.allow) return admissionReply({ error: capV.error }, { status: 409 });
  const lim = await checkLimits();
  if (!lim.allow) return admissionReply({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  const stopped = admissionCheckpoint(options, body, got, "audio", usd, marginKey, { task: `sarvam_${tool}`, model, language, units, projectId, shotId });
  if (stopped) return stopped;

  /* ── Run it: one request, reserved first and settled after ── */
  const by = got.user.id;
  if (tool === "speech") return runSpeech({ text, language, model: model as SarvamSpeechModel, voice, pace, usd, estimatedCredits, projectId, shotId }, got, options, seams);
  const event = { id: `sarvam_${randomUUID().replace(/-/g, "")}`, kind, engine: "sarvam", model, projectId, createdBy: by };
  const reserved = await reserveCall(event, usd, got);
  if (reserved) return reserved;
  try {
    let result: Record<string, unknown>;
    if (tool === "translate") {
      const out = await (seams.translate ?? translate)({ text, source, target: language, model: model as SarvamTranslateModel });
      result = { text: out.text, source, target: language };
    } else {
      const bytes = await readStoredSourceBytes(stored!, 25 * 1024 * 1024);
      const out = await (seams.transcribe ?? transcribe)({ bytes, filename: audio!.name, mime: audio!.mime, model, ...(language ? { language } : {}) });
      result = { transcript: out.transcript, language: out.language, seconds: audio!.seconds, source };
    }
    await meter({ ...event, status: "succeeded", engineCostUsd: usd });
    return admissionReply({ ok: true, tool, estimatedCredits, ...result });
  } catch (error) {
    await meter({ ...event, status: "failed", engineCostUsd: 0 }).catch(() => {});
    return failureReply(error);
  }
}

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback).slice(0, 300);
function failureReply(error: unknown): AdmissionReply {
  const status = error instanceof SarvamError && error.rejectedBeforeWork && error.status ? error.status : 502;
  return admissionReply({ error: `${messageOf(error, "Sarvam could not do this.")} Nothing was billed.`, charged: 0 }, { status });
}

/* ── Speech: an audio take ──────────────────────────────────────────────────────────────────────────────────────────────────── */

async function runSpeech(
  a: { text: string; language: string; model: SarvamSpeechModel; voice?: string; pace?: number; usd: number; estimatedCredits: number; projectId: string | null; shotId: string | null },
  got: AdmissionActor, options: AdmissionExecution, seams: SarvamSeams,
): Promise<AdmissionReply> {
  const genId = newId("gen"), ts = now();
  const params = { task: "sarvam_speech", job: "voice", sarvam: { tool: "speech", model: a.model, language: a.language, voice: a.voice ?? null, chars: chars(a.text), usd: a.usd } };
  const binding = await claimBinding(options.requestClaim, genId);
  await db().batch([
    {
      sql: `INSERT INTO generations (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by, created_at, updated_at, token_id, provider, task, title, billed_to, shot_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, a.projectId, null, "audio", a.model, a.text.slice(0, 5000), JSON.stringify(params), "running", got.user.id, ts, ts, got.token?.id ?? null, "sarvam", "generate", `${a.text.slice(0, 60)} · ${a.language}`.slice(0, 80), "sarvam", a.shotId],
    },
    // The claim is bound in the same write: a claim naming no job proves there is none.
    ...binding,
  ], "write");
  invalidate(PROJECTS_KEY);
  const reserved = await reserveCall({ id: genId, kind: "audio", engine: "sarvam", model: a.model, projectId: a.projectId, shotId: a.shotId, createdBy: got.user.id }, a.usd, got);
  if (reserved) {
    await settleSpeech(genId, "failed", { message: String(reserved.body.error ?? "The reservation could not be made."), costUsd: 0 }).catch(() => {});
    return reserved;
  }
  try {
    const bytes = await (seams.speak ?? speak)({ text: a.text, language: a.language, model: a.model, voice: a.voice, pace: a.pace });
    const stored = await storeAudioBytes(genId, bytes);
    const seconds = await inspectAudioBuffer(bytes).then((m) => Math.round(m.seconds * 1000) / 1000).catch(() => null);
    await settleSpeech(genId, "done", { costUsd: a.usd, storedUrl: stored.url, bytes: stored.bytes, seconds });
    return admissionReply({ id: genId, status: "succeeded", estimatedCredits: a.estimatedCredits, chars: chars(a.text) });
  } catch (error) {
    await settleSpeech(genId, "failed", { message: `${messageOf(error, "Sarvam could not do this.")} Nothing was billed.`, costUsd: 0, said: error instanceof SarvamError && error.status ? directErrorOutcome("sarvam", error.status, error.message, "submit") : silentOutcome("sarvam", "run", "failed", messageOf(error, "")) }).catch(() => {});
    return failureReply(error);
  }
}

/** The terminal write for a speech take: its outcome and its bill commit together; delivery to the ledger is idempotent. A failure settles at nothing. */
export async function settleSpeech(genId: string, status: "done" | "failed", outcome: { message?: string; costUsd: number; storedUrl?: string; bytes?: number; seconds?: number | null; said?: ProviderOutcome | null }): Promise<void> {
  await ready();
  const row = (await db().execute({ sql: "SELECT id, project_id, shot_id, created_by, created_at, model FROM generations WHERE id=? AND deleted=0 AND json_extract(params,'$.task')='sarvam_speech'", args: [genId] })).rows[0];
  if (!row) return;
  const said = status === "failed" && outcome.said ? await fundedOutcome(outcome.said, genId, "sarvam").catch(() => outcome.said ?? null) : null;
  const ms = Math.max(0, now() - Number(row.created_at));
  const ok = status === "done";
  const write = ok
    ? { sql: "UPDATE generations SET status='succeeded', stored_url=?, bytes=?, cost_usd=?, error=NULL, duration_ms=?, duration_s=?, updated_at=? WHERE id=? AND deleted=0 AND status IN ('queued','running')", args: [outcome.storedUrl ?? null, outcome.bytes ?? null, outcome.costUsd, ms, outcome.seconds ?? null, now(), genId] }
    : { sql: "UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms,?), cost_usd=0, provider_outcome=COALESCE(?,provider_outcome), updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled')", args: [(outcome.message ?? "The speech failed. Nothing was billed.").slice(0, 600), ms, said ? serializeOutcome(said) : null, now(), genId] };
  await writeGenerationOutcome(write, {
    id: genId, kind: "audio", engine: "sarvam", model: String(row.model), status: ok ? "succeeded" : "failed", engineCostUsd: ok ? outcome.costUsd : 0, durationMs: ms,
    projectId: row.project_id == null ? null : String(row.project_id), shotId: row.shot_id == null ? null : String(row.shot_id), createdBy: row.created_by == null ? null : String(row.created_by),
    ...(said ? { providerOutcome: said } : {}),
  });
  await deliverGenerationSettlement(genId);
  invalidate(PROJECTS_KEY);
}

/**
 * The cron's stage. Every Sarvam call is one request inside one request of ours, so a row or a reservation still running after SARVAM_STALE_MS is one the
 * process never finished: it is settled at nothing ("Nothing billed"; whether Sarvam charged is unknown, and the platform absorbs it), which also frees
 * its hold. Nothing is ever sent again.
 */
export async function recoverSarvamJobs(options: { limit?: number; deadlineAt?: number } = {}, clock: () => number = now): Promise<{ attempted: number; failed: number; deferred: number }> {
  await ready();
  const limit = Math.max(1, Math.min(50, options.limit ?? 8));
  const deadlineAt = options.deadlineAt ?? clock() + 250_000;
  const before = clock() - SARVAM_STALE_MS;
  const speech = (await db().execute({ sql: "SELECT id FROM generations WHERE deleted=0 AND status='running' AND json_extract(params,'$.task')='sarvam_speech' AND created_at<? ORDER BY created_at LIMIT ?", args: [before, limit] })).rows.map((r) => String(r.id));
  await platformReady();
  const orphans = (await platformDb().execute({ sql: "SELECT id, kind, model, created_by, project_id FROM meter_events WHERE workspace_id=? AND engine='sarvam' AND status='running' AND created_at<? ORDER BY created_at LIMIT ?", args: [requireTenant().id, before, limit] })).rows;
  let attempted = 0, failed = 0, deferred = 0;
  for (const id of speech) {
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await settleSpeech(id, "failed", { message: "This was never finished. Nothing was billed.", costUsd: 0, said: silentOutcome("sarvam", "run", "no_answer", "never finished") }); } catch { failed++; }
  }
  for (const row of orphans) {
    const id = String(row.id);
    if (speech.includes(id)) continue;
    if (clock() >= deadlineAt) { deferred++; continue; }
    attempted++;
    try { await meter({ id, kind: String(row.kind) as MeterKind, engine: "sarvam", model: String(row.model), status: "failed", engineCostUsd: 0 }); } catch { failed++; }
  }
  return { attempted, failed, deferred };
}

/* ── The registry tools ────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The three tools, declared beside their handler (docs/particl-sow-2026-10-04.md § 4.3). One route (POST /api/sarvam { tool }) at one price path and one
 * approval for every consumer. Anyone may prepare (a quote); a person approves the price. Stock voices only.
 */
const COMMON = { provider: "sarvam", kind: "engine" as const, route: "/api/sarvam", needs: ["SARVAM_API_KEY", "SARVAM_USD_PER_INR", "SARVAM_ENABLED"], who: "prepare: anyone; approve: a person" as const };
export const SARVAM_TOOLS = [
  { ...COMMON, id: "sarvam_speech", tool: "speech" as const, inputs: { text: "up to 2,500 characters", language: "a code such as hi-IN or en-IN", model: "bulbul:v3 (default) or bulbul:v4-flash", voice: "a stock voice's name (optional)", pace: "0.5 to 2 (optional)" }, output: "an audio take" },
  { ...COMMON, id: "sarvam_transcribe", tool: "transcribe" as const, inputs: { sourceUploadId: "an audio original of this workspace under about 30 s (or sourceGenId)", language: "a code, or detected" }, output: "the transcript" },
  { ...COMMON, id: "sarvam_translate", tool: "translate" as const, inputs: { text: "up to 2,000 characters (1,000 on mayura:v1)", source: "a code such as en-IN", target: "a code such as ta-IN", model: "sarvam-translate:v1 (default) or mayura:v1" }, output: "the translated text" },
];

/** The tools present for a workspace: none unless the engine is on for it. One that cannot be priced (no rupee rate) is listed as unavailable, with the reason. */
export async function sarvamTools(workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<((typeof SARVAM_TOOLS)[number] & { unavailable?: string })[]> {
  if (!(await engineEnabled(SARVAM_SWITCH, workspace))) return [];
  const why = usdPerInr() == null ? "It can't be priced: SARVAM_USD_PER_INR is not set." : !sarvamConfigured() ? "It is not set up: SARVAM_API_KEY is needed." : undefined;
  return SARVAM_TOOLS.map((t) => (why ? { ...t, unavailable: why } : t));
}
