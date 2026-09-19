/**
 * Atomik proposals on the connected account (slice A2), pure.
 *
 * The planner may propose a step on any model of the connected catalogue by
 * naming `connected:<model id>` with that model's declared settings. Here a
 * proposal is turned into exactly the validated generation request the
 * Generate page would send (catalogue.ts / generation-contract.ts), or into a
 * plain reason it cannot be run. Nothing here prices anything: a proposal
 * becomes a step only after the live `get_cost` quote succeeds
 * (planner-service.ts). A proposal that cannot be priced is not proposed.
 */
import {
  CatalogueError,
  effectiveParameters,
  mediaKindForRole,
  validateGenerationRequest,
  RESERVED_PARAMETERS,
  takesPreset,
  type ConnectedModel,
  type ConnectedOutputType,
} from "./catalogue";
import type { ConsumerGenerationInput } from "./generation-contract";

export const CONNECTED_PREFIX = "connected:";
export const isConnectedModelId = (id: string) => id.startsWith(CONNECTED_PREFIX);
export const connectedModelId = (id: string) => (isConnectedModelId(id) ? id.slice(CONNECTED_PREFIX.length) : id);
/** Never offered to the planner: game-pipeline-only audio (the provider forbids
 * standalone use). */
export const PLANNER_EXCLUDED_MODELS = Object.freeze(["sonilo_music", "mirelo_text_to_audio", "inworld_text_to_speech"]);
export const plannerModels = (models: ConnectedModel[]) => models.filter((model) => !PLANNER_EXCLUDED_MODELS.includes(model.id));

/** One line per model: id, name, output, and the settings it declares. */
export function connectedEngineLine(model: ConnectedModel): string {
  const settings = effectiveParameters(model)
    .filter((p) => !RESERVED_PARAMETERS.includes(p.name))
    .slice(0, 8)
    .map((p) => {
      const range = p.options?.length ? p.options.slice(0, 6).join("|") : p.min !== undefined || p.max !== undefined ? `${p.min ?? ""}-${p.max ?? ""}` : p.type;
      return `${p.name}${p.required ? "*" : ""}=${range}`;
    });
  const roles = model.medias.flatMap((slot) => slot.roles.map((role) => `${role}${slot.required ? "*" : ""}`)).slice(0, 6);
  return [
    `  ${CONNECTED_PREFIX}${model.id} — ${model.name} (${model.outputType}, connected credits)`,
    takesPreset(model) ? "preset* = a Motion presets id" : "",
    settings.length ? `settings ${settings.join(" ")}` : "",
    roles.length ? `files ${roles.join(" ")}` : "",
  ].filter(Boolean).join(". ").slice(0, 320);
}

/** What the planner proposed for a connected model, before validation. */
export type RawConnectedProposal = {
  kind: string;
  title: string;
  prompt: string;
  model: string;
  settings?: unknown;
  seconds?: unknown;
  ratio?: unknown;
  /** A motion preset id (slice A3), for a model that takes one. */
  preset?: unknown;
  /** A label shared by proposals that should run together in one batch (slice A4). */
  batch?: unknown;
};
export type ProposalFile = { uploadId?: string; genId?: string; kind: "image" | "video" | "audio" };
export type ConnectedProposal =
  | { ok: true; title: string; input: ConsumerGenerationInput; model: ConnectedModel }
  | { ok: false; title: string; reason: string };

const KINDS: ConnectedOutputType[] = ["image", "video", "audio", "3d"];
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";

/**
 * Builds and validates the generation request for one connected proposal.
 * Settings the model does not declare are dropped (the planner often adds
 * ones from another engine); `seconds` / `ratio` map onto the model's own
 * `duration` / `aspect_ratio` when it declares them. Files the person
 * attached are placed on the first declared role of the matching kind.
 */
export function buildConnectedProposal(raw: RawConnectedProposal, models: ConnectedModel[], files: ProposalFile[] = [], presets: { id: string; name: string }[] = []): ConnectedProposal {
  const title = String(raw.title ?? "").slice(0, 60) || "Connected step";
  const id = connectedModelId(String(raw.model ?? "").trim());
  const model = plannerModels(models).find((m) => m.id === id);
  if (!model) return { ok: false, title, reason: "that model is not in the connected catalogue" };
  const type = (KINDS.includes(raw.kind as ConnectedOutputType) ? raw.kind : model.outputType) as ConnectedOutputType;
  if (type !== model.outputType) return { ok: false, title, reason: `${model.name} makes ${model.outputType}, not ${type}` };
  const declared = new Map(effectiveParameters(model).map((p) => [p.name, p]));
  const parameters: Record<string, string | number | boolean | string[]> = {};
  const settings = raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings) ? (raw.settings as Record<string, unknown>) : {};
  for (const [name, value] of Object.entries(settings).slice(0, 64)) {
    if (RESERVED_PARAMETERS.includes(name) || !declared.has(name)) continue;
    if (scalar(value)) parameters[name] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) parameters[name] = value.slice(0, 32) as string[];
  }
  if (!("duration" in parameters) && declared.has("duration") && Number.isFinite(Number(raw.seconds)) && Number(raw.seconds) > 0) {
    const want = Number(raw.seconds), p = declared.get("duration")!;
    parameters.duration = p.options?.length
      ? (p.options as number[]).reduce((best, d) => (Math.abs(Number(d) - want) < Math.abs(Number(best) - want) ? d : best))
      : Math.min(p.max ?? want, Math.max(p.min ?? want, Math.round(want)));
  }
  if (!("aspect_ratio" in parameters) && declared.has("aspect_ratio") && typeof raw.ratio === "string") {
    const options = declared.get("aspect_ratio")!.options;
    if (!options || options.includes(raw.ratio)) parameters.aspect_ratio = raw.ratio;
  }
  const medias: ConsumerGenerationInput["medias"] = [];
  const used = new Map<string, number>();
  for (const file of files.slice(0, 30)) {
    const slot = model.medias.find((s) => s.roles.some((role) => mediaKindForRole(role) === file.kind) && (s.max === undefined || (used.get(s.name) ?? 0) < s.max));
    const role = slot?.roles.find((r) => mediaKindForRole(r) === file.kind);
    if (!slot || !role) continue;
    used.set(slot.name, (used.get(slot.name) ?? 0) + 1);
    medias.push({ role, source: file.genId ? { genId: file.genId } : { uploadId: file.uploadId! } });
  }
  let presetId: string | undefined;
  if (takesPreset(model)) {
    const wanted = String(raw.preset ?? settings.preset_id ?? "").trim();
    const preset = presets.find((p) => p.id === wanted);
    if (!preset) return { ok: false, title, reason: presets.length ? "choose one of the listed motion presets" : "the connected account lists no motion presets" };
    presetId = preset.id;
  }
  const prompt = String(raw.prompt ?? "").trim().slice(0, 5000);
  const input: ConsumerGenerationInput = { type, model: model.id, prompt, parameters, medias, ...(presetId ? { presetId } : {}) };
  try {
    validateGenerationRequest(model, { type, model: model.id, prompt, parameters, medias: medias.map((m) => ({ role: m.role, kind: mediaKindForRole(m.role) })), ...(presetId ? { presetId } : {}) });
  } catch (error) {
    return { ok: false, title, reason: error instanceof CatalogueError ? error.message.replace(/[“”]/g, "") : "its settings could not be validated" };
  }
  return { ok: true, title, input, model };
}

/** What a connected step stores in its params: the quote it was proposed at. */
export type ConnectedStepMeta = {
  model: string;
  type: ConnectedOutputType;
  modelName: string;
  input: ConsumerGenerationInput;
  /** The durable connected-account job holding the quote. */
  jobId: string;
  draftId: string;
  credits: number;
  workspaceId: string;
  workspaceName: string;
  quoteExpiresAt: number;
  /** Set when the step runs with others in one batch call under one approval (A4). */
  batch?: { id: string; size: number };
  /** The motion preset's name, for display (A3). */
  presetName?: string;
};
/** Items per batch: the workspace runs at most four connected jobs at once. */
export const PLANNER_BATCH_SIZE = 4;
const BATCHABLE: ConnectedOutputType[] = ["image", "video", "audio"];
/**
 * Groups priced proposals that share a batch label and output type into
 * batches of 2–4 (in proposal order); anything else runs on its own.
 */
export function assignBatches(entries: { label: string | null; meta: ConnectedStepMeta }[], newId: () => string) {
  const groups = new Map<string, { label: string | null; meta: ConnectedStepMeta }[]>();
  for (const entry of entries) {
    if (!entry.label || !BATCHABLE.includes(entry.meta.type)) continue;
    const key = `${entry.meta.type}:${entry.meta.workspaceId}:${entry.label}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const members of groups.values())
    for (let start = 0; start < members.length; start += PLANNER_BATCH_SIZE) {
      const chunk = members.slice(start, start + PLANNER_BATCH_SIZE);
      if (chunk.length < 2) continue;
      const id = newId();
      for (const member of chunk) member.meta.batch = { id, size: chunk.length };
    }
}
export const batchLabel = (value: unknown) => (typeof value === "string" && /^[\w .-]{1,40}$/.test(value.trim()) ? value.trim() : value === true ? "batch" : null);
export function connectedMeta(params: Record<string, unknown> | null | undefined): ConnectedStepMeta | null {
  const value = params?.connected;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const meta = value as Partial<ConnectedStepMeta>;
  return typeof meta.jobId === "string" && typeof meta.draftId === "string" && typeof meta.credits === "number" && typeof meta.workspaceId === "string"
    ? (meta as ConnectedStepMeta)
    : null;
}
/** The line shown in place of a step that could not be priced. */
export const unpricedLine = (title: string, reason: string) => `${title}: needs a priced run first (${reason}).`;
