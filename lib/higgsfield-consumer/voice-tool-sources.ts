/**
 * The one project video a voice tool works on: a tenant-owned original
 * (upload or completed generation), validated, resolved and imported exactly
 * like a Generate reference — the same tables, claims and limits — expressed
 * as a one-media video request so nothing here re-implements source handling.
 * The tool and its settings are folded into the request so the import claim's
 * fingerprint changes when they do.
 */
import type { Transaction } from "@libsql/client";
import type { ConsumerGenerationInput } from "./generation-contract";
import { db, ready } from "@/lib/db";
import { describeConsumerGenerationSources, resolveConsumerGenerationImport, resolveConsumerGenerationSources, validateConsumerGenerationSources, storedSourceDuration } from "./generation-sources";
import { parseConsumerVoiceToolInput } from "./voice-tools";

export const VOICE_TOOL_SOURCE_ROLE = "video";
/** The tool's source video expressed as a Generate-style reference request. */
export function voiceToolReferenceRequest(value: unknown): ConsumerGenerationInput {
  const input = parseConsumerVoiceToolInput(value);
  return {
    type: "video",
    model: `voice_tool_${input.tool}`,
    prompt: "",
    parameters: {
      ...(input.voice ? { voice_id: input.voice.id, voice_type: input.voice.type } : {}),
      ...(input.targetLanguage ? { target_language: input.targetLanguage } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
    },
    medias: [{ role: VOICE_TOOL_SOURCE_ROLE, source: input.source }],
  };
}
/** Checked inside the job/dispatch write transaction, shared with deletion. */
export const validateConsumerVoiceToolSources = (tx: Pick<Transaction, "execute">, value: unknown) =>
  validateConsumerGenerationSources(tx, voiceToolReferenceRequest(value));
/** Display name and kind of the validated source, for the job snapshot. */
export async function describeConsumerVoiceToolSource(value: unknown) {
  const [source] = await describeConsumerGenerationSources(voiceToolReferenceRequest(value));
  return { kind: source.kind, name: source.name };
}
export async function resolveConsumerVoiceToolSource(value: unknown): Promise<{ url: string; type: "video"; durationSeconds?: number }> {
  const request = voiceToolReferenceRequest(value);
  await ready();
  // The stored duration (never the browser's) prices a reframe.
  const [validated] = await validateConsumerGenerationSources(db(), request);
  const [source] = await resolveConsumerGenerationSources(request);
  // Missing lengths are measured from the stored original and written back, so
  // an original collected without one is priced without being re-uploaded.
  const durationSeconds = await storedSourceDuration(validated);
  return { url: source.url, type: "video", ...(durationSeconds === null ? {} : { durationSeconds }) };
}
/** One import claim per quote; success is reused, an unconfirmed attempt never repeats. */
export const resolveConsumerVoiceToolImport = (
  input: { userId: string; draftId: string; quoteKey: string; request: unknown; workspaceId: string; connectionGeneration: string },
  perform: () => Promise<string>,
) => resolveConsumerGenerationImport({ ...input, sourceIndex: 0, request: voiceToolReferenceRequest(input.request) }, perform);
