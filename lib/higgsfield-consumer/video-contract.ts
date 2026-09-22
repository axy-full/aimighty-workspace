import { z } from "zod";
import type { QualificationValue } from "./qualification";

/**
 * Family variant selectors the provider echoes back under `params.model`.
 *
 * `params.model` is NOT a model id on every family. The live connected account
 * returns, for one completed seedance_2_5 video, a top-level
 * `model: "seedance_2_5"` (the model id) with a nested
 * `params.model: "default"` — a per-family variant selector — while the live
 * nano_banana_2 image entries carry no nested `model` at all. `model` is a
 * RESERVED_PARAMETER we always send as the model id, so the value coming back
 * is the provider's own canonical params, not ours.
 *
 * The model identity is therefore taken from the ENTRY's top-level `model`,
 * which is compared strictly against the model we paid for above and re-checked
 * through the acknowledgement aliases. The nested value is tolerated only when
 * it is one of these variant words; any other value that is not our model id is
 * still a mismatch and still refuses the job, so a provider that echoed a
 * different real model id under `params.model` is rejected exactly as before.
 *
 * Deliberately an allow-set rather than "anything that does not look like a
 * model id": three ids in the live catalogue (`autosprite`, `outpaint`,
 * `clipify`) are bare lower-case words, so a structural test would read a real
 * model substitution as a variant. None of these words is a catalogue id.
 */
export const CONNECTED_MODEL_VARIANTS: ReadonlySet<string> = new Set([
  "default",
  "standard",
  "std",
  "pro",
  "fast",
  "turbo",
  "lite",
  "quality",
]);

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
export const CONSUMER_VIDEO_MODES = [
  "ugc", "ugc_how_to", "ugc_unboxing", "product_showcase", "product_review",
  "tv_spot", "wild_card", "ugc_virtual_try_on", "virtual_try_on",
] as const;
/** The modes that take a hook and a setting (references/marketing-modes.md). */
export const CONSUMER_VIDEO_SETUP_MODES = ["ugc", "ugc_how_to", "ugc_unboxing", "product_review", "ugc_virtual_try_on"] as const;
export const CONSUMER_VIDEO_MEDIA_ROLES = ["image", "start_image", "end_image"] as const;
const setupId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
/**
 * FINAL_SPEC §2.1: the whole Marketing Studio contract (cli/MODELS.md ›
 * marketing_studio_video). Everything past the first six fields is optional
 * and omitted from the params when absent, so quotes admitted before this
 * widening still match. The two server rules are enforced here as well:
 * "Ad_reference_id cannot be combined with hook_id or setting_id" and
 * "Product_ids and web_product_ids cannot both be set".
 */
export const consumerVideoInputSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(5000)
      .refine((value) => value.trim().length > 0),
    /* ≥ 4 per the schema; the account's own range caps it at quote time. */
    duration: z.number().int().min(4).max(120),
    resolution: z.enum(CONSUMER_VIDEO_RESOLUTIONS),
    aspectRatio: z.enum(CONSUMER_VIDEO_RATIOS),
    generateAudio: z.boolean(),
    // Omission preserves previously admitted quotes and their provider UGC default.
    mode: z.enum(CONSUMER_VIDEO_MODES).optional(),
    productIds: z.array(setupId).max(8).optional(),
    webProductIds: z.array(setupId).max(8).optional(),
    avatars: z.array(z.object({ id: setupId, type: z.enum(["preset", "custom"]) }).strict()).max(1).optional(),
    hookId: setupId.optional(),
    settingId: setupId.optional(),
    adReferenceId: setupId.optional(),
    /** Connected media ids (completed imports) with their roles. */
    medias: z.array(z.object({ id: z.string().uuid(), role: z.enum(CONSUMER_VIDEO_MEDIA_ROLES) }).strict()).max(14).optional(),
    /** Click-to-Ad: the account fetches the page and dedupes by URL. */
    productUrl: z.string().url().max(2048).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.productIds?.length && value.webProductIds?.length)
      ctx.addIssue({ code: "custom", message: "Product_ids and web_product_ids cannot both be set." });
    if (value.adReferenceId && (value.hookId || value.settingId))
      ctx.addIssue({ code: "custom", message: "Ad_reference_id cannot be combined with hook_id or setting_id." });
    if ((value.hookId || value.settingId) && !(CONSUMER_VIDEO_SETUP_MODES as readonly string[]).includes(value.mode ?? "ugc"))
      ctx.addIssue({ code: "custom", message: "Hooks and settings are valid only for the UGC family of modes." });
  });
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
  | "preflight_unavailable"
  | "tool_unavailable"
  | "tool_contract_changed"
  | "status_unavailable";
const messages: Record<ConsumerVideoErrorCode, string> = {
  invalid_input: "Review the video prompt, references and settings.",
  invalid_workspace:
    "The connected account did not return one selected billing workspace.",
  workspace_changed:
    "The selected connected-account billing workspace changed. Request a new quote.",
  invalid_quote: "The connected account did not return a usable exact credit quote.",
  quote_changed: "The connected-account price changed. Request a new quote.",
  unapproved_adjustment:
    "The connected account changed a requested setting. Review a new quote before continuing.",
  insufficient_credits:
    "The selected connected workspace has insufficient credits.",
  invalid_job: "The connected account did not return the requested job.",
  provider_error: "The connected account could not complete this request.",
  preflight_unavailable:
    "The connected account could not verify the submission prerequisites. No video was submitted.",
  // Connected toolset guard: neutral copy, shown as is by every surface.
  tool_unavailable:
    "The connected account does not currently offer this action. Nothing was sent and no credits were spent.",
  tool_contract_changed:
    "The connected account changed the settings this action accepts. Nothing was sent and no credits were spent.",
  status_unavailable:
    "The connected account does not currently offer a status check for this job. It stays saved; check again later.",
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
              "tool_unavailable",
              "tool_contract_changed",
            ].includes(code)
          ? 409
          : code === "status_unavailable"
            ? 503
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
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.productIds?.length ? { product_ids: [...input.productIds] } : {}),
    ...(input.webProductIds?.length ? { web_product_ids: [...input.webProductIds] } : {}),
    ...(input.avatars?.length ? { avatars: input.avatars.map((a) => ({ id: a.id, type: a.type })) } : {}),
    ...(input.hookId ? { hook_id: input.hookId } : {}),
    ...(input.settingId ? { setting_id: input.settingId } : {}),
    ...(input.adReferenceId ? { ad_reference_id: input.adReferenceId } : {}),
    ...(input.medias?.length ? { medias: input.medias.map((m) => ({ value: m.id.toLowerCase(), role: m.role })) } : {}),
    ...(input.productUrl ? { product: { url: input.productUrl } } : {}),
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
  return parseConsumerCreditsForParams(value, consumerVideoParams(input, true));
}
/** Float noise in the account's own arithmetic (12.12 arrives as
 * 12.120000000000001), never a tolerance on the price itself. */
const CREDITS_EPSILON = 1e-9;
/**
 * The charged figure out of a `{cost:{credits, credits_exact}}` reply.
 *
 * Both recorded live shapes (`tests/fixtures/connected-shorts-studio.json`,
 * recorded from production 2026-09-20) are accepted and nothing else:
 * - `{credits: 12, credits_exact: 12}` — a whole-unit price; the two agree.
 * - `{credits: 12, credits_exact: 12.120000000000001}` — the same price with a
 *   fractional part, where `credits` is the integer the account charges and
 *   `credits_exact` is that price unrounded. The account's own rounding is
 *   truncation, so `credits` must be an integer and `credits_exact` must sit in
 *   `[credits, credits + 1)`.
 *
 * Everything else is ambiguous and refused: a missing, non-numeric or
 * non-finite figure, a zero or negative price, a range (min/max, or `credits`
 * as anything but a number), an exact figure BELOW the charged one, or a gap of
 * a whole credit or more — which would mean a rounding we have not recorded and
 * cannot bind an approval to. The returned figure is always the account's own
 * `credits`, never a default, never a bound of a range, and never derived from
 * `credits_exact` alone.
 */
export function parseConsumerCreditsForParams(value: QualificationValue, params: Record<string, unknown>): number {
  if (!record(value) || !record(value.cost))
    throw new ConsumerVideoError("invalid_quote");
  const { credits, credits_exact: exact } = value.cost;
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    credits <= 0 ||
    credits > Number.MAX_SAFE_INTEGER ||
    typeof exact !== "number" ||
    !Number.isFinite(exact)
  )
    throw new ConsumerVideoError("invalid_quote");
  const agrees = Math.abs(exact - credits) <= CREDITS_EPSILON;
  const truncated = Number.isInteger(credits) && exact > credits && exact < credits + 1;
  // Do not silently choose between conflicting rounded/exact billing amounts.
  if (!agrees && !truncated) throw new ConsumerVideoError("invalid_quote");
  if (value.adjustments !== undefined) {
    if (!record(value.adjustments))
      throw new ConsumerVideoError("unapproved_adjustment");
    for (const [key, adjustment] of Object.entries(value.adjustments)) {
      if (
        !key.startsWith("params.") ||
        !Object.hasOwn(params, key.slice(7)) ||
        !record(adjustment) ||
        !sameConsumerValue(adjustment.requested, params[key.slice(7)]) ||
        !sameConsumerValue(adjustment.used, params[key.slice(7)])
      )
        throw new ConsumerVideoError("unapproved_adjustment");
    }
  }
  return credits;
}

/**
 * Keys under which this provider nests a job list at the TOP LEVEL of a reply.
 *
 * Recorded read-only from the live connected account on 20 September 2026 — no
 * job was submitted and nothing was billed:
 *
 *     job_display(id)                        -> {"results":[{id,type,status,model,params,results,createdAt}]}
 *     jobs_wait(jobs:[…])                    -> {"jobs":[{index,job_id,status,type,model,result_url,…}]}
 *     show_marketing_studio_generations      -> {"items":[{id,type,status,model,params,results,createdAt}],"next_cursor":null}
 *     video_analysis_jobs                    -> {"items":[],"total_count":0,"cursor":null}
 *
 * The per-entry shape is identical across all four; only the list key differs.
 * `data` is carried over from `normalizeFallbackStatus`, which searched it
 * before this helper existed. A reader that looks only for the job under a
 * single-object key (`generation`, `raw_data`, `analysis`, `result`) and then
 * falls through to the reply itself finds no `status` in any of these, returns
 * null forever, and never collects a finished, PAID job — the defect #251
 * fixed for `job_display`.
 */
export const CONNECTED_LIST_KEYS = ["results", "jobs", "items", "data"] as const;
const DEFAULT_ENTRY_ID_KEYS = ["id", "job_id", "jobId"] as const;
/** The one id a list entry names: every id key it carries must be a uuid, and
 * they must agree. Conflicting or malformed ids name nothing. */
function entryId(entry: Record<string, unknown>, idKeys: readonly string[]): string | null {
  const ids = idKeys.filter((key) => key in entry).map((key) => entry[key]);
  if (!ids.length || ids.some((id) => !uuid(id))) return null;
  const unique = new Set((ids as string[]).map((id) => id.toLowerCase()));
  return unique.size === 1 ? [...unique][0] : null;
}
/**
 * Exactly one entry of the reply's top-level job list naming the acknowledged
 * job, or null. Only the FIRST list key present is searched, so a reply cannot
 * be made to yield an entry from a second list. Two entries naming that id, or
 * none, leave the reply inert — the same rule `normalizeFallbackStatus` and
 * `consumerVideoAcknowledgement` apply. The entry is bound to the id we
 * received from our own acknowledged submission and to nothing else.
 */
export function connectedListEntry(
  value: Record<string, unknown>,
  jobId: string,
  idKeys: readonly string[] = DEFAULT_ENTRY_ID_KEYS,
): Record<string, unknown> | null {
  const key = CONNECTED_LIST_KEYS.find((name) => Array.isArray(value[name]));
  if (key === undefined) return null;
  const wanted = jobId.toLowerCase();
  const matching = (value[key] as unknown[]).filter(
    (item): item is Record<string, unknown> => record(item) && entryId(item, idKeys) === wanted,
  );
  return matching.length === 1 ? matching[0] : null;
}
/** Only explicit structured identifiers are evidence of acceptance. Prose and
 * arbitrary nested IDs are not searched; conflicting or malformed IDs fail closed. */
export function consumerVideoAcknowledgement(
  value: unknown,
  expectedModel = "marketing_studio_video",
  expectedType = "video",
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
      if (!record(result) || result.model !== expectedModel || result.type !== expectedType) invalid = true;
      else entry(result);
    }
  }
  return !invalid && new Set(ids).size === 1 ? ids[0] : null;
}
export function validateConsumerVideoStatus(
  value: QualificationValue,
  expectedJobId: string,
  expectedModel = "marketing_studio_video",
  expectedType = "video",
) {
  if (!record(value)) throw new ConsumerVideoError("invalid_job");
  if (
    ["job_id", "id", "jobs", "job_ids", "results"].some((key) => key in value) &&
    consumerVideoAcknowledgement(value, expectedModel, expectedType) !== expectedJobId
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

/** Qualified owner status response, 2026-09-18. Unknown structures are diagnostic
 * only: never scrape alternate URLs or interpret provider text as instructions. */
export function consumerVideoOriginalResult(
  value: unknown,
  expectedJobId: string,
  input: ConsumerVideoInput,
): { url: string } | null {
  if (!record(value) || !record(value.raw_data)) return null;
  if ("status" in value && value.status !== "completed") return null;
  if (["job_id", "id", "jobs", "job_ids", "results"].some(key => key in value) &&
      consumerVideoAcknowledgement(value) !== expectedJobId.toLowerCase()) return null;
  const raw = value.raw_data;
  if (!uuid(raw.id) || consumerVideoAcknowledgement(raw) !== expectedJobId.toLowerCase() ||
      raw.status !== "completed" || raw.job_set_type !== "marketing_studio_video" || !record(raw.params)) return null;
  const params = raw.params;
  if (params.prompt !== input.prompt || params.duration !== input.duration ||
      params.resolution !== input.resolution || params.aspect_ratio !== input.aspectRatio ||
      params.generate_audio !== input.generateAudio || params.mode !== (input.mode ?? "ugc")) return null;
  /* FINAL_SPEC §2.1: a job carrying exactly the ids and medias we sent is ours;
     one carrying anything we did not send is still refused. */
  const sent = consumerVideoParams(input, false) as Record<string, unknown>;
  const sameIds = (key: string, ours: unknown) => {
    const theirs = params[key];
    if (ours === undefined) return theirs == null || (Array.isArray(theirs) && theirs.length === 0);
    return Array.isArray(theirs) && Array.isArray(ours) && theirs.length === ours.length && theirs.every((v, i) => String(v).toLowerCase() === String(ours[i]).toLowerCase());
  };
  if (!sameIds("product_ids", sent.product_ids) || !sameIds("web_product_ids", sent.web_product_ids)) return null;
  if ("products" in params && !sameIds("products", sent.product_ids)) return null;
  if ("avatars" in params) {
    const theirs = params.avatars;
    if (!Array.isArray(theirs)) return null;
    const ours = (sent.avatars as { id: string }[] | undefined) ?? [];
    if (theirs.length !== ours.length || theirs.some((a, i) => !record(a) || String(a.id).toLowerCase() !== ours[i].id.toLowerCase())) return null;
  }
  if ("avatar_ids" in params && params.avatar_ids != null && !sameIds("avatar_ids", (sent.avatars as { id: string }[] | undefined)?.map((a) => a.id))) return null;
  if ("medias" in params) {
    const theirs = params.medias, ours = (sent.medias as { value: string; role: string }[] | undefined) ?? [];
    if (!Array.isArray(theirs) || theirs.length !== ours.length) return null;
    if (theirs.some((m, i) => !record(m) || String(m.value ?? m.id).toLowerCase() !== ours[i].value || (m.role !== undefined && m.role !== ours[i].role))) return null;
  }
  for (const key of ["web_products", "reference_elements"])
    if (key in params && params[key] !== null && (!Array.isArray(params[key]) || params[key].length !== 0)) return null;
  for (const [key, ours] of [["ad_reference_id", sent.ad_reference_id], ["hook_id", sent.hook_id], ["setting_id", sent.setting_id]] as const)
    if ((params[key] ?? null) !== (ours ?? null) && String(params[key] ?? "").toLowerCase() !== String(ours ?? "").toLowerCase()) return null;
  for (const key of ["storyboard_id", "hook", "setting"])
    if (params[key] != null) return null;
  if (("count" in params && params.count !== 1) || ("use_unlim" in params && params.use_unlim !== false)) return null;
  if (typeof raw.result_url !== "string" || raw.result_url.length > 8192) return null;
  try {
    const url = new URL(raw.result_url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return null;
    return { url: url.href };
  } catch { return null; }
}

export const ENHANCED_PROMPT_MAX = 8000;
/**
 * The prompt the account says it actually rendered (`params.enhanced_prompt`),
 * as inert provenance: control characters dropped, links omitted, capped.
 * Provider-authored text is shown, never used as an instruction.
 */
export function providerEnhancedPrompt(params: unknown): { text: string; truncated: boolean } | undefined {
  if (!record(params) || typeof params.enhanced_prompt !== "string") return undefined;
  const text = params.enhanced_prompt
    .replace(/\p{Cc}/gu, character => character === "\n" || character === "\t" ? character : "")
    .replace(/https?:\/\/[^\s<>"']+/giu, "[link omitted]")
    .trim();
  if (!text) return undefined;
  return { text: text.slice(0, ENHANCED_PROMPT_MAX), truncated: text.length > ENHANCED_PROMPT_MAX };
}

/** Inert provenance only, called after the terminal identity/settings validation.
 * Do not use provider-authored text as an instruction or persist delivery URLs. */
export function consumerVideoProviderResult(value: unknown, input: ConsumerVideoInput) {
  const raw = record(value) && record(value.raw_data) ? value.raw_data : null;
  const enhanced = providerEnhancedPrompt(raw && record(raw.params) ? raw.params : null);
  return {
    model: "marketing_studio_video" as const,
    mode: input.mode ?? "ugc",
    ...(enhanced === undefined ? {} : {
      enhancedPrompt: enhanced.text,
      ...(enhanced.truncated ? { enhancedPromptTruncated: true as const } : {}),
    }),
  };
}

/** JSON structural equality; provider object key order does not change consent. */
export function sameConsumerValue(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>sameConsumerValue(v,b[i]));
  if(!a||!b||typeof a!=="object"||typeof b!=="object")return false;
  const left=a as Record<string,unknown>,right=b as Record<string,unknown>,keys=Object.keys(left);
  return keys.length===Object.keys(right).length&&keys.every(k=>Object.hasOwn(right,k)&&sameConsumerValue(left[k],right[k]));
}
