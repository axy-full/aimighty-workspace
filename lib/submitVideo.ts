import { isGenjutsuModel } from "./genjutsuTypes";
import { higgsfieldSubmissionRejected } from "./higgsfield";
import { saveHiggsfieldGenerationReceipt, restoreHiggsfieldGenerationReceipt } from "./higgsfieldGenerationReceipts";
import type { RenderHandle } from "./engines/types";
import { ASTRA_MODEL, astraSettings } from "./astra";
import { withRecoveryJob } from "./recovery";
import { db, ready, now } from "./db";
import { type VideoParams, type Reference, type ImageRole } from "./ark";
import { falEndpointFor } from "./falVideo";
import { falSubmissionRejected } from "./fal";
import { xaiSubmissionRejected } from "./xaiVideo";
import { PreflightError } from "./preflight";
import { classifyFailure, billedTo } from "./providers";
import { getModel, type ModelDef } from "./models";
import { getTask, type TaskDef } from "./tasks";
import { meter, assertMeterFunding, FundingSourceChangedError } from "./meter";
import { engineFor } from "./engines";
import { platformDb, platformReady } from "./platform";
import { requireTenant } from "./tenant";
import {
  writeGenerationOutcome,
  deliverGenerationSettlement,
} from "./generationSettlement";

/**
 * The one call that can fail for reasons that aren't ours, in one place:
 * the Generate route sends a fresh take through it, and a held take is
 * released through it later from nothing but its own row.
 */
export type SubmitOutcome =
  | { ok: true; taskId: string; attempts: number }
  | { ok: false; error: string; cls: string };

export type VideoJob = {
  genId: string;
  model: ModelDef;
  task: TaskDef;
  prompt: string;
  params: VideoParams;
  references: Reference[];
  source: Reference | null;
  /** When the row was made; the queue time is measured from it. */
  ts: number;
};

type SubmittedVideo = {
  kind: "video";
  taskId: string;
  endpoint?: string;
  higgsfieldHandle?: RenderHandle;
  queueMs: number;
  submitMs: number;
};
type SubmissionRow = {
  status: string;
  error: string | null;
  ark_task_id: string | null;
  attempts: number;
  params: string;
};

async function submissionRow(
  genId: string,
): Promise<SubmissionRow | undefined> {
  return (
    await db().execute({
      sql: `SELECT status,error,ark_task_id,attempts,params FROM generations WHERE id=? AND kind='video' AND deleted=0`,
      args: [genId],
    })
  ).rows[0] as unknown as SubmissionRow | undefined;
}
function knownTask(row: SubmissionRow): string | null {
  const p = JSON.parse(row.params || "{}");
  const id = row.ark_task_id || p.falRequestId || p.higgsfieldVideoHandle?.ref;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Only database writes may retry. A transport failure cannot prove that a
 * paid POST did not arrive, even when the client calls it "could not reach". */
async function writeSubmission(fn: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
async function rememberSubmission(
  job: VideoJob,
  out: SubmittedVideo,
): Promise<void> {
  await writeSubmission(async () => {
    if (isGenjutsuModel(job.model.id)) {
      if (!out.higgsfieldHandle || out.higgsfieldHandle.model !== job.model.id || out.higgsfieldHandle.ref !== out.taskId) throw new Error("The transform receipt is incomplete.");
      const saved = await db().execute({ sql: `UPDATE generations SET status=CASE WHEN status IN ('succeeded','cancelled') THEN status ELSE 'running' END,
        attempts=1,queue_ms=?,submit_ms=?,error=NULL,params=json_set(params,'$.higgsfieldVideoHandle',json(?),'$.producedOutcome',json(?)),updated_at=?
        WHERE id=? AND deleted=0 AND (json_extract(params,'$.higgsfieldVideoHandle.ref') IS NULL OR json_extract(params,'$.higgsfieldVideoHandle.ref')=?)`,
        args: [out.queueMs,out.submitMs,JSON.stringify(out.higgsfieldHandle),JSON.stringify(out),now(),job.genId,out.taskId] });
      if (!saved.rowsAffected) throw new Error("The submitted take is no longer available.");
      return;
    }
    const result = await db().execute({
      sql:
        job.model.provider === "fal"
          ? `UPDATE generations SET status=CASE WHEN status IN ('succeeded','cancelled') THEN status ELSE 'running' END,
          attempts=1,queue_ms=?,submit_ms=?,error=NULL,
          params=json_set(params,'$.falRequestId',?,'$.falModel',?,'$.producedOutcome',json(?)),updated_at=? WHERE id=? AND deleted=0`
          : `UPDATE generations SET ark_task_id=?,status=CASE WHEN status IN ('succeeded','cancelled') THEN status ELSE 'running' END,
          attempts=1,queue_ms=?,submit_ms=?,error=NULL,
          params=json_set(params,'$.producedOutcome',json(?)),updated_at=? WHERE id=? AND deleted=0`,
      args:
        job.model.provider === "fal"
          ? [
              out.queueMs,
              out.submitMs,
              out.taskId,
              out.endpoint!,
              JSON.stringify(out),
              now(),
              job.genId,
            ]
          : [
              out.taskId,
              out.queueMs,
              out.submitMs,
              JSON.stringify(out),
              now(),
              job.genId,
            ],
    });
    if (!result.rowsAffected)
      throw new Error("The submitted take is no longer available.");
  });
}

/** A received refusal, or a failure before anything was sent — never transport
 * ambiguity. Each adapter says so with a typed error; unrecognized errors
 * retain the estimate conservatively. */
export function definitelyRejected(error: unknown, message: string): boolean {
  if (
    error instanceof PreflightError ||
    falSubmissionRejected(error) ||
    xaiSubmissionRejected(error) ||
    higgsfieldSubmissionRejected(error)
  )
    return true;
  const status = message.match(/^Ark submit failed \((\d+)\)/)?.[1];
  return (
    (status != null &&
      [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(
        Number(status),
      )) ||
    /^That engine isn't connected for this workspace\./.test(message)
  );
}
async function submissionFailed(
  job: VideoJob,
  error: string,
  uncertain: boolean,
): Promise<SubmitOutcome> {
  let retainedCost: number | null = uncertain ? null : 0;
  if (uncertain) {
    try {
      await platformReady();
      const reserved = (
        await platformDb().execute({
          sql: "SELECT engine_cost_usd FROM meter_events WHERE id=? AND workspace_id=?",
          args: [job.genId, requireTenant().id],
        })
      ).rows[0]?.engine_cost_usd;
      if (reserved != null) retainedCost = Number(reserved);
    } catch {
      /* The existing meter reservation remains authoritative. */
    }
  }
  let ended = false;
  await writeSubmission(async () => {
    const out = await db().execute({
      sql: `UPDATE generations SET status='failed',error=?,attempts=1,cost_usd=COALESCE(cost_usd,?),updated_at=? WHERE id=? AND deleted=0 AND ark_task_id IS NULL AND json_extract(params,'$.falRequestId') IS NULL AND json_extract(params,'$.higgsfieldVideoHandle') IS NULL`,
      args: [error, retainedCost, now(), job.genId],
    });
    ended ||= out.rowsAffected > 0;
  }).catch(() => {});
  await meter(
    {
      id: job.genId,
      kind: "video",
      engine: billedTo(job.model.provider ?? "byteplus"),
      model: job.model.id,
      status: "failed",
      engineCostUsd: uncertain ? null : 0,
    },
    { critical: false },
  ).catch(() => {});
  /* The take ended without a settlement, but its slot (and, when refused,
     its reservation) came back all the same: start what waited for it now,
     not at the next ten-minute cron. Imported late: held.ts submits through
     this module. */
  if (ended) await (await import("./held")).releaseAfterSettlement();
  return {
    ok: false,
    error,
    cls: uncertain ? "uncertain" : classifyFailure(new Error(error)),
  };
}

/** One durable owner per generation, including delayed held-job releases.
 * Claims never expire: uncertainty must not purchase another provider task. */
export async function submitVideoJob(job: VideoJob): Promise<SubmitOutcome> {
  return await withRecoveryJob(requireTenant().id, job.genId, async () => {
    await ready();
    if (isGenjutsuModel(job.model.id)) await restoreHiggsfieldGenerationReceipt(job.genId);
    let row = await submissionRow(job.genId);
    if (!row) return { ok: false, error: "No such take.", cls: "fatal" };
    const existing = knownTask(row);
    if (existing)
      return {
        ok: true,
        taskId: existing,
        attempts: Number(row.attempts) || 1,
      };
    const prior = JSON.parse(row.params || "{}").producedOutcome as
      SubmittedVideo | undefined;
    if (
      prior?.kind === "video" &&
      typeof prior.taskId === "string" &&
      prior.taskId
    ) {
      try {
        await rememberSubmission(job, prior);
        return { ok: true, taskId: prior.taskId, attempts: 1 };
      } catch {
        return {
          ok: false,
          cls: "uncertain",
          error: `The provider accepted task ${prior.taskId}, but tracking could not be restored. No additional request was sent; its estimated cost remains reserved.`,
        };
      }
    }
    if (!["queued", "running"].includes(row.status))
      return {
        ok: false,
        error: row.error || "This take is no longer awaiting submission.",
        cls: "fatal",
      };
    if (job.model.id === ASTRA_MODEL) {
      try {
        const settings = astraSettings(job.params.astra), source = job.params.astraSource;
        if (job.params.resolution !== "4k" || job.params.fps60 !== (settings.fps === 60) || !source || ![source.width,source.height,source.seconds].every(n=>Number.isFinite(n)&&n>0) || source.seconds>300)
          throw new Error("Astra source and output settings need a new quote.");
      } catch {
        const message = "Astra's output requirements changed. Review this source again in Gen before submitting a new upscale. No provider request was sent.";
        await failVideoDispatch(job.genId, message);
        const current = await submissionRow(job.genId);
        const handle = current && knownTask(current);
        if (handle) return {ok:true,taskId:handle,attempts:1};
        if (current && JSON.parse(current.params || "{}").paidClaim != null)
          return {ok:false,cls:"uncertain",error:"A prior Astra submission is still being reconciled. No additional request was sent; its estimated cost remains reserved."};
        return {ok:false,cls:"fatal",error:message};
      }
    }
    const claimed = await db().execute({
      sql: `UPDATE generations SET params=json_set(params,'$.paidClaim',?),attempts=1,updated_at=?
    WHERE id=? AND kind='video' AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.paidClaim') IS NULL
      AND ark_task_id IS NULL AND json_extract(params,'$.falRequestId') IS NULL AND json_extract(params,'$.higgsfieldVideoHandle') IS NULL`,
      args: [now(), now(), job.genId],
    });
    if (!claimed.rowsAffected) {
      row = await submissionRow(job.genId);
      const taskId = row && knownTask(row);
      return taskId
        ? { ok: true, taskId, attempts: Number(row!.attempts) || 1 }
        : {
            ok: false,
            cls: "uncertain",
            error:
              row?.error ||
              "Submission already started. No additional request was sent. Wait for confirmation; the estimated cost remains reserved.",
          };
    }

    const started = now();
    let submitted: SubmittedVideo;
    try {
      await assertMeterFunding(
        job.genId,
        billedTo(job.model.provider ?? "byteplus"),
      );
      // Never wrap this paid call in withRetry, including transport and 5xx failures.
      const out = await engineFor(job.model.provider).render({
        kind: "video",
        genId: job.genId,
        model: job.model,
        task: job.task,
        prompt: job.prompt,
        params: job.params,
        references: job.references,
        source: job.source,
      });
      if (
        !("handle" in out) ||
        typeof out.handle.ref !== "string" ||
        !out.handle.ref
      )
        throw new Error("The engine returned no usable task handle.");
      submitted = {
        kind: "video",
        taskId: out.handle.ref,
        queueMs: started - job.ts,
        submitMs: now() - started,
        ...(isGenjutsuModel(job.model.id) ? { higgsfieldHandle: out.handle } : {}),
        ...(job.model.provider === "fal"
          ? {
              endpoint:
                out.handle.endpoint ||
                falEndpointFor(
                  job.model,
                  job.task.id,
                  job.references.some((r) => r.kind === "image"),
                ),
            }
          : {}),
      };
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : String(error)
      ).replace(/; it will be retried\./, "; no additional request was sent.");
      const uncertain =
        !(error instanceof FundingSourceChangedError) &&
        !definitelyRejected(error, message);
      return submissionFailed(
        job,
        uncertain
          ? `${message} The provider may already have accepted this task. It was not sent again; its estimated cost remains reserved until the provider outcome is reconciled.`
          : message,
        uncertain,
      );
    }
    if (submitted.higgsfieldHandle) {
      // An independent platform receipt survives failure of the tenant handle write.
      // Receipt failure must never cause another paid POST: the paidClaim is permanent.
      await saveHiggsfieldGenerationReceipt(job.genId, submitted.higgsfieldHandle, job.params.higgsfieldCredentialFingerprint!).catch(() => {});
    }
    try {
      await rememberSubmission(job, submitted);
      return { ok: true, taskId: submitted.taskId, attempts: 1 };
    } catch {
      // A database timeout may be a lost acknowledgment of a committed write.
      // Recover the known handle; never go through engine.render a second time.
      const recovered = await submissionRow(job.genId).catch(() => undefined);
      if (submitted.higgsfieldHandle)
        await saveHiggsfieldGenerationReceipt(job.genId, submitted.higgsfieldHandle, job.params.higgsfieldCredentialFingerprint!).catch(() => {});
      if (recovered && knownTask(recovered) === submitted.taskId)
        return { ok: true, taskId: submitted.taskId, attempts: 1 };
      return submissionFailed(
        job,
        `The provider accepted task ${submitted.taskId}, but its tracking could not be saved. No additional request was sent; its estimated cost remains reserved. Keep this task ID for support to recover the result.`,
        true,
      );
    }
  });
}

class VideoSourceError extends Error {}

type StoredRef = {
  uploadId?: string;
  genId?: string;
  role: string;
  kind: string;
};

/**
 * Reference ids on the row become the objects the vendor adapter wants —
 * uploads and our own renders, either kind, in the order the person set.
 */
async function hydrateRefs(refs: StoredRef[]): Promise<Reference[]> {
  const uploadIds = refs.map((r) => r.uploadId).filter(Boolean) as string[];
  const genIds = refs.map((r) => r.genId).filter(Boolean) as string[];
  type Up = {
    id: string;
    mime: string;
    ext: string;
    stored_url: string;
    kind: string;
    derivative_url: string | null;
  };
  type Own = { id: string; kind: string; stored_url: string };
  const byUpload = new Map<string, Up>();
  if (uploadIds.length) {
    const rs = await db().execute({
      sql: `SELECT id, mime, ext, stored_url, kind, derivative_url FROM uploads WHERE id IN (${uploadIds.map(() => "?").join(",")})`,
      args: uploadIds,
    });
    for (const r of rs.rows as unknown as Up[]) byUpload.set(r.id, r);
  }
  const own = new Map<string, Own>();
  if (genIds.length) {
    const rs = await db().execute({
      sql: `SELECT id, kind, stored_url FROM generations
            WHERE id IN (${genIds.map(() => "?").join(",")}) AND deleted = 0 AND status = 'succeeded' AND stored_url IS NOT NULL`,
      args: genIds,
    });
    for (const r of rs.rows as unknown as Own[]) own.set(r.id, r);
  }
  const out: Reference[] = [];
  for (const r of refs) {
    if (r.genId) {
      const g = own.get(r.genId);
      if (
        !g ||
        !["image", "video"].includes(g.kind) ||
        (r.kind && r.kind !== g.kind)
      )
        throw new VideoSourceError(
          "A quoted reference is no longer available in its original form.",
        );
      const video = g.kind === "video";
      out.push({
        id: g.id,
        mime: video ? "video/mp4" : "image/png",
        ext: video ? "mp4" : "png",
        storedUrl: g.stored_url,
        role:
          (r.role as ImageRole) ??
          (video ? "reference_video" : "reference_image"),
        kind: video ? "video" : "image",
        fromGeneration: true,
      });
      continue;
    }
    const u = r.uploadId ? byUpload.get(r.uploadId) : undefined;
    if (
      !u ||
      !u.stored_url ||
      !["image", "video"].includes(u.kind) ||
      (r.kind && r.kind !== u.kind)
    )
      throw new VideoSourceError(
        "A quoted reference is no longer available in its original form.",
      );
    const video = u.kind === "video";
    out.push({
      id: u.id,
      mime: u.mime,
      ext: u.ext,
      storedUrl: u.stored_url,
      role:
        (r.role as ImageRole) ??
        (video ? "reference_video" : "reference_image"),
      kind: video ? "video" : "image",
      deliveryUrl: u.derivative_url ?? null,
    });
  }
  return out;
}

/** A queue failure can release an unsent job only. A paid claim or known handle
 * belongs to provider reconciliation and must never be replaced or refunded. */
export async function failVideoDispatch(
  genId: string,
  message: string,
): Promise<void> {
  await ready();
  const row = (
    await db().execute({
      sql: "SELECT model,provider FROM generations WHERE id=? AND kind='video' AND deleted=0",
      args: [genId],
    })
  ).rows[0];
  if (!row) return;
  await writeGenerationOutcome(
    {
      sql: `UPDATE generations SET status='failed',error=?,cost_usd=0,updated_at=?
      WHERE id=? AND kind='video' AND deleted=0 AND status IN ('queued','running')
      AND ark_task_id IS NULL AND json_extract(params,'$.falRequestId') IS NULL
      AND json_extract(params,'$.producedOutcome') IS NULL AND json_extract(params,'$.paidClaim') IS NULL`,
      args: [message.slice(0, 600), now(), genId],
    },
    {
      id: genId,
      kind: "video",
      engine: billedTo(String(row.provider || "byteplus")),
      model: String(row.model),
      status: "failed",
      engineCostUsd: 0,
    },
  );
  await deliverGenerationSettlement(genId);
}

/** Submit from durable row state; no request closure or recompiled prompt is required. */
export async function submitVideoRow(genId: string): Promise<SubmitOutcome> {
  return await withRecoveryJob(requireTenant().id, genId, async () => {
    await ready();
    const rs = await db().execute({
      sql: `SELECT id, model, prompt, params, task, source_gen_id, created_at FROM generations WHERE id = ? AND kind='video' AND deleted = 0`,
      args: [genId],
    });
    const row = rs.rows[0] as unknown as
      | {
          id: string;
          model: string;
          prompt: string;
          params: string;
          task: string | null;
          source_gen_id: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return { ok: false, error: "No such take.", cls: "fatal" };
    const model = getModel(String(row.model));
    const task = getTask(String(row.task ?? "generate"));
    const params = JSON.parse(String(row.params ?? "{}")) as VideoParams & {
      references?: StoredRef[];
      sourceUploadId?: string;
      producedOutcome?: SubmittedVideo;
      paidClaim?: number;
    };
    const job: VideoJob = {
      genId,
      model,
      task,
      prompt: String(row.prompt),
      params,
      references: [],
      source: null,
      ts: Number(row.created_at),
    };
    // A repeated delivery recovers a handle before touching reference files.
    const prior = await submissionRow(genId);
    if (
      prior &&
      (knownTask(prior) || params.producedOutcome || params.paidClaim != null)
    )
      return submitVideoJob(job);
    try {
      job.references = await hydrateRefs(params.references ?? []);
      job.source = row.source_gen_id
        ? (job.references.find(
            (r) => r.fromGeneration && r.id === row.source_gen_id,
          ) ?? null)
        : params.sourceUploadId
          ? (job.references.find(
              (r) => !r.fromGeneration && r.id === params.sourceUploadId,
            ) ?? null)
          : null;
      if (task.locked && !job.source)
        throw new VideoSourceError(
          "The source clip is no longer available. No provider request was sent.",
        );
    } catch (error) {
      if (!(error instanceof VideoSourceError)) throw error; // A DB outage is retryable preparation, never a paid replay.
      await failVideoDispatch(genId, error.message);
      return { ok: false, error: error.message, cls: "fatal" };
    }
    return submitVideoJob(job);
  });
}
