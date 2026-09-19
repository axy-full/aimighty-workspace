import { runAstraRender, reconcileAstraRender } from "./astra-blender/render-jobs";
import { advanceDubbingJob } from "./dubbing";
import { withRecoveryJob } from "./recovery";
import { db, ready, now } from "./db";
import { runWorkerProbe } from "./workerProbe";
import { loadJob, produce, seal, failJob, type Job, type Produced } from "./renderWork";
import { submitVideoRow, failVideoDispatch } from "./submitVideo";
import { runInTenant } from "./tenant";
import { getWorkspace, legacyWorkspace } from "./platform";
import { runDevelopmentStep } from "./workbench/development-server";
import { dispatchEvent, EVENTS, type WorkerEvent } from "./dispatch";
import type { TenantWorkspace } from "./tenant";

/**
 * The bodies of every worker, as plain async functions.
 *
 * Two callers share them: the Inngest functions in lib/workers.ts, which
 * wrap each piece in a memoised step and retry, and the native /api/worker
 * route, which runs a handler exactly once inside one Vercel function. What
 * differs between the two is retry policy, not the work — and every piece
 * here is idempotent against the row it works on, so at-least-once delivery
 * from either side does nothing twice that costs money.
 */

export type RenderKind = "image" | "audio" | "video";
export type RenderEventData = { genId: string; kind: RenderKind; workspaceId: string };
export type AstraEventData = { jobId: string; workspaceId: string };
export type DubbingEventData = { jobId: string; workspaceId: string };
export type DevelopmentEventData = { jobId: string; owner: string; workspaceId: string };
export type ProbeEventData = {
  workspaceId: string;
  probeId: string;
  expectedDeployment?: string;
  expectedEnvironment?: string;
};

/** The workspace an event belongs to; the studio's original one for events that predate workspaces. */
export async function workspaceOf(data: { workspaceId?: string }): Promise<TenantWorkspace> {
  const ws = data.workspaceId
    ? await getWorkspace(String(data.workspaceId))
    : await legacyWorkspace();
  if (!ws || ws.deletedAt) throw new Error("No active workspace for this event.");
  return ws;
}

/* ── render/requested ─────────────────────────────────────────────── */

export type RenderDeps = {
  workspaceOf?: typeof workspaceOf;
  loadJob?: typeof loadJob;
  produce?: typeof produce;
  seal?: typeof seal;
  failJob?: typeof failJob;
  submitVideoRow?: typeof submitVideoRow;
  failVideoDispatch?: typeof failVideoDispatch;
  ready?: typeof ready;
};

export async function renderSubmitVideo(data: RenderEventData, ws: TenantWorkspace, deps: RenderDeps = {}) {
  const { genId, workspaceId } = data;
  return withRecoveryJob(workspaceId, genId, () =>
    runInTenant(ws, async () => {
      await (deps.workspaceOf ?? workspaceOf)(data);
      await (deps.ready ?? ready)();
      return { genId, ...(await (deps.submitVideoRow ?? submitVideoRow)(genId)) };
    }),
  );
}

/** The paid step. loadJob returns null for anything already terminal, and
 * produce replays a stored outcome rather than paying twice. */
export async function renderProduce(
  data: RenderEventData,
  ws: TenantWorkspace,
  deps: RenderDeps = {},
): Promise<{ job: Job; out: Produced } | null> {
  const { genId, workspaceId } = data;
  return withRecoveryJob(workspaceId, genId, () =>
    runInTenant(ws, async () => {
      await (deps.workspaceOf ?? workspaceOf)(data);
      await (deps.ready ?? ready)();
      const job = await (deps.loadJob ?? loadJob)(genId);
      // Already finished, or gone. Nothing to do, and nothing to pay for.
      if (!job) return null;
      const out = await (deps.produce ?? produce)(job);
      return out ? { job, out } : null;
    }),
  );
}

export async function renderSeal(
  data: RenderEventData,
  ws: TenantWorkspace,
  produced: { job: Job; out: Produced },
  deps: RenderDeps = {},
) {
  const { genId, workspaceId } = data;
  return withRecoveryJob(workspaceId, genId, () =>
    runInTenant(ws, async () => {
      await (deps.workspaceOf ?? workspaceOf)(data);
      await (deps.ready ?? ready)();
      await (deps.seal ?? seal)(produced.job, produced.out);
      return { sealed: true };
    }),
  );
}

/** Inngest's onFailure, as a function: end the row this worker owned. */
export async function renderFailed(data: RenderEventData, message: string, deps: RenderDeps = {}) {
  const { genId, workspaceId } = data;
  if (!genId) return;
  await withRecoveryJob(workspaceId, genId, async () =>
    runInTenant(await (deps.workspaceOf ?? workspaceOf)(data), () =>
      data.kind === "video"
        ? (deps.failVideoDispatch ?? failVideoDispatch)(genId, message)
        : (deps.failJob ?? failJob)(genId, message),
    ),
  );
}

/**
 * Native mode: ONE attempt, no retry loop.
 *
 * Inngest retried a thrown step three times and then ran onFailure; there is
 * no retry here, so a thrown produce is failed immediately with its message
 * (the same terminal state Inngest would reach after its retries, minus the
 * retries). The one case that must not be treated that way is a seal that
 * throws AFTER produce returned: the vendor has been paid and the bytes are
 * stored, and `produce` already persisted its outcome on the row as
 * params.$.producedOutcome. The row is therefore left at "running" with
 * params.$.sealFailed recording the message, and the ten-minute cron's
 * syncPending seals it from the stored outcome without calling produce
 * again (lib/jobs.ts, the `params.producedOutcome` branch). This handler
 * never calls produce a second time itself.
 */
export async function handleRender(data: RenderEventData, deps: RenderDeps = {}) {
  const { genId, workspaceId } = data;
  const ws = await withRecoveryJob(workspaceId, genId, () => (deps.workspaceOf ?? workspaceOf)(data));
  if (data.kind === "video") {
    try {
      return await renderSubmitVideo(data, ws, deps);
    } catch (error) {
      await renderFailed(data, (error as Error).message, deps).catch(() => {});
      throw error;
    }
  }
  let produced: { job: Job; out: Produced } | null;
  try {
    produced = await renderProduce(data, ws, deps);
  } catch (error) {
    await renderFailed(data, (error as Error).message, deps).catch(() => {});
    throw error;
  }
  if (!produced) return { genId, skipped: true };
  try {
    await renderSeal(data, ws, produced, deps);
  } catch (error) {
    await markSealFailed(genId, ws, (error as Error).message).catch(() => {});
    throw error;
  }
  return { genId, ok: true };
}

/** Paid and stored, not yet recorded: say so on the row and leave it for syncPending. */
async function markSealFailed(genId: string, ws: TenantWorkspace, message: string) {
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({
      sql: `UPDATE generations SET params=json_set(params,'$.sealFailed',?),updated_at=?
            WHERE id=? AND status IN ('queued','running') AND deleted=0`,
      args: [message.slice(0, 600), now(), genId],
    });
  });
}

/* ── astra-blender/render.requested ───────────────────────────────── */

export type AstraDeps = {
  workspaceOf?: typeof workspaceOf;
  run?: typeof runAstraRender;
  reconcile?: typeof reconcileAstraRender;
};

/** Duplicate delivery is safe: only the permanent queued→starting claim can purchase compute. */
export async function handleAstraRender(data: AstraEventData, deps: AstraDeps = {}) {
  const { jobId, workspaceId } = data;
  return withRecoveryJob(workspaceId, jobId, async () =>
    runInTenant(await (deps.workspaceOf ?? workspaceOf)(data), async () => {
      await (deps.run ?? runAstraRender)(jobId);
      await (deps.reconcile ?? reconcileAstraRender)(jobId);
      return { jobId };
    }),
  );
}

/* ── audio/dubbing.requested ──────────────────────────────────────── */

export type DubbingDeps = { workspaceOf?: typeof workspaceOf; advance?: typeof advanceDubbingJob };
const DUBBING_ID = /^dub_[a-f0-9]{32}$/;

/**
 * One step of the dubbing machine (lib/dubbing.ts): submit once, or ask
 * after, or collect. Duplicate delivery is safe — the permanent submit
 * claim purchases at most one vendor project, a poll is free, and a
 * finished row is left alone. A thrown transport error ends this attempt;
 * the ten-minute cron's recoverDubbingJobs asks again.
 */
export async function handleDubbing(data: DubbingEventData, deps: DubbingDeps = {}) {
  const { jobId, workspaceId } = data;
  if (!DUBBING_ID.test(jobId)) throw new Error("Invalid dubbing job event.");
  return withRecoveryJob(workspaceId, jobId, async () =>
    runInTenant(await (deps.workspaceOf ?? workspaceOf)(data), async () => {
      const row = await (deps.advance ?? advanceDubbingJob)(jobId);
      return { jobId, status: row?.status ?? "missing" };
    }),
  );
}

/* ── workbench/development.requested ──────────────────────────────── */

export type DevelopmentDeps = {
  getWorkspace?: typeof getWorkspace;
  runStep?: typeof runDevelopmentStep;
  /** The step_index of the next never-started phase, or null. Runs inside the tenant. */
  nextPhase?: (jobId: string) => Promise<number | null>;
  dispatch?: (event: WorkerEvent) => Promise<boolean>;
  clock?: () => number;
  /** Wall time one invocation may spend before handing the rest to a new one. */
  budgetMs?: number;
};

/** Enough of the 300-second function for the phase in flight to finish and its result to be saved. */
export const DEVELOPMENT_BUDGET_MS = 240_000;
export const DEVELOPMENT_MAX_PHASES = 200;
const DEVELOPMENT_ID = /^wb_development_[a-f0-9-]+$/;

async function developmentWorkspace(workspaceId: string, deps: DevelopmentDeps) {
  const workspace = await (deps.getWorkspace ?? getWorkspace)(workspaceId);
  if (!workspace || workspace.deletedAt || workspace.suspendedAt)
    throw new Error("The workspace is unavailable for development work.");
  return workspace;
}

/** One persisted phase, inside the job's recovery intent and tenant. */
export async function runDevelopmentPhase(data: DevelopmentEventData, deps: DevelopmentDeps = {}) {
  const { jobId, owner, workspaceId } = data;
  return withRecoveryJob(workspaceId, jobId, async () => {
    const workspace = await developmentWorkspace(workspaceId, deps);
    return runInTenant(workspace, () => (deps.runStep ?? runDevelopmentStep)(jobId, owner));
  });
}

async function defaultNextPhase(jobId: string): Promise<number | null> {
  const next = (
    await db().execute({
      sql: "SELECT step_index,status FROM workbench_development_steps WHERE job_id=? AND status<>'succeeded' ORDER BY step_index LIMIT 1",
      args: [jobId],
    })
  ).rows[0];
  return next && next.status === "queued" ? Number(next.step_index) : null;
}

/** The phase-keyed continuation event: same job, same owner, same reservation. */
export function developmentContinuation(data: DevelopmentEventData, phase: number): WorkerEvent {
  return {
    id: `development-${data.jobId}-phase-${phase}`,
    name: EVENTS.development,
    data: { jobId: data.jobId, owner: data.owner, workspaceId: data.workspaceId },
  };
}

/** Hand the never-started remainder to a fresh invocation. False when nothing is queued or the hand-off was refused. */
export async function continueDevelopment(data: DevelopmentEventData, deps: DevelopmentDeps = {}): Promise<boolean> {
  const workspace = await developmentWorkspace(data.workspaceId, deps);
  const phase = await runInTenant(workspace, async () => {
    await ready();
    return (deps.nextPhase ?? defaultNextPhase)(data.jobId);
  });
  if (phase == null) return false;
  return (deps.dispatch ?? dispatchEvent)(developmentContinuation(data, phase));
}

export function validateDevelopmentEvent(data: DevelopmentEventData) {
  if (!DEVELOPMENT_ID.test(data.jobId) || !data.owner || !data.workspaceId)
    throw new Error("Invalid development job event.");
}

/**
 * Native mode: run persisted phases back to back until the job is done or
 * waiting, or until the wall-time budget is spent — then re-dispatch the
 * remainder to a new invocation under the same reservation. A phase whose
 * saved result is awaiting ledger settlement stops here; only recovery may
 * touch it, and nothing here can buy another provider attempt.
 */
export async function handleDevelopment(data: DevelopmentEventData, deps: DevelopmentDeps = {}) {
  validateDevelopmentEvent(data);
  const clock = deps.clock ?? Date.now;
  const budget = deps.budgetMs ?? DEVELOPMENT_BUDGET_MS;
  const startedAt = clock();
  for (let phase = 0; phase < DEVELOPMENT_MAX_PHASES; phase++) {
    if (clock() - startedAt >= budget) break;
    const result = await runDevelopmentPhase(data, deps);
    if (result.settlementPending) return { jobId: data.jobId, settlementPending: true };
    if (result.done) return { jobId: data.jobId, complete: true };
    if (result.waiting) return { jobId: data.jobId, waitingForExistingClaim: true };
  }
  const continued = await continueDevelopment(data, deps);
  if (!continued)
    throw new Error("The next development batch could not be dispatched. Resume the saved job.");
  return { jobId: data.jobId, continued: true };
}

/* ── worker/probe ─────────────────────────────────────────────────── */

export async function handleProbe(data: ProbeEventData, deps: { probe?: typeof runWorkerProbe } = {}) {
  return (deps.probe ?? runWorkerProbe)({
    workspaceId: String(data.workspaceId ?? ""),
    probeId: String(data.probeId ?? ""),
    ...(data.expectedDeployment ? { expectedDeployment: String(data.expectedDeployment) } : {}),
    ...(data.expectedEnvironment ? { expectedEnvironment: String(data.expectedEnvironment) } : {}),
  });
}

/* ── the switch ───────────────────────────────────────────────────── */

/** The identifier the slot and the recovery intent are keyed on. */
export function workerJobId(event: WorkerEvent): string {
  switch (event.name) {
    case EVENTS.render:
      return event.data.genId ?? "";
    case EVENTS.astraRender:
    case EVENTS.development:
    case EVENTS.dubbing:
      return event.data.jobId ?? "";
    case EVENTS.probe:
      return event.data.probeId ?? "";
  }
}

export async function runWorkerHandler(event: WorkerEvent): Promise<unknown> {
  const data = event.data;
  switch (event.name) {
    case EVENTS.render: {
      const kind = data.kind;
      if (kind !== "image" && kind !== "audio" && kind !== "video")
        throw new Error("Invalid render event.");
      return handleRender({ genId: String(data.genId ?? ""), kind, workspaceId: String(data.workspaceId ?? "") });
    }
    case EVENTS.astraRender:
      return handleAstraRender({ jobId: String(data.jobId ?? ""), workspaceId: String(data.workspaceId ?? "") });
    case EVENTS.development:
      return handleDevelopment({
        jobId: String(data.jobId ?? ""),
        owner: String(data.owner ?? ""),
        workspaceId: String(data.workspaceId ?? ""),
      });
    case EVENTS.dubbing:
      return handleDubbing({ jobId: String(data.jobId ?? ""), workspaceId: String(data.workspaceId ?? "") });
    case EVENTS.probe:
      return handleProbe(data as ProbeEventData);
  }
}
