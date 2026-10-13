import { after } from "next/server";
import { reserveRecoveryContinuation } from "../recovery";
import { currentTenant, runWithStore } from "../tenant";
import { enqueueExport } from "./dispatch";
import { runExport } from "./jobs";

/**
 * After the response: hand the export to the app's own worker route, or run it here when there is no queue. The
 * work is held by a recovery continuation, so a checkpoint accounts for it. Free to customers: no credits move.
 */
export async function scheduleExport(jobId: string, deps: { enqueue?: typeof enqueueExport; run?: typeof runExport; afterResponse?: typeof after } = {}) {
  const store = currentTenant();
  if (!store) throw new Error("No workspace for this export.");
  const hold = await reserveRecoveryContinuation("after-response", () =>
    runWithStore(store, async () => {
      if (!(await (deps.enqueue ?? enqueueExport)(jobId))) await (deps.run ?? runExport)(jobId);
    }),
  );
  (deps.afterResponse ?? after)(hold);
}
