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
  /** Neutral display name, from the catalogue. */
  label: string;
  type: ComposerType;
  /** Workspace image/video engines: the engine's own allowed settings. */
  ratios?: string[];
  resolutions?: string[];
  durations?: number[];
  /** Workspace sound engines: which audio task this capability is. */
  audioTask?: NodeAudioTask;
  /** Connected models: the reference roles the model accepts, if any. */
  referenceRoles?: string[];
};

/** A project file picked as a reference: already saved, so it is cited by id. */
export type ComposerReference = {
  key: string;
  id: string;
  origin: "upload" | "generation";
  kind: "image" | "video" | "audio";
  name: string;
  url: string;
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
  /** The last thing the composer said: a moved price, a refusal, a created project. */
  notice: string | null;
};

export const INITIAL_COMPOSER: ComposerState = {
  type: "image",
  billing: "workspace",
  chosen: {},
  prompt: "",
  references: [],
  seconds: 10,
  instrumental: true,
  voiceId: "",
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

/** A row of the connected account's catalogue, as the composer reads it. */
export type ConnectedRow = { id: string; name: string; outputType: string; medias?: { roles: string[] }[] };

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

/** The connected account's standalone models of each type, catalogue order kept. */
export function connectedModels(rows: readonly ConnectedRow[]): ComposerModel[] {
  return rows.flatMap((row) => {
    const type = row.outputType === "image" || row.outputType === "video" || row.outputType === "audio" ? row.outputType : null;
    if (!type) return [];
    return [{
      id: row.id,
      /* The connected catalogue already supplies neutral names; an id the
         product knows still goes through the one display-name function. */
      label: displayModelName(row.id) === row.id ? row.name : displayModelName(row.id),
      type,
      referenceRoles: [...new Set((row.medias ?? []).flatMap((slot) => slot.roles))],
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

export type ComposerSettings = { ratio: string; resolution: string; duration: number };

/** The settings a workspace engine renders with: its own first allowed values, the project's aspect where it fits. */
export function composerSettings(model: ComposerModel | null, projectAspect?: string): ComposerSettings {
  const ratios = model?.ratios ?? [];
  const ratio = projectAspect && ratios.includes(projectAspect)
    ? projectAspect
    : ratios.includes("16:9") ? "16:9" : ratios.find((r) => r !== "adaptive") ?? ratios[0] ?? "16:9";
  return {
    ratio,
    resolution: model?.resolutions?.[0] ?? "720p",
    duration: model?.durations?.includes(5) ? 5 : model?.durations?.[0] ?? 5,
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
    input.settings.ratio, input.settings.resolution, input.settings.duration,
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
}): string {
  if (input.submitting) return "Submitting…";
  const credits = liveCredits(input.quote, input.quoteKey);
  if (credits === null) return "Generate";
  return `Generate · ${credits.toLocaleString("en-US")} ${input.billing === "connected" ? "connected cr" : "cr"}`;
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
