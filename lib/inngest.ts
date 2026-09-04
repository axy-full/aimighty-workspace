import { Inngest } from "inngest";

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
