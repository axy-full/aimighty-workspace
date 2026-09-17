export type NodeAudioTask = "sound" | "music" | "speech";
export type NodeAudioSetup = {
  configured: boolean;
  speechModels: { id: string; label: string }[];
  defaultSpeechModel: string;
  voices: { id: string; name: string }[];
  voicesError: string | null;
};

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
