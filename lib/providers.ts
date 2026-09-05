/**
 * R7 — the API integration layer.
 *
 * The GPUs belong to somebody else. What this platform owns is the
 * orchestration around them, and the one thing we know for certain is that
 * the generation stack will change: models get retired on a schedule, a
 * second vendor arrives, a third is trialled for a week and dropped.
 *
 * So a provider is DATA, not code paths sprinkled through the app:
 *   • its key lives under a named env var, and the app can say whether it's set
 *   • its file and request limits are declared, so the upload layer can answer
 *     "will this master survive the trip?" before anyone spends money
 *   • its failures are classified — retryable, fatal, or rate-limited — in one
 *     place, so retry policy isn't re-invented per call site
 *
 * Adding a vendor = an entry here + an adapter module + model rows in
 * models.ts. Nothing else in the app should learn its name.
 */

export type ProviderId = "byteplus" | "google" | "elevenlabs" | "fal" | "vercel";

export type ProviderDef = {
  id: ProviderId;
  label: string;
  /** What this vendor makes, in the words the studio uses for it. A ledger
   *  is looked for by the medium it paid for, not by the company's name. */
  serves: string;
  /** Env var holding the key. Never NEXT_PUBLIC_ — these are server-side. */
  envKey: string;
  /** Overridable so a local echo server can stand in during verification. */
  baseUrlEnv: string;
  defaultBaseUrl: string;
  docs: string;
  /** Hard limits the vendor enforces on what we send. */
  limits: {
    maxImageBytes: number;
    maxVideoBytes: number;
    maxRequestBytes: number;
    minImagePx: number;
    maxImagePx: number;
    minAspect: number;
    maxAspect: number;
    /** Formats accepted as a reference image. */
    imageFormats: string[];
  };
  /** What we know about their throttling, for the operator's benefit. */
  rateLimit: string;
  /** Charged only for work delivered? Drives the "failed ≠ billed" promise. */
  billsFailures: boolean;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "byteplus",
    label: "BytePlus ModelArk",
    serves: "Video",
    envKey: "ARK_API_KEY",
    baseUrlEnv: "ARK_BASE_URL",
    defaultBaseUrl: "https://ark.ap-southeast.bytepluses.com",
    docs: "https://docs.byteplus.com/en/docs/ModelArk/1520757",
    limits: {
      maxImageBytes: 30 * 1024 * 1024,
      maxVideoBytes: 200 * 1024 * 1024,
      maxRequestBytes: 64 * 1024 * 1024,
      minImagePx: 300,
      maxImagePx: 6000,
      minAspect: 0.4,
      maxAspect: 2.5,
      imageFormats: ["jpeg", "jpg", "png", "webp", "bmp", "tiff", "gif"],
    },
    rateLimit: "Per-key concurrency and RPM set in the ModelArk console; a 429 " +
               "or 'rate' error is retried with backoff rather than failed.",
    billsFailures: false,
  },
  {
    id: "google",
    label: "Google Gemini",
    serves: "Images",
    envKey: "GEMINI_API_KEY",
    baseUrlEnv: "GEMINI_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    docs: "https://ai.google.dev/gemini-api/docs/image-generation",
    limits: {
      // References travel inline as base64 inside one JSON request, and the
      // request as a whole is what Google bounds — so the per-image ceiling
      // is set to leave room for the fourteen the model accepts.
      maxImageBytes: 7 * 1024 * 1024,
      maxVideoBytes: 0,
      maxRequestBytes: 20 * 1024 * 1024,
      minImagePx: 64,
      maxImagePx: 8192,
      minAspect: 0.25,
      maxAspect: 4,
      imageFormats: ["jpeg", "jpg", "png", "webp", "heic", "heif"],
    },
    rateLimit: "Per-project RPM and daily quotas set in Google AI Studio; a 429 " +
               "or RESOURCE_EXHAUSTED is retried with backoff rather than failed.",
    billsFailures: false,
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    serves: "Sound",
    envKey: "ELEVENLABS_API_KEY",
    baseUrlEnv: "ELEVENLABS_BASE_URL",
    defaultBaseUrl: "https://api.elevenlabs.io",
    docs: "https://elevenlabs.io/docs/api-reference/introduction",
    // Audio in, audio out: nothing here is an image, so the image limits are
    // zero and the upload layer never consults them.
    limits: {
      maxImageBytes: 0,
      maxVideoBytes: 0,
      maxRequestBytes: 10 * 1024 * 1024,
      minImagePx: 0,
      maxImagePx: 0,
      minAspect: 0,
      maxAspect: 0,
      imageFormats: [],
    },
    rateLimit: "Concurrent requests are capped per plan (a handful on the small " +
               "plans, more on Scale); a 429 is retried with backoff rather than failed.",
    billsFailures: false,
  },
  {
    id: "fal",
    label: "fal.ai",
    serves: "Characters",
    envKey: "FAL_KEY",
    baseUrlEnv: "FAL_BASE_URL",
    defaultBaseUrl: "https://queue.fal.run",
    docs: "https://docs.fal.ai/model-apis/model-endpoints/queue",
    limits: {
      maxImageBytes: 20 * 1024 * 1024,
      maxVideoBytes: 0,
      maxRequestBytes: 100 * 1024 * 1024,
      minImagePx: 256,
      maxImagePx: 4096,
      minAspect: 0.25,
      maxAspect: 4,
      imageFormats: ["jpeg", "jpg", "png", "webp"],
    },
    rateLimit: "Queue-based — a busy moment waits rather than fails. A 429 is " +
               "retried with backoff.",
    billsFailures: false,
  },
  {
    /* The thinking, as opposed to the making.
     *
     * Every text call this app makes -- the prompt writer, and every Atomik
     * turn -- goes through the Vercel AI Gateway, and the dollars come out
     * of the gateway's own credit balance. They were being charged to
     * whichever vendor made the RENDER, so a Claude turn showed up on
     * Google's ledger and a Seedance one on BytePlus's, and neither ledger
     * could ever agree with its own console.
     *
     * It is also the one vendor here whose balance we can simply ask for,
     * which is why it needs no top-ups recorded by hand. */
    id: "vercel",
    label: "Vercel AI Gateway",
    serves: "Thinking",
    envKey: "AI_GATEWAY_API_KEY",
    baseUrlEnv: "AI_GATEWAY_BASE_URL",
    defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
    docs: "https://vercel.com/docs/ai-gateway",
    limits: {
      maxImageBytes: 0, maxVideoBytes: 0, maxRequestBytes: 20 * 1024 * 1024,
      minImagePx: 0, maxImagePx: 0, minAspect: 0, maxAspect: 0,
      imageFormats: [],
    },
    rateLimit: "Per-account limits set by Vercel; a 429 is retried with backoff.",
    billsFailures: false,
  },
];

export const DEFAULT_PROVIDER: ProviderId = "byteplus";

export function getProvider(pid: string): ProviderDef {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p) throw new Error(`Unknown provider: ${pid}`);
  return p;
}

import { gatewayReachable } from "./gateway";
import { vendorKey, vendorKeyForEnv } from "./vendorKeys";

/** Is this vendor usable right now? Reported on /api/health and in Settings. */
export function providerConfigured(p: ProviderDef): boolean {
  if (p.id === "vercel") return gatewayReachable();
  return Boolean(process.env[p.envKey]) || (p.id === "google" && gatewayReachable());
}

/** Which door a vendor's calls go through from this deployment. */
/**
 * Whose balance actually pays for a render by this provider.
 *
 * `provider` records who MADE a render; this records who was charged, and
 * for stills the two differ. Nano Banana is a Google model, but when the
 * door is the Vercel AI Gateway — which it is on Vercel, where no
 * GEMINI_API_KEY is needed — the dollars come out of gateway credit. A
 * ledger that put them on Google could never agree with Google's console.
 *
 * The door logic mirrors stillsDoor() in lib/gemini.ts, which stays the
 * single authority on which door is actually opened; if that changes, this
 * must change with it.
 */
export function billedTo(provider: string): ProviderId {
  /* Widened to string because ModelDef.provider is one, and a model that
     names a vendor this build has never heard of must land somewhere
     nameable rather than throwing inside an INSERT. */
  if (provider !== "google") {
    return (PROVIDERS.some((p) => p.id === provider) ? provider : "byteplus") as ProviderId;
  }
  const key = Boolean(vendorKey("gemini"));
  if (process.env.STILLS_VIA === "google" && key) return "google";
  if (gatewayReachable()) return "vercel";
  return "google";
}

export function providerVia(p: ProviderDef): "key" | "gateway" | null {
  /* The gateway IS this vendor, and on Vercel it authenticates by the
     deployment's OIDC identity rather than a key — so asking whether the
     key is set would report the one vendor that is always reachable as
     not configured. */
  if (p.id === "vercel") return gatewayReachable() ? "gateway" : null;
  if (p.id === "google") {
    if (process.env.STILLS_VIA === "google" && vendorKeyForEnv(p.envKey)) return "key";
    if (gatewayReachable()) return "gateway";
    return process.env[p.envKey] ? "key" : null;
  }
  return process.env[p.envKey] ? "key" : null;
}

export function providerBaseUrl(p: ProviderDef): string {
  return (process.env[p.baseUrlEnv] ?? p.defaultBaseUrl).replace(/\/$/, "");
}

/* ── Failure classification ────────────────────────────────────────────
 * "Handled gracefully" (R6) means knowing which failures are worth trying
 * again. A timeout or a 502 is weather; a rejected prompt is a decision.
 * Retrying a decision just spends the clock twice.
 * ------------------------------------------------------------------- */
export type FailureClass = "retryable" | "rate-limited" | "fatal";

export function classifyFailure(err: unknown): FailureClass {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b429\b|rate.?limit|too many requests|quota.*exceed|concurren/.test(msg)) return "rate-limited";
  if (/\b(408|409|500|502|503|504)\b|timeout|timed out|etimedout|econnreset|socket hang up|network|fetch failed|temporarily/.test(msg))
    return "retryable";
  return "fatal";
}

/** Exponential-ish backoff with a ceiling; rate limits wait longer. */
export function backoffMs(attempt: number, cls: FailureClass): number {
  const base = cls === "rate-limited" ? 4000 : 1200;
  return Math.min(base * 2 ** (attempt - 1), 20_000);
}

/**
 * Run `fn`, retrying only what deserves it. `onRetry` is called before each
 * wait so the caller can record the attempt on the row — a render that
 * quietly succeeded on try three should say so.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { max: number; onRetry?: (attempt: number, cls: FailureClass, err: Error) => void }
): Promise<{ value: T; attempts: number }> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return { value: await fn(), attempts: attempt };
    } catch (e) {
      const cls = classifyFailure(e);
      if (cls === "fatal" || attempt > opts.max) throw e;
      opts.onRetry?.(attempt, cls, e as Error);
      await new Promise((r) => setTimeout(r, backoffMs(attempt, cls)));
    }
  }
}
