import { createHash } from "node:crypto";
import { findStoredSource, readStoredSourceBytes, resolveStoredDuration, SOURCE_BYTES_LIMIT } from "./mediaSource.server";
import { allowanceCheck } from "./allowance";
import { paidByPlatform } from "./platformSpend";
import { billCredits } from "./creditTerms";
import { completeGenerationRequest, fenceGenerationRequest, reserveGenerationSpend, STALE_CLAIM_MS, type GenerationRequest } from "./generationRequests";
import { meter, meteredCharge } from "./meter";
import { currentTenant, requireTenant } from "./tenant";
import { db, id as newId, now } from "./db";
import { GROK_STT_MODEL, grokTranscribe, grokTranscriptionUsd, grokVoiceConfigured, transcriptSrt, type Transcript } from "./xaiVoice";

/**
 * Grok transcription of a stored audio or video original (owner, 23
 * September: Grok APIs wherever possible): the words, timed, speakers told
 * apart, and subtitles made from them. Priced by the source's measured length
 * on the xAI key, quoted first, reserved at that estimate, then settled at
 * what the transcript's own duration says — never above the credits approved
 * for the request.
 *
 * A paid request is sent under an Idempotency-Key and claimed before anything
 * is spent (withGenerationRequest, in the route). The claim names the
 * transcription's meter event (transcriptionEventId), so the same key is
 * answered from its saved reply instead of being billed again, and a request
 * whose reply was lost is asked about by that key (checkTranscriptionRequest),
 * never sent a second time.
 */
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export type TranscriptionInput = { sourceUploadId?: unknown; sourceGenId?: unknown; language?: unknown; diarize?: unknown; quoteOnly?: unknown; maxCredits?: unknown; projectId?: unknown };
export type TranscriptionReply = { status: number; body: Record<string, unknown> };
/** Injected only by tests: the provider call and the read of the stored original's bytes. */
export type TranscriptionDeps = { provider?: typeof grokTranscribe; readSource?: typeof readStoredSourceBytes };

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

export async function transcribe(
  input: TranscriptionInput,
  userId: string,
  options: { claim?: GenerationRequest; deps?: TranscriptionDeps } = {},
): Promise<TranscriptionReply> {
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
  /* The credits approved for this request: the most it can be charged, whatever the transcript's own length says. */
  const approved = Number(input.maxCredits);
  if (!Number.isFinite(approved) || approved < estimatedCredits)
    return { status: 409, body: { error: "The transcription estimate exceeds the approved credit amount. Review the price before submitting.", estimatedCredits } };
  const allowance = await allowanceCheck("xai", estimateUsd, "xai");
  if (!allowance.ok) return { status: allowance.status, body: { error: allowance.error } };

  const event = {
    id: options.claim ? transcriptionEventId(requireTenant().id, options.claim) : newId("stt"),
    kind: "audio" as const, engine: "xai", model: GROK_STT_MODEL,
    projectId: typeof input.projectId === "string" ? input.projectId : null, createdBy: userId,
  };
  try { await reserveGenerationSpend({ ...event, status: "running", engineCostUsd: estimateUsd }, { token: currentTenant()?.token }); }
  catch (error) { return { status: 402, body: { error: error instanceof Error ? error.message : "This workspace cannot cover the transcription.", charged: 0 } }; }
  let transcript: Transcript & { costUsd: number };
  try {
    const readSource = options.deps?.readSource ?? readStoredSourceBytes;
    transcript = await (options.deps?.provider ?? grokTranscribe)({
      bytes: await readSource(source), mime: source.mime || (source.mediaKind === "video" ? "video/mp4" : "audio/mpeg"), filename: `${source.name || "source"}.${source.ext || "mp4"}`,
      language: typeof input.language === "string" && /^[A-Za-z]{2,3}(-[A-Za-z]{2})?$/.test(input.language) ? input.language : undefined,
      diarize: input.diarize !== false,
    });
  } catch (error) {
    await meter({ ...event, status: "failed", engineCostUsd: 0 });
    const outcome = await failedCharge(event.id);
    return { status: 502, body: { error: `${error instanceof Error ? error.message : "Transcription failed."} ${outcome.sentence}`, charged: outcome.charged } };
  }
  /* The transcript's own length prices it. Its cost is recorded in full on the
     platform's meter; the workspace pays that length's credits, never more
     than it approved. */
  const providerUsd = Number.isFinite(transcript.costUsd) && transcript.costUsd >= 0 ? transcript.costUsd : estimateUsd;
  const ceiling = Math.max(0, Math.floor(approved));
  try {
    await meter({ ...event, status: "succeeded", engineCostUsd: providerUsd, maxBilledCredits: ceiling }, { critical: true });
  } catch (error) {
    /* The transcript exists and is returned. Its reservation stands until the settlement is written. */
    console.error(`Transcription ${event.id} settlement not recorded:`, error instanceof Error ? error.message : error);
  }
  const charge = await meteredCharge(event.id).catch(() => null);
  return { status: 200, body: {
    text: transcript.text, language: transcript.language, seconds: transcript.seconds, words: transcript.words,
    srt: transcriptSrt(transcript.words),
    credits: charge ? charge.credits : paidByPlatform("xai") ? Math.min(billCredits(providerUsd, "xai"), ceiling) : 0,
  } };
}

/** What a paid transcription sent under an Idempotency-Key became (checkTranscriptionRequest). */
export type TranscriptionCheck =
  /** It finished: the reply it was answered with — the transcript and the credits it was charged. Nothing was sent again. */
  | { state: "answered"; reply: Record<string, unknown> }
  /** It was answered without a transcript: refused, or failed with nothing charged (the reply says which). */
  | { state: "refused"; status: number; error: string }
  /** It is still being transcribed: ask again in a moment. */
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
  if (charge.status === "succeeded")
    return { error: `Your last transcription finished and was charged ${creditWord(charge.credits)}, but its transcript was not saved. Nothing was sent again.`, credits: charge.credits };
  if (charge.status === "failed" && charge.credits === 0)
    return { error: "Your last transcription stopped without an answer. Its reserved credits were returned. Nothing was sent again.", credits: 0 };
  return { error: `Your last transcription stopped without an answer. ${charge.credits > 0 ? `Its ${creditWord(charge.credits)} stay reserved for review.` : "Its outcome is held for review."} Nothing was sent again.`, credits: charge.credits };
}

/**
 * Did the transcription sent under this key land, and with what? Asked for the
 * person who sent it, in this workspace's database only, with the fingerprint
 * of the request exactly as it was sent. Nothing here spends.
 *
 * A key the server has never seen is set aside in the same step, so a request
 * that arrives under it later is refused, never run. A request answered long
 * ago is read from its saved reply — the transcript itself when it finished.
 * One whose claim has no reply and that can no longer be running (older than
 * any function lives) is given its final answer from what it left on the
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
    if (Number(row.created_at) >= now() - STALE_CLAIM_MS) return { state: "pending" };
    const charge = await meteredCharge(eventId);
    await completeGenerationRequest(!charge
      ? { userId, key, status: 409, reply: { error: INTERRUPTED, charged: 0 } }
      : { userId, key, status: 502, reply: { error: (await uncertainOutcome(eventId)).error, code: UNCERTAIN, charged: charge.credits } });
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
