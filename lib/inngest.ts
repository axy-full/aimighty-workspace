import { Inngest } from "inngest";
import { dispatchRender, recoverRenderDispatches } from "./renderDispatch";

/**
 * Stills and audio return bytes synchronously. Dispatch intent and terminal
 * settlement are persisted independently of Inngest; a permanent paid claim
 * prevents duplicate vendor submission even after an ambiguous event send.
 * Completed produce steps can replay their small stored outcome. If a process
 * dies inside a paid call, its uncertain attempt is never purchased again.
 */
export const inngest = new Inngest({ id: "particl" });

/** Every event this app sends, named in one place so senders can't drift. */
export const EVENTS = {
  /** Wiring check, triggered by hand from the dashboard. */
  probe: "worker/probe",
  /** A still or a piece of audio whose row already exists as "running". */
  render: "render/requested",
} as const;

/**
 * Whether this deployment can actually reach Inngest.
 *
 * Both keys are set by the Inngest integration on Vercel, never by hand.
 * Locally neither exists and the dev server stands in for them, so this is
 * only ever consulted in production — where a missing key must read as
 * "not connected yet" rather than as an opaque 500 on a route nobody
 * recognises.
 */
export function inngestConfigured(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return Boolean(
    process.env.INNGEST_SIGNING_KEY && process.env.INNGEST_EVENT_KEY,
  );
}

/**
 * Hand a render to the worker, and say whether it was taken.
 *
 * A false answer is not a failure — it means this deployment has no queue
 * reachable right now (no keys, or the send itself failed), and the caller
 * should do the work inline the way it always did. That fallback is what
 * makes the queue safe to adopt: the worst case is the behaviour we had
 * before it existed.
 *
 * Delivery intent is stored before sending. The cron can reconstruct an
 * interrupted dispatch from a reserved, unclaimed generation row.
 */
export async function enqueueRender(
  genId: string,
  kind: "image" | "audio" | "video",
): Promise<boolean> {
  if (!inngestConfigured()) return false;
  return dispatchRender(genId, kind, (event) => inngest.send(event));
}

export async function retryRenderDispatches(
  options: { limit?: number; deadlineAt?: number } = {},
) {
  if (!inngestConfigured()) return { attempted: 0, failed: 0, deferred: 0 };
  return recoverRenderDispatches((event) => inngest.send(event), options);
}
