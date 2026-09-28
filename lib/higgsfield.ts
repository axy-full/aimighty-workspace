import { createHash, randomUUID } from "node:crypto";
import { vendorKey } from "./vendorKeys";
import { recoveryFetch } from "./recovery";

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
/** The render family a reference is trained for. v1 keeps continuity with existing identity renders. */
export const SOUL_MODEL_VERSIONS = ["v1", "v2", "cinema"] as const;
export type SoulModelVersion = (typeof SOUL_MODEL_VERSIONS)[number];
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

export function higgsfieldCredentials(): {
  keyId: string;
  keySecret: string;
  fingerprint: string;
} {
  const value =
    process.env.ENGINE_MOCK === "1"
      ? "particl-mock:higgsfield"
      : vendorKey("higgsfield");
  const split = value?.indexOf(":") ?? -1;
  if (!value || split < 1 || split === value.length - 1 || /\s/.test(value))
    throw new Error(
      "Add an identity account API key ID and secret before using identities.",
    );
  return {
    keyId: value.slice(0, split),
    keySecret: value.slice(split + 1),
    fingerprint: createHash("sha256").update(value).digest("hex"),
  };
}
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
): Record<string, string> {
  const { keyId, keySecret } = higgsfieldCredentials();
  return origin === "dev-v1"
    ? { "hf-api-key": keyId, "hf-secret": keySecret, "Content-Type": "application/json" }
    : { Authorization: `Key ${keyId}:${keySecret}`, "Content-Type": "application/json" };
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
  options: { modelVersion?: SoulModelVersion } = {},
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
    headers: higgsfieldHeaders(SOUL_REFERENCE_ORIGIN),
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
    headers: higgsfieldHeaders(origin),
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
    headers: higgsfieldHeaders(origin),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel().catch(() => {});
  if (response.status !== 204 && response.status !== 404)
    throw new HiggsfieldHttpError(response.status);
}
