import { createHash, randomUUID } from "node:crypto";
import { vendorKey } from "./vendorKeys";
import { recoveryFetch } from "./recovery";

const BASE = "https://dev-api.higgsfield.com/v1/custom-references";
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
/** Custom-reference API headers. Generation uses its separate Authorization contract. */
export function higgsfieldHeaders(): Record<string, string> {
  const { keyId, keySecret } = higgsfieldCredentials();
  return {
    "hf-api-key": keyId,
    "hf-secret": keySecret,
    "Content-Type": "application/json",
  };
}
export class HiggsfieldHttpError extends Error {
  constructor(
    public readonly status: number,
    message = `The identity account returned HTTP ${status}.`,
  ) {
    super(message);
    this.name = "HiggsfieldHttpError";
  }
}
export function higgsfieldSubmissionRejected(error: unknown): boolean {
  return (
    error instanceof HiggsfieldHttpError &&
    [400, 401, 402, 403, 404, 422, 423, 429].includes(error.status)
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
export async function createSoulReference(
  name: string,
  imageUrls: string[],
): Promise<SoulReference> {
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
  const response = await recoveryFetch(BASE, {
    method: "POST",
    headers: higgsfieldHeaders(),
    body: JSON.stringify({
      name,
      input_images: imageUrls.map((image_url) => ({
        type: "image_url",
        image_url,
      })),
    }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new HiggsfieldHttpError(response.status);
  return reference(await response.json());
}
export async function getSoulReference(id: string): Promise<SoulReference> {
  if (!UUID.test(id)) throw new Error("Invalid stored identity handle.");
  if (process.env.ENGINE_MOCK === "1") return { id, status: "completed" };
  const response = await recoveryFetch(`${BASE}/${id}`, {
    headers: higgsfieldHeaders(),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new HiggsfieldHttpError(response.status);
  const result = reference(await response.json());
  if (result.id !== id)
    throw new Error("The identity account returned a different identity handle.");
  return result;
}
export async function deleteSoulReference(id: string): Promise<void> {
  if (!UUID.test(id)) throw new Error("Invalid stored identity handle.");
  if (process.env.ENGINE_MOCK === "1") return;
  const response = await recoveryFetch(`${BASE}/${id}`, {
    method: "DELETE",
    headers: higgsfieldHeaders(),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 204 && response.status !== 404)
    throw new HiggsfieldHttpError(response.status);
}
