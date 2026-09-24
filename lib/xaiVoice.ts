import { vendorKey } from "./vendorKeys";
import { recoveryFetch } from "./recovery";
import { engineMock } from "./mock";
import { fixtureBytes } from "./mockFs";

/**
 * xAI's Grok voice (owner, 23 September: Grok APIs wherever possible), on the
 * xAI key and billed as an xAI charge:
 *   - Grok Voice, text to speech: POST /v1/tts, $15 per million characters,
 *     speech tags in the text ([laugh], [pause], <whisper>…</whisper>);
 *   - the built-in voices: GET /v1/tts/voices;
 *   - Grok transcription: POST /v1/stt, $0.000028 a second of audio (about
 *     ten cents an hour), words with
 *     their times and (asked for) speakers.
 */
import { GROK_TTS_MODEL } from "./grokVoiceModel";
export { GROK_TTS_MODEL };
export const GROK_STT_MODEL = "grok-stt";
export const GROK_TTS_USD_PER_CHAR = 0.000015;
/** Grok Voice as a speech model beside ElevenLabs' (same shape as SPEECH_MODELS). */
export const GROK_SPEECH_MODEL = {
  id: "grok-tts", label: "Grok Voice", creditsPerChar: 0, vendor: "xai" as const,
  note: "xAI's voice: 20 languages, speech tags in the text — [laugh], [pause], <whisper>…</whisper>.",
};
export const GROK_STT_USD_PER_SECOND = 0.000028;
/** xAI's text limit per request. */
export const GROK_TTS_MAX_CHARS = 60_000;
/** Built-in voice ids are lowercase names (eve, ara, rex…); custom ones are longer ids. */
export const GROK_VOICE_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

/** Which vendor voices an audio model: Grok Voice is xAI's, every other audio model ElevenLabs'. */
export function audioVendor(modelId: string): "xai" | "elevenlabs" {
  return modelId === GROK_TTS_MODEL ? "xai" : "elevenlabs";
}
export const grokSpeechUsd = (text: string) => text.length * GROK_TTS_USD_PER_CHAR;
export const grokTranscriptionUsd = (seconds: number) => Math.max(1, seconds) * GROK_STT_USD_PER_SECOND;

const BASE = () => (process.env.XAI_BASE_URL ?? "https://api.x.ai/v1").replace(/\/$/, "");
function key(): string {
  const value = vendorKey("xai");
  if (!value) throw new Error("Grok voice needs the xAI account connected for this workspace.");
  return value;
}
export const grokVoiceConfigured = () => engineMock() || Boolean(vendorKey("xai"));

export type GrokVoice = { id: string; name: string; language: string | null };
const MOCK_VOICES: GrokVoice[] = ["Eve", "Ara", "Rex", "Sal", "Leo"].map((name) => ({ id: name.toLowerCase(), name, language: "en" }));
let cached: { at: number; key: string; voices: GrokVoice[] } | null = null;

/** The built-in voices, from xAI (an hour's cache per key). */
export async function listGrokVoices(refresh = false): Promise<GrokVoice[]> {
  if (engineMock()) return MOCK_VOICES;
  const k = key();
  if (!refresh && cached && cached.key === k && Date.now() - cached.at < 3_600_000) return cached.voices;
  const res = await recoveryFetch(`${BASE()}/tts/voices`, { headers: { Authorization: `Bearer ${k}` }, cache: "no-store", signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!res.ok) throw new Error(`Grok voices could not be listed (${res.status}).`);
  const reply = await res.json() as { voices?: { voice_id?: string; name?: string; language?: string | null }[] };
  const voices = (reply.voices ?? []).filter((v) => typeof v.voice_id === "string" && GROK_VOICE_ID.test(v.voice_id))
    .map((v) => ({ id: v.voice_id!, name: v.name || v.voice_id!, language: v.language ?? null }));
  cached = { at: Date.now(), key: k, voices };
  return voices;
}

/** One spoken line: MP3 at 24 kHz / 128 kbps, the charge by its characters. */
export async function grokSpeech(opts: { text: string; voiceId: string; language?: string; speed?: number }): Promise<{ bytes: Buffer; mime: string; costUsd: number }> {
  const text = opts.text.slice(0, GROK_TTS_MAX_CHARS);
  if (engineMock()) return { bytes: await fixtureBytes("tone.mp3"), mime: "audio/mpeg", costUsd: grokSpeechUsd(text) };
  const body: Record<string, unknown> = { text, voice_id: opts.voiceId, language: opts.language || "auto" };
  if (opts.speed != null && Number.isFinite(opts.speed)) body.speed = Math.max(0.7, Math.min(1.5, opts.speed));
  const res = await recoveryFetch(`${BASE()}/tts`, {
    method: "POST", headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180_000), redirect: "error",
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw Object.assign(new Error(`Grok Voice refused the line (${res.status}): ${detail}`), { status: res.status });
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || "audio/mpeg", costUsd: grokSpeechUsd(text) };
}

export type Transcript = { text: string; language: string | null; seconds: number; words: { text: string; start: number; end: number; speaker?: number }[] };

/** A transcript of an audio or video file, words timed and (asked for) speakers told apart. */
export async function grokTranscribe(opts: { bytes: Buffer; mime: string; filename: string; language?: string; diarize?: boolean }): Promise<Transcript & { costUsd: number }> {
  if (engineMock()) {
    const words = "Not tonight. The ice will hold until morning.".split(" ").map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4, speaker: i < 2 ? 0 : 1 }));
    return { text: words.map((w) => w.text).join(" "), language: "en", seconds: 4, words, costUsd: grokTranscriptionUsd(4) };
  }
  const form = new FormData();
  if (opts.language) { form.append("language", opts.language); form.append("format", "true"); }
  if (opts.diarize) form.append("diarize", "true");
  form.append("file", new Blob([new Uint8Array(opts.bytes)], { type: opts.mime }), opts.filename);
  const res = await recoveryFetch(`${BASE()}/stt`, { method: "POST", headers: { Authorization: `Bearer ${key()}` }, body: form, signal: AbortSignal.timeout(280_000), redirect: "error" });
  if (!res.ok) throw Object.assign(new Error(`Grok transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`), { status: res.status });
  const reply = await res.json() as { text?: string; language?: string; duration?: number; words?: Transcript["words"] };
  const seconds = Number(reply.duration) || 0;
  return { text: reply.text ?? "", language: reply.language ?? null, seconds, words: reply.words ?? [], costUsd: grokTranscriptionUsd(seconds) };
}

/** Subtitles from a timed transcript: lines of up to ~42 characters or 6 seconds, a new cue at a change of speaker. */
export function transcriptSrt(words: Transcript["words"]): string {
  type Cue = { start: number; end: number; text: string; speaker?: number };
  const cues: Cue[] = [];
  for (const word of words) {
    const last = cues.at(-1);
    const joined = last ? `${last.text} ${word.text}` : word.text;
    if (last && joined.length <= 42 && word.end - last.start <= 6 && word.speaker === last.speaker) { last.end = word.end; last.text = joined; }
    else cues.push({ start: word.start, end: word.end, text: word.text, speaker: word.speaker });
  }
  const stamp = (s: number) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
  return cues.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join("\n");
}
