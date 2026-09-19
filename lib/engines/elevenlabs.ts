import type { EngineAdapter } from "./types";
import { elevenConfigured, textToSpeech, textToDialogue, soundEffect, composeMusic, speechToSpeech, speechCredits, sfxCredits, musicCredits, dialogueCredits, voiceChangeUsd, usdForCredits, type DialogueLine, type VoiceSettings } from "../elevenlabs";
import { findStoredSource, readStoredSourceBytes } from "../mediaSource.server";

/** ElevenLabs: synchronous sound — a spoken line, a sound effect, a piece of music, a re-voiced track — billed in its own credits, or per minute for voice change. */
export const elevenlabs: EngineAdapter = {
  id: "elevenlabs",
  kinds: ["audio"],
  configured: () => elevenConfigured(),
  estimate(req) {
    if (req.kind !== "audio") return null;
    if (req.task === "voiceChange") {
      const seconds = Number(req.params.sourceSeconds);
      return Number.isFinite(seconds) && seconds > 0 ? voiceChangeUsd(seconds) : null;
    }
    const credits = req.task === "speech" ? speechCredits(req.text, req.modelId)
      : req.task === "dialogue" ? dialogueCredits((req.params.lines ?? []) as DialogueLine[])
      : req.task === "sound" ? sfxCredits() : musicCredits(Number(req.params.lengthMs ?? 0));
    return usdForCredits(credits, null);
  },
  async render(req) {
    if (req.kind !== "audio") throw new Error("ElevenLabs renders sound.");
    const p = req.params;
    if (req.task === "voiceChange") {
      /* The source's bytes are read through the storage backend at render
         time (bounded 100 MB), never carried on the row; the admission
         already measured and priced their length. */
      const source = await findStoredSource({ uploadId: p.sourceUploadId as string | undefined, genId: p.sourceGenId as string | undefined });
      if (!source) throw new Error("The voice change source is no longer available in this workspace.");
      const seconds = Number(p.sourceSeconds);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("The voice change source has no measured length.");
      const out = await speechToSpeech({
        voiceId: String(p.voiceId), audio: await readStoredSourceBytes(source), filename: source.name, mime: source.mime, seconds,
        modelId: req.modelId, removeBackgroundNoise: Boolean(p.removeBackgroundNoise),
        settings: Object.fromEntries(Object.entries((p.settings ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined)) as VoiceSettings,
      });
      return { produced: { bytes: out.bytes, mime: out.mime, costUsd: out.costUsd, totalTokens: null, credits: null, requestId: out.requestId } };
    }
    const out = req.task === "speech"
      ? await textToSpeech({
          voiceId: String(p.voiceId), text: req.text, modelId: req.modelId,
          settings: Object.fromEntries(Object.entries((p.settings ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined)),
        })
      : req.task === "dialogue"
        ? await textToDialogue({ lines: (p.lines ?? []) as DialogueLine[], modelId: req.modelId })
      : req.task === "sound"
        ? await soundEffect({ text: req.text, durationSeconds: (p.durationSeconds as number | null) ?? null, promptInfluence: p.promptInfluence as number | undefined, loop: Boolean(p.loop) })
        : await composeMusic({ prompt: req.text, lengthMs: p.lengthMs as number, instrumental: Boolean(p.instrumental) });
    return { produced: { bytes: out.bytes, mime: out.mime, costUsd: null, totalTokens: null, credits: out.credits, requestId: out.requestId } };
  },
};
