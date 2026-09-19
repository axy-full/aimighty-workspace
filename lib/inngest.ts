import { Inngest } from "inngest";
import { dispatchRender, recoverRenderDispatches } from "./renderDispatch";
import { dispatchEventDetailed, dispatchMode, type WorkerEvent } from "./dispatch";
import { recordDispatch } from "./dispatch-log";

export { EVENTS } from "./dispatch";

/**
 * Stills and audio return bytes synchronously. Dispatch intent and terminal
 * settlement are persisted independently of the dispatcher; a permanent paid
 * claim prevents duplicate vendor submission even after an ambiguous event
 * send. A completed produce step stores its small outcome on the row, so a
 * later seal never pays again. If a process dies inside a paid call, its
 * uncertain attempt is never purchased again.
 *
 * Inngest is one of three dispatch modes now (see lib/dispatch.ts); this
 * client is only ever used when the deployment asks for it explicitly.
 */
export const inngest = new Inngest({ id: "particl" });

/**
 * Whether Inngest is the dispatcher on this deployment.
 *
 * True only in "inngest" mode: DISPATCH_MODE=inngest with both keys set. In
 * every other case the /api/inngest route answers "not connected" and the
 * app dispatches natively (production) or inline (development, mocks).
 */
export function inngestConfigured(): boolean {
  return dispatchMode() === "inngest";
}

/**
 * The send function for the current mode, or null when there is no queue
 * and the caller should run the work inline.
 *
 * In native mode a refused hand-off (no 202) is surfaced as a throw so every
 * caller's existing "send failed → false → inline fallback" path applies
 * unchanged; dispatchEvent itself never throws. Every native hand-off, taken
 * or not, is also written to the platform's dispatch_log (best-effort) so
 * the outcome is readable from /api/health afterwards.
 */
export function queueSender(): ((event: WorkerEvent) => Promise<unknown>) | null {
  const mode = dispatchMode();
  if (mode === "inngest") return (event) => inngest.send(event);
  if (mode === "native")
    return async (event) => {
      const result = await dispatchEventDetailed(event);
      await recordDispatch({
        eventId: event.id,
        name: event.name,
        phase: "send",
        outcome: result.outcome,
        status: result.status,
        durationMs: result.durationMs,
        workspaceId: event.data.workspaceId,
      });
      if (result.outcome !== "sent")
        throw new Error("The native worker did not accept the event.");
    };
  return null;
}

/**
 * Hand a render to the worker, and say whether it was taken.
 *
 * A false answer is not a failure — it means this deployment has no queue
 * reachable right now (inline mode, or the send itself failed), and the
 * caller should do the work inline the way it always did. That fallback is
 * what makes the queue safe to adopt: the worst case is the behaviour we had
 * before it existed.
 *
 * Delivery intent is stored before sending. The cron can reconstruct an
 * interrupted dispatch from a reserved, unclaimed generation row.
 */
export async function enqueueRender(
  genId: string,
  kind: "image" | "audio" | "video",
): Promise<boolean> {
  const send = queueSender();
  if (!send) return false;
  return dispatchRender(genId, kind, send);
}

export async function retryRenderDispatches(
  options: { limit?: number; deadlineAt?: number } = {},
) {
  const send = queueSender();
  if (!send) return { attempted: 0, failed: 0, deferred: 0 };
  return recoverRenderDispatches(send, options);
}
