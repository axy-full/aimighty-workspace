/**
 * The Social · narrated board's Voice stage in the new interface (docs/redesign/inventory.md § 10.2; prototype 12 "Voice"):
 * what the Narrator and Music bed cards ask Make for, as data. Pure: no React, no fetch (tests/unit/v12-social.spec.ts).
 *
 * Both cards run on today's sound engine (ElevenLabs, through POST /api/audio): a spoken line in a chosen voice, and a piece of
 * music. A card is drawn only when this workspace can run it (`audioTaskAvailable`). The price of either is the server's live
 * quote of the take as written (a narration is priced per character: "up to N cr"), and with nothing written there is nothing
 * to price, so no figure is shown: no number is written here.
 */
import { nodeAudioBody, audioTaskAvailable, type NodeAudioSetup } from "@/lib/workbench/generation-audio";

/** Make's own limit for a spoken line (components/workbench/SoundGenerate.tsx maxLength). */
export const LINES_MAX = 5000;
/** A bed's description and length, as Make's music task opens (lib/workbench/sound-generate.ts SOUND_SECONDS.music.initial). */
export const BED_SECONDS = 30;

type Setup = Pick<NodeAudioSetup, "configured" | "vendors" | "speechModels">;

/** Whether the workspace can speak a line, and whether it can make music, by the audio setup Make itself reads. */
export const canNarrate = (setup: Setup | null | undefined): boolean => audioTaskAvailable(setup, "speech");
export const canMakeBed = (setup: Setup | null | undefined): boolean => audioTaskAvailable(setup, "music");

/** The quote-only body of a narration: the same payload Make's sound form quotes and submits (nodeAudioBody). Null with no lines or no voice. */
export function narrationBody(lines: string, voiceId: string, modelId: string): Record<string, unknown> | null {
  const text = lines.trim().slice(0, LINES_MAX);
  return text && voiceId && modelId ? { ...nodeAudioBody({ task: "speech", text, seconds: 0, instrumental: false, voiceId, modelId }) } : null;
}

/** The quote-only body of a music bed, instrumental. Null with no description. */
export function bedBody(description: string): Record<string, unknown> | null {
  const text = description.trim().slice(0, LINES_MAX);
  return text ? { ...nodeAudioBody({ task: "music", text, seconds: BED_SECONDS, instrumental: true, voiceId: "", modelId: "" }) } : null;
}

/** What Make opens with: its audio mode, the words, and for a narration the voice. */
export type MakeOpening = { prompt: string; type: "audio"; billing: "workspace"; note: string; model?: string; sound?: { voiceId?: string; instrumental?: boolean; seconds?: number } };
export const narrationOpening = (lines: string, voiceId: string, voiceName: string | null, modelId: string): MakeOpening => ({
  /* The model rides with it: Make keeps the person's last audio model otherwise, which may be a sound-effects or music engine priced
     differently from the button, and would take the lines as the wrong kind of prompt. */
  prompt: lines.trim().slice(0, LINES_MAX), type: "audio", billing: "workspace", model: modelId,
  note: voiceName ? `Narration · ${voiceName}` : "Narration", sound: { voiceId },
});
export const bedOpening = (description: string): MakeOpening => ({
  prompt: description.trim().slice(0, LINES_MAX), type: "audio", billing: "workspace", note: "Music bed", model: "eleven_music", sound: { instrumental: true, seconds: BED_SECONDS },
});
