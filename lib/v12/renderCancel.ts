/**
 * What a Cancel press said, in words that match what is billed (redesign P3, review of #633; docs/redesign/cancel-billing.md).
 *
 * Two cancels exist today, and they do not bill alike:
 *  - A take held for a slot or for credits is discarded (PATCH /api/jobs/:id {discard}): nothing was reserved or sent, so it
 *    is cancelled for good and nothing is billed.
 *  - A Higgsfield-API video waiting in its provider's queue is cancelled by asking the provider (POST /api/generations/:id/cancel).
 *    The route's answer `requested` means the provider took the request: it is not the end of the take, and the credits it
 *    holds come back only when the engine confirms (lib/genjutsuVideo.ts reconciles later). Until then the hold stays, so the
 *    words say "sent", never "cancelled", and a failed ask never says nothing was billed.
 * Pure.
 */
import { CANCELLED_FREE_TOAST, type CancelVia } from "./renderState";

/** What the press came to: the words, whether the take is cancelled for good, and whether the cancel is on its way. */
export type CancelOutcome = { text: string; cancelled: boolean; pending: boolean };

export const CANCEL_SENT = "Cancel sent · nothing billed once the engine confirms";
export const CANCEL_STARTED = "It had already started, so it could not be cancelled.";
export const CANCEL_FINISHED = "It had already finished, so it could not be cancelled.";
export const CANCEL_STOPPED = "It had already stopped. The take says what it cost.";
/** The ask did not get through, or its answer was lost: the hold may still stand, so nothing is said about billing. */
export const CANCEL_UNSURE = "The cancel could not be confirmed. Check the take before trying again: it says what it cost.";
/** A held take that could not be discarded is still held, with nothing reserved or sent. */
export const DISCARD_FAILED = "It could not be cancelled just now. Nothing was billed.";

/** The route's answer to POST /api/generations/:id/cancel (lib/genjutsuVideo.ts cancelGenjutsuVideo). */
export function providerQueueOutcome(status: unknown): CancelOutcome {
  switch (status) {
    case "requested": return { text: CANCEL_SENT, cancelled: false, pending: true };
    case "cancelled": return { text: CANCELLED_FREE_TOAST, cancelled: true, pending: false };
    case "running": return { text: CANCEL_STARTED, cancelled: false, pending: false };
    case "succeeded": return { text: CANCEL_FINISHED, cancelled: false, pending: false };
    case "failed": return { text: CANCEL_STOPPED, cancelled: false, pending: false };
    default: return { text: CANCEL_UNSURE, cancelled: false, pending: false };
  }
}

/** A press that came back with a refusal: the server's own words when it gave them; for a provider cancel nothing is claimed about billing. */
export function cancelFailure(via: CancelVia, message: string | null | undefined): CancelOutcome {
  const said = typeof message === "string" && message.trim() ? message.trim() : null;
  return { text: said ?? (via === "discard" ? DISCARD_FAILED : CANCEL_UNSURE), cancelled: false, pending: false };
}

export const discardedOutcome = (): CancelOutcome => ({ text: CANCELLED_FREE_TOAST, cancelled: true, pending: false });

/** Whether this viewer may cancel a take: its author, or an admin or the owner. The routes refuse everyone else, so the button is not drawn for them. */
export function mayCancelTake(viewer: { role: "owner" | "admin" | "member" | null; userId?: string | null }, createdBy: string | null | undefined): boolean {
  return viewer.role === "owner" || viewer.role === "admin" || (Boolean(viewer.userId) && viewer.userId === createdBy);
}
