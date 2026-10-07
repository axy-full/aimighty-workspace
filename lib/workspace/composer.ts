import { displayModelName, isRetiredModel } from "../models";
import { DRAFT_RESOLUTION } from "../draftFinal";
import { audioTaskAvailable, speechVoicesFor, type NodeAudioSetup, type NodeAudioTask } from "../workbench/generation-audio";
import { isCinemaStudioModel } from "../cinemaStudioTypes";

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
/**
 * Which credits pay for the render: this workspace's. `"connected"` (a
 * signed-in account's catalogue) is retired and nothing here offers it; the
 * word stays in the type only so a recipe, preset or composer state saved with
 * it still parses. The reducer lands every one of them on `"workspace"`.
 */
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
  /** Image/video engines: the engine's own allowed settings. */
  ratios?: string[];
  resolutions?: string[];
  durations?: number[];
  /** Workspace sound engines: which audio task this capability is. */
  audioTask?: NodeAudioTask;
  /** Never set now: no engine Gen offers carries an identity. Kept so a recreated take's identity reads "→ none" (lib/shell/recipe.ts). */
  soulId?: boolean;
  /** Image/video engines: the most reference images and videos the engine takes. */
  maxImages?: number;
  maxVideos?: number;
  /** Takes carry sound: a Studio engine that always renders it (engines route › audio). */
  audio?: boolean;
  /** Workspace image/video engines: the price at the composer's untouched settings (GET /api/workbench/engines › rate). */
  rate?: EngineRate | null;
  /** Sizes the engine lists but that were never rendered here (lib/models.ts › untestedResolutions). */
  untested?: string[];
  /** Workspace video engines with draft mode (lib/draftFinal.ts): Gen offers "Draft first · 480p". */
  draft?: true;
  /** Cinema Studio's Sound switch is offered in this workspace (GET /api/workbench/engines › sound). */
  sound?: true;
};

/** A project file picked as a reference: already saved, so it is cited by id. */
export type ComposerReference = {
  key: string;
  id: string;
  origin: "upload" | "generation";
  kind: "image" | "video" | "audio";
  name: string;
  url: string;
  /** The role a recreated take's reference had (first or last frame); Gen sends it as a plain reference. */
  role?: string;
};

export type ComposerState = {
  type: ComposerType;
  billing: BillingSource;
  /** The model chosen per type (keyed `workspace:<type>`), so switching back keeps it. */
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
  /** Takes per Generate (the stepper, 1–4). Two or more go as one batch at the total on the button (lib/workspace/take-batch.ts). */
  count: number;
  /** Gen's film vocabulary (lib/workspace/film-vocabulary.ts): one camera-bank value per row; a row that is absent is Auto. */
  shot: Record<string, string>;
  /** Cinema Studio 4.0's creative controls (lib/workspace/cinema-vocabulary.ts): one documented value per control; absent is Auto. */
  cinema: Record<string, string>;
  /** The last thing the composer said: a moved price, a refusal, a created project. */
  notice: string | null;
};
export const TAKES_MAX = 4;

/** `draft`: "Draft first" (lib/draftFinal.ts), honoured only on an engine with draft mode: a 480p draft whose final is made after.
 *  `generateAudio`: the Sound switch, honoured only where the engine offers one (soundOffered); off unless picked. */
export type ComposerPicks = { ratio?: string; resolution?: string; duration?: number; soulId?: string; draft?: boolean; generateAudio?: boolean };

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
  count: 1,
  shot: {},
  cinema: {},
  notice: null,
};

export const chosenKey = (type: ComposerType) => `workspace:${type}`;

/**
 * A take's recipe applied in one step (Recreate, lib/shell/recipe.ts): the
 * output, the credits, the model and its settings replace the composer's; the
 * words and references do too unless they are left out (Use settings only).
 * One take — a recreate is one new take, priced again on the button.
 */
export type ComposerRecipe = {
  type: ComposerType;
  billing: BillingSource;
  model?: string;
  picks: ComposerPicks;
  prompt?: string;
  references?: ComposerReference[];
  sound?: { seconds?: number; instrumental?: boolean; voiceId?: string };
  /** The take's shot setup (params.shotSpec); none puts every chip back to Auto. */
  shot?: Record<string, string>;
  /** The take's Cinema Studio controls (params.cinema); none puts every Cinema chip back to Auto. */
  cinema?: Record<string, string>;
};

export type ComposerAction =
  | { type: "type"; value: ComposerType }
  | { type: "billing"; value: BillingSource }
  | { type: "model"; value: string }
  | { type: "prompt"; value: string }
  /** `task` is the current model's audio task: the length is held to what that task bills. */
  | { type: "seconds"; value: number; task?: NodeAudioTask }
  | { type: "instrumental"; value: boolean }
  | { type: "voice"; value: string }
  | { type: "pick"; value: ComposerPicks }
  | { type: "count"; value: number }
  | { type: "shot"; value: Record<string, string> }
  | { type: "cinema"; value: Record<string, string> }
  | { type: "addReference"; value: ComposerReference }
  | { type: "removeReference"; key: string }
  | { type: "notice"; value: string | null }
  | { type: "recipe"; value: ComposerRecipe }
  /** Undo of a recipe: the composer exactly as it was. */
  | { type: "restore"; value: ComposerState }
  | { type: "reset" };

const SOUND_SECONDS = 10;

/**
 * The lengths the audio route takes, per task: music has a ten-second floor
 * and runs to five minutes, a sound effect runs 1–30 s. The composer holds
 * its seconds inside these, so the length it shows is the length it bills.
 */
export const AUDIO_SECONDS: Record<"sound" | "music", { min: number; max: number }> = {
  sound: { min: 1, max: 30 },
  music: { min: 10, max: 300 },
};

/** `value` in whole seconds, inside the task's range (unchanged for a task with no length). */
export function audioSeconds(task: NodeAudioTask | null | undefined, value: number): number {
  if (task !== "sound" && task !== "music") return value;
  const { min, max } = AUDIO_SECONDS[task];
  const whole = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, whole));
}

/** One press of Gen's length stepper: a second for a sound effect, five for music, whose range runs to five minutes. */
export const AUDIO_SECONDS_STEP: Record<"sound" | "music", number> = { sound: 1, music: 5 };

/** Where one press of the stepper lands: the next whole step up or down, held to the task's range. */
export function stepAudioSeconds(task: "sound" | "music", seconds: number, direction: 1 | -1): number {
  const step = AUDIO_SECONDS_STEP[task];
  const now = audioSeconds(task, seconds);
  return audioSeconds(task, direction > 0 ? Math.floor(now / step) * step + step : Math.ceil(now / step) * step - step);
}

/**
 * The voices a speech model reads in: its own vendor's (speechVoicesFor — Grok
 * Voice has xAI's, every other model the ElevenLabs account's), so the list
 * swaps with the model and a line is never priced in the other vendor's voice.
 * A reply without Grok Voice's own list names the default model's in `voices`.
 */
export function composerVoices(audio: Pick<NodeAudioSetup, "voices" | "grokVoices" | "defaultSpeechModel"> | null | undefined, modelId: string): { id: string; name: string }[] {
  if (!audio) return [];
  const own = speechVoicesFor(audio, modelId);
  return own.length || modelId !== audio.defaultSpeechModel ? own : audio.voices;
}

/** The workspace's own audio models (workspaceModels below), so choosing one holds the length to its range. */
const AUDIO_MODEL_TASK: Record<string, NodeAudioTask> = { eleven_sfx: "sound", eleven_music: "music" };

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
      /* One source: whatever is asked for, the composer is on this workspace's credits. */
      return state.billing === "workspace" ? state : { ...state, billing: "workspace", notice: null };
    case "model":
      return {
        ...state,
        chosen: { ...state.chosen, [chosenKey(state.type)]: action.value },
        seconds: audioSeconds(AUDIO_MODEL_TASK[action.value], state.seconds),
        notice: null,
      };
    case "prompt":
      return { ...state, prompt: action.value.slice(0, 5000), notice: null };
    case "seconds":
      return { ...state, seconds: audioSeconds(action.task, action.value), notice: null };
    case "instrumental":
      return { ...state, instrumental: action.value, notice: null };
    case "voice":
      return { ...state, voiceId: action.value, notice: null };
    case "pick":
      return { ...state, picks: { ...state.picks, ...action.value }, notice: null };
    case "count":
      return { ...state, count: Math.max(1, Math.min(TAKES_MAX, Math.round(action.value))) };
    case "shot":
      return { ...state, shot: { ...action.value }, notice: null };
    case "cinema":
      return { ...state, cinema: { ...action.value }, notice: null };
    case "addReference":
      if (state.references.some((r) => r.key === action.value.key)) return state;
      if (state.references.length >= 10) return { ...state, notice: "The composer takes up to 10 references." };
      return { ...state, references: [...state.references, action.value], notice: null };
    case "removeReference":
      return { ...state, references: state.references.filter((r) => r.key !== action.key), notice: null };
    case "notice":
      return { ...state, notice: action.value };
    case "recipe": {
      const recipe = action.value;
      const sound = recipe.type === "audio" ? recipe.sound ?? {} : {};
      const references = recipe.type === "audio" ? [] : recipe.references ?? state.references;
      return {
        ...state,
        type: recipe.type,
        billing: "workspace",
        chosen: recipe.model ? { ...state.chosen, [chosenKey(recipe.type)]: recipe.model } : state.chosen,
        picks: { ...recipe.picks },
        prompt: recipe.prompt === undefined ? state.prompt : recipe.prompt.slice(0, 5000),
        references: references.slice(0, 10),
        seconds: sound.seconds ?? (recipe.type === "audio" && state.type !== "audio" ? SOUND_SECONDS : state.seconds),
        instrumental: sound.instrumental ?? state.instrumental,
        voiceId: sound.voiceId ?? state.voiceId,
        count: 1,
        shot: { ...(recipe.shot ?? {}) },
        cinema: { ...(recipe.cinema ?? {}) },
        notice: null,
      };
    }
    case "restore":
      return { ...action.value, billing: "workspace", notice: null };
    case "reset":
      return { ...INITIAL_COMPOSER, chosen: state.chosen };
  }
}

/* ── Model lists ──────────────────────────────────────────────────────── */

/** An engine's price at the settings it names, in credits (lib/workbench/media-quote.ts › workbenchRate). */
export type EngineRate = { credits: number; resolution: string; ratio: string; duration: number | null; /** An approximate figure: shown as "about". */ approximate?: true;
  /** The figure is for a take with sound (Cinema Studio's Sound switch on). */ sound?: true };

/** A row of GET /api/workbench/engines, as the composer reads it. */
export type EngineRow = {
  id: string;
  kind: "image" | "video";
  resolutions: string[];
  ratios: string[];
  durations: number[];
  soulIdentity?: boolean;
  marketing?: boolean;
  maxReferenceImages?: number;
  maxReferenceVideos?: number;
  untestedResolutions?: string[];
  /** One line on what the engine is for, as Gen renders it (lib/workbench/media-quote.ts › workbenchUse). */
  use?: string;
  /** A take from this engine carries sound as the workbench renders it (lib/workbench/media-quote.ts › rendersSound). */
  audio?: boolean;
  rate?: EngineRate | null;
  /** The engine has draft mode (lib/models.ts › supportsDraft). */
  draft?: boolean;
  /** Cinema Studio's Sound switch is offered here: its sound is priced, or this is the house workspace (lib/cinemaSoundPricing.ts). */
  sound?: boolean;
};

/**
 * The image and sound models the composer offers on the workspace's own
 * credits, in the order the account's own catalogue lists them — so the first
 * of each type is the sensible default and the composer works untouched.
 *
 * Identity and campaign engines are left out: one needs a trained likeness
 * bound to a node and the other a saved campaign mapping, so neither can
 * render from an untouched composer. An engine no longer offered for new
 * renders (lib/models.ts › retired) is left out whatever the route lists.
 */
export function workspaceModels(engines: readonly EngineRow[], audio: NodeAudioSetup | null): ComposerModel[] {
  const out: ComposerModel[] = engines
    .filter((engine) => !engine.soulIdentity && !engine.marketing && !isRetiredModel(engine.id))
    .map((engine) => ({
      id: engine.id,
      label: displayModelName(engine.id),
      type: engine.kind,
      ratios: engine.ratios,
      resolutions: engine.resolutions,
      durations: engine.durations,
      ...(engine.use ? { description: engine.use } : {}),
      ...(typeof engine.maxReferenceImages === "number" ? { maxImages: engine.maxReferenceImages } : {}),
      ...(typeof engine.maxReferenceVideos === "number" ? { maxVideos: engine.maxReferenceVideos } : {}),
      ...(engine.audio ? { audio: true } : {}),
      ...(engine.rate ? { rate: engine.rate } : {}),
      ...(engine.untestedResolutions?.length ? { untested: engine.untestedResolutions } : {}),
      ...(engine.draft && engine.kind === "video" ? { draft: true as const } : {}),
      ...(engine.sound && engine.kind === "video" ? { sound: true as const } : {}),
    }));
  if (audio?.configured) {
    /* Sound and music are ElevenLabs'; a workspace on Grok Voice alone speaks only. */
    if (audioTaskAvailable(audio, "sound")) {
      out.push({ id: "eleven_sfx", label: displayModelName("eleven_sfx"), type: "audio", audioTask: "sound", description: "Sound effects from a description." });
      out.push({ id: "eleven_music", label: displayModelName("eleven_music"), type: "audio", audioTask: "music", description: "Music from a description, 10 s and up." });
    }
    /* Every speech model the workspace reaches that has voices to read in, the default first: picking another one
       (Grok Voice, say) swaps the voice list with it. */
    const speech = [...new Set([audio.defaultSpeechModel, ...audio.speechModels.map((m) => m.id)].filter(Boolean))];
    for (const id of speech) {
      if (!composerVoices(audio, id).length) continue;
      const note = audio.speechModels.find((m) => m.id === id)?.note;
      out.push({ id, label: displayModelName(id), type: "audio", audioTask: "speech", description: note || "Your words, read in a chosen voice." });
    }
  }
  return out;
}

/** The models of the composer's current type, in catalogue order. */
export function offeredModels(state: Pick<ComposerState, "type">, models: readonly ComposerModel[]): ComposerModel[] {
  return models.filter((model) => model.type === state.type);
}

/**
 * The named defaults, by id, first match wins: image → GPT Image 2.5,
 * video → Seedance 2.5, audio → sound effects. The ids of the retired
 * catalogue stay in the lists (they match nothing now), so the order of
 * preference is what it always was. Never invented: a default that the list
 * does not offer is simply not the default.
 */
export const DEFAULT_MODEL_PREFERENCE: ModelPreference = {
  image: ["gpt_image_2_5", "gpt_image_2", "gpt-image-2.5-flare", "gpt-image-2"],
  video: ["seedance_2_5", "dreamina-seedance-2-5-260628"],
  audio: ["seed_audio", "eleven_sfx"],
};

/** A named default: an engine by id, or the first offered engine a test matches (a speech engine, whatever its id). */
export type ModelPreference = Record<ComposerType, readonly (string | ((model: ComposerModel) => boolean))[]>;

/**
 * The model the composer would send: the person's choice while the list still
 * offers it, else the named default when the list carries it, else the list's
 * first — which is why the composer works without anybody touching the model row.
 * A host with defaults of its own (Make, lib/shell/make-price.ts › MAKE_MODEL_PREFERENCE) names them.
 */
export function activeModel(
  /* `billing` is read by nothing: callers that still name the source keep compiling. */
  state: Pick<ComposerState, "type" | "chosen"> & { billing?: BillingSource },
  models: readonly ComposerModel[],
  preference: ModelPreference = DEFAULT_MODEL_PREFERENCE,
): ComposerModel | null {
  const offered = offeredModels(state, models);
  const picked = state.chosen[chosenKey(state.type)];
  const preferred = preference[state.type].map((want) => offered.find((model) => (typeof want === "string" ? model.id === want : want(model)))).find(Boolean);
  return offered.find((model) => model.id === picked) ?? preferred ?? offered[0] ?? null;
}

/* ── Settings the engine allows ───────────────────────────────────────── */

export type ComposerSettings = {
  ratio: string; resolution: string; duration: number;
  /** Never set now (no engine Gen offers carries an identity); read by a recreated take's chips. */ soulId?: string;
  /** A draft first (lib/draftFinal.ts): 480p, watermarked, and made into its 1080p final after. */ draft?: true;
  /** The Sound switch is on: the take is asked for with sound (`generateAudio`). Absent, it is asked for without. */ generateAudio?: true;
};

/** Whether "Draft first" applies to this engine as the composer stands. */
export const draftOffered = (model: Pick<ComposerModel, "draft" | "resolutions"> | null | undefined): boolean =>
  Boolean(model?.draft && model.resolutions?.includes(DRAFT_RESOLUTION));

/**
 * Whether the composer offers a Sound switch for this engine: Cinema Studio 4.0 on this workspace's credits, where the
 * engines route says sound is offered (once its cost is priced, or in the house workspace). Its takes are silent unless
 * the switch is on. The switch is its own choice: a sound reference never turns it on.
 */
export const soundOffered = (model: Pick<ComposerModel, "id" | "type" | "sound"> | null | undefined): boolean =>
  Boolean(model && model.type === "video" && isCinemaStudioModel(model.id) && model.sound);

/** The settings a workspace engine renders with: its own first allowed values, the project's aspect where it fits. */
export function composerSettings(model: ComposerModel | null, projectAspect?: string, picks: ComposerPicks = {}): ComposerSettings {
  const ratios = model?.ratios ?? [];
  const ratio = picks.ratio && ratios.includes(picks.ratio)
    ? picks.ratio
    : projectAspect && ratios.includes(projectAspect)
    ? projectAspect
    : ratios.includes("16:9") ? "16:9" : ratios.find((r) => r !== "adaptive") ?? ratios[0] ?? "16:9";
  /* A draft is 480p whatever size was picked; the pick comes back when the draft is switched off. */
  const draft = Boolean(picks.draft) && draftOffered(model);
  return {
    ratio,
    resolution: draft ? DRAFT_RESOLUTION
      : picks.resolution && model?.resolutions?.includes(picks.resolution) ? picks.resolution : model?.resolutions?.[0] ?? "720p",
    duration: picks.duration != null && model?.durations?.includes(picks.duration)
      ? picks.duration
      : model?.durations?.includes(5) ? 5 : model?.durations?.[0] ?? 5,
    ...(model?.soulId && picks.soulId ? { soulId: picks.soulId } : {}),
    ...(draft ? { draft: true as const } : {}),
    ...(picks.generateAudio && soundOffered(model) ? { generateAudio: true as const } : {}),
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
  /** A batch's own fresh per-take figures (a Generate of takes 2–4 re-quoted them and they moved): their sum is the button's total. */
  takes?: number[];
  /** The figure is approximate (the engine settles on what it delivers): the button says "about". */
  approximate?: boolean;
};

/**
 * The exact inputs a price belongs to. Anything a person can change that moves
 * the price is in here, so a stale figure can never be sent.
 */
export function quoteKeyFor(input: {
  /** Always this workspace's credits; its place in the key is kept so the recovery keys already saved still match. */
  billing?: BillingSource;
  type: ComposerType;
  modelId: string;
  settings: ComposerSettings;
  references: readonly ComposerReference[];
  /** Sound prices the prompt itself. */
  prompt: string;
  /** Sound: the length billed, and the voice a line is read in (the one the picker shows, composerVoices). */
  seconds: number;
  instrumental: boolean;
  voiceId: string;
}): string {
  const priced = input.type === "audio" ? input.prompt : "";
  return JSON.stringify([
    "workspace", input.type, input.modelId,
    input.settings.ratio, input.settings.resolution, input.settings.duration, input.settings.soulId ?? "",
    input.references.map((r) => `${r.origin}:${r.id}`),
    priced, input.seconds, input.instrumental, input.voiceId,
    // Keep existing recovery keys unchanged. Only the new draft body gets its own discriminator.
    ...(input.settings.draft ? ["draft"] : []),
    /* The Sound switch: on, the take is another request, priced (and approved) again; off, the key is as it was. */
    ...(input.settings.generateAudio ? ["sound"] : []),
  ]);
}

/** A ready, current price, or null — the only figure the composer will send. */
export function liveCredits(quote: ComposerQuote | null, quoteKey: string): number | null {
  if (!quote || quote.key !== quoteKey || quote.state !== "ready" || quote.credits === null) return null;
  return quote.credits;
}

/**
 * The total for `count` takes: the batch's own fresh per-take figures when the
 * last Generate re-quoted exactly `count` of them, else `count` times one
 * take's price. Summed take by take — the arithmetic the fresh total it is
 * compared with uses — so an unchanged price always compares equal.
 */
export function batchTotal(credits: number | null, count: number, takes?: readonly number[] | null): number | null {
  if (takes && takes.length === count && takes.every((c) => Number.isFinite(c))) return takes.reduce((sum, c) => sum + c, 0);
  if (credits === null || !Number.isFinite(credits)) return null;
  let total = 0;
  for (let i = 0; i < Math.max(1, count); i++) total += credits;
  return total;
}

/** The figure on the button, which is what a Generate approves: one take's price, or the batch's total. */
export function shownTotal(quote: ComposerQuote | null, quoteKey: string, count: number): number | null {
  const credits = liveCredits(quote, quoteKey);
  if (credits === null) return null;
  return count > 1 ? batchTotal(credits, count, quote?.takes) : credits;
}

/** Why Generate waits with no words; Make says it in its own verb (components/graphite/MakePanel.tsx). */
export const EMPTY_PROMPT = "Write what to generate.";

/** The reason that means "still loading", not "refused" — the model sheet draws it as a loading list. */
export const READING_MODELS = "Reading the available models…";

/**
 * Why Generate cannot run, or null. A missing or stale quote blocks with a
 * visible reason rather than a button that silently does nothing.
 */
export function composerBlock(input: {
  /** `voiceId`: the voice the line will be read in (composerVoices › speechVoiceFor), not only one picked. */
  state: Pick<ComposerState, "type" | "prompt" | "voiceId"> & { billing?: BillingSource };
  model: ComposerModel | null;
  quote: ComposerQuote | null;
  quoteKey: string;
  submitting: boolean;
  /** A failed project list is not evidence that this workspace has no project. */
  projects?: "loading" | "ready" | "error";
  /** Any loading or refusal from reading the model catalogue. */
  catalogue: { loading: boolean; error: string | null };
  /** Sound references held in the well: only Cinema Studio 4.0 takes them. */
  soundReferences?: number;
}): string | null {
  const { state, model, quote, quoteKey } = input;
  if (input.submitting) return "Submitting this generation…";
  if (input.projects === "loading") return "Reading the projects…";
  if (input.projects === "error") return "Projects didn’t load. Use Try again above before generating.";
  if (input.catalogue.error) return input.catalogue.error;
  if (input.catalogue.loading && !model) return READING_MODELS;
  if (!model) return `No ${TYPE_LABELS[state.type].toLowerCase()} model is available on this account.`;
  if (!state.prompt.trim()) return EMPTY_PROMPT;
  if (model.audioTask === "speech" && !state.voiceId) return `${model.label} has no voice to read in here. Choose another model.`;
  if ((input.soundReferences ?? 0) > 0 && !isCinemaStudioModel(model.id))
    return `${model.label} takes pictures and video as references, not sound. Remove the sound, or choose Cinema Studio 4.0.`;
  if (!quote || quote.key !== quoteKey || quote.state === "loading") return "Getting the live price…";
  if (quote.state === "unavailable" || quote.credits === null)
    return quote.reason ?? "This model has no live price with these settings.";
  return null;
}

type ButtonInput = {
  quote: ComposerQuote | null;
  quoteKey: string;
  submitting: boolean;
  /** Takes per Generate; the price shown is the batch's total. */
  count?: number;
  /** A draft first (one take, 480p): the button says so. */
  draft?: boolean;
  /** What the button does, in its own word: "Generate" (the default) or Make's "Make". */
  verb?: string;
};

/**
 * The button's label in its two parts: what it does ("Generate 4 takes") and
 * what it costs ("72 cr" — the live figure, whole, "about" where it is
 * approximate, or none).
 * Gen draws them apart so the price can take its own line on a narrow button
 * rather than ever being cut.
 */
export function composerButtonParts(input: ButtonInput): { action: string; price: string | null } {
  if (input.submitting) return { action: "Submitting…", price: null };
  const count = input.draft ? 1 : Math.max(1, input.count ?? 1);
  const total = shownTotal(input.quote, input.quoteKey, count);
  const verb = input.verb ?? "Generate";
  const action = input.draft ? `${verb} draft` : count > 1 ? `${verb} ${count} takes` : verb;
  if (total === null) return { action, price: null };
  const about = input.quote?.approximate ? "about " : "";
  return { action, price: `${about}${total.toLocaleString("en-US")} cr` };
}

/** "Generate · 18 cr" / "Generate 4 takes · 72 cr" / "Generate · about 18 cr" — the live figure, or no figure at all. */
export function composerButtonLabel(input: ButtonInput): string {
  const { action, price } = composerButtonParts(input);
  return price ? `${action} · ${price}` : action;
}

/** Which credits pay, said plainly. */
export function billingWording(input: { workspaceName?: string | null }): string {
  return `Charged to ${input.workspaceName ? `${input.workspaceName}’s` : "this workspace’s"} credits.`;
}
