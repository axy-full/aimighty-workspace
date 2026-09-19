import { inngest, EVENTS } from "./inngest";
import { withRecoveryJob } from "./recovery";
import {
  handleAstraRender,
  handleDubbing,
  handleProbe,
  renderFailed,
  renderProduce,
  renderSeal,
  renderSubmitVideo,
  workspaceOf,
  type RenderEventData,
} from "./worker-handlers";

/**
 * The Inngest functions, for deployments that opt into DISPATCH_MODE=inngest.
 *
 * Their bodies live in lib/worker-handlers.ts and are shared with the native
 * /api/worker route; what this file adds is Inngest's step memoisation,
 * retries and concurrency around those bodies. Ids, triggers, concurrency
 * and retry counts are the registration contract and stay as they were.
 */

/** A scoped deployment probe proves DB/storage access without spending on a model. */
export const probe = inngest.createFunction(
  {
    id: "worker-probe",
    name: "Worker probe",
    triggers: [{ event: EVENTS.probe }],
  },
  async ({ event, step }) =>
    step.run("verify-scoped-database-and-storage", () =>
      handleProbe({
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
 * ElevenLabs a second time. (produce also stores its outcome on the row,
 * which is what the native route and the cron rely on instead.)
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
      const data = (event.data.event?.data ?? {}) as Partial<RenderEventData>;
      await renderFailed(
        {
          genId: String(data.genId ?? ""),
          kind: data.kind === "video" ? "video" : data.kind === "audio" ? "audio" : "image",
          workspaceId: String(data.workspaceId ?? ""),
        },
        error.message,
      );
    },
  },
  async ({ event, step }) => {
    const data: RenderEventData = {
      genId: String(event.data.genId),
      kind: event.data.kind === "video" ? "video" : event.data.kind === "audio" ? "audio" : "image",
      workspaceId: String(event.data.workspaceId ?? ""),
    };
    const ws = await withRecoveryJob(data.workspaceId, data.genId, () => workspaceOf(data));

    if (data.kind === "video")
      return step.run("submit-video", () => renderSubmitVideo(data, ws));

    const produced = await step.run("produce", () => renderProduce(data, ws));
    if (!produced) return { genId: data.genId, skipped: true };

    await step.run("record", () => renderSeal(data, ws, produced));
    return { genId: data.genId, ok: true };
  },
);

export const astraRender = inngest.createFunction(
  {
    id: "astra-blender-render",
    name: "Render Astra Blender",
    triggers: [{ event: EVENTS.astraRender }],
    concurrency: [{ limit: 4 }, { limit: 2, key: "event.data.workspaceId" }],
    retries: 2,
  },
  async ({ event, step }) =>
    step.run("render-persist-and-account", () =>
      handleAstraRender({
        jobId: String(event.data.jobId),
        workspaceId: String(event.data.workspaceId),
      }),
    ),
);

export const dubbing = inngest.createFunction(
  {
    id: "audio-dubbing",
    name: "Advance dubbing project",
    triggers: [{ event: EVENTS.dubbing }],
    concurrency: [{ limit: 4 }, { limit: 2, key: "event.data.workspaceId" }],
    retries: 2,
  },
  async ({ event, step }) =>
    step.run("submit-poll-or-collect", () =>
      handleDubbing({
        jobId: String(event.data.jobId),
        workspaceId: String(event.data.workspaceId),
      }),
    ),
);

/** Everything the route serves. Workers are added here as they are written. */
export const functions = [probe, render, astraRender, dubbing];
