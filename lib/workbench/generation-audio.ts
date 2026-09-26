import { GROK_TTS_MODEL } from "../grokVoiceModel";

export type NodeAudioTask = "sound" | "music" | "speech";
export type NodeAudioSetup = {
  configured: boolean;
  /** Which sound engines this workspace reaches: ElevenLabs makes every
   *  task, xAI only Grok Voice lines. Absent from older replies: both. */
  vendors?: { elevenlabs: boolean; xai: boolean };
  speechModels: { id: string; label: string }[];
  defaultSpeechModel: string;
  /** The default speech model's voices. */
  voices: { id: string; name: string }[];
  /** Grok Voice's own voices, when xAI is connected. */
  grokVoices?: { id: string; name: string }[];
  voicesError: string | null;
  grokVoicesError?: string | null;
};

/** The voices a speech model speaks in: Grok Voice has xAI's own, every other speech model the ElevenLabs account's. */
export function speechVoicesFor<V>(setup: { voices: V[]; grokVoices?: V[] } | null | undefined, modelId: string): V[] {
  if (!setup) return [];
  return modelId === GROK_TTS_MODEL ? (setup.grokVoices ?? []) : setup.voices;
}

/** The voice a line is read in: the one chosen, when this model speaks it, else the model's first. */
export function speechVoiceFor<V extends { id: string }>(voices: readonly V[], chosen: string | null | undefined): V | null {
  return voices.find((v) => v.id === chosen) ?? voices[0] ?? null;
}

/** Whether a task can run here: speech on any connected speech model, sound and music on ElevenLabs only. */
export function audioTaskAvailable(setup: Pick<NodeAudioSetup, "configured" | "vendors" | "speechModels"> | null | undefined, task: NodeAudioTask | string): boolean {
  if (!setup?.configured) return false;
  if (task === "speech") return setup.speechModels.length > 0;
  return setup.vendors?.elevenlabs !== false;
}

/** The task a picker lands on: the one asked for when it can run here, else a spoken line. */
export function usableAudioTask<T extends string>(setup: Pick<NodeAudioSetup, "configured" | "vendors" | "speechModels"> | null | undefined, task: T): T | "speech" {
  return !setup?.configured || audioTaskAvailable(setup, task) ? task : "speech";
}

/** The same payload is quoted and submitted through the existing audio admission. */
export function nodeAudioBody(input: {
  task: NodeAudioTask; text: string; seconds: number; instrumental: boolean;
  voiceId: string; modelId: string;
}) {
  return { task: input.task, text: input.text,
    ...(input.task === "speech" ? { voiceId: input.voiceId, modelId: input.modelId }
      : input.task === "music" ? { lengthMs: input.seconds * 1000, instrumental: input.instrumental }
      : { durationSeconds: input.seconds }) };
}

export function validAudioQuote(value: { estimatedCredits?: unknown }): value is { estimatedCredits: number } {
  return typeof value.estimatedCredits === "number" && Number.isInteger(value.estimatedCredits) && value.estimatedCredits >= 0;
}
