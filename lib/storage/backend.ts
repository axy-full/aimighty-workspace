import { createBlobBackend } from "./blob";
import { createR2Backend, type R2Config } from "./r2";
import type { StorageBackend, StorageBackendKind } from "./types";

export * from "./types";
export type { R2Config } from "./r2";

/**
 * Which store holds private media, and how a value stored in a row resolves
 * to an object in it.
 *
 * Three backends: `blob` (Vercel Blob, the store in production today), `r2`
 * (Cloudflare R2 over the S3 REST API, not yet used in production) and `local`
 * (the developer's disk, kept inline in lib/storage.ts because its layout is
 * not key-shaped).
 */

type Environment = Record<string, string | undefined>;

/**
 * STORAGE_BACKEND=blob|r2|local decides; unset, it is `blob` when the Blob
 * token is present and `local` otherwise (the rule the app always had). An
 * unknown value is a misconfiguration and fails loudly rather than silently
 * writing somewhere else.
 */
export function backendKind(env: Environment = process.env): StorageBackendKind {
  const explicit = env.STORAGE_BACKEND?.trim().toLowerCase();
  if (explicit === "blob" || explicit === "r2" || explicit === "local") return explicit;
  if (explicit) throw new Error(`Unknown STORAGE_BACKEND "${explicit}" (expected blob, r2 or local).`);
  return env.BLOB_READ_WRITE_TOKEN ? "blob" : "local";
}

/** True when objects live in a cloud store (Blob or R2) rather than on local disk. */
export const usingCloud = (env: Environment = process.env): boolean => backendKind(env) !== "local";

/** Reads the R2 variables; the error names which are missing, never their values. */
export function r2ConfigFromEnv(env: Environment = process.env): R2Config {
  const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].filter((name) => !env[name]);
  if (missing.length) throw new Error(`R2 storage is selected but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`);
  const accountId = env.R2_ACCOUNT_ID!;
  return {
    accountId,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    bucket: env.R2_BUCKET!,
    endpoint: env.R2_ENDPOINT?.replace(/\/+$/, "") || `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

let blobInstance: StorageBackend | null = null;
let r2Instance: { backend: StorageBackend; config: R2Config } | null = null;

/** The Blob backend whatever the selector says: absolute Blob URLs in old rows stay readable during a migration. */
export function blobBackend(): StorageBackend {
  return (blobInstance ??= createBlobBackend());
}

export function r2Backend(env: Environment = process.env): StorageBackend {
  const config = r2ConfigFromEnv(env);
  const same = r2Instance && (Object.keys(config) as (keyof R2Config)[]).every((k) => r2Instance!.config[k] === config[k]);
  if (!same) r2Instance = { backend: createR2Backend(config), config };
  return r2Instance!.backend;
}

/** The selected cloud backend. Throws under `local`; callers branch on usingCloud() first. */
export function cloudBackend(env: Environment = process.env): StorageBackend {
  const kind = backendKind(env);
  if (kind === "blob") return blobBackend();
  if (kind === "r2") return r2Backend(env);
  throw new Error("Storage backend \"local\" keeps objects on disk; there is no cloud backend to call.");
}

/* ── Stored values ─────────────────────────────────────────────────────── */

export type ResolvedObject = {
  backend: StorageBackend;
  key: string;
  /** A public Blob URL: readable with a plain fetch, no credentials. */
  publicUrl: boolean;
};

const BLOB_HOST = ".vercel-storage.com";
const PUBLIC_BLOB_HOST = ".public.blob.vercel-storage.com";

/**
 * Where a value stored in a database row lives.
 *
 * Route URLs (/api/media/<id>, /api/uploads/<id>) and empty values are not
 * storage-shaped: null, and the caller uses its deterministic key. An absolute
 * URL on a Vercel Blob host is an object in the Blob store whatever the active
 * backend (older browser-direct uploads kept their random-suffix URL). Any other
 * absolute URL is unknown and refused. A bare value is a key on the active
 * cloud backend.
 */
export function resolveStored(stored: string | null | undefined): ResolvedObject | null {
  if (!stored) return null;
  if (stored.startsWith("/api/media/") || stored.startsWith("/api/uploads/")) return null;
  if (/^https?:\/\//.test(stored)) {
    let hostname = "";
    try { hostname = new URL(stored).hostname.toLowerCase(); } catch { /* refused below */ }
    if (hostname.endsWith(BLOB_HOST)) return { backend: blobBackend(), key: stored, publicUrl: hostname.endsWith(PUBLIC_BLOB_HOST) };
    throw new Error("Stored media URL does not belong to a known storage backend.");
  }
  return { backend: cloudBackend(), key: stored, publicUrl: false };
}
