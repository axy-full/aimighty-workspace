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
 * 20 September 2026, THIRD recording — `show_generations` over the whole
 * `video` and `audio` history rather than the seedance jobs alone. `data.type`
 * is NOT always `media_input`; it is per-kind on some models:
 *
 *     jq '[.items[].params.medias[]?.data.type] | unique' (type=video)
 *       => ["media_input","video_input"]
 *
 *     reframe job: {"role":"video",
 *                   "data":{"id":"<uuid>","type":"video_input",
 *                           "url":"https://…/<uuid>.mp4"}}
 *     seed_audio:  {"role":"audio",
 *                   "data":{"id":"<uuid>","type":"audio_input","url":"…"}}
 *
 * The second recording's `["media_input"]` was true of the twelve seedance jobs
 * it covered and false of the account, and a fixed four-spelling list built
 * from it would have refused every paid job carrying a VIDEO reference. That is
 * what `RECORDED_MEDIA_DATA_TYPES` and `echoedMediaVideoInput` below exist for.
 *
 * 20 September 2026, FOURTH recording — `show_generations(type=audio)`, free and
 * read-only, no job submitted. Completed `seed_audio` jobs
 * (70990834-1f07-45aa-a325-a8bc55d1d921, 87c8a5b1-1863-43b8-8265-614605d17fad,
 * d0450755-703e-43c0-b15e-24a8f75d433e) echo TWO `params.medias` entries where
 * we would have sent ONE. The extra entry is the VOICE reference, supplied
 * through the model's own `voice_type` / `voice_id` pair and not through any
 * medias array, and its `data` carries only a `url` — no `id`, no `type`:
 *
 *     "medias":[{"role":"audio","data":{"url":"https://…/6f332b29-….wav"}},
 *               {"role":"audio","data":{"id":"70bbc31b-18b4-4ccd-b60f-8b06e380af61",
 *                                       "type":"audio_input","url":"https://…_sfx.wav"}}]
 *
 * The third recording's comment said this was "NOT yet handled anywhere", and it
 * was not: both contracts required `p.medias.length === params.medias.length`,
 * so a job that used a voice was refused on the COUNT alone. `injectedVoiceUrl`
 * below builds that first entry, and `consumerEchoedMediasMatch` is the rule
 * that walks past it — every reference we sent still matched by its exact uuid,
 * in the order we sent it.
 *
 * `show_generations` returns the same per-entry shape as `job_display`'s
 * `results` elements. The live `nano_banana_2` image entries carry NO nested
 * `params.model` at all and an extra `results.minUrl`, so a nested `model` is
 * per-family and is never the model id.
 */

/** One reference file as the provider echoes it back. `kind` is the media KIND
 * the provider reports under `role` — NOT the slot role we sent; recorded from
 * life (see above). It defaults to `image`, the only kind observed so far. */
export type EnvelopeMedia = {
  id: string;
  url: string;
  kind?: "image" | "video" | "audio";
  /** The echoed `data.type`. Defaults to `media_input`; the live per-kind
   * spellings are in `RECORDED_MEDIA_DATA_TYPES`. */
  dataType?: string;
};

/** Every `data.type` spelling recorded from the live account on 20 September
 * 2026, with the model each came from. Recorded, not assumed. */
export const RECORDED_MEDIA_DATA_TYPES = Object.freeze({
  /** seedance_2_5, nano_banana_2_lite, seedream_v5_pro — image references. */
  media_input: "media_input",
  /** reframe — the single `video` reference on a completed job. */
  video_input: "video_input",
  /** seed_audio — the audio reference. */
  audio_input: "audio_input",
} as const);

export type EnvelopeJob = {
  jobId: string;
  model: string;
  type: string;
  /** The prompt we submitted; the provider echoes it verbatim under `params`. */
  prompt: string;
  /** Reference files echoed under `params.medias`, in the order we sent them. */
  medias?: EnvelopeMedia[];
  /** The voice reference the account INJECTS ahead of our own references when
   * the request used a voice (`voice_type` / `voice_id`) — recorded from life on
   * `seed_audio`; we never sent it, and its `data` carries only this url. */
  injectedVoiceUrl?: string;
  rawUrl: string;
};

const THUMBNAIL = "https://fixtures.particl.invalid/outputs/thumb.jpg";

/** One echoed `params.medias` entry, exactly as recorded: the KIND under
 * `role`, and a `<kind>_input` spelling under `data.type`. */
export const echoedMedia = (media: EnvelopeMedia) => ({
  role: media.kind ?? "image",
  data: { id: media.id, type: media.dataType ?? RECORDED_MEDIA_DATA_TYPES.media_input, url: media.url },
});

/** The extra `params.medias` entry the account injects for a voice, exactly as
 * recorded from production on 20 September 2026 (url synthetic; the key set and
 * every label as recorded): the media KIND under `role`, and a `data` carrying
 * only a `url` — no `id`, no `type`, so it names no media of ours. */
export const echoedInjectedVoice = (url: string, kind: "audio" | "video" | "image" = "audio") => ({
  role: kind,
  data: { url },
});
/** Every echoed `params.medias` entry for a job, in the recorded order: the
 * provider's injected voice first, then our own references. */
export const echoedMedias = (job: EnvelopeJob) => [
  ...(job.injectedVoiceUrl ? [echoedInjectedVoice(job.injectedVoiceUrl, job.medias?.[0]?.kind ?? "audio")] : []),
  ...(job.medias ?? []).map(echoedMedia),
];

/** The reframe entry as recorded from production on 20 September 2026 (ids and
 * url synthetic; every key, shape and label as recorded): a `video` role with
 * `video_input` under `data.type`. */
export const echoedMediaVideoInput = (media: Omit<EnvelopeMedia, "kind" | "dataType">) =>
  echoedMedia({ ...media, kind: "video", dataType: RECORDED_MEDIA_DATA_TYPES.video_input });

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
        ...(echoedMedias(job).length ? { medias: echoedMedias(job) } : {}),
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
