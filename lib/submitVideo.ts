import { db, now } from "./db";
import { submitTask, type VideoParams, type Reference, type ImageRole } from "./ark";
import { submitFalVideo, falEndpointFor } from "./falVideo";
import { withRetry, classifyFailure, billedTo } from "./providers";
import { getSetting } from "./settings";
import { getModel, type ModelDef } from "./models";
import { getTask, type TaskDef } from "./tasks";
import { meter } from "./meter";

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

/* A timeout or a 429 is weather and gets tried again with backoff; a
 * rejected prompt is a decision and fails immediately with the vendor's
 * own words. Either way the row already exists, so nothing disappears. */
export async function submitVideoJob(job: VideoJob): Promise<SubmitOutcome> {
  const { genId, model, task, prompt, params, references, source, ts } = job;
  const maxRetries = Math.max(0, Math.min(5, Number(await getSetting("maxRetries")) || 0));
  const submitStartedAt = now();
  try {
    const { value: taskId, attempts } = await withRetry(
      async () => {
        try {
          if (model.provider === "fal") {
            const q = await submitFalVideo({ model, task, prompt, params, references, source });
            return q.requestId;
          }
          return await submitTask(model.id, prompt, params, references);
        } catch (e) {
          /* Two very different failures wear the same coat here. "Could not
             reach ModelArk" means the request never landed, and trying again
             is free. But an error CARRYING a status — "Ark submit failed
             (500)" — means they received it, and may well have accepted and
             billed the task before failing to tell us. Retrying that buys a
             second paid render nobody asked for. So it is re-thrown in words
             classifyFailure reads as fatal. (lib/fal.ts carries the same
             reasoning for the same reason.) */
          const msg = (e as Error).message;
          if (/^Ark submit failed \(/.test(msg)) {
            throw new Error(`${msg} The task may already have been accepted, so it was not sent again.`);
          }
          throw e;
        }
      },
      {
        max: maxRetries,
        onRetry: (n, cls, err) => console.warn(`generate ${genId}: attempt ${n} ${cls} — ${err.message}`),
      }
    );
    if (model.provider === "fal") {
      /* fal holds the job on its own queue; the request id is the handle the
         wall's poll and the cron finish the render from (lib/falVideo.ts). */
      await db().execute({
        sql: `UPDATE generations
              SET status='running', attempts=?, queue_ms=?, submit_ms=?,
                  params=json_set(params, '$.falRequestId', ?, '$.falModel', ?), updated_at=?
              WHERE id=?`,
        args: [attempts, submitStartedAt - ts, now() - submitStartedAt, taskId,
               falEndpointFor(model, task.id, references.some((r) => r.kind === "image")), now(), genId],
      });
    } else {
      await db().execute({
        sql: `UPDATE generations
              SET ark_task_id=?, status='running', attempts=?,
                  queue_ms=?, submit_ms=?, updated_at=?
              WHERE id=?`,
        args: [taskId, attempts, submitStartedAt - ts, now() - submitStartedAt, now(), genId],
      });
    }
    return { ok: true, taskId, attempts };
  } catch (e) {
    const msg = (e as Error).message;
    const cls = classifyFailure(e);
    const shown = cls === "rate-limited"
      ? `The provider is rate-limiting us — try again shortly. (${msg})`
      : msg;
    await db().execute({
      sql: `UPDATE generations SET status='failed', error=?, attempts=?, updated_at=? WHERE id=?`,
      args: [shown, maxRetries + 1, now(), genId],
    });
    // The vendor never took the job, so nothing is billed: the meter row closes at zero.
    await meter({ id: genId, kind: "video", engine: billedTo(model.provider ?? "byteplus"), model: model.id,
                  status: "failed", engineCostUsd: 0 }, { critical: false }).catch(() => {});
    return { ok: false, error: shown, cls };
  }
}

type StoredRef = { uploadId?: string; genId?: string; role: string; kind: string };

/**
 * Reference ids on the row become the objects the vendor adapter wants —
 * uploads and our own renders, either kind, in the order the person set.
 */
async function hydrateRefs(refs: StoredRef[]): Promise<Reference[]> {
  const uploadIds = refs.map((r) => r.uploadId).filter(Boolean) as string[];
  const genIds = refs.map((r) => r.genId).filter(Boolean) as string[];
  type Up = { id: string; mime: string; ext: string; stored_url: string; kind: string; derivative_url: string | null };
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
      if (!g) continue; // deleted since: dropped rather than fatal, the prompt still describes the shot
      const video = g.kind === "video";
      out.push({
        id: g.id, mime: video ? "video/mp4" : "image/png", ext: video ? "mp4" : "png", storedUrl: g.stored_url,
        role: (r.role as ImageRole) ?? (video ? "reference_video" : "reference_image"), kind: video ? "video" : "image",
        fromGeneration: true,
      });
      continue;
    }
    const u = r.uploadId ? byUpload.get(r.uploadId) : undefined;
    if (!u) continue;
    const video = u.kind === "video";
    out.push({
      id: u.id, mime: u.mime, ext: u.ext, storedUrl: u.stored_url,
      role: (r.role as ImageRole) ?? (video ? "reference_video" : "reference_image"), kind: video ? "video" : "image",
      deliveryUrl: u.derivative_url ?? null,
    });
  }
  return out;
}

/** Send a take that already exists as a row — a held one, released. */
export async function submitVideoRow(genId: string): Promise<SubmitOutcome> {
  const rs = await db().execute({
    sql: `SELECT id, model, prompt, params, task, source_gen_id, created_at FROM generations WHERE id = ? AND deleted = 0`,
    args: [genId],
  });
  const row = rs.rows[0] as unknown as
    { id: string; model: string; prompt: string; params: string; task: string | null; source_gen_id: string | null; created_at: number } | undefined;
  if (!row) return { ok: false, error: "No such take.", cls: "fatal" };
  const model = getModel(String(row.model));
  const task = getTask(String(row.task ?? "generate"));
  const params = JSON.parse(String(row.params ?? "{}")) as VideoParams & { references?: StoredRef[] };
  const references = await hydrateRefs(params.references ?? []);
  const source = row.source_gen_id
    ? references.find((r) => r.fromGeneration && r.id === row.source_gen_id) ?? null
    : null;
  return submitVideoJob({ genId, model, task, prompt: String(row.prompt), params, references, source, ts: Number(row.created_at) });
}
