import { z } from "zod";
import { GENJUTSU_VARIANTS } from "../genjutsuTypes";
import { consumerEchoedMediasMatch } from "./catalogue";
import {
  CONNECTED_MODEL_VARIANTS,
  ConsumerVideoError,
  consumerVideoAcknowledgement,
} from "./video-contract";

export const CONSUMER_GENJUTSU_MODELS = {
  "motion-transfer": "hf_mult_motion_control",
  "object-swap": "hf_mult_replace_object",
} as const;
export const CONSUMER_GENJUTSU_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const consumerMediaIdentitySchema = z
  .object({ uploadId: id.optional(), genId: id.optional() })
  .strict()
  .refine((value) => Boolean(value.uploadId) !== Boolean(value.genId));
export const consumerGenjutsuInputSchema = z
  .object({
    variant: z.enum(GENJUTSU_VARIANTS),
    resolution: z.enum(CONSUMER_GENJUTSU_RESOLUTIONS),
    prompt: z.string().max(5000),
    source: consumerMediaIdentitySchema,
    references: z.array(consumerMediaIdentitySchema).max(30),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = [value.source, ...value.references].map((ref) =>
      ref.genId ? `generation:${ref.genId}` : `upload:${ref.uploadId}`,
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: "custom",
        message: "Choose distinct original sources.",
      });
  });
export type ConsumerGenjutsuInput = z.infer<typeof consumerGenjutsuInputSchema>;
export type ConsumerMediaIdentity = z.infer<typeof consumerMediaIdentitySchema>;
/**
 * The roles the transform workflow SENDS, taken from the live catalogue rather
 * than invented. `hf_mult_motion_control` and `hf_mult_replace_object` both
 * declare exactly `["image_references", "video_references"]` (read free from
 * `models_explore(get …)` on 20 September 2026), and
 * `validateGenerationRequest` rejects any role that is not a declared slot.
 * This path used to send `video` / `image`, which no model declares: it only
 * survived because it never ran through that validator. The source video is
 * index 0; every later entry is an image reference.
 */
export const CONSUMER_GENJUTSU_ROLES = ["video_references", "image_references"] as const;
export type ConsumerGenjutsuRole = (typeof CONSUMER_GENJUTSU_ROLES)[number];
export const consumerGenjutsuRole = (index: number): ConsumerGenjutsuRole =>
  index === 0 ? "video_references" : "image_references";
export type ConsumerGenjutsuMedia = { value: string; role: ConsumerGenjutsuRole };
export type ConsumerGenjutsuParams = {
  model: (typeof CONSUMER_GENJUTSU_MODELS)[keyof typeof CONSUMER_GENJUTSU_MODELS];
  prompt: string;
  resolution: ConsumerGenjutsuInput["resolution"];
  medias: ConsumerGenjutsuMedia[];
  count: 1;
  use_unlim: false;
};
export function parseConsumerGenjutsuInput(
  value: unknown,
): ConsumerGenjutsuInput {
  const parsed = consumerGenjutsuInputSchema.safeParse(value);
  if (!parsed.success) throw new ConsumerVideoError("invalid_input");
  const keys = [parsed.data.source, ...parsed.data.references].map(
    consumerMediaKey,
  );
  if (new Set(keys).size !== keys.length)
    throw new ConsumerVideoError("invalid_input");
  return parsed.data;
}
export const consumerMediaKey = (ref: ConsumerMediaIdentity) =>
  ref.genId ? `generation:${ref.genId}` : `upload:${ref.uploadId}`;
export function consumerGenjutsuParams(
  input: ConsumerGenjutsuInput,
  medias: ConsumerGenjutsuMedia[],
): ConsumerGenjutsuParams {
  const checked = parseConsumerGenjutsuInput(input);
  if (
    medias.length !== checked.references.length + 1 ||
    medias.some(
      (m, i) =>
        !z.uuid().safeParse(m.value).success ||
        m.role !== consumerGenjutsuRole(i),
    )
  )
    throw new ConsumerVideoError("invalid_input");
  return {
    model: CONSUMER_GENJUTSU_MODELS[checked.variant],
    prompt: checked.prompt,
    resolution: checked.resolution,
    medias: medias.map((m) => ({ ...m })),
    count: 1,
    use_unlim: false,
  };
}
export function consumerGenjutsuAcknowledgement(
  value: unknown,
  model: ConsumerGenjutsuParams["model"],
) {
  return consumerVideoAcknowledgement(value, model);
}
/** The advertised normalized job_status schema, requested with raw_data:false.
 * No raw-data aliases, thumbnail fallback, or inferred result locations. */
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function generationEvidence(
  value: unknown,
  jobId: string,
  params: ConsumerGenjutsuParams,
) {
  if (!record(value) || !record(value.generation)) return null;
  if (
    ["id", "job_id", "jobs", "job_ids", "results"].some((k) => k in value) &&
    consumerGenjutsuAcknowledgement(value, params.model) !== jobId
  )
    return null;
  const g = value.generation;
  if (
    g.id !== jobId ||
    g.model !== params.model ||
    g.type !== "video" ||
    typeof g.status !== "string" ||
    !record(g.params) ||
    g.params.prompt !== params.prompt
  )
    return null;
  if ("status" in value && value.status !== g.status) return null;
  const aliases = Object.fromEntries(
    ["id", "job_id", "jobs", "job_ids"]
      .filter((k) => k in g)
      .map((k) => [k, g[k]]),
  );
  if (consumerGenjutsuAcknowledgement(aliases, params.model) !== jobId)
    return null;
  const p = g.params;
  // `params.model` is a per-family VARIANT selector on some families, not a
  // model id (see CONNECTED_MODEL_VARIANTS): the live connected account echoes
  // `params.model: "default"` beside a top-level `model: "seedance_2_5"`. The
  // model identity is `g.model`, compared strictly above; a variant word is
  // tolerated here and every other differing value still refuses the job.
  if (
    ("model" in p &&
      p.model !== params.model &&
      !(typeof p.model === "string" && CONNECTED_MODEL_VARIANTS.has(p.model))) ||
    ("count" in p && p.count !== 1) ||
    ("use_unlim" in p && p.use_unlim !== false)
  )
    return null;
  if ("resolution" in p && p.resolution !== params.resolution) return null;
  if (p.medias != null) {
    // The provider echoes the media KIND under `role` and a `<kind>_input`
    // spelling under `data.type` (`media_input`, `video_input`, `audio_input`
    // all recorded from life) — see consumerEchoedMediaMatches. This check used
    // to demand the slot name we sent AND a `video`/`image` type, so it refused
    // every completed transform job we had already paid for; a fixed list of
    // four type spellings then still refused any VIDEO reference.
    // `data` is still required here, and `data.id` is still exact.
    // The equal-length rule went with it: the account injects entries we never
    // sent (recorded on `seed_audio`, whose voice is echoed as an extra medias
    // entry with only a `url` under `data`), and refusing on the count alone
    // discarded a completed, PAID job. This path has no voice of its own, but
    // the echo is the same envelope and the same injection is possible. Every
    // reference we sent must still appear, `data` and all, matched by its exact
    // uuid and in the order we sent it; only entries naming no media are
    // skipped — see consumerEchoedMediasMatch.
    if (!consumerEchoedMediasMatch(p.medias, params.medias, { requireData: true }))
      return null;
  }
  return g;
}
export function consumerGenjutsuOriginalResult(
  value: unknown,
  jobId: string,
  params: ConsumerGenjutsuParams,
): { url: string } | null {
  const g = generationEvidence(value, jobId, params);
  if (
    !g ||
    g.status !== "completed" ||
    !record(g.results) ||
    typeof g.results.rawUrl !== "string"
  )
    return null;
  try {
    const url = new URL(g.results.rawUrl);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
      ? { url: url.toString() }
      : null;
  } catch {
    return null;
  }
}
export function consumerGenjutsuFailureResult(
  value: unknown,
  jobId: string,
  params: ConsumerGenjutsuParams,
): string | null {
  const g = generationEvidence(value, jobId, params);
  if (
    !g ||
    !["failed", "canceled", "nsfw", "ip_detected"].includes(String(g.status))
  )
    return null;
  if (g.results != null) return null;
  return String(g.status);
}
