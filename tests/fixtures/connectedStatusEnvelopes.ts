/**
 * The connected account's REAL status envelopes, recorded read-only from the
 * live account on 20 September 2026 against one completed job
 * (`e7023b04-…`, model `seedance_2_5`, type `video`). Free reads only: no job
 * was submitted and nothing was billed.
 *
 * They exist because the unit suite previously invented flat shapes the
 * provider never sends — `{id, status, model, type, results:{rawUrl}}` for
 * `job_display` — and that invention hid a defect that left a finished, paid
 * job uncollectable. Anything asserted about a fallback envelope is asserted
 * against these shapes.
 *
 * `job_display` (the provider's gallery envelope) — note the top-level
 * `results` ARRAY, the model id at the ENTRY's top level, and the per-family
 * VARIANT selector under `params.model`:
 *
 *     {"results":[{"id":"<uuid>","type":"video","status":"completed",
 *                  "model":"seedance_2_5",
 *                  "params":{"prompt":"…","aspect_ratio":"16:9","duration":10,
 *                            "medias":[{"role":"image","data":{"id":"<uuid>",
 *                                       "type":"media_input","url":"https://…"}}],
 *                            "width":1280,"height":720,"resolution":"720p",
 *                            "generate_audio":true,"model":"default"},
 *                  "results":{"rawUrl":"https://…","thumbnailUrl":"https://…"},
 *                  "createdAt":1789675148.404006}]}
 *
 * `jobs_wait` (the headless long-poll snapshot, `timeout_seconds: 0`):
 *
 *     {"jobs":[{"index":0,"job_id":"<uuid>","status":"completed","type":"video",
 *               "model":"seedance_2_5","result_url":"https://…",
 *               "thumbnail_url":"https://…"}],
 *      "summary":{"total":1,"completed":1,"failed":0,"active":0,"errors":0},
 *      "all_terminal":true}
 *
 * `show_generations` returns the same per-entry shape as `job_display`'s
 * `results` elements. The live `nano_banana_2` image entries carry NO nested
 * `params.model` at all and an extra `results.minUrl`, so a nested `model` is
 * per-family and is never the model id.
 */

export type EnvelopeJob = {
  jobId: string;
  model: string;
  type: string;
  /** The prompt we submitted; the provider echoes it verbatim under `params`. */
  prompt: string;
  /** Media uuid and source url of one reference file, echoed under
   * `params.medias[].data`, with the role we sent. */
  media?: { id: string; role: string; url: string };
  rawUrl: string;
};

const THUMBNAIL = "https://fixtures.particl.invalid/outputs/thumb.jpg";

/** The live `job_display` envelope for a completed job. */
export const displayCompleted = (job: EnvelopeJob) => ({
  results: [
    {
      id: job.jobId,
      type: job.type,
      status: "completed",
      model: job.model,
      params: {
        prompt: job.prompt,
        aspect_ratio: "9:16",
        duration: 5,
        ...(job.media ? { medias: [{ role: job.media.role, data: { id: job.media.id, type: "media_input", url: job.media.url } }] } : {}),
        width: 720,
        height: 1280,
        resolution: "720p",
        generate_audio: true,
        prompt_language: "en",
        // The per-family variant selector, NOT a model id.
        model: "default",
      },
      results: { rawUrl: job.rawUrl, thumbnailUrl: THUMBNAIL },
      createdAt: 1789675148.404006,
    },
  ],
});

/** The same envelope while the job is still running: no `results` key at all. */
export const displayInProgress = (job: EnvelopeJob) => {
  const entry: Record<string, unknown> = { ...displayCompleted(job).results[0], status: "in_progress" };
  delete entry.results;
  return { results: [entry] };
};

/** The live `jobs_wait` snapshot for a completed job. */
export const waitCompleted = (job: EnvelopeJob) => ({
  jobs: [
    {
      index: 0,
      job_id: job.jobId,
      status: "completed",
      type: job.type,
      model: job.model,
      result_url: job.rawUrl,
      thumbnail_url: THUMBNAIL,
    },
  ],
  summary: { total: 1, completed: 1, failed: 0, active: 0, errors: 0 },
  all_terminal: true,
});

/** The live `jobs_wait` snapshot while the job is still running. */
export const waitInProgress = (job: EnvelopeJob, pollAfterSeconds = 5) => ({
  jobs: [{ index: 0, job_id: job.jobId, status: "in_progress", type: job.type, model: job.model }],
  summary: { total: 1, completed: 0, failed: 0, active: 1, errors: 0 },
  all_terminal: false,
  poll_after_seconds: pollAfterSeconds,
});
