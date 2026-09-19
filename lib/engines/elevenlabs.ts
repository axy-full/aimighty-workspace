import type { EngineAdapter } from "./types";
import { elevenConfigured, textToSpeech, textToDialogue, soundEffect, composeMusic, speechCredits, sfxCredits, musicCredits, dialogueCredits, usdForCredits, type DialogueLine } from "../elevenlabs";

/** ElevenLabs: synchronous sound — a spoken line, a sound effect, a piece of music — billed in its own credits. */
export const elevenlabs: EngineAdapter = {
  id: "elevenlabs",
  kinds: ["audio"],
  configured: () => elevenConfigured(),
  estimate(req) {
    if (req.kind !== "audio") return null;
    const credits = req.task === "speech" ? speechCredits(req.text, req.modelId)
      : req.task === "dialogue" ? dialogueCredits((req.params.lines ?? []) as DialogueLine[])
      : req.task === "sound" ? sfxCredits() : musicCredits(Number(req.params.lengthMs ?? 0));
    return usdForCredits(credits, null);
  },
  async render(req) {
    if (req.kind !== "audio") throw new Error("ElevenLabs renders sound.");
    const p = req.params;
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
