import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { findStoredSource, readStoredSourceBytes, resolveStoredDuration, SOURCE_BYTES_LIMIT } from "./mediaSource.server";
import { allowanceCheck } from "./allowance";
import { paidByPlatform } from "./platformSpend";
import { billCredits } from "./creditTerms";
import { completeGenerationRequest, fenceGenerationRequest, generationRequestsReady, reserveGenerationSpend, SpendReservationError, TRANSCRIPTION_STALE_MS, type GenerationRequest } from "./generationRequests";
import { deliverGenerationSettlement, generationSettlementReady } from "./generationSettlement";
import { meter, meteredCharge, type MeterEvent } from "./meter";
import { currentTenant, requireTenant } from "./tenant";
import { db, now } from "./db";
import { GROK_STT_MODEL, grokTranscribe, grokTranscriptionUsd, grokVoiceConfigured, transcriptSrt, type Transcript } from "./xaiVoice";
import { XaiHttpError } from "./xaiErrors";
import { PreflightError } from "./preflight";

/**
 * Grok transcription of a stored audio or video original (owner, 23
 * September: Grok APIs wherever possible): the words, timed, speakers told
 * apart, and subtitles made from them. Priced by the source's measured length
 * on the xAI key and quoted first as an approximate price, reserved at that
 * estimate, then settled at what the transcript's own duration says through
 * the credit terms, never above three times the estimate.
 *
 * A paid request is sent under an Idempotency-Key and claimed before anything
 * is spent (withGenerationRequest, in the route). The claim names the
 * transcription's meter event (transcriptionEventId), so the same key is
 * answered from its saved reply instead of being billed again, and a request
 * whose reply was lost is asked about by that key (checkTranscriptionRequest),
 * never sent a second time.
 *
 * The transcript is saved on its claim before anything is charged for it, in
 * one write with the bill it will be charged (saveTranscript). A request that
 * stops at any point after that write is answered with its transcript and
 * charged for it once, from that bill. One that stops before it is never
 * charged for a transcript: ended by an error, it is answered at once from
 * what it left on the meter (endedAnswer); killed, its check answers the same
 * way once it cannot be running (TRANSCRIPTION_STALE_MS). A reservation it
 * left is held for review, and the answer says so.
 */
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export type TranscriptionInput = { sourceUploadId?: unknown; sourceGenId?: unknown; language?: unknown; diarize?: unknown; quoteOnly?: unknown; maxCredits?: unknown; projectId?: unknown };
export type TranscriptionReply = { status: number; body: Record<string, unknown> };
/** How far a paid transcription has got, in order: its estimate reserved; the provider's transcript in hand; that transcript saved with its bill queued; the bill on the meter; the reply made. */
export type TranscriptionStep = "reserved" | "transcribed" | "saved" | "settled" | "answered";
/**
 * Injected only by tests: the reservation, the provider call, the read of the
 * stored original's bytes, and a call as each step is reached — one that never
 * returns stands for a function killed there.
 */
export type TranscriptionDeps = {
  reserve?: typeof reserveGenerationSpend; provider?: typeof grokTranscribe; readSource?: typeof readStoredSourceBytes;
  step?: (step: TranscriptionStep) => void | Promise<void>;
};

/**
 * How long a transcription's claim can go without an answer before its
 * request is known to be gone (lib/generationRequests.ts): twice the route's
 * limit. A render's claim is given STALE_CLAIM_MS (30 minutes); a
 * transcription answers in its own reply, so its check can say what became of
 * it after ten.
 */
export { TRANSCRIPTION_STALE_MS };

/**
 * The meter event a claimed request's transcription is written under: named
 * by the claim (workspace, person, key), so there is at most one per request
 * and what became of it can be read back by the key alone.
 */
export function transcriptionEventId(workspaceId: string, claim: GenerationRequest): string {
  return `stt_${createHash("sha256").update(JSON.stringify([workspaceId, claim.userId, claim.key])).digest("hex").slice(0, 32)}`;
}

const creditWord = (n: number) => `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;

/** What the workspace stands charged for an event that ended without a transcript, said from the meter's own record. */
async function failedCharge(id: string): Promise<{ charged: number | null; sentence: string }> {
  const charge = await meteredCharge(id).catch(() => null);
  if (charge && charge.status !== "running" && charge.credits === 0) return { charged: 0, sentence: "Nothing was charged for it." };
  if (charge) return { charged: charge.credits, sentence: charge.credits > 0 ? `Its ${creditWord(charge.credits)} stay reserved for review.` : "Its outcome is held for review." };
  return { charged: null, sentence: "Its charge could not be read; it is held for review." };
}

/** A transcript as it is saved on its claim: the reply without its charge, which the meter adds (chargedReply). */
type SavedTranscript = { text: string; language: string | null; seconds: number; words: Transcript["words"]; srt: string };

const outcomesBoot = new WeakMap<Client, Promise<void>>();
/** transcription_outcomes: each claim's transcript, saved before it is charged. In this workspace's database only. */
async function transcriptionOutcomesReady(): Promise<void> {
  await generationRequestsReady();
  await generationSettlementReady();
  const client = db();
  if (!outcomesBoot.has(client))
    outcomesBoot.set(client, client.execute(`CREATE TABLE IF NOT EXISTS transcription_outcomes (
      user_id TEXT NOT NULL, request_key TEXT NOT NULL, event_id TEXT NOT NULL,
      transcript_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, request_key)
    )`).then(() => undefined).catch((error) => { outcomesBoot.delete(client); throw error; }));
  await outcomesBoot.get(client);
}

/** The transcript saved on this person's claim, or null when none was. */
async function readSavedTranscript(userId: string, key: string): Promise<SavedTranscript | null> {
  await transcriptionOutcomesReady();
  const row = (await db().execute({ sql: "SELECT transcript_json FROM transcription_outcomes WHERE user_id=? AND request_key=?", args: [userId, key] })).rows[0];
  return row ? (JSON.parse(String(row.transcript_json)) as SavedTranscript) : null;
}

/**
 * One write in this workspace's database: the transcript on the claim that
 * asked for it, and the bill it will be charged, queued for the meter
 * (generation_settlements, which the check and the sync deliver until it
 * lands). Only while the claim has no answer: once the check has given it one
 * (no request could still be running it), nothing is saved and nothing is
 * queued. True when the transcript stands saved on the claim; false when the
 * claim was answered first, and that answer stands.
 */
async function saveTranscript(claim: GenerationRequest, saved: SavedTranscript, bill: MeterEvent): Promise<boolean> {
  await transcriptionOutcomesReady();
  const at = now();
  let failure: unknown = null;
  try {
    await db().batch([
      {
        sql: `INSERT INTO transcription_outcomes(user_id,request_key,event_id,transcript_json,created_at)
              SELECT user_id,request_key,?,?,? FROM generation_requests
              WHERE user_id=? AND request_key=? AND response_json IS NULL
              ON CONFLICT(user_id,request_key) DO NOTHING`,
        args: [bill.id, JSON.stringify(saved), at, claim.userId, claim.key],
      },
      {
        sql: `INSERT INTO generation_settlements(id,event,created_at) SELECT ?,?,? WHERE changes()>0 ON CONFLICT(id) DO NOTHING`,
        args: [bill.id, JSON.stringify(bill), at],
      },
    ], "write");
  } catch (error) {
    failure = error;
  }
  /* A write whose acknowledgement was lost may have landed: the claim's own row says. */
  if (await readSavedTranscript(claim.userId, claim.key)) return true;
  if (failure) throw failure;
  return false;
}

/**
 * The queued bill written to the meter, once: it is keyed by the event, so a
 * second delivery changes nothing. Delivered as every finished job's is
 * (deliverGenerationSettlement), without starting held takes here — the
 * request may be near its time limit; the sync starts them, as it always has
 * after a transcription. A failure waits for the next check or sync.
 */
async function deliverTranscriptCharge(eventId: string): Promise<void> {
  try {
    await deliverGenerationSettlement(eventId, { releaseHeld: false });
  } catch (error) {
    console.error(`Transcription ${eventId} charge not recorded yet:`, error instanceof Error ? error.message : error);
  }
}

/** The reply for a saved transcript: the transcript and the credits the meter charged for it. Null until the meter records it charged. */
async function chargedReply(eventId: string, saved: SavedTranscript): Promise<Record<string, unknown> | null> {
  const charge = await meteredCharge(eventId).catch(() => null);
  return charge?.status === "succeeded" ? { ...saved, credits: charge.credits } : null;
}

/** What a person is told of a failed transcription: a fixed sentence by kind of failure. The provider's own text (which can carry account details) never reaches them; it is logged on the server. */
function failureSentence(error: unknown): string {
  if (error instanceof XaiHttpError) return `Grok could not transcribe this take (${error.status}).`;
  if (error instanceof PreflightError) return "Transcription needs the xAI account connected for this workspace.";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "Grok did not answer in time.";
  return "This take could not be transcribed.";
}

type TranscribeOptions = { claim?: GenerationRequest; deps?: TranscriptionDeps };

/**
 * A quote (`quoteOnly`), or the paid transcription under its claim. A paid
 * request that ends by an error has certainly ended, so it is answered at once
 * from what it left on the meter (endedAnswer) rather than after the check's
 * window — unless its transcript was saved, which the check then returns.
 */
export async function transcribe(input: TranscriptionInput, userId: string, options: TranscribeOptions = {}): Promise<TranscriptionReply> {
  const claim = options.claim;
  if (!claim || input.quoteOnly === true) return transcription(input, userId, options);
  try {
    return await transcription(input, userId, options);
  } catch (error) {
    const ended = await endedAnswer(claim).catch(() => null);
    if (!ended) throw error;
    console.error(`Transcription ${transcriptionEventId(requireTenant().id, claim)} ended early:`, error instanceof Error ? error.message : error);
    return ended;
  }
}

async function transcription(input: TranscriptionInput, userId: string, options: TranscribeOptions): Promise<TranscriptionReply> {
  if (!grokVoiceConfigured()) return { status: 400, body: { error: "Transcription needs the xAI account connected for this workspace." } };
  const uploadId = input.sourceUploadId ? String(input.sourceUploadId) : "";
  const genId = input.sourceGenId ? String(input.sourceGenId) : "";
  if ((!uploadId && !genId) || (uploadId && genId)) return { status: 400, body: { error: "Pick one audio or video original to transcribe." } };
  if ((uploadId && !SOURCE_ID.test(uploadId)) || (genId && !SOURCE_ID.test(genId))) return { status: 400, body: { error: "That source is not valid." } };
  const source = await findStoredSource(uploadId ? { uploadId } : { genId });
  if (!source) return { status: 404, body: { error: "That original is not in this workspace." } };
  if (source.bytes > SOURCE_BYTES_LIMIT) return { status: 400, body: { error: "Transcription takes a source up to 100 MB." } };
  const length = await resolveStoredDuration(source);
  if (length.seconds == null) return { status: 422, body: { error: `This source has no measured length, so it cannot be priced${length.reason ? `: ${length.reason}` : "."}` } };
  const estimateUsd = grokTranscriptionUsd(length.seconds);
  const estimatedCredits = paidByPlatform("xai") ? billCredits(estimateUsd, "xai") : 0;
  if (input.quoteOnly === true) return { status: 200, body: { quoteOnly: true, estimatedCredits, seconds: length.seconds } };
  /* A paid transcription is saved on its claim before it is charged, so it runs only under one (the route's withGenerationRequest). */
  const claim = options.claim;
  if (!claim) return { status: 500, body: { error: "This transcription was not sent under a request key. Nothing was sent or charged.", charged: 0 } };
  if (!Number.isFinite(Number(input.maxCredits)) || Number(input.maxCredits) < estimatedCredits)
    return { status: 409, body: { error: "The transcription estimate exceeds the approved credit amount. Review the price before submitting.", estimatedCredits } };
  const allowance = await allowanceCheck("xai", estimateUsd, "xai");
  if (!allowance.ok) return { status: allowance.status, body: { error: allowance.error } };

  const step = options.deps?.step;
  const event = {
    id: transcriptionEventId(requireTenant().id, claim),
    kind: "audio" as const, engine: "xai", model: GROK_STT_MODEL,
    projectId: typeof input.projectId === "string" ? input.projectId : null, createdBy: userId,
  };
  try { await (options.deps?.reserve ?? reserveGenerationSpend)({ ...event, status: "running", engineCostUsd: estimateUsd }, { token: currentTenant()?.token }); }
  catch (error) {
    if (error instanceof SpendReservationError) return { status: 402, body: { error: error.message, charged: 0 } };
    /* Not a refusal: the write may have landed with its acknowledgement lost. Nothing was sent, so a hold it
       left is released — found by the event's own id — before anything is said; one that cannot be is answered from the meter. */
    if ((await meteredCharge(event.id))?.status === "running") await meter({ ...event, status: "failed", engineCostUsd: 0 }, { critical: true });
    const held = await meteredCharge(event.id);
    if (held && (held.status === "running" || held.credits > 0)) throw error;
    console.error(`Transcription ${event.id} could not be reserved:`, error instanceof Error ? error.message : error);
    return { status: 503, body: { error: "The transcription could not be reserved. Nothing was sent or charged; try again.", charged: 0 } };
  }
  await step?.("reserved");
  let transcript: Transcript & { costUsd: number };
  try {
    const readSource = options.deps?.readSource ?? readStoredSourceBytes;
    transcript = await (options.deps?.provider ?? grokTranscribe)({
      bytes: await readSource(source), mime: source.mime || (source.mediaKind === "video" ? "video/mp4" : "audio/mpeg"), filename: `${source.name || "source"}.${source.ext || "mp4"}`,
      language: typeof input.language === "string" && /^[A-Za-z]{2,3}(-[A-Za-z]{2})?$/.test(input.language) ? input.language : undefined,
      diarize: input.diarize !== false,
    });
  } catch (error) {
    console.error(`Transcription ${event.id} failed:`, error instanceof Error ? error.message : error);
    await meter({ ...event, status: "failed", engineCostUsd: 0 });
    const outcome = await failedCharge(event.id);
    return { status: 502, body: { error: `${failureSentence(error)} ${outcome.sentence}`, charged: outcome.charged } };
  }
  await step?.("transcribed");
  /* The transcript's own length prices it, through the credit terms, never above three times the estimate. */
  const reportedUsd = Number.isFinite(transcript.costUsd) && transcript.costUsd >= 0 ? transcript.costUsd : estimateUsd;
  const costUsd = Math.min(reportedUsd, estimateUsd * 3);
  const saved: SavedTranscript = { text: transcript.text, language: transcript.language, seconds: transcript.seconds, words: transcript.words, srt: transcriptSrt(transcript.words) };
  /* Saved before it is charged, with its bill in the same write. Thrown, the claim keeps no answer, and the check answers it by its key. */
  if (!(await saveTranscript(claim, saved, { ...event, status: "succeeded", engineCostUsd: costUsd })))
    throw new Error(`Transcription ${event.id} was answered by its check before its transcript could be saved; that answer stands.`);
  await step?.("saved");
  await deliverTranscriptCharge(event.id);
  await step?.("settled");
  const reply = await chargedReply(event.id, saved);
  if (!reply) throw new Error(`Transcription ${event.id} is saved; its charge is not on the meter yet, so the check answers it once it is.`);
  await step?.("answered");
  return { status: 200, body: reply };
}

/** What a paid transcription sent under an Idempotency-Key became (checkTranscriptionRequest). */
export type TranscriptionCheck =
  /** It finished: the reply it was answered with — the transcript and the credits it was charged. Nothing was sent again. */
  | { state: "answered"; reply: Record<string, unknown> }
  /** It was answered without a transcript: refused, or failed with nothing charged (the reply says which). */
  | { state: "refused"; status: number; error: string }
  /** It has no answer yet (it may still be running, or its charge is still being written): ask again in a moment. */
  | { state: "pending" }
  /** It never reached the server, and its key is set aside now, so it never will: nothing was charged. */
  | { state: "absent" }
  /** It stopped without a transcript it could return; what it is charged stands as the meter records it. Nothing is sent again. */
  | { state: "unknown"; error: string; credits: number | null }
  /** The key names a different request than the one asked about. */
  | { state: "mismatch" };

const INTERRUPTED = "It was interrupted before anything was charged.";
const UNCERTAIN = "uncertain";

/** How an ended request that left no transcript stands, from the meter's record of its event now. */
async function uncertainOutcome(eventId: string): Promise<{ error: string; credits: number | null }> {
  const charge = await meteredCharge(eventId).catch(() => null);
  if (!charge) return { error: "Your last transcription stopped without an answer, and its charge could not be read. Nothing was sent again.", credits: null };
  /* Only a request made before transcripts were saved ahead of their charge can have left this. */
  if (charge.status === "succeeded")
    return { error: `Your last transcription finished and was charged ${creditWord(charge.credits)}, but its transcript was not saved. Nothing was sent again.`, credits: charge.credits };
  if (charge.status === "failed" && charge.credits === 0)
    return { error: "Your last transcription stopped without an answer. Its reserved credits were returned. Nothing was sent again.", credits: 0 };
  return { error: `Your last transcription stopped without an answer. ${charge.credits > 0 ? `Its ${creditWord(charge.credits)} stay reserved for review.` : "Its outcome is held for review."} Nothing was sent again.`, credits: charge.credits };
}

/**
 * The final answer for a claim whose request ended without a saved
 * transcript — written only while none is saved, so it and saveTranscript
 * exclude each other: whichever lands first stands.
 */
async function answerUnsaved(input: { userId: string; key: string; status: number; reply: Record<string, unknown> }): Promise<void> {
  await transcriptionOutcomesReady();
  await db().execute({
    sql: `UPDATE generation_requests SET response_json=?,response_status=?,updated_at=?
          WHERE user_id=? AND request_key=? AND response_json IS NULL
            AND NOT EXISTS (SELECT 1 FROM transcription_outcomes WHERE user_id=? AND request_key=?)`,
    args: [JSON.stringify(input.reply), input.status, now(), input.userId, input.key, input.userId, input.key],
  });
}

/**
 * A claim's final answer from the meter's record of its event, while no
 * transcript is saved for it: no event, interrupted before anything was
 * charged; an event, what that event records (uncertainOutcome).
 */
async function answerFromMeter(userId: string, key: string): Promise<void> {
  const eventId = transcriptionEventId(requireTenant().id, { userId, key });
  const charge = await meteredCharge(eventId);
  await answerUnsaved(!charge
    ? { userId, key, status: 409, reply: { error: INTERRUPTED, charged: 0 } }
    : { userId, key, status: 502, reply: { error: (await uncertainOutcome(eventId)).error, code: UNCERTAIN, charged: charge.credits } });
}

/**
 * The final answer for a claim whose request ended by an error without a
 * saved transcript — the one its check gives once the request is known to be
 * gone, or the answer the claim already has. Null when its transcript was
 * saved (the check answers with that) or no answer could be written.
 */
async function endedAnswer(claim: GenerationRequest): Promise<TranscriptionReply | null> {
  if (await readSavedTranscript(claim.userId, claim.key)) return null;
  await answerFromMeter(claim.userId, claim.key);
  const row = (await db().execute({ sql: "SELECT response_json,response_status FROM generation_requests WHERE user_id=? AND request_key=?", args: [claim.userId, claim.key] })).rows[0];
  return row?.response_json == null ? null : { status: Number(row.response_status), body: JSON.parse(String(row.response_json)) as Record<string, unknown> };
}

/**
 * Did the transcription sent under this key land, and with what? Asked for the
 * person who sent it, in this workspace's database only, with the fingerprint
 * of the request exactly as it was sent. It never sends the request again.
 *
 * A key the server has never seen is set aside in the same step, so a request
 * that arrives under it later is refused, never run. A request answered long
 * ago is read from its saved reply — the transcript itself when it finished.
 * One whose transcript was saved but whose reply was not (the function
 * stopped between the two) is answered with that transcript now: its bill,
 * queued in the same write, is written to the meter if it was not — once, by
 * its event, like every finished job's — and the reply says what it charged.
 * One with no saved transcript that can no longer be running
 * (TRANSCRIPTION_STALE_MS) is given its final answer from what it left on the
 * meter: nothing charged when no event was written; otherwise the event's own
 * record, which stands.
 */
export async function checkTranscriptionRequest(input: { userId: string; key: string; fingerprint: string }): Promise<TranscriptionCheck> {
  const { userId, key, fingerprint } = input;
  if (await fenceGenerationRequest({ userId, key, fingerprint })) return { state: "absent" };
  const eventId = transcriptionEventId(requireTenant().id, { userId, key });
  const read = async () => (await db().execute({ sql: "SELECT fingerprint,response_json,response_status,created_at FROM generation_requests WHERE user_id=? AND request_key=?", args: [userId, key] })).rows[0];
  let row = await read();
  if (!row || row.fingerprint !== fingerprint) return { state: "mismatch" };
  if (row.response_json == null) {
    const saved = await readSavedTranscript(userId, key);
    if (saved) {
      await deliverTranscriptCharge(eventId);
      const reply = await chargedReply(eventId, saved);
      if (!reply) return { state: "pending" };
      await completeGenerationRequest({ userId, key, status: 200, reply });
    } else {
      if (Number(row.created_at) >= now() - TRANSCRIPTION_STALE_MS) return { state: "pending" };
      await answerFromMeter(userId, key);
    }
    row = await read();
    if (!row || row.response_json == null) return { state: "pending" };
  }
  let reply: Record<string, unknown>;
  try { reply = JSON.parse(String(row.response_json)) as Record<string, unknown>; }
  catch { return { state: "unknown", error: "The saved answer to your last transcription cannot be read. Nothing was sent again.", credits: null }; }
  if (reply.code === "set_aside") return { state: "absent" };
  const status = Number(row.response_status);
  if (status >= 200 && status < 300) return { state: "answered", reply };
  if (reply.code === UNCERTAIN) return { state: "unknown", ...(await uncertainOutcome(eventId)) };
  return { state: "refused", status, error: typeof reply.error === "string" && reply.error ? reply.error : `Refused (${status})` };
}
