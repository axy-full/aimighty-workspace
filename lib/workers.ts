import { inngest, EVENTS } from "./inngest";
import { ASTRA_RENDER_CONCURRENCY } from "./astra-blender/backend";
import { RIG_AGENT_STOPPED, RIG_RENDER_SETTLED } from "./dispatch";
import { withRecoveryJob } from "./recovery";
import { continueRigAgent, rigAgentTick, type RigAgentEventData } from "./workbench/rig-agent";
import {
  handleAstraRender,
  handleDubbing,
  handleProbe,
  renderFailed,
  renderProduce,
  renderSeal,
  renderSubmitVideo,
  workspaceOf,
  type AstraEventData,
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

/** A busy job is tried again after this wait, up to this many times (past its 30-minute start expiry). */
export const ASTRA_BUSY_WAIT = "30s";
export const ASTRA_BUSY_ROUNDS = 64;

type AstraSteps = {
  run: (id: string, work: () => Promise<{ jobId: string; busy?: true }>) => Promise<{ jobId: string; busy?: boolean }>;
  sleep: (id: string, duration: string) => Promise<unknown>;
};

/**
 * One render, waiting while every render worker is busy. A busy answer means
 * the job is back in the queue with nothing started and nothing billed; a
 * sleeping run holds no concurrency, and each new attempt is its own
 * memoised step, so a finished attempt is never repeated.
 */
export async function astraRenderWithWorkerWaits(data: AstraEventData, step: AstraSteps, handle: typeof handleAstraRender = handleAstraRender) {
  let result = await step.run("render-persist-and-account", () => handle(data));
  for (let round = 1; result.busy && round <= ASTRA_BUSY_ROUNDS; round++) {
    await step.sleep(`wait-for-a-render-worker-${round}`, ASTRA_BUSY_WAIT);
    result = await step.run(`render-persist-and-account-${round}`, () => handle(data));
  }
  return result;
}

export const astraRender = inngest.createFunction(
  {
    id: "astra-blender-render",
    name: "Render Astra 3D",
    triggers: [{ event: EVENTS.astraRender }],
    // Three renders at once, platform-wide, on either backend (the self-hosted pool has three workers).
    concurrency: [{ limit: ASTRA_RENDER_CONCURRENCY }, { limit: 2, key: "event.data.workspaceId" }],
    retries: 2,
  },
  async ({ event, step }) =>
    astraRenderWithWorkerWaits(
      { jobId: String(event.data.jobId), workspaceId: String(event.data.workspaceId) },
      { run: (id, work) => step.run(id, work), sleep: (id, duration) => step.sleep(id, duration) },
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

/** A take's id as a waitForEvent match may name it: generated ids only, never anything else. */
export const SETTLE_MATCH = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * An Atomik run on a Rig board (lib/workbench/rig-agent.ts): planned, built
 * step by step, then its renders run inside the limit a person approved. The
 * run's state lives in the workspace database; each tick is one bounded,
 * memoised step under the run's lease, and a step applied twice changes nothing
 * (its canvas op id; a render's saved request key). While a render is in
 * flight the function waits for its settlement (rig/render.settled, up to 20
 * minutes, then it looks again). One run at a time per production, two per
 * workspace; a stop cancels it at its next step. Past the step budget it
 * carries on in a fresh event, like development work.
 */
export const rigAgent = inngest.createFunction(
  {
    id: "rig-agent",
    name: "Atomik builds a Rig board",
    triggers: [{ event: EVENTS.rigAgent }],
    concurrency: [{ limit: 2, key: "event.data.workspaceId" }, { limit: 1, key: "event.data.productionId" }],
    retries: 3,
    cancelOn: [{ event: RIG_AGENT_STOPPED, match: "data.runId" }],
  },
  async ({ event, step }) => {
    const data: RigAgentEventData = {
      runId: String(event.data.runId ?? ""),
      productionId: String(event.data.productionId ?? ""),
      workspaceId: String(event.data.workspaceId ?? ""),
    };
    for (let n = 0; n < 40; n++) {
      const tick = await step.run(`tick-${n}`, () => rigAgentTick(data));
      if (tick.busy) { await step.sleep(`busy-${n}`, "5s"); continue; }
      if (tick.waitFor && SETTLE_MATCH.test(tick.waitFor.genId)) {
        await step.waitForEvent(`settled-${n}`, { event: RIG_RENDER_SETTLED, timeout: "20m", if: `async.data.genId == "${tick.waitFor.genId}"` });
        continue;
      }
      if (!tick.more) return { runId: data.runId, state: tick.state };
    }
    await step.run("continue-next-batch", () => continueRigAgent(data));
    return { runId: data.runId, continued: true };
  },
);

/** Everything the route serves. Workers are added here as they are written. */
export const functions = [probe, render, astraRender, dubbing, rigAgent];
