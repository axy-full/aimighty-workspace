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

export type ProviderId = "byteplus";

export type ProviderDef = {
  id: ProviderId;
  label: string;
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
];

export const DEFAULT_PROVIDER: ProviderId = "byteplus";

export function getProvider(pid: string): ProviderDef {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p) throw new Error(`Unknown provider: ${pid}`);
  return p;
}

/** Is this vendor usable right now? Reported on /api/health and in Settings. */
export function providerConfigured(p: ProviderDef): boolean {
  return Boolean(process.env[p.envKey]);
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
