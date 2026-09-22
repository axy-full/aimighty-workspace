import { displayModelName } from "../models";
import type { NodeAudioSetup, NodeAudioTask } from "../workbench/generation-audio";

/**
 * The global Generate composer's own state, as pure data.
 *
 * The composer is the workspace's shortest path to a render: type, model,
 * prompt, optional references, one priced button. It never navigates, and it
 * works the same in every suite.
 *
 * Nothing here fetches, and nothing here writes a model name: every label
 * comes from the catalogue the account offers, through `displayModelName`
 * (lib/models.ts), so a renamed engine renames itself here too.
 */

export type ComposerType = "image" | "video" | "audio";
/** Which credits pay for the render. The workspace's own are the default. */
export type BillingSource = "workspace" | "connected";

export const COMPOSER_TYPES: readonly ComposerType[] = ["image", "video", "audio"];
export const TYPE_LABELS: Record<ComposerType, string> = { image: "Image", video: "Video", audio: "Audio" };

export type ComposerModel = {
  id: string;
  /** Display name, from the catalogue. */
  label: string;
  type: ComposerType;
  /** One line of what it is for (the catalogue's description). */
  description?: string;
  /** Workspace image/video engines: the engine's own allowed settings.
      Connected models: read from the live catalogue entry (FINAL_SPEC §3) —
      `durations` is every second of a range, or exactly the closed list. */
  ratios?: string[];
  resolutions?: string[];
  durations?: number[];
  /** Workspace sound engines: which audio task this capability is. */
  audioTask?: NodeAudioTask;
  /** Connected models: the reference roles the model accepts, if any. */
  referenceRoles?: string[];
  /** Connected models: served through the connected account. */
  connected?: true;
  /** Connected models: declares no media slot at all — the well is hidden. */
  promptOnly?: boolean;
  /** Connected models: the schema declares `enhance_prompt` (FINAL_SPEC §4). */
  enhanceable?: boolean;
  /** Connected Soul models: the schema declares `soul_id` (FINAL_SPEC §4 › Soul ID); a trained character can be carried. */
  soulId?: boolean;
  /** Connected models: the most references the smallest slot allows, when declared. */
  mediaMax?: number;
};

/** A project file picked as a reference: already saved, so it is cited by id. */
export type ComposerReference = {
  key: string;
  id: string;
  origin: "upload" | "generation";
  kind: "image" | "video" | "audio";
  name: string;
  url: string;
  /** Connected models: the role this reference takes (one of the model's). */
  role?: string;
};

export type ComposerState = {
  type: ComposerType;
  billing: BillingSource;
  /** The model chosen per billing source and type, so switching back keeps it. */
  chosen: Record<string, string>;
  prompt: string;
  references: ComposerReference[];
  /** Sound only. */
  seconds: number;
  instrumental: boolean;
  voiceId: string;
  /**
   * What the person chose where the engine offers a choice (the Suites Gen
   * composer). A pick the current engine does not allow is ignored, never
   * sent: composerSettings falls back to the engine's own default.
   */
  picks: ComposerPicks;
  /** Gen's Auto: a connected model whose schema declares `enhance_prompt` is asked to enhance on the account. */
  enhance: boolean;
  /** Takes per Generate (the prototype's stepper, 1–4): each take is its own quoted job at the price shown. */
  count: number;
  /** The last thing the composer said: a moved price, a refusal, a created project. */
  notice: string | null;
};
export const TAKES_MAX = 4;

export type ComposerPicks = { ratio?: string; resolution?: string; duration?: number; soulId?: string };

export const INITIAL_COMPOSER: ComposerState = {
  type: "image",
  billing: "workspace",
  chosen: {},
  prompt: "",
  references: [],
  seconds: 10,
  instrumental: true,
  voiceId: "",
  picks: {},
  enhance: false,
  count: 1,
  notice: null,
};

export const chosenKey = (billing: BillingSource, type: ComposerType) => `${billing}:${type}`;

export type ComposerAction =
  | { type: "type"; value: ComposerType }
  | { type: "billing"; value: BillingSource }
  | { type: "model"; value: string }
  | { type: "prompt"; value: string }
  | { type: "seconds"; value: number }
  | { type: "instrumental"; value: boolean }
  | { type: "voice"; value: string }
  | { type: "pick"; value: ComposerPicks }
  | { type: "referenceRole"; key: string; role: string }
  | { type: "enhance"; value: boolean }
  | { type: "count"; value: number }
  | { type: "addReference"; value: ComposerReference }
  | { type: "removeReference"; key: string }
  | { type: "notice"; value: string | null }
  | { type: "reset" };

const SOUND_SECONDS = 10;

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case "type":
      if (action.value === state.type) return state;
      /* Another kind of output takes its own model; sound has no visual references. */
      return {
        ...state,
        type: action.value,
        references: action.value === "audio" ? [] : state.references,
        seconds: action.value === "audio" ? SOUND_SECONDS : state.seconds,
        notice: null,
      };
    case "billing":
      if (action.value === state.billing) return state;
      /* The switch changes the model list and the price source. */
      return { ...state, billing: action.value, notice: null };
    case "model":
      return { ...state, chosen: { ...state.chosen, [chosenKey(state.billing, state.type)]: action.value }, notice: null };
    case "prompt":
      return { ...state, prompt: action.value.slice(0, 5000), notice: null };
    case "seconds":
      return { ...state, seconds: action.value, notice: null };
    case "instrumental":
      return { ...state, instrumental: action.value, notice: null };
    case "voice":
      return { ...state, voiceId: action.value, notice: null };
    case "pick":
      return { ...state, picks: { ...state.picks, ...action.value }, notice: null };
    case "referenceRole":
      return { ...state, references: state.references.map((r) => (r.key === action.key ? { ...r, role: action.role } : r)), notice: null };
    case "enhance":
      return { ...state, enhance: action.value };
    case "count":
      return { ...state, count: Math.max(1, Math.min(TAKES_MAX, Math.round(action.value))) };
    case "addReference":
      if (state.references.some((r) => r.key === action.value.key)) return state;
      if (state.references.length >= 10) return { ...state, notice: "The composer takes up to 10 references." };
      return { ...state, references: [...state.references, action.value], notice: null };
    case "removeReference":
      return { ...state, references: state.references.filter((r) => r.key !== action.key), notice: null };
    case "notice":
      return { ...state, notice: action.value };
    case "reset":
      return { ...INITIAL_COMPOSER, billing: state.billing, chosen: state.chosen };
  }
}

/* ── Model lists ──────────────────────────────────────────────────────── */

/** A row of GET /api/workbench/engines, as the composer reads it. */
export type EngineRow = {
  id: string;
  kind: "image" | "video";
  resolutions: string[];
  ratios: string[];
  durations: number[];
  soulIdentity?: boolean;
  marketing?: boolean;
};

/** A row of the connected account's catalogue, as the composer reads it (the CLI's `model get` shape). */
export type ConnectedRow = {
  id: string; name: string; outputType: string; description?: string;
  medias?: { name?: string; roles: string[]; max?: number }[];
  aspectRatios?: string[]; durations?: number[]; durationRange?: { min: number; max: number };
  parameters?: { name: string; type?: string; options?: (string | number)[]; min?: number; max?: number }[];
};
/** Every whole second of a range, for engines whose `durations` is min/max (Seedance 2.5: 4–30 s). */
export function secondsIn(range: { min: number; max: number }): number[] {
  const min = Math.ceil(range.min), max = Math.floor(range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min || max - min > 600) return [];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/**
 * The image and sound models the composer offers on the workspace's own
 * credits, in the order the account's own catalogue lists them — so the first
 * of each type is the sensible default and the composer works untouched.
 *
 * Identity and campaign engines are left out: one needs a trained likeness
 * bound to a node and the other a saved campaign mapping, so neither can
 * render from an untouched composer. They stay available where they belong
 * (Rig's Inspector and the Marketing page).
 */
export function workspaceModels(engines: readonly EngineRow[], audio: NodeAudioSetup | null): ComposerModel[] {
  const out: ComposerModel[] = engines
    .filter((engine) => !engine.soulIdentity && !engine.marketing)
    .map((engine) => ({
      id: engine.id,
      label: displayModelName(engine.id),
      type: engine.kind,
      ratios: engine.ratios,
      resolutions: engine.resolutions,
      durations: engine.durations,
    }));
  if (audio?.configured) {
    const speech = audio.defaultSpeechModel || audio.speechModels[0]?.id || "";
    out.push({ id: "eleven_sfx", label: displayModelName("eleven_sfx"), type: "audio", audioTask: "sound" });
    out.push({ id: "eleven_music", label: displayModelName("eleven_music"), type: "audio", audioTask: "music" });
    if (speech && audio.voices.length) out.push({ id: speech, label: displayModelName(speech), type: "audio", audioTask: "speech" });
  }
  return out;
}

/**
 * The connected account's standalone models of each type, catalogue order kept.
 *
 * A connected model's name is the catalogue's own, which the catalogue reader
 * has already stripped of the provider (#262: models we integrate directly read
 * under their real names, models served through the connected account stay
 * neutral). Nothing is renamed here.
 */
export function connectedModels(rows: readonly ConnectedRow[]): ComposerModel[] {
  return rows.flatMap((row) => {
    const type = row.outputType === "image" || row.outputType === "video" || row.outputType === "audio" ? row.outputType : null;
    if (!type) return [];
    const resolution = row.parameters?.find((p) => p.name === "resolution")?.options?.map(String);
    const slots = row.medias ?? [];
    const maxes = slots.map((slot) => slot.max).filter((m): m is number => typeof m === "number");
    return [{
      id: row.id,
      label: row.name,
      type,
      connected: true,
      ...(row.description ? { description: row.description } : {}),
      ...(row.aspectRatios?.length ? { ratios: [...row.aspectRatios] } : {}),
      ...(resolution?.length ? { resolutions: resolution } : {}),
      ...(row.durations?.length ? { durations: [...row.durations] } : row.durationRange ? { durations: secondsIn(row.durationRange) } : {}),
      referenceRoles: [...new Set(slots.flatMap((slot) => slot.roles))],
      promptOnly: slots.length === 0,
      enhanceable: Boolean(row.parameters?.some((p) => p.name === "enhance_prompt")),
      soulId: Boolean(row.parameters?.some((p) => p.name === "soul_id")),
      ...(maxes.length ? { mediaMax: Math.min(...maxes) } : {}),
    }];
  });
}

/** The models of the composer's current type, in catalogue order. */
export function offeredModels(state: Pick<ComposerState, "type">, models: readonly ComposerModel[]): ComposerModel[] {
  return models.filter((model) => model.type === state.type);
}

/**
 * The model the composer would send: the person's choice while the list still
 * offers it, else the list's first — which is why the composer works without
 * anybody touching the model row.
 */
export function activeModel(
  state: Pick<ComposerState, "type" | "billing" | "chosen">,
  models: readonly ComposerModel[],
): ComposerModel | null {
  const offered = offeredModels(state, models);
  const picked = state.chosen[chosenKey(state.billing, state.type)];
  return offered.find((model) => model.id === picked) ?? offered[0] ?? null;
}

/* ── Settings the engine allows ───────────────────────────────────────── */

export type ComposerSettings = { ratio: string; resolution: string; duration: number; /** A trained character, only where the model declares `soul_id`. */ soulId?: string };

/** The settings a workspace engine renders with: its own first allowed values, the project's aspect where it fits. */
export function composerSettings(model: ComposerModel | null, projectAspect?: string, picks: ComposerPicks = {}): ComposerSettings {
  const ratios = model?.ratios ?? [];
  const ratio = picks.ratio && ratios.includes(picks.ratio)
    ? picks.ratio
    : projectAspect && ratios.includes(projectAspect)
    ? projectAspect
    : ratios.includes("16:9") ? "16:9" : ratios.find((r) => r !== "adaptive") ?? ratios[0] ?? "16:9";
  return {
    ratio,
    resolution: picks.resolution && model?.resolutions?.includes(picks.resolution) ? picks.resolution : model?.resolutions?.[0] ?? "720p",
    duration: picks.duration != null && model?.durations?.includes(picks.duration)
      ? picks.duration
      : model?.durations?.includes(5) ? 5 : model?.durations?.[0] ?? 5,
    ...(model?.soulId && picks.soulId ? { soulId: picks.soulId } : {}),
  };
}

/* ── The quote and the button ─────────────────────────────────────────── */

export type QuoteState = "loading" | "ready" | "unavailable";
export type ComposerQuote = {
  /** The inputs this figure prices. A different key means the figure is stale. */
  key: string;
  credits: number | null;
  state: QuoteState;
  reason: string | null;
};

/** The connected account's readiness, as /api/me and the connection route report it. */
export type ConnectedCapability = { owner: boolean; connected: boolean; suspended: boolean };

/**
 * The exact inputs a price belongs to. Anything a person can change that moves
 * the price is in here, so a stale figure can never be sent.
 */
export function quoteKeyFor(input: {
  billing: BillingSource;
  type: ComposerType;
  modelId: string;
  settings: ComposerSettings;
  references: readonly ComposerReference[];
  /** Sound and connected models price the prompt itself. */
  prompt: string;
  seconds: number;
  instrumental: boolean;
  voiceId: string;
}): string {
  const priced = input.billing === "connected" || input.type === "audio" ? input.prompt : "";
  return JSON.stringify([
    input.billing, input.type, input.modelId,
    input.settings.ratio, input.settings.resolution, input.settings.duration, input.settings.soulId ?? "",
    input.references.map((r) => `${r.origin}:${r.id}`),
    priced, input.seconds, input.instrumental, input.voiceId,
  ]);
}

/** A ready, current price, or null — the only figure the composer will send. */
export function liveCredits(quote: ComposerQuote | null, quoteKey: string): number | null {
  if (!quote || quote.key !== quoteKey || quote.state !== "ready" || quote.credits === null) return null;
  return quote.credits;
}

/**
 * Why Generate cannot run, or null. A missing or stale quote blocks with a
 * visible reason rather than a button that silently does nothing.
 */
export function composerBlock(input: {
  state: Pick<ComposerState, "billing" | "type" | "prompt" | "voiceId">;
  model: ComposerModel | null;
  quote: ComposerQuote | null;
  quoteKey: string;
  submitting: boolean;
  capability: ConnectedCapability | null;
  /** Any loading or refusal from reading the model catalogue. */
  catalogue: { loading: boolean; error: string | null };
}): string | null {
  const { state, model, quote, quoteKey } = input;
  if (input.submitting) return "Submitting this generation…";
  if (state.billing === "connected") {
    if (!input.capability) return "Reading the connected account…";
    if (!input.capability.owner) return "The workspace owner uses the connected account. Switch to this workspace’s credits.";
    if (!input.capability.connected) return "No account is connected. Connect one in Workspace settings, or use this workspace’s credits.";
    if (input.capability.suspended) return "Rendering is paused for this workspace.";
  }
  if (input.catalogue.error) return input.catalogue.error;
  if (input.catalogue.loading && !model) return "Reading the available models…";
  if (!model) return `No ${TYPE_LABELS[state.type].toLowerCase()} model is available on this account.`;
  if (!state.prompt.trim()) return "Write what to generate.";
  if (model.audioTask === "speech" && !state.voiceId) return "Choose a voice.";
  if (!quote || quote.key !== quoteKey || quote.state === "loading") return "Getting the live price…";
  if (quote.state === "unavailable" || quote.credits === null)
    return quote.reason ?? "This model has no live price with these settings.";
  return null;
}

/** "Generate · 18 cr" / "Generate · 18 connected cr" — the exact live figure, or no figure at all. */
export function composerButtonLabel(input: {
  billing: BillingSource;
  quote: ComposerQuote | null;
  quoteKey: string;
  submitting: boolean;
  /** Takes per Generate; the price shown is the take's price times the count. */
  count?: number;
}): string {
  if (input.submitting) return "Submitting…";
  const credits = liveCredits(input.quote, input.quoteKey);
  const count = Math.max(1, input.count ?? 1);
  if (credits === null) return count > 1 ? `Generate ${count} takes` : "Generate";
  const unit = input.billing === "connected" ? "connected cr" : "cr";
  return count > 1
    ? `Generate ${count} takes · ${(credits * count).toLocaleString("en-US")} ${unit}`
    : `Generate · ${credits.toLocaleString("en-US")} ${unit}`;
}

/** Which credits pay, said plainly and without naming the provider. */
export function billingWording(billing: BillingSource, input: { workspaceName?: string | null; walletName?: string | null }): string {
  if (billing === "workspace")
    return `Charged to ${input.workspaceName ? `${input.workspaceName}’s` : "this workspace’s"} credits.`;
  return `Charged to the connected account’s credits${input.walletName ? ` · ${input.walletName}` : ""}. The output belongs to that account.`;
}

export const BILLING_LABELS: Record<BillingSource, string> = {
  workspace: "This workspace’s credits",
  connected: "Connected account",
};
