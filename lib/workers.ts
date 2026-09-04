import { inngest, EVENTS } from "./inngest";
import { db, ready } from "./db";
import { usingBlob } from "./storage";
import { loadJob, produce, seal, failJob } from "./renderWork";

/**
 * The functions the worker route serves.
 *
 * Nothing here does render work yet. This is the wiring, and the one thing
 * worth proving before trusting a queue with paid renders: that a function
 * running OUTSIDE a request can still reach the database and the store. A
 * worker that cannot read the row it was handed is exactly the failure you
 * do not want to discover halfway through the first migration.
 */

/**
 * Wiring check. Send `worker/probe`, or run it by hand from the Inngest
 * dashboard. Two steps on purpose: the second only runs if the first
 * succeeded, and on a retry the first replays from cache rather than
 * running again — the memoisation the whole design rests on.
 */
export const probe = inngest.createFunction(
  {
    id: "worker-probe",
    name: "Worker probe",
    triggers: [{ event: EVENTS.probe }],
  },
  async ({ step }) => {
    const database = await step.run("read-the-database", async () => {
      await ready();
      const rs = await db().execute(
        `SELECT COUNT(*) AS n FROM generations WHERE deleted = 0`
      );
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      return { renders: Number((rs.rows[0] as any)?.n ?? 0) };
    });

    const storage = await step.run("check-the-store", async () => ({
      blob: usingBlob(),
    }));

    return { ok: true, ...database, ...storage };
  }
);

/**
 * A still or a piece of audio, made durable.
 *
 * Two steps, and the split is the entire point. `produce` is the part that
 * costs money — it calls the vendor and writes the bytes to storage — and
 * Inngest MEMOISES a completed step, so if `record` fails and the run is
 * retried, produce replays from cache rather than paying Google or
 * ElevenLabs a second time. An ordinary retry queue cannot do that, and for
 * a synchronous vendor it is the difference between a retry costing nothing
 * and a retry costing the price of the render.
 *
 * Idempotency comes from the row itself: loadJob returns null for anything
 * already terminal, so an at-least-once delivery of an event whose render
 * has finished quietly does nothing.
 */
export const render = inngest.createFunction(
  {
    id: "render",
    name: "Render a still or audio",
    triggers: [{ event: EVENTS.render }],
    // Four at a time. These vendors bill per call and rate-limit per key, so
    // an unbounded fan-out would spend money faster than anyone could stop it.
    concurrency: [{ limit: 4 }],
    retries: 3,
    /* Inngest owns the row while it is working on it, so Inngest is what
       ends it. Without this the render would sit at "running" until the
       cron's long backstop noticed, hours later. */
    onFailure: async ({ event, error }) => {
      const genId = String(event.data.event?.data?.genId ?? "");
      if (genId) await failJob(genId, error.message);
    },
  },
  async ({ event, step }) => {
    const genId = String(event.data.genId);

    const produced = await step.run("produce", async () => {
      const job = await loadJob(genId);
      // Already finished, or gone. Nothing to do, and nothing to pay for.
      if (!job) return null;
      return { job, out: await produce(job) };
    });

    if (!produced) return { genId, skipped: true };

    await step.run("record", async () => {
      await seal(produced.job, produced.out);
      return { sealed: true };
    });

    return { genId, ok: true };
  }
);

/** Everything the route serves. Workers are added here as they are written. */
export const functions = [probe, render];
