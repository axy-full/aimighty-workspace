import { inngest, EVENTS } from "./inngest";
import { db, ready } from "./db";
import { usingBlob } from "./storage";

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

/** Everything the route serves. Workers are added here as they are written. */
export const functions = [probe];
