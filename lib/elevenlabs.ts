import { recoveryFetch as fetch } from "./recovery";
import { getProvider, providerBaseUrl } from "./providers";
import { vendorKey } from "./vendorKeys";
import { memoGet, memoPut } from "./memo";
import { engineMock } from "./mock";
import { fixtureBytes } from "./mockFs";
import { ELEVENLABS_RATES, ELEVENLABS_SOURCE_LIMIT_BYTES, type DubbingMode } from "./vendorRates";

/**
 * ElevenLabs — voices, sound effects and music.
 *
 * Three doors, one key (ELEVENLABS_API_KEY, server-side only). Everything
 * comes back as MP3 bytes in the response body; the credits it cost are
 * read off the response where the API states them and estimated from the
 * request where it doesn't, then priced from the account's plan.
 */

export function elevenConfigured(): boolean {
  if (engineMock()) return true;
  return Boolean(vendorKey("elevenlabs"));
}

function key(): string {
  const k = vendorKey("elevenlabs");
  if (!k) {
    throw new Error(
      "Sound isn't connected for this workspace. Ask the platform to connect it.",
    );
  }
  return k;
}

const base = () => providerBaseUrl(getProvider("elevenlabs"));

/* ── What the account can do ────────────────────────────────────────── */

export type SpeechModel = {
  id: string;
  label: string;
  creditsPerChar: number;
  note: string;
  alpha?: boolean;
};

export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: "eleven_multilingual_v2",
    label: "Multilingual v2",
    creditsPerChar: 1,
    note: "The dependable studio voice — 29 languages, the most consistent read.",
  },
  {
    id: "eleven_v3",
    label: "Voice v3",
    creditsPerChar: 1,
    alpha: true,
    note: "The most expressive. Direct it with tags in the text: [whispers], [laughs], [sighs].",
  },
  {
    id: "eleven_flash_v2_5",
    label: "Flash v2.5",
    creditsPerChar: 0.5,
    note: "Fast, and half the credits — for scratch tracks and timing passes.",
  },
  {
    id: "eleven_turbo_v2_5",
    label: "Turbo v2.5",
    creditsPerChar: 0.5,
    note: "Quality and speed balanced, half the credits.",
  },
];
export const DEFAULT_SPEECH_MODEL = "eleven_multilingual_v2";
export const SFX_MODEL = "eleven_sfx";
export const MUSIC_MODEL = "eleven_music";
/** Text to Dialogue: several voices in one request, on the v3 model only. */
export const DIALOGUE_MODEL = ELEVENLABS_RATES.dialogue.modelId;
export const DIALOGUE_MAX_CHARS = ELEVENLABS_RATES.dialogue.maxChars;
export const DIALOGUE_MAX_VOICES = ELEVENLABS_RATES.dialogue.maxVoices;

/** A sound effect costs the same whatever its length (pricing page: "200
 *  credits per generation"). */
export const SFX_CREDITS = Number(process.env.ELEVEN_SFX_CREDITS ?? 200);
/** Music bills per minute of track ("900 credits per minute"). */
export const MUSIC_CREDITS_PER_MINUTE = Number(
  process.env.ELEVEN_MUSIC_CREDITS_PER_MINUTE ?? 900,
);

/** What a credit costs on each plan: the monthly price over the credits it
 *  includes, from elevenlabs.io/pricing. Top-ups are priced near this. */
export const PLAN_USD_PER_CREDIT: Record<string, number> = {
  free: 0,
  starter: 6 / 30_000,
  creator: 22 / 121_000,
  pro: 99 / 600_000,
  scale: 299 / 1_800_000,
  business: 990 / 6_000_000,
};
export const FALLBACK_USD_PER_CREDIT = PLAN_USD_PER_CREDIT.creator;

export function usdForCredits(
  credits: number,
  tier: string | null | undefined,
): number {
  const rate =
    tier && PLAN_USD_PER_CREDIT[tier.toLowerCase()] != null
      ? PLAN_USD_PER_CREDIT[tier.toLowerCase()]
      : FALLBACK_USD_PER_CREDIT;
  return Math.round(credits * rate * 10_000) / 10_000;
}

export function speechCredits(text: string, modelId: string): number {
  const m = SPEECH_MODELS.find((x) => x.id === modelId) ?? SPEECH_MODELS[0];
  return Math.ceil(text.length * m.creditsPerChar);
}
export const sfxCredits = () => SFX_CREDITS;
export type DialogueLine = { text: string; voiceId: string };
/** Dialogue bills every character of every line at the v3 rate. */
export function dialogueCredits(lines: DialogueLine[]): number {
  const chars = lines.reduce((n, line) => n + line.text.length, 0);
  return Math.ceil(chars * ELEVENLABS_RATES.dialogue.creditsPerChar);
}
export const musicCredits = (lengthMs: number) =>
  Math.ceil((lengthMs / 60_000) * MUSIC_CREDITS_PER_MINUTE);

/* ── Errors, in sentences ───────────────────────────────────────────── */

function explain(status: number, json: unknown): string {
  const j = (json ?? {}) as {
    detail?: { status?: string; message?: string } | string;
    message?: string;
  };
  const d =
    typeof j.detail === "string" ? { message: j.detail } : (j.detail ?? {});
  const msg = d.message ?? j.message ?? "";
  if (status === 401)
    return `The audio service rejected the key (401)${msg ? ` — ${msg}` : ""}.`;
  if (status === 402 || d.status === "quota_exceeded")
    return `Audio credits are used up for this billing cycle${msg ? ` — ${msg}` : ""}.`;
  if (status === 422)
    return `The audio service refused the request: ${msg || "invalid input"}.`;
  if (status === 429)
    return "The audio service is at its concurrency limit. Try again when a slot is available.";
  return `The audio service returned ${status}${msg ? `: ${msg}` : ""}.`;
}

/** A received provider rejection can release the reservation; transport failures cannot. */
export class ElevenLabsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
  get rejectedBeforeGeneration() {
    return [400, 401, 402, 403, 404, 422, 429].includes(this.status);
  }
}

/**
 * A deadline on every call. ElevenLabs is synchronous — the bytes come back
 * in the response body — so a stalled connection would otherwise hold the
 * route open for its full five minutes and leave the row spinning.
 */
async function elevenFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error(
        `The audio service did not answer within ${Math.round(timeoutMs / 1000)}s. The outcome is unconfirmed; this request will not be submitted again automatically.`,
      );
    }
    throw new Error(`Could not reach the audio service: ${err.message}`);
  }
}

async function callJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await elevenFetch(
    `${base()}${path}`,
    {
      ...init,
      cache: "no-store",
      headers: { "xi-api-key": key(), ...(init.headers ?? {}) },
    },
    30_000,
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(explain(res.status, json));
  return json as T;
}

/** POST for bytes: the audio itself, plus what the headers say it cost. */
async function callAudio(
  path: string,
  body: unknown,
): Promise<{
  bytes: Buffer;
  mime: string;
  credits: number | null;
  requestId: string | null;
}> {
  // Generous: a long line on the v3 model, or a full music piece, genuinely
  // takes a while to synthesise — but still well inside the route's ceiling.
  const res = await elevenFetch(
    `${base()}${path}`,
    {
      method: "POST",
      cache: "no-store",
      headers: {
        "xi-api-key": key(),
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    },
    180_000,
  );
  if (!res.ok) {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 300) };
    }
    throw new ElevenLabsError(res.status, explain(res.status, json));
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  // The API documents no cost header, so the caller prices from the
  // request by the published rates; the request id is kept for support.
  return {
    bytes,
    mime: res.headers.get("content-type") ?? "audio/mpeg",
    credits: null as number | null,
    requestId: res.headers.get("request-id") ?? res.headers.get("x-request-id"),
  };
}

/* ── Voices ────────────────────────────────────────────────────────── */

export type Voice = {
  id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  previewUrl: string | null;
  description: string;
};

type VoicesResponse = {
  voices: {
    voice_id: string;
    name: string;
    category?: string;
    labels?: Record<string, string>;
    preview_url?: string | null;
    description?: string | null;
  }[];
  has_more?: boolean;
};

/** The account's voices — its own and the premade library it can use. Memoed per workspace: the key differs. */
export async function listVoices(force = false): Promise<Voice[]> {
  const hit = force ? null : memoGet<Voice[]>("eleven-voices", 10 * 60_000);
  if (hit) return hit;
  let raw: VoicesResponse;
  try {
    raw = await callJson<VoicesResponse>("/v2/voices?page_size=100");
  } catch {
    raw = await callJson<VoicesResponse>("/v1/voices");
  }
  const voices = (raw.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category ?? "premade",
    labels: v.labels ?? {},
    previewUrl: v.preview_url ?? null,
    description: v.description ?? "",
  }));
  // Your own voices first, then the library, alphabetical inside each.
  const rank = (c: string) =>
    c === "cloned" || c === "generated" || c === "professional" ? 0 : 1;
  voices.sort(
    (a, b) =>
      rank(a.category) - rank(b.category) || a.name.localeCompare(b.name),
  );
  memoPut("eleven-voices", voices);
  return voices;
}

/* ── Speech ────────────────────────────────────────────────────────── */

export type VoiceSettings = {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
};

export async function textToSpeech(opts: {
  voiceId: string;
  text: string;
  modelId: string;
  settings?: VoiceSettings;
  format?: string;
}) {
  if (engineMock())
    return {
      bytes: await fixtureBytes("tone.mp3"),
      mime: "audio/mpeg",
      credits: speechCredits(opts.text, opts.modelId),
      requestId: "mock",
    };
  const format = opts.format ?? "mp3_44100_128";
  const out = await callAudio(
    `/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=${encodeURIComponent(format)}`,
    {
      text: opts.text,
      model_id: opts.modelId,
      ...(opts.settings && Object.keys(opts.settings).length
        ? { voice_settings: opts.settings }
        : {}),
    },
  );
  return {
    ...out,
    credits: out.credits ?? speechCredits(opts.text, opts.modelId),
  };
}

/* ── Dialogue ──────────────────────────────────────────────────────── */

/** POST /v1/text-to-dialogue: one MP3 with each line read by its voice. */
export async function textToDialogue(opts: {
  lines: DialogueLine[];
  modelId?: string;
  format?: string;
}) {
  const modelId = opts.modelId ?? DIALOGUE_MODEL;
  if (engineMock())
    return {
      bytes: await fixtureBytes("tone.mp3"),
      mime: "audio/mpeg",
      credits: dialogueCredits(opts.lines),
      requestId: "mock",
    };
  const format = opts.format ?? "mp3_44100_128";
  const out = await callAudio(
    `/v1/text-to-dialogue?output_format=${encodeURIComponent(format)}`,
    {
      inputs: opts.lines.map((line) => ({
        text: line.text,
        voice_id: line.voiceId,
      })),
      model_id: modelId,
    },
  );
  return { ...out, credits: out.credits ?? dialogueCredits(opts.lines) };
}

/* ── Sound effects ─────────────────────────────────────────────────── */

export async function soundEffect(opts: {
  text: string;
  durationSeconds: number | null;
  promptInfluence?: number;
  loop?: boolean;
}) {
  if (engineMock())
    return {
      bytes: await fixtureBytes("tone.mp3"),
      mime: "audio/mpeg",
      credits: sfxCredits(),
      requestId: "mock",
    };
  const out = await callAudio(
    `/v1/sound-generation?output_format=mp3_44100_128`,
    {
      text: opts.text,
      model_id: "eleven_text_to_sound_v2",
      ...(opts.durationSeconds != null
        ? { duration_seconds: opts.durationSeconds }
        : {}),
      ...(opts.promptInfluence != null
        ? { prompt_influence: opts.promptInfluence }
        : {}),
      ...(opts.loop ? { loop: true } : {}),
    },
  );
  return { ...out, credits: out.credits ?? sfxCredits() };
}

/* ── Music ─────────────────────────────────────────────────────────── */

export async function composeMusic(opts: {
  prompt: string;
  lengthMs: number;
  instrumental?: boolean;
}) {
  if (engineMock())
    return {
      bytes: await fixtureBytes("tone.mp3"),
      mime: "audio/mpeg",
      credits: musicCredits(opts.lengthMs),
      requestId: "mock",
    };
  const out = await callAudio(`/v1/music?output_format=mp3_44100_128`, {
    prompt: opts.prompt,
    music_length_ms: opts.lengthMs,
    model_id: "music_v1",
    ...(opts.instrumental ? { force_instrumental: true } : {}),
  });
  return { ...out, credits: out.credits ?? musicCredits(opts.lengthMs) };
}

/* ── The account ───────────────────────────────────────────────────── */

export type Subscription = {
  tier: string;
  status: string;
  used: number;
  limit: number;
  resetAt: number | null;
  usdPerCredit: number;
};

type SubscriptionResponse = {
  tier?: string;
  status?: string;
  character_count?: number;
  character_limit?: number;
  next_character_count_reset_unix?: number;
};

export async function subscription(): Promise<Subscription> {
  if (engineMock())
    return {
      tier: "creator",
      status: "active",
      used: 0,
      limit: 100_000,
      resetAt: null,
      usdPerCredit: 0.0003,
    };
  const s = await callJson<SubscriptionResponse>("/v1/user/subscription");
  const tier = (s.tier ?? "free").toLowerCase();
  return {
    tier,
    status: s.status ?? "",
    used: Number(s.character_count ?? 0),
    limit: Number(s.character_limit ?? 0),
    resetAt: s.next_character_count_reset_unix
      ? Number(s.next_character_count_reset_unix) * 1000
      : null,
    usdPerCredit: PLAN_USD_PER_CREDIT[tier] ?? FALLBACK_USD_PER_CREDIT,
  };
}

/* ── Voice change (speech to speech) ───────────────────────────────── */

export const VOICE_CHANGE_MODEL = ELEVENLABS_RATES.voiceChange.modelId;
/** $0.12 per minute of INPUT audio, whole minutes rounded up (API pricing page, 19 September 2026). */
export function voiceChangeUsd(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Voice change needs the source's length to price.");
  const minutes = Math.max(1, Math.ceil(seconds / 60 - 1e-9));
  return Math.round(minutes * ELEVENLABS_RATES.voiceChange.usdPerMinute * 10_000) / 10_000;
}

/** Multipart POST for bytes: the same deadline and error sentences as callAudio. */
async function callAudioMultipart(
  path: string,
  form: FormData,
  timeoutMs = 300_000,
): Promise<{ bytes: Buffer; mime: string; credits: number | null; requestId: string | null }> {
  const res = await elevenFetch(
    `${base()}${path}`,
    { method: "POST", cache: "no-store", headers: { "xi-api-key": key(), Accept: "audio/mpeg" }, body: form },
    timeoutMs,
  );
  if (!res.ok) {
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 300) }; }
    throw new ElevenLabsError(res.status, explain(res.status, json));
  }
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: res.headers.get("content-type") ?? "audio/mpeg",
    credits: null,
    requestId: res.headers.get("request-id") ?? res.headers.get("x-request-id"),
  };
}

/**
 * POST /v1/speech-to-speech/{voice_id}: the source's bytes as multipart
 * `audio`, re-voiced on eleven_multilingual_sts_v2, back as MP3. Only the
 * documented fields travel: model_id, optional voice_settings, seed and
 * remove_background_noise; output_format as the query.
 */
export async function speechToSpeech(opts: {
  voiceId: string;
  audio: Buffer;
  filename: string;
  mime: string;
  seconds: number;
  modelId?: string;
  settings?: VoiceSettings;
  seed?: number;
  removeBackgroundNoise?: boolean;
  format?: string;
}) {
  const costUsd = voiceChangeUsd(opts.seconds);
  if (engineMock())
    return { bytes: await fixtureBytes("tone.mp3"), mime: "audio/mpeg", credits: null, costUsd, requestId: "mock" };
  if (opts.audio.length > ELEVENLABS_SOURCE_LIMIT_BYTES)
    throw new Error("Voice change takes a source up to 100 MB.");
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(opts.audio)], { type: opts.mime || "application/octet-stream" }), opts.filename || "source");
  form.append("model_id", opts.modelId ?? VOICE_CHANGE_MODEL);
  if (opts.settings && Object.keys(opts.settings).length) form.append("voice_settings", JSON.stringify(opts.settings));
  if (opts.seed != null && Number.isInteger(opts.seed)) form.append("seed", String(opts.seed));
  if (opts.removeBackgroundNoise) form.append("remove_background_noise", "true");
  const format = opts.format ?? "mp3_44100_128";
  const out = await callAudioMultipart(
    `/v1/speech-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=${encodeURIComponent(format)}`,
    form,
  );
  return { ...out, costUsd };
}

/* ── Dubbing (an asynchronous project) ─────────────────────────────── */

export type DubbingStatus = "dubbing" | "dubbed" | "failed";
export type DubbingProject = { dubbingId: string; expectedDurationSec: number | null };

/** The per-minute price of a mode; one target language is charged up front. */
export function dubbingUsdPerMinute(mode: DubbingMode): number {
  const rate = ELEVENLABS_RATES.dubbing.modes[mode];
  if (!rate) throw new Error("Unknown dubbing mode.");
  return rate;
}
export function dubbingUsd(seconds: number, mode: DubbingMode): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Dubbing needs the source's length to price.");
  const minutes = Math.max(1, Math.ceil(seconds / 60 - 1e-9));
  return Math.round(minutes * dubbingUsdPerMinute(mode) * 10_000) / 10_000;
}

/**
 * POST /v1/dubbing: multipart `file`, `source_lang`, `target_lang`,
 * `num_speakers` (0 = detect), `watermark`, `mode` automatic. Answers the
 * project id and the vendor's own expectation of how long it will take.
 * A 4xx is a refusal before any work; a timeout is an UNCONFIRMED outcome
 * the caller must treat as uncertain and never resubmit.
 */
export async function submitDubbing(opts: {
  file: Buffer;
  filename: string;
  mime: string;
  sourceLang: string;
  targetLang: string;
  watermark: boolean;
  numSpeakers?: number;
}): Promise<DubbingProject> {
  if (engineMock()) return { dubbingId: `mock-dub-${Date.now()}`, expectedDurationSec: 1 };
  if (opts.file.length > ELEVENLABS_SOURCE_LIMIT_BYTES) throw new Error("Dubbing takes a source up to 100 MB.");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(opts.file)], { type: opts.mime || "application/octet-stream" }), opts.filename || "source");
  form.append("source_lang", opts.sourceLang);
  form.append("target_lang", opts.targetLang);
  form.append("num_speakers", String(opts.numSpeakers ?? 0));
  form.append("watermark", opts.watermark ? "true" : "false");
  form.append("mode", "automatic");
  const res = await elevenFetch(
    `${base()}/v1/dubbing`,
    { method: "POST", cache: "no-store", headers: { "xi-api-key": key() }, body: form },
    120_000,
  );
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
  if (!res.ok) throw new ElevenLabsError(res.status, explain(res.status, json));
  const j = (json ?? {}) as { dubbing_id?: string; expected_duration_sec?: number };
  if (!j.dubbing_id || typeof j.dubbing_id !== "string") throw new Error("The audio service accepted the dubbing request without a project id. The outcome is unconfirmed.");
  return { dubbingId: j.dubbing_id, expectedDurationSec: Number.isFinite(Number(j.expected_duration_sec)) ? Number(j.expected_duration_sec) : null };
}

/** GET /v1/dubbing/{id}: `dubbing` while it works, `dubbed` when the audio can be downloaded, `failed` with the vendor's note. */
export async function dubbingStatus(dubbingId: string): Promise<{ status: DubbingStatus; error: string | null; targetLanguages: string[] }> {
  if (engineMock()) return { status: "dubbed", error: null, targetLanguages: [] };
  const j = await callJson<{ status?: string; error?: string | null; target_languages?: string[] }>(`/v1/dubbing/${encodeURIComponent(dubbingId)}`);
  const status = j.status === "dubbed" ? "dubbed" : j.status === "failed" ? "failed" : "dubbing";
  return { status, error: j.error ? String(j.error) : null, targetLanguages: Array.isArray(j.target_languages) ? j.target_languages.map(String) : [] };
}

/** GET /v1/dubbing/{id}/audio/{language_code}: the dubbed track's bytes, bounded. */
export async function downloadDubbedAudio(dubbingId: string, languageCode: string, maxBytes = ELEVENLABS_SOURCE_LIMIT_BYTES): Promise<{ bytes: Buffer; mime: string }> {
  if (engineMock()) return { bytes: await fixtureBytes("tone.mp3"), mime: "audio/mpeg" };
  const res = await elevenFetch(
    `${base()}/v1/dubbing/${encodeURIComponent(dubbingId)}/audio/${encodeURIComponent(languageCode)}`,
    { method: "GET", cache: "no-store", headers: { "xi-api-key": key() } },
    300_000,
  );
  if (!res.ok) {
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 300) }; }
    throw new ElevenLabsError(res.status, explain(res.status, json));
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { await res.body?.cancel(); throw new Error("The dubbed audio exceeds the download limit."); }
  if (!res.body) throw new Error("The audio service returned an empty dubbed track.");
  const reader = res.body.getReader(), chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error("The dubbed audio exceeds the download limit."); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return { bytes: Buffer.concat(chunks, total), mime: res.headers.get("content-type") ?? "audio/mpeg" };
}
