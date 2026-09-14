import { withRecoveryJob } from "./recovery";
import { inngest, EVENTS } from "./inngest";
import { ready } from "./db";
import { runWorkerProbe } from "./workerProbe";
import { loadJob, produce, seal, failJob } from "./renderWork";
import { runInTenant } from "./tenant";
import { getWorkspace, legacyWorkspace } from "./platform";

/** The workspace an event belongs to; the studio's original one for events that predate workspaces. */
async function workspaceOf(data: { workspaceId?: string }) {
  const ws = data.workspaceId
    ? await getWorkspace(String(data.workspaceId))
    : await legacyWorkspace();
  if (!ws || ws.deletedAt)
    throw new Error("No active workspace for this event.");
  return ws;
}

/** A scoped deployment probe proves DB/storage access without spending on a model. */
export const probe = inngest.createFunction(
  {
    id: "worker-probe",
    name: "Worker probe",
    triggers: [{ event: EVENTS.probe }],
  },
  async ({ event, step }) =>
    step.run("verify-scoped-database-and-storage", () =>
      runWorkerProbe({
        workspaceId: String(event.data.workspaceId ?? ""),
        probeId: String(event.data.probeId ?? ""),
        ...(event.data.expectedDeployment
          ? { expectedDeployment: String(event.data.expectedDeployment) }
          : {}),
        ...(event.data.expectedEnvironment
          ? { expectedEnvironment: String(event.data.expectedEnvironment) }
          : {}),
      }),
    ),
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
    // Cap total provider work; one busy workspace can occupy at most half
    // the shared workers. Workspace plan admission remains enforced at reservation.
    concurrency: [{ limit: 4 }, { limit: 2, key: "event.data.workspaceId" }],
    retries: 3,
    /* Inngest owns the row while it is working on it, so Inngest is what
       ends it. Without this the render would sit at "running" until the
       cron's long backstop noticed, hours later. */
    onFailure: async ({ event, error }) => {
      const data = (event.data.event?.data ?? {}) as {
        genId?: string;
        workspaceId?: string;
      };
      const genId = String(data.genId ?? "");
      if (genId)
        await withRecoveryJob(String(data.workspaceId ?? ""), genId, async () => runInTenant(await workspaceOf(data), () =>
          failJob(genId, error.message),
        ));
    },
  },
  async ({ event, step }) => {
    const genId = String(event.data.genId);
    const workspaceId = String(event.data.workspaceId ?? "");
    const ws = await withRecoveryJob(workspaceId, genId, () => workspaceOf(event.data as { workspaceId?: string }));

    const produced = await step.run("produce", async () =>
      withRecoveryJob(workspaceId, genId, () => runInTenant(ws, async () => {
        await workspaceOf(event.data as { workspaceId?: string });
        await ready();
        const job = await loadJob(genId);
        // Already finished, or gone. Nothing to do, and nothing to pay for.
        if (!job) return null;
        const out = await produce(job);
        return out ? { job, out } : null;
      })),
    );

    if (!produced) return { genId, skipped: true };

    await step.run("record", async () =>
      withRecoveryJob(workspaceId, genId, () => runInTenant(ws, async () => {
        await workspaceOf(event.data as { workspaceId?: string });
        await ready();
        await seal(produced.job, produced.out);
        return { sealed: true };
      })),
    );

    return { genId, ok: true };
  },
);

/** Everything the route serves. Workers are added here as they are written. */
export const functions = [probe, render];
