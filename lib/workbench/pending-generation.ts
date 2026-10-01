/** The paid routes a claim may be sent to; each is asked about through POST /api/generate/check after a lost reply. */
export const PENDING_ENDPOINTS = ["/api/generate", "/api/audio", "/api/audio/dub", "/api/audio/transcribe"] as const;
export type PendingGeneration = {
  key: string; body: string; credits: number; endpoint?: (typeof PENDING_ENDPOINTS)[number];
  /** When the claim was written (ms), where a surface stamps it: a window without Web Locks leaves a fresh claim to the window sending it (lib/workbench/transcription-request.ts). */
  claimedAt?: number;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export function pendingGenerationKey(
  scope: string,
  projectId: string,
  nodeId: string,
) {
  return `particl:pending-generation:${JSON.stringify([scope, projectId, nodeId])}`;
}

/** Corrupt or unavailable recovery storage must never silently create a new paid attempt. */
export function readPendingGeneration(
  storage: Storage,
  key: string,
): PendingGeneration | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const request = JSON.parse(raw) as PendingGeneration;
  if (
    !request ||
    typeof request.key !== "string" ||
    typeof request.body !== "string" ||
    !Number.isFinite(request.credits) ||
    (request.endpoint != null && !(PENDING_ENDPOINTS as readonly string[]).includes(request.endpoint))
  ) {
    throw new Error(
      "The saved generation request cannot be read. Check Activity before starting another take.",
    );
  }
  JSON.parse(request.body);
  return request;
}

/** Persist before sending; once pending, retries always reuse the original exact request. */
export function claimPendingGeneration(
  storage: Storage,
  key: string,
  request: PendingGeneration,
) {
  const pending = readPendingGeneration(storage, key);
  if (pending) return pending;
  storage.setItem(key, JSON.stringify(request));
  if (storage.getItem(key) !== JSON.stringify(request))
    throw new Error("Enable local storage to safely recover this generation.");
  return request;
}

export function clearPendingGeneration(
  storage: Storage,
  key: string,
  requestKey: string,
) {
  if (readPendingGeneration(storage, key)?.key === requestKey)
    storage.removeItem(key);
}
