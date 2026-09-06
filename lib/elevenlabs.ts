import { getProvider, providerBaseUrl } from "./providers";
import { vendorKey } from "./vendorKeys";
import { memoGet, memoPut } from "./memo";

/**
 * ElevenLabs — voices, sound effects and music.
 *
 * Three doors, one key (ELEVENLABS_API_KEY, server-side only). Everything
 * comes back as MP3 bytes in the response body; the credits it cost are
 * read off the response where the API states them and estimated from the
 * request where it doesn't, then priced from the account's plan.
 */

export function elevenConfigured(): boolean {
  return Boolean(vendorKey("elevenlabs"));
}

function key(): string {
  const k = vendorKey("elevenlabs");
  if (!k) {
    throw new Error(
      "ElevenLabs isn't connected for this workspace — add its key under Settings › Vendors & keys."
    );
  }
  return k;
}

const base = () => providerBaseUrl(getProvider("elevenlabs"));

/* ── What the account can do ────────────────────────────────────────── */

export type SpeechModel = { id: string; label: string; creditsPerChar: number; note: string; alpha?: boolean };

export const SPEECH_MODELS: SpeechModel[] = [
  { id: "eleven_multilingual_v2", label: "Multilingual v2", creditsPerChar: 1,
    note: "The dependable studio voice — 29 languages, the most consistent read." },
  { id: "eleven_v3", label: "Eleven v3", creditsPerChar: 1, alpha: true,
    note: "The most expressive. Direct it with tags in the text: [whispers], [laughs], [sighs]." },
  { id: "eleven_flash_v2_5", label: "Flash v2.5", creditsPerChar: 0.5,
    note: "Fast, and half the credits — for scratch tracks and timing passes." },
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5", creditsPerChar: 0.5,
    note: "Quality and speed balanced, half the credits." },
];
export const DEFAULT_SPEECH_MODEL = "eleven_multilingual_v2";
export const SFX_MODEL = "eleven_sfx";
export const MUSIC_MODEL = "eleven_music";

/** A sound effect costs the same whatever its length (pricing page: "200
 *  credits per generation"). */
export const SFX_CREDITS = Number(process.env.ELEVEN_SFX_CREDITS ?? 200);
/** Music bills per minute of track ("900 credits per minute"). */
export const MUSIC_CREDITS_PER_MINUTE = Number(process.env.ELEVEN_MUSIC_CREDITS_PER_MINUTE ?? 900);

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

export function usdForCredits(credits: number, tier: string | null | undefined): number {
  const rate = tier && PLAN_USD_PER_CREDIT[tier.toLowerCase()] != null
    ? PLAN_USD_PER_CREDIT[tier.toLowerCase()] : FALLBACK_USD_PER_CREDIT;
  return Math.round(credits * rate * 10_000) / 10_000;
}

export function speechCredits(text: string, modelId: string): number {
  const m = SPEECH_MODELS.find((x) => x.id === modelId) ?? SPEECH_MODELS[0];
  return Math.ceil(text.length * m.creditsPerChar);
}
export const sfxCredits = () => SFX_CREDITS;
export const musicCredits = (lengthMs: number) => Math.ceil((lengthMs / 60_000) * MUSIC_CREDITS_PER_MINUTE);

/* ── Errors, in sentences ───────────────────────────────────────────── */

function explain(status: number, json: unknown): string {
  const j = (json ?? {}) as { detail?: { status?: string; message?: string } | string; message?: string };
  const d = typeof j.detail === "string" ? { message: j.detail } : (j.detail ?? {});
  const msg = d.message ?? j.message ?? "";
  if (status === 401) return `ElevenLabs rejected the key (401)${msg ? ` — ${msg}` : ""}.`;
  if (status === 402 || d.status === "quota_exceeded") return `ElevenLabs credits are used up for this billing cycle${msg ? ` — ${msg}` : ""}.`;
  if (status === 422) return `ElevenLabs refused the request: ${msg || "invalid input"}.`;
  if (status === 429) return "ElevenLabs is at its concurrency limit — it will be retried.";
  return `ElevenLabs returned ${status}${msg ? `: ${msg}` : ""}.`;
}

/**
 * A deadline on every call. ElevenLabs is synchronous — the bytes come back
 * in the response body — so a stalled connection would otherwise hold the
 * route open for its full five minutes and leave the row spinning.
 */
async function elevenFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error(`ElevenLabs did not answer within ${Math.round(timeoutMs / 1000)}s. Nothing was delivered, so nothing was charged.`);
    }
    throw new Error(`Could not reach ElevenLabs: ${err.message}`);
  }
}

async function callJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await elevenFetch(`${base()}${path}`, {
    ...init, cache: "no-store",
    headers: { "xi-api-key": key(), ...(init.headers ?? {}) },
  }, 30_000);
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(explain(res.status, json));
  return json as T;
}

/** POST for bytes: the audio itself, plus what the headers say it cost. */
async function callAudio(path: string, body: unknown): Promise<{ bytes: Buffer; mime: string; credits: number | null; requestId: string | null }> {
  // Generous: a long line on the v3 model, or a full music piece, genuinely
  // takes a while to synthesise — but still well inside the route's ceiling.
  const res = await elevenFetch(`${base()}${path}`, {
    method: "POST", cache: "no-store",
    headers: { "xi-api-key": key(), "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
  }, 180_000);
  if (!res.ok) {
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = { message: text.slice(0, 300) }; }
    throw new Error(explain(res.status, json));
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
  id: string; name: string; category: string;
  labels: Record<string, string>; previewUrl: string | null; description: string;
};

type VoicesResponse = {
  voices: {
    voice_id: string; name: string; category?: string;
    labels?: Record<string, string>; preview_url?: string | null; description?: string | null;
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
    id: v.voice_id, name: v.name, category: v.category ?? "premade",
    labels: v.labels ?? {}, previewUrl: v.preview_url ?? null, description: v.description ?? "",
  }));
  // Your own voices first, then the library, alphabetical inside each.
  const rank = (c: string) => (c === "cloned" || c === "generated" || c === "professional" ? 0 : 1);
  voices.sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name));
  memoPut("eleven-voices", voices);
  return voices;
}

/* ── Speech ────────────────────────────────────────────────────────── */

export type VoiceSettings = {
  stability?: number; similarity_boost?: number; style?: number; use_speaker_boost?: boolean; speed?: number;
};

export async function textToSpeech(opts: {
  voiceId: string; text: string; modelId: string; settings?: VoiceSettings; format?: string;
}) {
  const format = opts.format ?? "mp3_44100_128";
  const out = await callAudio(`/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=${encodeURIComponent(format)}`, {
    text: opts.text,
    model_id: opts.modelId,
    ...(opts.settings && Object.keys(opts.settings).length ? { voice_settings: opts.settings } : {}),
  });
  return { ...out, credits: out.credits ?? speechCredits(opts.text, opts.modelId) };
}

/* ── Sound effects ─────────────────────────────────────────────────── */

export async function soundEffect(opts: { text: string; durationSeconds: number | null; promptInfluence?: number; loop?: boolean }) {
  const out = await callAudio(`/v1/sound-generation?output_format=mp3_44100_128`, {
    text: opts.text,
    model_id: "eleven_text_to_sound_v2",
    ...(opts.durationSeconds != null ? { duration_seconds: opts.durationSeconds } : {}),
    ...(opts.promptInfluence != null ? { prompt_influence: opts.promptInfluence } : {}),
    ...(opts.loop ? { loop: true } : {}),
  });
  return { ...out, credits: out.credits ?? sfxCredits() };
}

/* ── Music ─────────────────────────────────────────────────────────── */

export async function composeMusic(opts: { prompt: string; lengthMs: number; instrumental?: boolean }) {
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
  tier: string; status: string;
  used: number; limit: number; resetAt: number | null;
  usdPerCredit: number;
};

type SubscriptionResponse = {
  tier?: string; status?: string;
  character_count?: number; character_limit?: number;
  next_character_count_reset_unix?: number;
};

export async function subscription(): Promise<Subscription> {
  const s = await callJson<SubscriptionResponse>("/v1/user/subscription");
  const tier = (s.tier ?? "free").toLowerCase();
  return {
    tier, status: s.status ?? "",
    used: Number(s.character_count ?? 0), limit: Number(s.character_limit ?? 0),
    resetAt: s.next_character_count_reset_unix ? Number(s.next_character_count_reset_unix) * 1000 : null,
    usdPerCredit: PLAN_USD_PER_CREDIT[tier] ?? FALLBACK_USD_PER_CREDIT,
  };
}
