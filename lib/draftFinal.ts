/**
 * Seedance 2.5 draft mode (owner, 27 September 2026): a 480p DRAFT first,
 * then a 1080p FINAL made from that draft.
 *
 *  - A draft is an ordinary take at 480p, priced and approved like any take,
 *    and it carries the engine's watermark. The final never does.
 *  - The final is a SECOND render from the draft's task, not an upscale:
 *    framing and motion hold, fine detail (texture, patterns, small text,
 *    crowds) can come out slightly different.
 *  - One final per draft. A final that failed without a charge frees the
 *    draft for another; anything else (in flight, held, rendered, or an
 *    outcome still being reconciled) keeps it.
 *
 * The vendor's rules, from ModelArk's "Draft mode" guide (read 27 September
 * 2026, docs.byteplus.com/en/docs/ModelArk/2607688 and the API reference
 * /1520757): a draft is a normal task with `draft: true`, 480p only; the
 * final is a task whose only content item is the draft's task id, at 1080p
 * only; the prompt, references, length, ratio, seed, audio and task type are
 * the draft's and must not be sent again; a draft's task id works for seven
 * days from its `created_at`. lib/ark.ts builds both requests.
 *
 * Pure and browser-safe: the admission, the jobs reader and Gen's draft card
 * all read the same rules from here.
 */

export const DRAFT_RESOLUTION = "480p";
export const FINAL_RESOLUTION = "1080p";
/** How long a draft's task id can make its final: seven days from when the vendor took it. */
export const DRAFT_VALID_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Read short of the vendor's own cutoff. The draft's clock starts when the
 * vendor created its task, a moment after our request left; this margin
 * covers that, clock drift between the two, and a final sent at the edge.
 */
export const DRAFT_EXPIRY_MARGIN_MS = 10 * 60 * 1000;

/** When the draft's request left for the vendor: the row's birth plus its queue time, when known. */
export function draftSentAt(createdAt: number, queueMs?: unknown): number {
  const queued = typeof queueMs === "number" && Number.isFinite(queueMs) && queueMs > 0 ? queueMs : 0;
  return createdAt + queued;
}

/** The last moment a final can be asked of this draft. */
export function draftExpiresAt(sentAt: number): number {
  return sentAt + DRAFT_VALID_MS - DRAFT_EXPIRY_MARGIN_MS;
}

export const draftExpired = (expiresAt: number, now = Date.now()) => !(now < expiresAt);

/** A take's params, as a row or the browser holds them. */
type Params = Record<string, unknown> | null | undefined;

export const isDraft = (params: Params): boolean => params?.draft === true;
/** The draft a final was made from, or null. */
export function finalOf(params: Params): string | null {
  const id = params?.finalOf;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null;
}
/** When the draft's final stops being available (derived by lib/jobs.ts for the browser). */
export function draftExpiry(params: Params): number | null {
  const at = params?.draftExpiresAt;
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * Whether a final that already exists still holds its draft. Only a final
 * that ended without rendering AND without a charge lets the draft go again
 * according to the stored outcome. An outcome still being reconciled keeps its
 * charge, so it keeps the draft too: its task may exist at the vendor.
 */
export function finalHoldsDraft(final: { status: string; charged: boolean } | null): boolean {
  if (!final) return false;
  return !((final.status === "failed" || final.status === "cancelled") && !final.charged);
}

/** "Oct 4, 2:31 PM": when a draft's final stops being available, said the way the Inspector says times. */
export function draftDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * What a draft offers, in one word: `rendering` (the draft itself is not
 * back), `failed` (it did not render; there is nothing to finalise),
 * `expired`, `ready` (a final can be made; `retry` names a final that
 * failed uncharged), `finalising` (its final is on its way or held) or
 * `final` (its final rendered).
 */
export type DraftState =
  | { state: "rendering" }
  | { state: "failed" }
  | { state: "expired"; expiresAt: number }
  | { state: "ready"; expiresAt: number; retry: string | null }
  | { state: "finalising"; finalId: string }
  | { state: "finalFailed"; finalId: string }
  | { state: "final"; finalId: string };

export function draftState(
  draft: { status: string; params: Params; createdAt: number },
  finals: readonly { id: string; status: string; charged: boolean; createdAt: number }[],
  now = Date.now(),
): DraftState {
  if (draft.status === "failed" || draft.status === "cancelled") return { state: "failed" };
  const claimedId = typeof draft.params?.finalGenId === "string" ? draft.params.finalGenId : null;
  const latest = finals.find((f) => f.id === claimedId) ?? [...finals].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  // A library page may not contain the claimed final yet. Follow it before offering another.
  if (claimedId && !finals.some((f) => f.id === claimedId)) return { state: "finalising", finalId: claimedId };
  if (latest?.status === "succeeded") return { state: "final", finalId: latest.id };
  if (latest && finalHoldsDraft(latest)) return {
    state: latest.status === "failed" || latest.status === "cancelled" ? "finalFailed" : "finalising",
    finalId: latest.id,
  };
  if (draft.status !== "succeeded") return { state: "rendering" };
  /* The server sends the expiry; without it, the row's own birth is the earliest the clock can have started. */
  const expiresAt = draftExpiry(draft.params) ?? draftExpiresAt(draftSentAt(draft.createdAt));
  if (draftExpired(expiresAt, now)) return { state: "expired", expiresAt };
  return { state: "ready", expiresAt, retry: latest ? latest.id : null };
}
