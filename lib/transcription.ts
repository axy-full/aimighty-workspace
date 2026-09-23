import { findStoredSource, readStoredSourceBytes, resolveStoredDuration, SOURCE_BYTES_LIMIT } from "./mediaSource.server";
import { allowanceCheck } from "./allowance";
import { paidByPlatform } from "./platformSpend";
import { billCredits } from "./creditTerms";
import { reserveGenerationSpend } from "./generationRequests";
import { meter } from "./meter";
import { currentTenant } from "./tenant";
import { id as newId } from "./db";
import { GROK_STT_MODEL, grokTranscribe, grokTranscriptionUsd, grokVoiceConfigured, transcriptSrt, type Transcript } from "./xaiVoice";

/**
 * Grok transcription of a stored audio or video original (owner, 23
 * September: Grok APIs wherever possible): the words, timed, speakers told
 * apart, and subtitles made from them. Priced by the source's measured length
 * ($0.000028 a second on the xAI key), quoted first, reserved at that
 * ceiling, then metered at what the transcript's own duration says.
 */
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export type TranscriptionInput = { sourceUploadId?: unknown; sourceGenId?: unknown; language?: unknown; diarize?: unknown; quoteOnly?: unknown; maxCredits?: unknown; projectId?: unknown };
export type TranscriptionReply = { status: number; body: Record<string, unknown> };

export async function transcribe(input: TranscriptionInput, userId: string): Promise<TranscriptionReply> {
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
  if (!Number.isFinite(Number(input.maxCredits)) || Number(input.maxCredits) < estimatedCredits)
    return { status: 409, body: { error: "The transcription estimate exceeds the approved credit amount. Review the price before submitting.", estimatedCredits } };
  const allowance = await allowanceCheck("xai", estimateUsd, "xai");
  if (!allowance.ok) return { status: allowance.status, body: { error: allowance.error } };

  const event = { id: newId("stt"), kind: "audio" as const, engine: "xai", model: GROK_STT_MODEL, projectId: typeof input.projectId === "string" ? input.projectId : null, createdBy: userId };
  try { await reserveGenerationSpend({ ...event, status: "running", engineCostUsd: estimateUsd }, { token: currentTenant()?.token }); }
  catch (error) { return { status: 402, body: { error: error instanceof Error ? error.message : "This workspace cannot cover the transcription." } }; }
  let transcript: Transcript & { costUsd: number };
  try {
    transcript = await grokTranscribe({
      bytes: await readStoredSourceBytes(source), mime: source.mime || (source.mediaKind === "video" ? "video/mp4" : "audio/mpeg"), filename: `${source.name || "source"}.${source.ext || "mp4"}`,
      language: typeof input.language === "string" && /^[A-Za-z]{2,3}(-[A-Za-z]{2})?$/.test(input.language) ? input.language : undefined,
      diarize: input.diarize !== false,
    });
  } catch (error) {
    await meter({ ...event, status: "failed", engineCostUsd: 0 });
    return { status: 502, body: { error: error instanceof Error ? error.message : "Transcription failed." } };
  }
  /* The transcript's own length prices it, never above three times the quote. */
  const costUsd = Math.min(transcript.costUsd, estimateUsd * 3);
  await meter({ ...event, status: "succeeded", engineCostUsd: costUsd }, { critical: true });
  return { status: 200, body: {
    text: transcript.text, language: transcript.language, seconds: transcript.seconds, words: transcript.words,
    srt: transcriptSrt(transcript.words), credits: paidByPlatform("xai") ? billCredits(costUsd, "xai") : 0,
  } };
}
