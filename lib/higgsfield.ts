import { createHash, randomUUID } from "node:crypto";
import { vendorKey } from "./vendorKeys";
import { recoveryFetch } from "./recovery";
import { SOUL_VERSIONS, type SoulVersion } from "./soulRenderTypes";

/**
 * Where a custom reference (a trained identity) was accepted, as a versioned
 * marker. Every new identity and its independent receipt are stamped with the
 * current marker before the paid request is sent, and status reads always go
 * back to the host that accepted the reference. A marker is only ever one of
 * these fixed keys; it is never built from input or a provider response.
 */
export const SOUL_REFERENCE_ORIGINS = {
  /** The earlier host. Identities accepted before markers existed stay here, read-only. */
  "dev-v1": "https://dev-api.higgsfield.com/v1/custom-references",
  /** The production custom-reference API. All new training goes here. */
  "api-v1": "https://api.higgsfield.ai/v1/custom-references",
} as const;
export type SoulReferenceOrigin = keyof typeof SOUL_REFERENCE_ORIGINS;
export const SOUL_REFERENCE_ORIGIN: SoulReferenceOrigin = "api-v1";
export const LEGACY_SOUL_REFERENCE_ORIGIN: SoulReferenceOrigin = "dev-v1";
/** The render family a reference is trained for (lib/soulRenderTypes.ts). v1 is the default when none is chosen. */
export const SOUL_MODEL_VERSIONS = SOUL_VERSIONS;
export type SoulModelVersion = SoulVersion;
export const SOUL_MODEL_VERSION: SoulModelVersion = "v1";

/** A stored marker. A row saved before markers existed was accepted by the earlier host. */
export function soulReferenceOrigin(stored: unknown): SoulReferenceOrigin {
  if (stored == null) return LEGACY_SOUL_REFERENCE_ORIGIN;
  if (typeof stored === "string" && Object.hasOwn(SOUL_REFERENCE_ORIGINS, stored))
    return stored as SoulReferenceOrigin;
  throw new Error("The stored identity host is not recognized.");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SOUL_REFERENCE_STATUSES = [
  "not_ready",
  "queued",
  "in_progress",
  "completed",
  "failed",
] as const;
export type SoulReference = {
  id: string;
  status: (typeof SOUL_REFERENCE_STATUSES)[number];
};

export type HiggsfieldCredentials = { keyId: string; keySecret: string; fingerprint: string };
const MOCK_CREDENTIAL = "particl-mock:higgsfield";
type Env = Record<string, string | undefined>;

/** `KEY_ID:KEY_SECRET`, and its one-way fingerprint (SHA-256 of the whole value; the key cannot be read back from it). */
function credentialFrom(value: string | null | undefined): HiggsfieldCredentials | null {
  const split = value?.indexOf(":") ?? -1;
  if (!value || split < 1 || split === value.length - 1 || /\s/.test(value)) return null;
  return {
    keyId: value.slice(0, split),
    keySecret: value.slice(split + 1),
    fingerprint: createHash("sha256").update(value).digest("hex"),
  };
}

export function higgsfieldCredentials(): HiggsfieldCredentials {
  const found = credentialFrom(
    process.env.ENGINE_MOCK === "1" ? MOCK_CREDENTIAL : vendorKey("higgsfield"),
  );
  if (!found)
    throw new Error(
      "Add an identity account API key ID and secret before using identities.",
    );
  return found;
}

/**
 * The platform's own key, as the deployment configures it (lib/vendorKeys.ts:
 * `HF_CREDENTIALS`, or `HF_API_KEY_ID` with `HF_API_KEY_SECRET`); the fixture
 * key under ENGINE_MOCK. Null when none is set.
 */
export function platformHiggsfieldCredentials(env: Env = process.env): HiggsfieldCredentials | null {
  if (env.ENGINE_MOCK === "1") return credentialFrom(MOCK_CREDENTIAL);
  return credentialFrom(env.HF_CREDENTIALS || (env.HF_API_KEY_ID && env.HF_API_KEY_SECRET ? `${env.HF_API_KEY_ID}:${env.HF_API_KEY_SECRET}` : null));
}

/** Whether the key this workspace sends on right now is the platform's shared one (its jobs share the pool, lib/providerPool.ts). */
export function higgsfieldUsesPlatformKey(env: Env = process.env): boolean {
  try {
    const platform = platformHiggsfieldCredentials(env);
    return Boolean(platform) && higgsfieldCredentials().fingerprint === platform!.fingerprint;
  } catch {
    return false;
  }
}

/**
 * Keys the platform sent work on before a rotation, kept in the deployment's
 * configuration only so that work can still be collected and settled
 * (`HF_CREDENTIALS_PREVIOUS`: `KEY_ID:KEY_SECRET` entries, separated by
 * commas or new lines). Never used to send anything new.
 */
export function previousHiggsfieldCredentials(env: Env = process.env): HiggsfieldCredentials[] {
  return (env.HF_CREDENTIALS_PREVIOUS ?? "").split(/[\s,]+/).map(credentialFrom).filter((c): c is HiggsfieldCredentials => c !== null);
}

/**
 * The operator's word that an old key belonged to the same provider
 * organization as the current platform key (`HF_CREDENTIAL_ALIASES`: old
 * fingerprints, or their first 12 or more characters as the platform desk
 * shows them). The provider scopes requests to the organization, not to the
 * key, so the current key may collect what the old one sent.
 */
function sameOrganization(fingerprint: string, env: Env): boolean {
  return (env.HF_CREDENTIAL_ALIASES ?? "").split(/[\s,]+/).map((s) => s.trim().toLowerCase())
    .some((prefix) => /^[a-f0-9]{12,64}$/.test(prefix) && fingerprint.startsWith(prefix));
}

/** How a collection found its key: the one sending now, the platform's, a previous platform key, or an alias to the current one. */
export type CollectionKey = HiggsfieldCredentials & { via: "current" | "platform" | "previous" | "alias" };

/**
 * The key a request was accepted under, found by the one-way fingerprint
 * pinned on its job when it was sent. Collection and settlement use exactly
 * that key: the key sending now, the platform's key, or a previous platform
 * key kept for collection; failing those, the current platform key when the
 * operator has said the old key was the same organization. None of these:
 * the key is gone, and the job waits (HiggsfieldKeyChangedError) — it is
 * never failed, refunded or sent again for it.
 */
export function higgsfieldCollectionCredentials(fingerprint: string | undefined, env: Env = process.env): CollectionKey {
  if (fingerprint && /^[a-f0-9]{64}$/.test(fingerprint)) {
    let current: HiggsfieldCredentials | null = null;
    try { current = higgsfieldCredentials(); } catch { /* No key is sending now; an older one may still collect. */ }
    if (current?.fingerprint === fingerprint) return { ...current, via: "current" };
    const platform = platformHiggsfieldCredentials(env);
    if (platform?.fingerprint === fingerprint) return { ...platform, via: "platform" };
    const previous = previousHiggsfieldCredentials(env).find((c) => c.fingerprint === fingerprint);
    if (previous) return { ...previous, via: "previous" };
    if (platform && sameOrganization(fingerprint, env)) return { ...platform, via: "alias" };
  }
  throw new HiggsfieldKeyChangedError();
}

/** What a take shows while the key it was sent on is gone (lib/higgsfieldKeyAlerts.ts). */
export { KEY_CHANGED } from "./sharedKeyTerms";
export function higgsfieldConfigured(): boolean {
  try {
    higgsfieldCredentials();
    return true;
  } catch {
    return false;
  }
}
export const higgsfieldCredentialFingerprint = () =>
  higgsfieldCredentials().fingerprint;
/**
 * Custom-reference headers for the host that accepted the reference. The
 * production API takes the documented `Authorization: Key` header; the earlier
 * host keeps the paired headers it accepted.
 */
export function higgsfieldHeaders(
  origin: SoulReferenceOrigin = SOUL_REFERENCE_ORIGIN,
  correlationId?: string,
): Record<string, string> {
  const credentials = higgsfieldCredentials();
  if (origin !== "dev-v1") return higgsfieldKeyHeaders(credentials, { correlationId });
  /* The earlier host keeps its paired key headers, and takes our correlation id beside them. */
  return {
    "hf-api-key": credentials.keyId, "hf-secret": credentials.keySecret, "Content-Type": "application/json",
    ...(correlationHeaderOn() ? { [CORRELATION_HEADER]: correlationId ?? higgsfieldCorrelationId() } : {}),
  };
}
export class HiggsfieldHttpError extends Error {
  constructor(
    public readonly status: number,
    message = `The identity account returned HTTP ${status}.`,
    /** A bounded copy of the provider's own error body (a FastAPI `detail`), when it sent one. */
    public readonly body: string | null = null,
  ) {
    super(message);
    this.name = "HiggsfieldHttpError";
  }
}

/**
 * The key a request was sent on is gone: no configured key has its
 * fingerprint and no alias covers it. Nothing was asked of the provider. The
 * collectors keep the job waiting and alert the platform's admin
 * (lib/higgsfieldKeyAlerts.ts); it is not a failure or a refund.
 */
export class HiggsfieldKeyChangedError extends HiggsfieldHttpError {
  constructor() {
    super(401, "The identity account connection changed. Restore the original connection before collecting this request.");
    this.name = "HiggsfieldKeyChangedError";
  }
}

/* ── Correlation ids ────────────────────────────────────────────────
   The provider answers every request with an `X-Correlation-ID` header, and
   its support asks for that id together with the request_id. A submission's
   id is kept beside its request_id (in the job's handle and its platform
   receipt) and shown only on the platform owner's desk; never to a member.
   Our own id goes out as a custom request header beside the key (the client
   already sends custom headers), fixed per job and purpose, so a request
   whose answer was lost can still be traced. `HF_CORRELATION_HEADER=off`
   stops sending ours; the provider's own is kept either way. */
export const CORRELATION_HEADER = "X-Correlation-ID";
const CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;

/** A UUID-shaped id. With a subject (a job, a request) it is fixed for that subject and purpose, so it can be read again later without being stored. */
export function higgsfieldCorrelationId(subject?: string, purpose = "submit"): string {
  const hex = subject
    ? createHash("sha256").update(`particl-correlation:${purpose}:${subject}`).digest("hex")
    : randomUUID().replace(/-/g, "");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The provider's own correlation id on a response, when it sent a usable one. */
export function responseCorrelationId(response: Pick<Response, "headers">): string | null {
  const value = response.headers.get(CORRELATION_HEADER)?.trim() ?? "";
  return CORRELATION.test(value) ? value : null;
}

/** Whether our correlation id goes out with each request (on unless `HF_CORRELATION_HEADER=off`). */
export function correlationHeaderOn(env: Env = process.env): boolean {
  return (env.HF_CORRELATION_HEADER ?? "").trim().toLowerCase() !== "off";
}

/** Headers for one request on the commercial API: the key, JSON, and our correlation id. */
export function higgsfieldKeyHeaders(credentials: HiggsfieldCredentials, options: { correlationId?: string; json?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Key ${credentials.keyId}:${credentials.keySecret}` };
  if (options.json !== false) headers["Content-Type"] = "application/json";
  if (correlationHeaderOn()) headers[CORRELATION_HEADER] = options.correlationId ?? higgsfieldCorrelationId();
  return headers;
}

/** Up to `max` bytes of a response body as text; the rest is cancelled, never buffered. */
export async function boundedBody(response: Response, max = 8192): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)), Math.min(total, max));
  return bytes.toString("utf8").slice(0, max) || null;
}
export function higgsfieldSubmissionRejected(error: unknown): boolean {
  return (
    error instanceof HiggsfieldHttpError &&
    [400, 401, 402, 403, 404, 422, 423, 429].includes(error.status)
  );
}
/**
 * A status read the host refused outright: it no longer accepts this account,
 * or does not know the reference. The training outcome is then unknown; it is
 * never a failure, a refund, or a reason to send another training request.
 */
export function higgsfieldReferenceUnreachable(error: unknown): boolean {
  return (
    error instanceof HiggsfieldHttpError &&
    [401, 403, 404, 410].includes(error.status)
  );
}
function reference(value: unknown): SoulReference {
  if (!value || typeof value !== "object")
    throw new Error("The identity account returned an unreadable identity response.");
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !UUID.test(r.id))
    throw new Error(
      "The identity account returned an incomplete identity response. The paid request must not be repeated.",
    );
  // A valid UUID is durable proof of acceptance even if status is absent or
  // newer than this client. Keep it and poll; never turn it into another POST.
  return {
    id: r.id,
    status: SOUL_REFERENCE_STATUSES.includes(
      r.status as SoulReference["status"],
    )
      ? (r.status as SoulReference["status"])
      : "not_ready",
  };
}
/** New training is only ever sent to the current production host. */
export async function createSoulReference(
  name: string,
  imageUrls: string[],
  options: { modelVersion?: SoulModelVersion; correlationId?: string } = {},
): Promise<SoulReference> {
  const modelVersion = options.modelVersion ?? SOUL_MODEL_VERSION;
  if (!SOUL_MODEL_VERSIONS.includes(modelVersion))
    throw new Error("Choose a supported identity version.");
  if (
    !name.trim() ||
    name.length > 100 ||
    imageUrls.length < 1 ||
    imageUrls.length > 40
  )
    throw new Error(
      "An identity needs a name and between 1 and 40 still references.",
    );
  if (
    imageUrls.some((url) => {
      try {
        return new URL(url).protocol !== "https:";
      } catch {
        return true;
      }
    })
  )
    throw new Error("An identity requires signed HTTPS image references.");
  if (process.env.ENGINE_MOCK === "1")
    return { id: randomUUID(), status: "queued" };
  // No retries: even a timeout can mean the provider accepted and billed the request.
  const response = await recoveryFetch(SOUL_REFERENCE_ORIGINS[SOUL_REFERENCE_ORIGIN], {
    method: "POST",
    headers: higgsfieldHeaders(SOUL_REFERENCE_ORIGIN, options.correlationId),
    body: JSON.stringify({
      name,
      model_version: modelVersion,
      input_images: imageUrls.map((image_url) => ({
        type: "image_url",
        image_url,
      })),
    }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HiggsfieldHttpError(response.status);
  }
  return reference(await response.json());
}
/** Read-only: asks the host that accepted this reference, never another one. */
export async function getSoulReference(
  id: string,
  origin: SoulReferenceOrigin,
): Promise<SoulReference> {
  if (!UUID.test(id)) throw new Error("Invalid stored identity handle.");
  const base = SOUL_REFERENCE_ORIGINS[soulReferenceOrigin(origin)];
  if (process.env.ENGINE_MOCK === "1") return { id, status: "completed" };
  const response = await recoveryFetch(`${base}/${id}`, {
    headers: higgsfieldHeaders(origin, higgsfieldCorrelationId(id, "reference")),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HiggsfieldHttpError(response.status);
  }
  const result = reference(await response.json());
  if (result.id !== id)
    throw new Error("The identity account returned a different identity handle.");
  return result;
}
export async function deleteSoulReference(
  id: string,
  origin: SoulReferenceOrigin,
): Promise<void> {
  if (!UUID.test(id)) throw new Error("Invalid stored identity handle.");
  const base = SOUL_REFERENCE_ORIGINS[soulReferenceOrigin(origin)];
  if (process.env.ENGINE_MOCK === "1") return;
  const response = await recoveryFetch(`${base}/${id}`, {
    method: "DELETE",
    headers: higgsfieldHeaders(origin, higgsfieldCorrelationId(id, "reference")),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel().catch(() => {});
  if (response.status !== 204 && response.status !== 404)
    throw new HiggsfieldHttpError(response.status);
}
