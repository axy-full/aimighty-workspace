import { z } from "zod";
import type { QualificationValue } from "./qualification";

export const CONSUMER_VIDEO_RATIOS = [
  "auto",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
export const CONSUMER_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const consumerVideoInputSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(5000)
      .refine((value) => value.trim().length > 0),
    duration: z.number().int().min(12).max(15),
    resolution: z.enum(CONSUMER_VIDEO_RESOLUTIONS),
    aspectRatio: z.enum(CONSUMER_VIDEO_RATIOS),
    generateAudio: z.boolean(),
  })
  .strict();
export type ConsumerVideoInput = z.infer<typeof consumerVideoInputSchema>;
export type ConsumerVideoErrorCode =
  | "invalid_input"
  | "invalid_workspace"
  | "workspace_changed"
  | "invalid_quote"
  | "quote_changed"
  | "unapproved_adjustment"
  | "insufficient_credits"
  | "invalid_job"
  | "provider_error"
  | "preflight_unavailable";
const messages: Record<ConsumerVideoErrorCode, string> = {
  invalid_input: "Review the Marketing Video prompt and settings.",
  invalid_workspace:
    "Higgsfield did not return one selected billing workspace.",
  workspace_changed:
    "The selected Higgsfield billing workspace changed. Request a new quote.",
  invalid_quote: "Higgsfield did not return a usable exact credit quote.",
  quote_changed: "The Higgsfield price changed. Request a new quote.",
  unapproved_adjustment:
    "Higgsfield changed a requested setting. Review a new quote before continuing.",
  insufficient_credits:
    "The selected Higgsfield workspace has insufficient credits.",
  invalid_job: "Higgsfield did not return the requested job.",
  provider_error: "Higgsfield could not complete this read-only check.",
  preflight_unavailable:
    "Higgsfield could not verify the submission prerequisites. No video was submitted.",
};
/** These errors are raised only before a paid POST, or during a read. */
export class ConsumerVideoError extends Error {
  readonly paidAttempted = false;
  readonly status: number;
  constructor(readonly code: ConsumerVideoErrorCode) {
    super(messages[code]);
    this.name = "ConsumerVideoError";
    this.status =
      code === "invalid_input"
        ? 400
        : [
              "workspace_changed",
              "quote_changed",
              "unapproved_adjustment",
              "insufficient_credits",
            ].includes(code)
          ? 409
          : 502;
  }
}
export function parseConsumerVideoInput(
  input: unknown,
): Readonly<ConsumerVideoInput> {
  const result = consumerVideoInputSchema.safeParse(input);
  if (!result.success) throw new ConsumerVideoError("invalid_input");
  return Object.freeze(result.data);
}
export function consumerVideoParams(
  input: ConsumerVideoInput,
  getCost: boolean,
) {
  return {
    model: "marketing_studio_video",
    prompt: input.prompt,
    duration: input.duration,
    resolution: input.resolution,
    aspect_ratio: input.aspectRatio,
    generate_audio: input.generateAudio,
    count: 1,
    get_cost: getCost,
    use_unlim: false,
  } as const;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function consumerVideoJobId(value: unknown): string {
  if (!uuid(value)) throw new ConsumerVideoError("invalid_job");
  return value.toLowerCase();
}
export type ConsumerVideoWorkspace = {
  id: string;
  name?: string;
  credits: number;
};
export function parseConsumerVideoWorkspace(
  value: QualificationValue,
): ConsumerVideoWorkspace {
  if (
    !record(value) ||
    !Array.isArray(value.workspaces) ||
    value.workspaces.length > 200
  )
    throw new ConsumerVideoError("invalid_workspace");
  if (
    value.workspaces.some(
      (item) => !record(item) || typeof item.is_selected !== "boolean",
    )
  )
    throw new ConsumerVideoError("invalid_workspace");
  const selected = value.workspaces.filter(
    (item) => record(item) && item.is_selected === true,
  );
  const entry = selected[0];
  if (
    selected.length !== 1 ||
    !record(entry) ||
    !uuid(entry.id) ||
    typeof entry.credits !== "number" ||
    !Number.isFinite(entry.credits) ||
    entry.credits < 0 ||
    entry.credits > Number.MAX_SAFE_INTEGER
  )
    throw new ConsumerVideoError("invalid_workspace");
  return {
    id: entry.id.toLowerCase(),
    credits: entry.credits,
    ...(typeof entry.name === "string" && entry.name.length <= 200
      ? { name: entry.name }
      : {}),
  };
}
export function parseConsumerVideoCredits(
  value: QualificationValue,
  input: ConsumerVideoInput,
): number {
  if (!record(value) || !record(value.cost))
    throw new ConsumerVideoError("invalid_quote");
  const { credits, credits_exact: exact } = value.cost;
  // Do not silently choose between conflicting rounded/exact billing amounts.
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    credits <= 0 ||
    credits > Number.MAX_SAFE_INTEGER ||
    credits !== exact
  )
    throw new ConsumerVideoError("invalid_quote");
  if (value.adjustments !== undefined) {
    if (!record(value.adjustments))
      throw new ConsumerVideoError("unapproved_adjustment");
    const params: Record<string, unknown> = consumerVideoParams(input, true);
    for (const [key, adjustment] of Object.entries(value.adjustments)) {
      if (
        !key.startsWith("params.") ||
        !Object.hasOwn(params, key.slice(7)) ||
        !record(adjustment) ||
        adjustment.requested !== params[key.slice(7)] ||
        adjustment.used !== params[key.slice(7)]
      )
        throw new ConsumerVideoError("unapproved_adjustment");
    }
  }
  return credits;
}

/** Only explicit structured identifiers are evidence of acceptance. Prose and
 * arbitrary nested IDs are not searched; conflicting or malformed IDs fail closed. */
export function consumerVideoAcknowledgement(
  value: unknown,
): string | null {
  if (!record(value)) return null;
  const ids: string[] = [];
  let invalid = false;
  const add = (id: unknown) => {
    if (!uuid(id)) invalid = true;
    else ids.push(id.toLowerCase());
  };
  const entry = (item: unknown) => {
    if (typeof item === "string") return add(item);
    if (!record(item) || (!("job_id" in item) && !("id" in item))) {
      invalid = true;
      return;
    }
    if ("job_id" in item) add(item.job_id);
    if ("id" in item) add(item.id);
  };
  if ("job_id" in value) add(value.job_id);
  if ("id" in value) add(value.id);
  for (const key of ["jobs", "job_ids"])
    if (key in value) {
      if (!Array.isArray(value[key]) || value[key].length !== 1) invalid = true;
      else entry(value[key][0]);
    }
  // Observed Consumer Marketing Video acknowledgement, qualified 2026-09-18.
  // A batch or another model is not evidence for this single-video workflow.
  if ("results" in value) {
    if (!Array.isArray(value.results) || value.results.length !== 1) invalid = true;
    else {
      const result = value.results[0];
      if (!record(result) || result.model !== "marketing_studio_video" || result.type !== "video") invalid = true;
      else entry(result);
    }
  }
  return !invalid && new Set(ids).size === 1 ? ids[0] : null;
}
export function validateConsumerVideoStatus(
  value: QualificationValue,
  expectedJobId: string,
) {
  if (!record(value)) throw new ConsumerVideoError("invalid_job");
  if (
    ["job_id", "id", "jobs", "job_ids", "results"].some((key) => key in value) &&
    consumerVideoAcknowledgement(value) !== expectedJobId
  )
    throw new ConsumerVideoError("invalid_job");
  const wait = value.poll_after_seconds;
  if (
    wait !== undefined &&
    (typeof wait !== "number" ||
      !Number.isFinite(wait) ||
      wait < 0 ||
      wait > 3600)
  )
    throw new ConsumerVideoError("invalid_job");
  return {
    ...(typeof wait === "number"
      ? { pollAfterSeconds: Math.max(1, Math.ceil(wait)) }
      : {}),
  };
}
