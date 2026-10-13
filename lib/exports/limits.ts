/**
 * What the platform sets for exports. None of it is a price: exports are free to customers (0 cr) and
 * nothing here ever becomes one. Read from the platform's environment at run time, bounded, with the owner's
 * starting figures (13 Oct 2026) as defaults.
 */
export type ExportLimits = {
  /** Exports one workspace may have rendering at once. */
  maxRunningPerWorkspace: number;
  /** Exports one workspace may start in any rolling hour. */
  maxPerHourPerWorkspace: number;
  /** How long one run call to the worker may take, in ms. Inside the 300 s a worker invocation lives. */
  runTimeoutMs: number;
  /** A queued export that has not started after this long is ended ("Nothing billed"). */
  queueExpiryMs: number;
};

export const EXPORT_PRICE = Object.freeze({ credits: 0, label: "Free" as const });

type Env = Readonly<Record<string, string | undefined>>;

function bounded(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function exportLimits(env: Env = process.env): ExportLimits {
  return {
    maxRunningPerWorkspace: bounded(env, "REMOTION_EXPORT_MAX_RUNNING", 1, 1, 4),
    maxPerHourPerWorkspace: bounded(env, "REMOTION_EXPORT_MAX_PER_HOUR", 6, 1, 120),
    runTimeoutMs: bounded(env, "REMOTION_EXPORT_RUN_TIMEOUT_MS", 280_000, 30_000, 900_000),
    queueExpiryMs: bounded(env, "REMOTION_EXPORT_QUEUE_EXPIRY_MS", 30 * 60_000, 60_000, 24 * 3600_000),
  };
}

/** `secrets[i]` is the bearer for `urls[i]`. */
export type ExportWorkerConfig = { readonly urls: readonly string[]; readonly secrets: readonly string[] };

const SECRET = /^[\x21-\x7e]{32,512}$/;

/**
 * The export workers, or null when they are not fully configured. `REMOTION_WORKER_URLS` is one to three
 * comma-separated http(s) origins (no credentials, path, query or fragment); `REMOTION_WORKER_SECRETS` is one
 * secret per worker in the same order, each at least 32 printable characters. Requests go to these origins only.
 */
export function exportWorkerConfig(env: Env = process.env): ExportWorkerConfig | null {
  const raw = (env.REMOTION_WORKER_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (raw.length < 1 || raw.length > 3) return null;
  const urls: string[] = [];
  for (const value of raw) {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || value.includes("@")) return null;
    if (url.search || url.hash || url.pathname !== "/" || !url.hostname) return null;
    urls.push(url.origin);
  }
  if (new Set(urls).size !== urls.length) return null;
  const secrets = (env.REMOTION_WORKER_SECRETS ?? "").split(",").map((value) => value.trim());
  if (secrets.length !== urls.length || !secrets.every((secret) => SECRET.test(secret))) return null;
  return { urls, secrets };
}

/** Exports that can run at once, platform-wide: one per configured worker (one when none is configured yet). */
export function exportWorkerSlots(env: Env = process.env): number {
  return exportWorkerConfig(env)?.urls.length ?? 1;
}
