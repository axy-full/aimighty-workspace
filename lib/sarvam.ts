import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";
import { SARVAM_RATES, type SarvamSpeechModel, type SarvamTranslateModel } from "./vendorRates";

/**
 * Sarvam, DIRECT (the owner, 15 Oct 2026: "Sarvam (Bulbul TTS, Saaras STT, dubbing), DIRECT"): Indian-language speech, transcription and translation.
 * Retention 0 is set on the account by the owner (14 Oct, 14:25); the code cannot see that setting and does not rely on it for anything but the owner's
 * promise. Voices are stock voices only: no voice cloning is offered or called (owner, "not now").
 *
 * Settings (names only): SARVAM_API_KEY, SARVAM_USD_PER_INR (the owner's rupee rate, lib/sarvamTools.ts), SARVAM_BASE_URL (optional; default
 * https://api.sarvam.ai) and SARVAM_ENABLED (the kill switch, lib/engineGate.ts). Under ENGINE_MOCK=1 nothing is called: a fixture answers in process.
 *
 * What is called (docs/plans/provider-adapters.md § 2): `POST /text-to-speech`, `POST /speech-to-text` (clips under about 30 s) and `POST /translate`,
 * with the header `api-subscription-key`. **The request and reply field names and the model ids follow Sarvam's public API as the plan records it and are TO
 * CONFIRM in the first qualification run** (the plan names the endpoints and models, not every field). Every reply is read defensively; a field that is not what
 * is expected is a failure, never a guess, and nothing is billed on a failure (Sarvam's pages say nothing about billing a failed call: plan § 2).
 */
export const SARVAM_SWITCH = "SARVAM_ENABLED";
const DEFAULT_BASE = "https://api.sarvam.ai";
const TIMEOUT_MS = 60_000;
/** Per request (plan § 2): speech 2,500 characters on Bulbul v3 and v4-flash; translation 2,000 on sarvam-translate and 1,000 on mayura. */
export const SARVAM_SPEECH_MAX_CHARS = 2500;
export const SARVAM_TRANSLATE_MAX_CHARS: Record<SarvamTranslateModel, number> = { "sarvam-translate:v1": 2000, "mayura:v1": 1000 };
/** The shortest-clip endpoint takes audio under about 30 seconds; longer is a batch job, which is not offered yet. */
export const SARVAM_SHORT_AUDIO_SECONDS = 30;
export const SARVAM_AUDIO_BYTES_LIMIT = 25 * 1024 * 1024;
/** Bulbul's languages (plan § 2: eleven, English with them) and the codes the API names them by (TO CONFIRM). */
export const SARVAM_SPEECH_LANGUAGES = ["hi-IN", "bn-IN", "ta-IN", "te-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "en-IN"] as const;
const LANGUAGE = /^[a-z]{2,3}-[A-Z]{2}$/;

export const sarvamConfigured = (): boolean => Boolean(process.env.SARVAM_API_KEY) || engineMock();
export const isSpeechModel = (v: unknown): v is SarvamSpeechModel => typeof v === "string" && Object.hasOwn(SARVAM_RATES.speechInrPer10kChars, v);
export const isTranslateModel = (v: unknown): v is SarvamTranslateModel => typeof v === "string" && Object.hasOwn(SARVAM_RATES.translateInrPer10kChars, v);
export const isSpeechLanguage = (v: unknown): boolean => typeof v === "string" && (SARVAM_SPEECH_LANGUAGES as readonly string[]).includes(v);
/** A language code of the shape the API takes ("ta-IN"); translation covers 22 Indian languages and English, so the shape is checked, not a list of ours. */
export const isLanguageCode = (v: unknown): v is string => typeof v === "string" && LANGUAGE.test(v);
/** A stock voice's name, passed through as the API names it; only its shape is checked. */
export const isVoiceName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(v);

/** A refusal or failure from Sarvam (or from reaching it). `rejectedBeforeWork`: it answered 4xx before any work (not 408/429). */
export class SarvamError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly rejectedBeforeWork = false) { super(message); this.name = "SarvamError"; }
}

function base(): string {
  const raw = (process.env.SARVAM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_BASE;
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(raw) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(raw)) return raw;
  throw new SarvamError("SARVAM_BASE_URL is not an https address.");
}
function key(): string {
  const value = process.env.SARVAM_API_KEY;
  if (!value) throw new SarvamError("This is not set up: SARVAM_API_KEY is needed.");
  return value;
}

type Deps = { fetch?: typeof fetch };
async function post(path: string, body: { json?: unknown; form?: FormData }, deps: Deps): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (deps.fetch ?? recoveryFetch)(`${base()}${path}`, {
      method: "POST",
      headers: { "api-subscription-key": key(), ...(body.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: body.form ?? JSON.stringify(body.json),
      /* The key goes in a header, and undici forwards custom headers across an origin: a redirect is a failure, never followed. */
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof SarvamError) throw error;
    throw new SarvamError("Sarvam did not answer.");
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const error = json.error;
    const said = typeof json.message === "string" ? json.message : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
    throw new SarvamError(said ? `Sarvam refused the request: ${said.slice(0, 200)}` : `Sarvam answered ${res.status}.`, res.status, res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
  }
  return json;
}

/* ── Fixture (ENGINE_MOCK=1) ────────────────────────────────────────────────── */
/** A text that begins "[[mock-fail]]" fails; anything else answers. Deterministic and in process. */
const MOCK_MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);

/** Text to speech: one request, at most SARVAM_SPEECH_MAX_CHARS characters, a stock voice. Returns the audio bytes (mp3). */
export async function speak(input: { text: string; language: string; model: SarvamSpeechModel; voice?: string; pace?: number }, deps: Deps = {}): Promise<Buffer> {
  if (!input.text.trim() || [...input.text].length > SARVAM_SPEECH_MAX_CHARS) throw new SarvamError(`Speech takes up to ${SARVAM_SPEECH_MAX_CHARS} characters at a time.`, null, true);
  if (engineMock()) {
    if (input.text.startsWith("[[mock-fail]]")) throw new SarvamError("Sarvam refused the request: mock failure.", 422, true);
    return Buffer.from(MOCK_MP3);
  }
  const json = await post("/text-to-speech", {
    json: { text: input.text, target_language_code: input.language, model: input.model, output_audio_codec: "mp3", ...(input.voice ? { speaker: input.voice } : {}), ...(input.pace ? { pace: input.pace } : {}) },
  }, deps);
  const audio = Array.isArray(json.audios) ? json.audios[0] : null;
  if (typeof audio !== "string" || !audio) throw new SarvamError("Sarvam's reply held no audio.");
  const bytes = Buffer.from(audio, "base64");
  if (!bytes.length) throw new SarvamError("Sarvam's reply held no audio.");
  return bytes;
}

/** Speech to text for a clip under about 30 seconds. Returns the transcript and the language Sarvam heard. */
export async function transcribe(input: { bytes: Buffer; filename: string; mime: string; model: string; language?: string }, deps: Deps = {}): Promise<{ transcript: string; language: string | null }> {
  if (!input.bytes.length || input.bytes.length > SARVAM_AUDIO_BYTES_LIMIT) throw new SarvamError("Transcription takes audio up to 25 MB.", null, true);
  if (engineMock()) {
    if (input.bytes.subarray(0, 13).toString("utf8") === "[[mock-fail]]") throw new SarvamError("Sarvam refused the request: mock failure.", 422, true);
    return { transcript: "mock transcript", language: input.language ?? "hi-IN" };
  }
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.mime }), input.filename.slice(0, 120));
  form.append("model", input.model);
  if (input.language) form.append("language_code", input.language);
  const json = await post("/speech-to-text", { form }, deps);
  if (typeof json.transcript !== "string") throw new SarvamError("Sarvam's reply held no transcript.");
  return { transcript: json.transcript, language: typeof json.language_code === "string" ? json.language_code : null };
}

/** Translation of one piece of text, at most the model's limit. */
export async function translate(input: { text: string; source: string; target: string; model: SarvamTranslateModel }, deps: Deps = {}): Promise<{ text: string }> {
  const limit = SARVAM_TRANSLATE_MAX_CHARS[input.model];
  if (!input.text.trim() || [...input.text].length > limit) throw new SarvamError(`${input.model} takes up to ${limit} characters at a time.`, null, true);
  if (engineMock()) {
    if (input.text.startsWith("[[mock-fail]]")) throw new SarvamError("Sarvam refused the request: mock failure.", 422, true);
    return { text: `[${input.target}] ${input.text}` };
  }
  const json = await post("/translate", { json: { input: input.text, source_language_code: input.source, target_language_code: input.target, model: input.model } }, deps);
  if (typeof json.translated_text !== "string") throw new SarvamError("Sarvam's reply held no translation.");
  return { text: json.translated_text };
}
