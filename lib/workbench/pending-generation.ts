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
  /* This tab's own copy: another tab may settle the claim and remove it, and this tab must still ask before it sends again. */
  try { tabStorage(storage).setItem(OWN_PREFIX + key, JSON.stringify(request)); } catch { /* the shared claim still guards this tab until another settles it */ }
  return request;
}

/** Let the claim go: the tab that learns what became of a request lets go of its own copy too (another tab's copy stays with it). */
export function clearPendingGeneration(
  storage: Storage,
  key: string,
  requestKey: string,
) {
  forgetOwnClaim(storage, key, requestKey);
  if (readPendingGeneration(storage, key)?.key === requestKey)
    storage.removeItem(key);
}

/*
 * ── A claim another tab settled ──────────────────────────────────────────
 * The claim in `storage` is shared by every tab of this browser, and the tab that settles it removes it. A tab whose own
 * reply was lost would then find nothing to ask about and quote anew: two paid requests for one press. So each tab keeps its
 * own copy of every claim it made (sessionStorage: this tab only, kept across a reload), and the tab that settles a claim
 * leaves a short-lived note of what it became, by its key. A tab finding its own copy with no shared claim reads the note,
 * else asks the server by that key (POST /api/generate/check), before anything else is sent.
 */
const OWN_PREFIX = "particl:own-claim:v1:";
const SETTLED_KEY = "particl:settled-generations:v1";
/**
 * How long a settled note is kept: one sitting with two tabs open. Nothing depends on it for money: without the note (expired,
 * evicted, a lost write between two tabs) the tab's own copy is asked about on the server, whose claims are never deleted and
 * whose fenced keys stay fenced, so the answer is the same. The note saves that question and answers it when the server cannot.
 */
export const SETTLED_MS = 60 * 60_000;

export type SettledGeneration =
  | { state: "landed"; jobId: string; status: string; credits: number; model: string | null }
  | { state: "lost"; reason: string };

const tabShims = new WeakMap<object, Storage>();
function mapStorage(): Storage {
  const items = new Map<string, string>();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) };
}
/** This tab's own store beside a shared one: sessionStorage beside the browser's localStorage, else one kept in memory for this page. */
export function tabStorage(shared: Storage): Storage {
  if (typeof window !== "undefined") {
    try { if (shared === window.localStorage) return window.sessionStorage; } catch { /* storage off: kept in memory below */ }
  }
  let own = tabShims.get(shared);
  if (!own) { own = mapStorage(); tabShims.set(shared, own); }
  return own;
}

/** This tab's own copy of the claim it made at `key`, if it has not learned what became of it. */
export function readOwnClaim(storage: Storage, key: string): PendingGeneration | null {
  try {
    const own = tabStorage(storage);
    const raw = own.getItem(OWN_PREFIX + key);
    if (!raw) return null;
    const request = JSON.parse(raw) as PendingGeneration;
    if (request && typeof request.key === "string" && typeof request.body === "string" && Number.isFinite(request.credits) &&
        (request.endpoint == null || (PENDING_ENDPOINTS as readonly string[]).includes(request.endpoint))) return request;
    own.removeItem(OWN_PREFIX + key);
  } catch { /* unreadable: the shared claim, if any, still guards */ }
  return null;
}

export function forgetOwnClaim(storage: Storage, key: string, requestKey: string) {
  try {
    const own = tabStorage(storage);
    const raw = own.getItem(OWN_PREFIX + key);
    if (raw && (JSON.parse(raw) as { key?: unknown } | null)?.key === requestKey) own.removeItem(OWN_PREFIX + key);
  } catch { /* nothing to let go */ }
}

function readSettledMap(storage: Storage): Record<string, SettledGeneration & { at: number }> {
  try {
    const value = JSON.parse(storage.getItem(SETTLED_KEY) ?? "null") as Record<string, SettledGeneration & { at: number }> | null;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** Note what a settled request became, by its key, for a tab whose own copy names it; expired notes are dropped on the way. */
export function recordSettledGeneration(storage: Storage, requestKey: string, outcome: SettledGeneration) {
  try {
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(readSettledMap(storage)).filter(([, v]) => typeof v?.at === "number" && now - v.at <= SETTLED_MS && now >= v.at));
    storage.setItem(SETTLED_KEY, JSON.stringify({ ...kept, [requestKey]: { ...outcome, at: now } }));
  } catch { /* the tab that needs it asks the server instead */ }
}

/** What another tab learned about this key, while its note is fresh. */
export function readSettledGeneration(storage: Storage, requestKey: string): SettledGeneration | null {
  const v = readSettledMap(storage)[requestKey];
  if (!v || typeof v.at !== "number" || Date.now() - v.at > SETTLED_MS || Date.now() < v.at) return null;
  if (v.state === "landed" && typeof v.jobId === "string" && v.jobId && typeof v.status === "string" && Number.isFinite(v.credits))
    return { state: "landed", jobId: v.jobId, status: v.status, credits: v.credits, model: typeof v.model === "string" ? v.model : null };
  if (v.state === "lost" && typeof v.reason === "string") return { state: "lost", reason: v.reason };
  return null;
}
