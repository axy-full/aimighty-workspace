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
/** Provider parameters the workflow owns; a request cannot set them itself. */
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
  return value.replace(PROVIDER_NAME, "").replace(/\s{2,}/g, " ").trim();
}
export function mediaKindForRole(role: string): ConnectedMediaKind {
  if (/video/.test(role)) return "video";
  if (/audio/.test(role)) return "audio";
  return "image";
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
    out.description = text(value.description, 2000);
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
    slot.description = text(value.description, 2000);
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
    name: displayName(text(value.name ?? id, 200)) || id,
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
};
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
export function listCatalogueModels(
  catalogue: ConnectedCatalogue,
  filter: { type?: ConnectedOutputType } = {},
) {
  return catalogue.models.filter((model) => !filter.type || model.outputType === filter.type);
}
export function findCatalogueModel(catalogue: ConnectedCatalogue, id: string) {
  return catalogue.models.find((model) => model.id === id) ?? null;
}

