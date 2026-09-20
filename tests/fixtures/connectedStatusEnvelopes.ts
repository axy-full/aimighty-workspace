/**
 * The connected account's REAL status envelopes, recorded read-only from the
 * live account. Free reads only: no job was submitted and nothing was billed.
 *
 * They exist because the unit suite previously invented flat shapes the
 * provider never sends — `{id, status, model, type, results:{rawUrl}}` for
 * `job_display` — and that invention hid a defect that left a finished, paid
 * job uncollectable.
 *
 * WHAT WAS RECORDED FROM LIFE, AND WHEN
 *
 * 20 September 2026, first recording (one completed job `e7023b04-…`, model
 * `seedance_2_5`, type `video`, via `job_display` and `jobs_wait`): the
 * top-level `results` ARRAY, the entry's own key set, the model id at the
 * ENTRY's top level, the per-family VARIANT selector `params.model: "default"`,
 * `results: {rawUrl, thumbnailUrl}`, and the `jobs_wait` snapshot keys
 * (`jobs[].job_id` / `result_url` / `thumbnail_url`, `summary`, `all_terminal`,
 * `poll_after_seconds`).
 *
 * 20 September 2026, SECOND recording — `show_generations(type=video,size=12)`,
 * twelve consecutive completed `seedance_2_5` jobs carrying 3-4 reference files
 * each. This is the recording the media fields below come from:
 *
 *     jq '[.items[].params.medias[]? | keys] | unique'     => [["data","role"]]
 *     jq '[.items[].params.medias[]?.role] | unique'       => ["image"]
 *     jq '[.items[].params.medias[]?.data | keys] | unique'=> [["id","type","url"]]
 *     jq '[.items[].params.medias[]?.data.type] | unique'  => ["media_input"]
 *
 * The previous version of this file asserted, in a comment, that media are
 * echoed "with the role we sent", and built the envelope from the caller's own
 * role. That was an ASSUMPTION, never a recording, and it was wrong: the
 * provider echoes the media KIND. It is what hid the defect fixed alongside
 * this file — `evidence()` compared the echoed kind to the slot name we sent
 * (`start_image`) and discarded every completed, paid job with reference media.
 *
 * `seedance_2_5` declares `start_image`, `end_image`, `image_references`,
 * `video_references`, `audio_references` and no role named `image`
 * (`models_explore(get seedance_2_5)`, read free the same day), so for that
 * model the echoed `image` cannot be a slot name.
 *
 * Only ids, urls, the prompt and the job/model identity are synthetic here, so
 * that nothing account-identifying is checked in; every key, every shape and
 * every label above is as recorded.
 *
 * The envelopes, as recorded:
 *
 *     job_display:
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
 *     jobs_wait (`timeout_seconds: 0`):
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

/** One reference file as the provider echoes it back. `kind` is the media KIND
 * the provider reports under `role` — NOT the slot role we sent; recorded from
 * life (see above). It defaults to `image`, the only kind observed so far. */
export type EnvelopeMedia = { id: string; url: string; kind?: "image" | "video" | "audio" };

export type EnvelopeJob = {
  jobId: string;
  model: string;
  type: string;
  /** The prompt we submitted; the provider echoes it verbatim under `params`. */
  prompt: string;
  /** Reference files echoed under `params.medias`, in the order we sent them. */
  medias?: EnvelopeMedia[];
  rawUrl: string;
};

const THUMBNAIL = "https://fixtures.particl.invalid/outputs/thumb.jpg";

/** One echoed `params.medias` entry, exactly as recorded: the KIND under
 * `role`, and `media_input` under `data.type`. */
export const echoedMedia = (media: EnvelopeMedia) => ({
  role: media.kind ?? "image",
  data: { id: media.id, type: "media_input", url: media.url },
});

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
        ...(job.medias?.length ? { medias: job.medias.map(echoedMedia) } : {}),
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

/** The live `jobs_wait` snapshot for a completed job. It carries no `params`
 * at all, which is why the media echo never reaches the contract on this read. */
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
