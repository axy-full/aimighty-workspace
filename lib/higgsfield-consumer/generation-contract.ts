/**
 * Typed contract for the catalogue-driven "Generate" workflows (image, video,
 * audio, 3D) on the connected account. Mirrors the Genjutsu contract: an
 * immutable input, provider params built only from validated declarations,
 * a strict acknowledgement and a strict normalized status envelope.
 */
import { z } from "zod";
import {
  CONNECTED_OUTPUT_TYPES,
  MEDIA_ROLE,
  MODEL_ID,
  PROMPT_LIMIT,
  MEDIA_LIMIT,
  mediaKindForRole,
  validateGenerationRequest,
  type ConnectedModel,
  type ConnectedOutputType,
} from "./catalogue";
import { CONNECTED_TOOL_NAMES, requireConnectedTool, validateToolRequest } from "./tools";
import { consumerMediaIdentitySchema, consumerMediaKey } from "./genjutsu-contract";
import { ConsumerVideoError, consumerVideoAcknowledgement } from "./video-contract";

const parameterValue = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(32),
]);
export const consumerGenerationInputSchema = z
  .object({
    type: z.enum(CONNECTED_OUTPUT_TYPES),
    model: z.string().regex(MODEL_ID),
    prompt: z.string().max(PROMPT_LIMIT),
    parameters: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), parameterValue)
      .refine((value) => Object.keys(value).length <= 64),
    medias: z
      .array(
        z
          .object({ role: z.string().regex(MEDIA_ROLE), source: consumerMediaIdentitySchema })
          .strict(),
      )
      .max(MEDIA_LIMIT),
    /** Present when a media tool preset produced the request; the chosen
     * model must be the request's model. Never sent to the provider. */
    tool: z.object({ name: z.enum(CONNECTED_TOOL_NAMES), model: z.string().regex(MODEL_ID) }).strict().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.medias.map((media) => consumerMediaKey(media.source));
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Choose distinct reference files." });
    if (value.tool && value.tool.model !== value.model)
      ctx.addIssue({ code: "custom", message: "The tool's model must be the request's model." });
  });
export type ConsumerGenerationInput = z.infer<typeof consumerGenerationInputSchema>;
export type ConsumerGenerationMedia = { value: string; role: string };
export type ConsumerGenerationParams = Record<string, string | number | boolean | string[] | ConsumerGenerationMedia[]> & {
  model: string;
  medias: ConsumerGenerationMedia[];
  count: 1;
  use_unlim: false;
};
export const GENERATION_TOOLS: Record<ConnectedOutputType, string> = {
  image: "generate_image",
  video: "generate_video",
  audio: "generate_audio",
  "3d": "generate_3d",
};
export function parseConsumerGenerationInput(value: unknown): ConsumerGenerationInput {
  const parsed = consumerGenerationInputSchema.safeParse(value);
  if (!parsed.success) throw new ConsumerVideoError("invalid_input");
  return parsed.data;
}
/** The media kinds a request needs, derived from its roles (video/audio/image). */
export function consumerGenerationMediaKinds(input: ConsumerGenerationInput) {
  return input.medias.map((media) => ({ role: media.role, kind: mediaKindForRole(media.role), source: media.source }));
}
/** Validated against the catalogue entry; unknown settings are rejected here
 * and never reach the provider. Media UUIDs come from completed imports. */
export function consumerGenerationParams(
  model: ConnectedModel,
  input: ConsumerGenerationInput,
  medias: ConsumerGenerationMedia[],
): ConsumerGenerationParams {
  const checked = parseConsumerGenerationInput(input);
  const request = {
    type: checked.type,
    model: checked.model,
    prompt: checked.prompt,
    parameters: checked.parameters,
    medias: checked.medias.map((media) => ({ role: media.role, kind: mediaKindForRole(media.role) })),
  };
  const settings = checked.tool
    ? validateToolRequest(requireConnectedTool(checked.tool.name), model, request)
    : validateGenerationRequest(model, request);
  if (
    medias.length !== checked.medias.length ||
    medias.some((media, i) => !z.uuid().safeParse(media.value).success || media.role !== checked.medias[i].role)
  )
    throw new ConsumerVideoError("invalid_input");
  return {
    ...settings,
    model: checked.model,
    ...(checked.prompt.trim() ? { prompt: checked.prompt } : {}),
    medias: medias.map((media) => ({ value: media.value.toLowerCase(), role: media.role })),
    count: 1,
    use_unlim: false,
  };
}
export const consumerGenerationAcknowledgement = (value: unknown, model: string, type: ConnectedOutputType) =>
  consumerVideoAcknowledgement(value, model, type);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash ? url.toString() : null;
  } catch {
    return null;
  }
};
/** The normalized job_status envelope (raw_data:false): exactly the requested
 * job, model, output type and prompt. Anything else stays diagnostic. */
function evidence(value: unknown, jobId: string, params: ConsumerGenerationParams, type: ConnectedOutputType) {
  if (!record(value) || !record(value.generation)) return null;
  if (["id", "job_id", "jobs", "job_ids", "results"].some((k) => k in value) &&
      consumerGenerationAcknowledgement(value, params.model, type) !== jobId)
    return null;
  const g = value.generation;
  if (g.id !== jobId || g.model !== params.model || g.type !== type || typeof g.status !== "string") return null;
  if ("status" in value && value.status !== g.status) return null;
  const aliases = Object.fromEntries(["id", "job_id", "jobs", "job_ids"].filter((k) => k in g).map((k) => [k, g[k]]));
  if (consumerGenerationAcknowledgement(aliases, params.model, type) !== jobId) return null;
  if (g.params !== undefined) {
    if (!record(g.params)) return null;
    const p = g.params;
    if ("model" in p && p.model !== params.model) return null;
    if ("prompt" in p && "prompt" in params && p.prompt !== params.prompt) return null;
    if ("count" in p && p.count !== 1) return null;
    if ("use_unlim" in p && p.use_unlim !== false) return null;
    if (p.medias != null) {
      if (!Array.isArray(p.medias) || p.medias.length !== params.medias.length) return null;
      if (p.medias.some((m, i) => !record(m) || m.role !== params.medias[i].role ||
          (record(m.data) ? m.data.id !== params.medias[i].value : m.value !== undefined && m.value !== params.medias[i].value)))
        return null;
    }
  }
  return g;
}
export function consumerGenerationOriginalResult(
  value: unknown,
  jobId: string,
  params: ConsumerGenerationParams,
  type: ConnectedOutputType,
): { url: string } | null {
  const g = evidence(value, jobId, params, type);
  if (!g || g.status !== "completed" || !record(g.results)) return null;
  const url = safeUrl(g.results.rawUrl);
  return url ? { url } : null;
}
export function consumerGenerationFailureResult(
  value: unknown,
  jobId: string,
  params: ConsumerGenerationParams,
  type: ConnectedOutputType,
): string | null {
  const g = evidence(value, jobId, params, type);
  if (!g || !["failed", "canceled", "cancelled", "nsfw", "ip_detected"].includes(String(g.status))) return null;
  if (g.results != null) return null;
  return String(g.status);
}
/** What the collector must store for each output type. */
export const GENERATION_OUTPUT_KIND: Record<ConnectedOutputType, "image" | "video" | "audio" | "model"> = {
  image: "image",
  video: "video",
  audio: "audio",
  "3d": "model",
};
