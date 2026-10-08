/**
 * Which compute runs a native 3D render, and what the meter calls it.
 *
 * `ASTRA_RENDER_BACKEND` picks the backend: `vercel` (the default, a Vercel
 * Sandbox started from the verified snapshot) or `selfhost` (the platform's own
 * single-slot CPU workers, docs/astra-blender-runtime.md). Both run the same
 * compiled scene and launcher at the same paths and are billed by the same
 * formula; only the engine label on the meter row differs, and a job keeps the
 * label it was approved under for its whole life.
 *
 * This file imports nothing so the statement, ledger and funding code can read
 * the engine labels without loading the renderer.
 */
export type AstraRenderBackend = "vercel" | "selfhost";

export const ASTRA_COMPUTE_ENGINES = { vercel: "vercel-sandbox", selfhost: "selfhost-blender" } as const;
export type AstraComputeEngine = (typeof ASTRA_COMPUTE_ENGINES)[AstraRenderBackend];

/** At most this many native renders run at once, platform-wide, on either backend (three workers). */
export const ASTRA_RENDER_CONCURRENCY = 3;

export function isAstraComputeEngine(engine: unknown): engine is AstraComputeEngine {
  return engine === ASTRA_COMPUTE_ENGINES.vercel || engine === ASTRA_COMPUTE_ENGINES.selfhost;
}

/** The backend a job's recorded engine belongs to. Rows from before the switch carry no engine and were Vercel's. */
export function astraBackendOfEngine(engine: unknown): AstraRenderBackend {
  return engine === ASTRA_COMPUTE_ENGINES.selfhost ? "selfhost" : "vercel";
}

/** The configured backend; null when the setting holds something that is neither. */
export function astraRenderBackend(env: Readonly<Record<string, string | undefined>> = process.env): AstraRenderBackend | null {
  const value = (env.ASTRA_RENDER_BACKEND ?? "").trim().toLowerCase();
  if (value === "" || value === "vercel") return "vercel";
  if (value === "selfhost") return "selfhost";
  return null;
}

export type AstraSelfhostConfig = { readonly urls: readonly string[]; readonly secret: string };

const SECRET = /^[\x21-\x7e]{32,512}$/;

/**
 * The self-hosted workers, or null when they are not fully configured.
 *
 * `ASTRA_WORKER_URLS` is one to three comma-separated http(s) origins (no
 * credentials, path, query or fragment); `ASTRA_WORKER_SECRET` is at least 32
 * printable characters. Requests go to these origins and nowhere else.
 */
export function astraSelfhostConfig(env: Readonly<Record<string, string | undefined>> = process.env): AstraSelfhostConfig | null {
  const raw = (env.ASTRA_WORKER_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
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
  const secret = env.ASTRA_WORKER_SECRET ?? "";
  if (!SECRET.test(secret)) return null;
  return { urls, secret };
}
