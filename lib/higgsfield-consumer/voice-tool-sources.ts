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
import { describeConsumerGenerationSources, resolveConsumerGenerationImport, resolveConsumerGenerationSources, validateConsumerGenerationSources } from "./generation-sources";
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
export async function resolveConsumerVoiceToolSource(value: unknown): Promise<{ url: string; type: "video" }> {
  const [source] = await resolveConsumerGenerationSources(voiceToolReferenceRequest(value));
  return { url: source.url, type: "video" };
}
/** One import claim per quote; success is reused, an unconfirmed attempt never repeats. */
export const resolveConsumerVoiceToolImport = (
  input: { userId: string; draftId: string; quoteKey: string; request: unknown; workspaceId: string; connectionGeneration: string },
  perform: () => Promise<string>,
) => resolveConsumerGenerationImport({ ...input, sourceIndex: 0, request: voiceToolReferenceRequest(input.request) }, perform);
