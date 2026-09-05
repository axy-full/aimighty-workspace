import { Inngest } from "inngest";
import { db, now } from "./db";
import { requireTenant } from "./tenant";

/**
 * The durable worker.
 *
 * Stills and audio are synchronous at their vendors: the bytes come back
 * inside the response, so there is no task id to come back to the way there
 * is with ModelArk or fal. Until now that work ran in Next's `after()`,
 * which has no redelivery — if the instance was reclaimed the render was
 * simply gone, and the cron could do nothing but mark it failed.
 *
 * Inngest holds the intent instead. The route writes the row, sends an
 * event and returns; the function runs outside the request, is retried on
 * its own schedule, and survives a deploy landing mid-render.
 *
 * The reason it is Inngest rather than a plain retry queue: `step.run`
 * MEMOISES a completed step. Split the work so that calling the vendor and
 * writing the bytes to storage are one step and recording the row is
 * another, and a failure in the second replays the first from cache instead
 * of paying the vendor twice. That is the whole argument — for a
 * synchronous vendor, an ordinary queue would re-charge on every retry.
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
  return Boolean(process.env.INNGEST_SIGNING_KEY && process.env.INNGEST_EVENT_KEY);
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
 * The row is stamped on success so the cron's janitor knows the render
 * belongs to the worker and stops counting the fifteen minutes after which
 * an unowned row is presumed dead.
 */
export async function enqueueRender(genId: string, kind: "image" | "audio"): Promise<boolean> {
  if (!inngestConfigured()) return false;
  try {
    /* A deadline, like every other outbound call in this app. The send sits
       on the path of a request a person is waiting on, so if Inngest is slow
       to accept the event we stop waiting and render inline instead. Losing
       durability for one render is a far smaller cost than holding the
       submit open until the function's own ceiling. */
    await Promise.race([
      inngest.send({ name: EVENTS.render, data: { genId, kind, workspaceId: requireTenant().id } }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Inngest did not accept the event within 5s")), 5_000)
      ),
    ]);
    await db().execute({
      sql: `UPDATE generations SET params=json_set(params, '$.worker', 'inngest'), updated_at=? WHERE id=?`,
      args: [now(), genId],
    });
    return true;
  } catch (e) {
    console.error(`could not queue ${genId}, running it inline instead:`, (e as Error).message);
    return false;
  }
}
