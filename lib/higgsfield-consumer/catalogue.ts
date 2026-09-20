/**
 * The connected account's generation catalogue (`models_explore list`), parsed
 * into per-model constraints and cached for one hour per connection
 * fingerprint. Every generation request is validated here against the model's
 * declared parameters, media roles, aspect ratios and durations before any
 * paid call; parameters a model does not declare are never sent.
 *
 * Catalogue text is provider data shown to the owner. Provider names are not
 * part of the product vocabulary, so display names drop them.
 *
 * This module is pure (no database, no network) so the browser can reuse the
 * same constraint logic; the one-hour cache lives in catalogue-cache.ts.
 */
import { neutralModelText } from "../vendorNames";

export const CONNECTED_OUTPUT_TYPES = ["image", "video", "audio", "3d"] as const;
export type ConnectedOutputType = (typeof CONNECTED_OUTPUT_TYPES)[number];
export type ConnectedParameterType = "string" | "number" | "bool" | "string_array";
export type ConnectedParameter = {
  name: string;
  required: boolean;
  type: ConnectedParameterType;
  description?: string;
  options?: (string | number)[];
  min?: number;
  max?: number;
  default?: string | number | boolean | null;
  nullable?: boolean;
  /** string_array only: declared item cap. */
  maxItems?: number;
  /** True when derived from aspect_ratios/durations rather than declared. */
  synthetic?: boolean;
};
export type ConnectedMediaKind = "image" | "video" | "audio";
export type ConnectedMediaSlot = {
  name: string;
  roles: string[];
  max?: number;
  required: boolean;
  description?: string;
};
export type ConnectedModel = {
  id: string;
  /** Display name with provider names removed. */
  name: string;
  description: string;
  outputType: ConnectedOutputType;
  parameters: ConnectedParameter[];
  medias: ConnectedMediaSlot[];
  aspectRatios: string[];
  durations?: number[];
  durationRange?: { min: number; max: number };
  tags: string[];
  supportsUnlim: boolean;
};
export type ConnectedUnlim = {
  available: boolean;
  remaining: number | null;
  expiresAt: string | null;
};
export type ConnectedCatalogue = {
  models: ConnectedModel[];
  unlim: ConnectedUnlim;
  /** False when the provider reported more pages than were read. */
  complete: boolean;
  fetchedAt: number;
};
export const CATALOGUE_TTL_MS = 3_600_000;
export const CATALOGUE_LIMITS = {
  models: 400,
  parameters: 64,
  options: 256,
  medias: 8,
  roles: 16,
  aspectRatios: 32,
  tags: 64,
  jsonBytes: 1_048_576,
} as const;
/** Provider parameters the workflow owns; a request cannot set them itself.
 * `preset_id` stays reserved as a SETTING: it is carried only by a request's
 * own `presetId`, only for a model that declares it, and the service checks
 * the value against the connected account's live `presets_show` listing. */
export const RESERVED_PARAMETERS = Object.freeze([
  "model",
  "prompt",
  "medias",
  "count",
  "get_cost",
  "use_unlim",
  "preset_id",
  "declined_preset_id",
]);
const PROVIDER_NAME = /\bhiggsfield\b/gi;
export const MODEL_ID = /^[A-Za-z0-9_.-]{1,80}$/;
export const MEDIA_ROLE = /^[a-z][a-z0-9_]{0,39}$/;
export const PROMPT_LIMIT = 5000;
export const MEDIA_LIMIT = 30;

export type CatalogueErrorCode =
  | "invalid_catalogue"
  | "model_unknown"
  | "type_mismatch"
  | "parameter_unknown"
  | "parameter_reserved"
  | "parameter_required"
  | "parameter_invalid"
  | "media_role_unknown"
  | "media_limit"
  | "media_required"
  | "prompt_required"
  | "prompt_limit"
  | "tool_unknown"
  | "tool_model"
  | "tool_source";
export class CatalogueError extends Error {
  readonly status: number;
  constructor(
    readonly code: CatalogueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CatalogueError";
    this.status = code === "invalid_catalogue" ? 502 : 400;
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(): never {
  throw new CatalogueError(
    "invalid_catalogue",
    "The connected account returned an unusable model catalogue.",
  );
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) return invalid();
  return value.replace(/\p{Cc}/gu, "").trim();
}
/** Product copy never names the provider; catalogue names are shown without it. */
export function displayName(value: string) {
  return neutralModelText(value.replace(PROVIDER_NAME, "").replace(/\s{2,}/g, " ").trim());
}

/** Workflows the catalogue names only by their provider's brand. */
const WORKFLOW_NAMES: Record<string, string> = {
  hf_mult_motion_control: "Motion Transfer",
  hf_mult_replace_object: "Object Swap",
};
export function mediaKindForRole(role: string): ConnectedMediaKind {
  if (/video/.test(role)) return "video";
  if (/audio/.test(role)) return "audio";
  return "image";
}
/**
 * The `data.type` spellings an echoed reference has actually been OBSERVED to
 * carry on the live account, with the date each was recorded. This list is
 * documentation and test material; the accepting rule is
 * `echoedMediaTypeAccepted` below, which is deliberately wider than the list.
 *
 * - `media_input` — 20 September 2026, image references on `seedance_2_5`,
 *   `nano_banana_2_lite` and `seedream_v5_pro`.
 * - `video_input` — 20 September 2026, the single `video` reference on a
 *   completed `reframe` job (`show_generations(type=video)`).
 * - `audio_input` — 20 September 2026, the audio reference on completed
 *   `seed_audio` jobs (`show_generations(type=audio)`).
 * - `image`, `video`, `audio` — the bare kinds the contracts originally
 *   demanded. Never observed under `data.type`; kept accepted because the
 *   provider does use the bare kinds under `role`, so a connection that spells
 *   the type the same way is plausible and must not cost us a paid job.
 */
export const ECHOED_MEDIA_TYPES = Object.freeze([
  "media_input",
  "video_input",
  "audio_input",
  "image_input",
  "image",
  "video",
  "audio",
] as const);
/** The bare media kinds, accepted under `data.type` and under `role`. */
const ECHOED_MEDIA_KINDS: readonly string[] = ["image", "video", "audio"];
/**
 * `<word>_input`: the family the provider actually uses. Bounded on purpose —
 * lowercase words and digits joined by single underscores, 40 characters at
 * most, and it must end in `_input` — so it admits every per-kind spelling
 * (`media_input`, `video_input`, `audio_input`, `image_input`, and any
 * `<kind>_input` a future model introduces) without admitting arbitrary junk.
 */
const ECHOED_MEDIA_INPUT = /^[a-z0-9]+(?:_[a-z0-9]+)*_input$/;
/**
 * Is this echoed `data.type` one of the spellings we are willing to see?
 *
 * WHY A FAMILY AND NOT A LIST. On 20 September 2026 a fixed list of four
 * spellings, written from one sample of `media_input`, refused a completed
 * `reframe` job whose echo said `video_input` — the same mistake as #251 and
 * #253, an assumption recorded from one sample and generalised. `data.type` is
 * a LABEL and no guarantee ever rested on it: the binding is `data.id`, the
 * uuid of the import we made, compared exactly at the index we submitted it.
 * So the rule is bounded rather than enumerated, and a spelling we have not
 * met can never again discard a job we have already paid for.
 */
export const echoedMediaTypeAccepted = (value: string) =>
  value.length <= 40 && (ECHOED_MEDIA_KINDS.includes(value) || ECHOED_MEDIA_INPUT.test(value));
/**
 * Does one echoed `params.medias[i]` entry correspond to the reference WE
 * submitted at that index?
 *
 * RECORDED FROM LIFE — free, read-only `show_generations` on 20 September 2026,
 * no job submitted, US$0.00 spent. Twelve consecutive completed `seedance_2_5`
 * jobs carrying 3-4 reference files each echo exactly
 *
 *     { "role": "image",
 *       "data": { "id": "<uuid>", "type": "media_input", "url": "https://…" } }
 *
 * `jq '[.items[].params.medias[]?.role] | unique'` returns `["image"]` and the
 * same over `.data.type` returns `["media_input"]`; the entry keys are exactly
 * `["data","role"]` and the data keys exactly `["id","type","url"]`.
 *
 * RE-READ 20 September 2026, over the whole video and audio history rather
 * than the seedance jobs alone. Two more spellings are live:
 *
 *     reframe  aa426b31-…  { "role": "video",
 *                            "data": { "id": "851d883d-…",
 *                                      "type": "video_input", "url": "…mp4" } }
 *     seed_audio           { "role": "audio",
 *                            "data": { "id": "…", "type": "audio_input", … } }
 *
 * so `jq '[.items[].params.medias[]?.data.type] | unique'` over the video
 * history now returns `["media_input","video_input"]`. `data.type` is therefore
 * per-kind on some models and generic on others, and is matched by family
 * (`echoedMediaTypeAccepted`) rather than by a list of samples.
 *
 * `seedance_2_5` declares the roles `start_image`, `end_image`,
 * `image_references`, `video_references`, `audio_references` and NOT `image`,
 * so for that model the echoed `image` is the media KIND, not a slot name.
 * (Other models — `higgsfield_preset` — do declare a slot literally named
 * `image`, where slot and kind coincide, and a connection that echoes the slot
 * name verbatim is therefore still possible.) Comparing the echo against the
 * slot name we sent refused every job with reference media; comparing it
 * against the kind, and accepting the slot name too, matches both readings.
 * `role` accepts `<kind>_input` as well, for symmetry with `data.type`: every
 * live role so far is a bare kind, and the widening is precautionary.
 *
 * The binding that carries the guarantee is unchanged and exact: `data.id` is
 * the uuid of the import we made and submitted, at the index we submitted it.
 * The role and `data.type` are labels, and no guarantee ever rested on them:
 * both are checked only against bounded families of spellings, so that a label
 * we have not observed can never again discard a job we paid for.
 */
export function consumerEchoedMediaMatches(
  entry: unknown,
  sent: { value: string; role: string },
  options: { requireData?: boolean } = {},
): boolean {
  if (!object(entry)) return false;
  const kind = mediaKindForRole(sent.role);
  if (
    entry.role !== undefined &&
    entry.role !== kind &&
    entry.role !== sent.role &&
    entry.role !== `${kind}_input`
  )
    return false;
  if (!object(entry.data)) {
    if (options.requireData) return false;
    return entry.value === undefined || entry.value === sent.value;
  }
  if (entry.data.id !== sent.value) return false;
  return (
    entry.data.type === undefined ||
    (typeof entry.data.type === "string" && echoedMediaTypeAccepted(entry.data.type))
  );
}
/**
 * Is this echoed entry an extra the PROVIDER injected, rather than one of our
 * references? The tolerated shape is exactly the one recorded from life: a
 * `data` object that carries no `id` (in the recording, only a `url`), and no
 * top-level `value` either. It therefore claims NO reference identity at all.
 *
 * That is the whole reason the relaxation below is safe, and it is why the test
 * is written as "claims no identity" rather than "looks like a voice": an entry
 * that claims no identity can neither be mistaken for one of our references
 * (each of ours is matched by the exact uuid of the import we made) nor stand in
 * for one (every reference we sent must still be matched, in order). An entry
 * that DOES carry a `data.id` is never an extra: it is matched against the next
 * reference we sent and refuses the whole echo if it is anything else.
 */
const echoedMediaClaimsNoIdentity = (entry: unknown) =>
  object(entry) &&
  entry.value === undefined &&
  object(entry.data) &&
  entry.data.id === undefined;
/**
 * How many provider-injected extras we tolerate, over and above the references
 * we sent. Deliberately as wide as the limit we impose on our OWN references:
 * an extra carries no identity (see above), so a tighter bound could only ever
 * do what #251, #253 and #255 each did — discard a completed, PAID job over a
 * shape we had not happened to record yet — while buying no guarantee back. The
 * bound exists only so that an echo padded with an unbounded number of
 * unexplained entries, a shape nothing in the recording resembles, is still
 * refused rather than walked.
 */
export const ECHOED_MEDIA_EXTRA_LIMIT = MEDIA_LIMIT;
/**
 * Does the whole echoed `params.medias` array correspond to the references WE
 * submitted?
 *
 * RECORDED FROM PRODUCTION, 20 September 2026 — free read-only
 * `show_generations(type=audio)` on the connected account; no job submitted,
 * US$0.00 spent. Completed `seed_audio` jobs (70990834-1f07-45aa-a325-a8bc55d1d921,
 * 87c8a5b1-1863-43b8-8265-614605d17fad, d0450755-703e-43c0-b15e-24a8f75d433e)
 * echo TWO entries where we would have sent one:
 *
 *     "medias": [
 *       {"role":"audio","data":{"url":"https://…/6f332b29-….wav"}},
 *       {"role":"audio","data":{"id":"70bbc31b-18b4-4ccd-b60f-8b06e380af61",
 *                               "type":"audio_input","url":"https://…_sfx.wav"}}
 *     ]
 *
 * The FIRST entry is the VOICE reference. It was never sent through a medias
 * array: `seed_audio` takes a voice through the `voice_type` / `voice_id` pair
 * it declares (`modelVoiceParameters`), and the account echoed it back as a
 * medias entry of its own, with only a `url` under `data` — no `id`, no `type`.
 * `seed_audio` declares the roles `image_references` and `audio_references`
 * BESIDE those voice parameters, so a request that uses a voice AND sends an
 * audio reference is one our own workflow can compose today.
 *
 * WHY A SUBSEQUENCE, AND WHAT IS STILL EXACT. The rule was
 * `p.medias.length === params.medias.length` plus a match at each index, so
 * one provider-injected entry refused the job on the COUNT alone — a completed,
 * paid job discarded as uncollectable, the same class of bug as #251, #253 and
 * #255. The relaxation keeps every part of the binding that carried a guarantee:
 *
 *   • every reference we sent must appear, matched by the exact uuid of the
 *     import we made (`consumerEchoedMediaMatches`, `data.id` compared
 *     verbatim), and
 *   • they must appear IN THE ORDER WE SENT THEM — a reordered echo still
 *     refuses, because order is what binds a reference to its slot, and
 *   • an entry carrying any reference identity we do not expect next refuses
 *     the whole echo.
 *
 * WHY THIS CANNOT ADMIT ANOTHER JOB'S OUTPUT. Only entries that name no media
 * at all are skipped. An echo belonging to another job differs from ours in the
 * identities it names — a different import uuid, a missing reference, or ours in
 * a different order — and each of those is refused here, exactly as before:
 * skipping an identity-less entry never supplies a reference we did not find,
 * because the walk must still consume all of `sent` by exact uuid in order.
 * (The job identity itself is bound separately and strictly: `generation.id`
 * equals the acknowledged job id, and the model and output type are compared
 * exactly, before this array is ever looked at.)
 */
export function consumerEchoedMediasMatch(
  echoed: unknown,
  sent: readonly { value: string; role: string }[],
  options: { requireData?: boolean } = {},
): boolean {
  if (!Array.isArray(echoed)) return false;
  if (echoed.length > sent.length + ECHOED_MEDIA_EXTRA_LIMIT) return false;
  let next = 0;
  for (const entry of echoed) {
    if (next < sent.length && consumerEchoedMediaMatches(entry, sent[next], options)) {
      next += 1;
      continue;
    }
    // Not the reference we expect next: tolerated only if it names no media.
    if (!echoedMediaClaimsNoIdentity(entry)) return false;
  }
  return next === sent.length;
}
function parameter(value: unknown): ConnectedParameter {
  if (!object(value)) return invalid();
  const name = text(value.name, 64);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) invalid();
  const type = value.type;
  if (
    type !== "string" &&
    type !== "number" &&
    type !== "bool" &&
    type !== "string_array"
  )
    invalid();
  if (value.required !== "optional" && value.required !== "required") invalid();
  const out: ConnectedParameter = {
    name,
    required: value.required === "required",
    type: type as ConnectedParameterType,
  };
  if (value.description !== undefined)
    out.description = displayName(text(value.description, 2000));
  if (value.options !== undefined) {
    if (
      !Array.isArray(value.options) ||
      value.options.length > CATALOGUE_LIMITS.options ||
      value.options.some(
        (option) =>
          !(typeof option === "string" && option.length <= 200) &&
          !finite(option),
      )
    )
      invalid();
    out.options = value.options as (string | number)[];
  }
  for (const key of ["min", "max"] as const)
    if (value[key] !== undefined) {
      if (!finite(value[key])) invalid();
      if (type === "string_array" && key === "max") out.maxItems = value[key];
      else out[key] = value[key];
    }
  if (value.nullable !== undefined) {
    if (typeof value.nullable !== "boolean") invalid();
    out.nullable = value.nullable;
  }
  if (value.default !== undefined) {
    const fallback = value.default;
    if (
      fallback !== null &&
      typeof fallback !== "boolean" &&
      !finite(fallback) &&
      !(typeof fallback === "string" && fallback.length <= 200)
    )
      invalid();
    out.default = fallback as ConnectedParameter["default"];
  }
  return out;
}
function mediaSlot(value: unknown): ConnectedMediaSlot {
  if (!object(value)) return invalid();
  const name = text(value.name, 64);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) invalid();
  const roles = Array.isArray(value.roles) ? value.roles : [];
  if (
    roles.length > CATALOGUE_LIMITS.roles ||
    roles.some((role) => typeof role !== "string" || !MEDIA_ROLE.test(role))
  )
    invalid();
  const slot: ConnectedMediaSlot = {
    name,
    roles: [...new Set(roles as string[])],
    required: value.required === true,
  };
  if (value.max !== undefined) {
    if (!Number.isSafeInteger(value.max) || (value.max as number) < 0) invalid();
    slot.max = value.max as number;
  }
  if (value.description !== undefined)
    slot.description = displayName(text(value.description, 2000));
  return slot;
}
export function parseConnectedModel(value: unknown): ConnectedModel {
  if (!object(value)) return invalid();
  const id = text(value.id, 80);
  if (!MODEL_ID.test(id)) invalid();
  if (!CONNECTED_OUTPUT_TYPES.includes(value.output_type as ConnectedOutputType))
    invalid();
  const parameters = value.parameters === undefined ? [] : value.parameters;
  const medias = value.medias === undefined ? [] : value.medias;
  const aspectRatios = value.aspect_ratios === undefined ? [] : value.aspect_ratios;
  const tags = value.tags === undefined ? [] : value.tags;
  if (
    !Array.isArray(parameters) ||
    parameters.length > CATALOGUE_LIMITS.parameters ||
    !Array.isArray(medias) ||
    medias.length > CATALOGUE_LIMITS.medias ||
    !Array.isArray(aspectRatios) ||
    aspectRatios.length > CATALOGUE_LIMITS.aspectRatios ||
    aspectRatios.some(
      (ratio) => typeof ratio !== "string" || !/^[0-9a-z:.]{1,16}$/i.test(ratio),
    ) ||
    !Array.isArray(tags) ||
    tags.length > CATALOGUE_LIMITS.tags ||
    tags.some((tag) => typeof tag !== "string" || tag.length > 64)
  )
    invalid();
  const parsedParameters = parameters.map(parameter);
  if (new Set(parsedParameters.map((p) => p.name)).size !== parsedParameters.length)
    invalid();
  const model: ConnectedModel = {
    id,
    name: WORKFLOW_NAMES[id] ?? (displayName(text(value.name ?? id, 200)) || displayName(id.replace(/_/g, " ")) || id),
    description: displayName(text(value.description ?? "", 4000)),
    outputType: value.output_type as ConnectedOutputType,
    parameters: parsedParameters,
    medias: medias.map(mediaSlot),
    aspectRatios: [...new Set(aspectRatios as string[])],
    tags: tags as string[],
    supportsUnlim: value.supports_unlim === true,
  };
  if (value.durations !== undefined) {
    if (
      !Array.isArray(value.durations) ||
      value.durations.length > 64 ||
      value.durations.some((d) => !finite(d))
    )
      invalid();
    model.durations = value.durations as number[];
  }
  if (value.duration_range !== undefined) {
    const range = value.duration_range;
    if (!object(range) || !finite(range.min) || !finite(range.max) || range.min > range.max)
      invalid();
    model.durationRange = { min: range.min, max: range.max };
  }
  return model;
}
/** `{items, has_more, unlim}` as returned by models_explore list (19 September 2026). */
export function parseConnectedCatalogue(
  raw: unknown,
  fetchedAt = Date.now(),
): ConnectedCatalogue {
  if (!object(raw) || !Array.isArray(raw.items) || raw.items.length > CATALOGUE_LIMITS.models)
    invalid();
  const models = raw.items.map(parseConnectedModel);
  if (new Set(models.map((m) => m.id)).size !== models.length) invalid();
  const unlim: ConnectedUnlim = { available: false, remaining: null, expiresAt: null };
  if (raw.unlim !== undefined) {
    if (!object(raw.unlim)) invalid();
    unlim.available = raw.unlim.available === true;
    unlim.remaining = finite(raw.unlim.remaining) ? raw.unlim.remaining : null;
    unlim.expiresAt =
      typeof raw.unlim.expires_at === "string" && raw.unlim.expires_at.length <= 64
        ? raw.unlim.expires_at
        : null;
  }
  return { models, unlim, complete: raw.has_more !== true, fetchedAt };
}

/** Declared parameters plus the aspect-ratio/duration constraints the
 * catalogue lists beside them, so one validation path covers both. */
export function effectiveParameters(model: ConnectedModel): ConnectedParameter[] {
  const declared = new Set(model.parameters.map((p) => p.name));
  const extra: ConnectedParameter[] = [];
  if (!declared.has("aspect_ratio") && model.aspectRatios.length)
    extra.push({
      name: "aspect_ratio",
      required: false,
      type: "string",
      options: model.aspectRatios,
      description: "Output aspect ratio.",
      synthetic: true,
    });
  if (!declared.has("duration") && (model.durations?.length || model.durationRange))
    extra.push({
      name: "duration",
      required: false,
      type: "number",
      ...(model.durations?.length ? { options: model.durations } : {}),
      ...(model.durationRange ? { min: model.durationRange.min, max: model.durationRange.max } : {}),
      description: "Duration in seconds.",
      synthetic: true,
    });
  return [...model.parameters, ...extra];
}
export type GenerationParameterValue = string | number | boolean | string[];
export type GenerationMediaRequest = { role: string; kind: ConnectedMediaKind };
export type GenerationRequest = {
  type: ConnectedOutputType;
  model: string;
  prompt: string;
  parameters: Record<string, GenerationParameterValue>;
  medias: GenerationMediaRequest[];
  /** A motion preset from presets_show; only for a model declaring preset_id. */
  presetId?: string;
};
export const PRESET_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
/** Whether a model takes a motion preset (declares preset_id). */
export const takesPreset = (model: ConnectedModel) => model.parameters.some((p) => p.name === "preset_id");
function reject(code: CatalogueErrorCode, message: string): never {
  throw new CatalogueError(code, message);
}
function checkParameter(
  declaration: ConnectedParameter,
  value: GenerationParameterValue,
) {
  const name = `“${declaration.name}”`;
  const bad = (why: string) =>
    reject("parameter_invalid", `The setting ${name} ${why}.`);
  if (declaration.type === "bool") {
    if (typeof value !== "boolean") bad("must be on or off");
    return;
  }
  if (declaration.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) bad("must be a number");
    if (declaration.options && !declaration.options.includes(value as number))
      bad(`must be one of ${declaration.options.join(", ")}`);
    if (declaration.min !== undefined && (value as number) < declaration.min)
      bad(`must be at least ${declaration.min}`);
    if (declaration.max !== undefined && (value as number) > declaration.max)
      bad(`must be at most ${declaration.max}`);
    return;
  }
  if (declaration.type === "string") {
    if (typeof value !== "string" || value.length > 2000) bad("must be text of at most 2000 characters");
    if (declaration.options && !declaration.options.includes(value as string))
      bad(`must be one of ${declaration.options.join(", ")}`);
    return;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length > 500)
  )
    bad("must be a list of text values");
  const cap = declaration.maxItems ?? 32;
  if ((value as string[]).length > cap) bad(`accepts at most ${cap} values`);
}
/**
 * Validates one request against its model. Returns the provider parameter
 * object (without media UUIDs, which are attached after import) containing
 * only declared parameters, the prompt and the fixed single-result settings.
 */
export function validateGenerationRequest(
  model: ConnectedModel,
  request: GenerationRequest,
): Record<string, string | number | boolean | string[]> {
  if (request.model !== model.id)
    reject("model_unknown", "Choose a model from the connected catalogue.");
  if (request.type !== model.outputType)
    reject("type_mismatch", `${model.name} produces ${model.outputType} output, not ${request.type}.`);
  if (typeof request.prompt !== "string" || request.prompt.length > PROMPT_LIMIT)
    reject("prompt_limit", `Prompts are limited to ${PROMPT_LIMIT} characters.`);
  if (!object(request.parameters) || Object.keys(request.parameters).length > CATALOGUE_LIMITS.parameters)
    reject("parameter_invalid", "Review the generation settings.");
  const declarations = new Map(effectiveParameters(model).map((p) => [p.name, p]));
  const params: Record<string, string | number | boolean | string[]> = {};
  for (const [name, value] of Object.entries(request.parameters)) {
    if (RESERVED_PARAMETERS.includes(name))
      reject("parameter_reserved", `The setting “${name}” is managed by the workflow.`);
    const declaration = declarations.get(name);
    if (!declaration)
      reject("parameter_unknown", `${model.name} does not declare a setting named “${name}”.`);
    checkParameter(declaration!, value);
    params[name] = Array.isArray(value) ? [...value] : value;
  }
  if (request.presetId !== undefined) {
    if (!takesPreset(model))
      reject("parameter_reserved", `${model.name} does not take a motion preset.`);
    if (typeof request.presetId !== "string" || !PRESET_ID.test(request.presetId))
      reject("parameter_invalid", "Choose a motion preset from the connected account.");
    params.preset_id = request.presetId;
  }
  for (const declaration of declarations.values())
    if (declaration.required && !(declaration.name in params))
      reject("parameter_required", `${model.name} requires the setting “${declaration.name}”.`);
  if (!Array.isArray(request.medias) || request.medias.length > MEDIA_LIMIT)
    reject("media_limit", `Choose at most ${MEDIA_LIMIT} reference files.`);
  const roles = new Map<string, ConnectedMediaSlot>();
  for (const slot of model.medias) for (const role of slot.roles) roles.set(role, slot);
  const counts = new Map<string, number>();
  for (const media of request.medias) {
    if (typeof media.role !== "string" || !MEDIA_ROLE.test(media.role) || !roles.has(media.role))
      reject("media_role_unknown", `${model.name} does not accept a reference with the role “${String(media.role)}”.`);
    if (mediaKindForRole(media.role) !== media.kind)
      reject("media_role_unknown", `The role “${media.role}” needs a ${mediaKindForRole(media.role)} file.`);
    const slot = roles.get(media.role)!;
    counts.set(slot.name, (counts.get(slot.name) ?? 0) + 1);
    if (slot.max !== undefined && counts.get(slot.name)! > slot.max)
      reject("media_limit", `${model.name} accepts at most ${slot.max} reference file${slot.max === 1 ? "" : "s"}.`);
  }
  for (const slot of model.medias)
    if (slot.required && !counts.get(slot.name))
      reject("media_required", `${model.name} needs a reference file (${slot.roles.join(", ")}).`);
  if (!request.prompt.trim() && !request.medias.length)
    reject("prompt_required", "Write a prompt or choose a reference file.");
  return params;
}
/**
 * Models the provider reserves for its own game-generation pipeline. Their
 * catalogue descriptions say they must not be used for standalone audio
 * (19 September 2026: "Game pipeline only."), so no Particl surface offers,
 * quotes or submits them. Matched by id and, for models added later, by the
 * provider's own wording.
 */
export const GAME_PIPELINE_ONLY_MODELS = Object.freeze([
  "sonilo_music",
  "mirelo_text_to_audio",
  "inworld_text_to_speech",
]);
const GAME_PIPELINE_ONLY = /\bgame(?:[- ]generation)? pipeline only\b|\bonly for the game[- ]generation pipeline\b/i;
/** False for models that may only run inside the provider's game pipeline. */
export function isStandaloneModel(model: Pick<ConnectedModel, "id" | "description">) {
  return !GAME_PIPELINE_ONLY_MODELS.includes(model.id) && !GAME_PIPELINE_ONLY.test(model.description);
}
/** The models a standalone workflow may offer: every catalogue entry except
 * the game-pipeline-only ones, optionally of one output type. */
export function listCatalogueModels(
  catalogue: ConnectedCatalogue,
  filter: { type?: ConnectedOutputType } = {},
) {
  return catalogue.models.filter(
    (model) => isStandaloneModel(model) && (!filter.type || model.outputType === filter.type),
  );
}
/** A standalone model by id; game-pipeline-only models are never found. */
export function findCatalogueModel(catalogue: ConnectedCatalogue, id: string) {
  return catalogue.models.find((model) => model.id === id && isStandaloneModel(model)) ?? null;
}
/**
 * A model that takes a connected-account voice declares the pair
 * `voice_type` (options preset/element) and `voice_id` (text). The Sound
 * workflow fills both from the cached `list_voices` picker instead of showing
 * two free-text settings.
 */
export function modelVoiceParameters(model: ConnectedModel) {
  const type = model.parameters.find((p) => p.name === "voice_type");
  const id = model.parameters.find((p) => p.name === "voice_id");
  if (!type || !id || type.type !== "string" || id.type !== "string") return null;
  const kinds = (type.options ?? []).filter((o): o is "preset" | "element" => o === "preset" || o === "element");
  if (!kinds.length) return null;
  return { kinds, required: type.required || id.required };
}

