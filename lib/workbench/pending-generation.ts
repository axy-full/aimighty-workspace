export type PendingGeneration = { key: string; body: string; credits: number };
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
    !Number.isFinite(request.credits)
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
