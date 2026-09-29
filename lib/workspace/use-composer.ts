"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { DraftRequestError, draftRequest, draftWriter, isDraftConflict, MERGE_TRIES, writeDraft, type DraftWriter } from "../workbench/draft-request";
import { nodeAudioBody, speechVoiceFor, type NodeAudioSetup } from "../workbench/generation-audio";
import { mediaQuoteReferences, mediaReferenceIdentity } from "../workbench/media-reference-input";
import { pendingGenerationKey } from "../workbench/pending-generation";
import { createSoundNode, findSoundNode } from "../workbench/sound-generate";
import { stableId } from "../workbench/stable-id";
import { newProject, type Asset, type CanvasNode, type Project } from "../workbench/studio";
import { activeMediaJob, type MediaJob } from "../workbench/job-recovery";
import { movedOn, poll } from "../poll";
import {
  activeModel,
  audioSeconds,
  billingWording,
  composerBlock,
  composerVoices,
  composerButtonLabel,
  composerButtonParts,
  composerReducer,
  composerSettings,
  INITIAL_COMPOSER,
  liveCredits,
  offeredModels,
  quoteKeyFor,
  shownTotal,
  workspaceModels,
  type ComposerAction,
  type ComposerModel,
  type ComposerQuote,
  type ComposerReference,
  type ComposerSettings,
  type ComposerState,
  type ComposerType,
  type EngineRow,
} from "./composer";
import { formatCredits } from "./cost";
import { refreshProjectLibrary } from "./library";
import { dispatchGeneration, type DispatchRequest } from "./generate-submit";
import { rememberWorkspaceQuote } from "./last-quote";
import {
  batchNotice, batchPhase, batchSettledText, rememberWorkspaceBatch, sendWorkspaceBatch,
  settleWorkspaceBatch, takesPhrase, takeView,
  type BatchTake, type TakeRead, type TakeView,
} from "./take-batch";
import { newBatchId } from "../variations";
import { addShotNode, generationPhase, neutralCopy, referenceRole } from "./rig";
import { shotPatch } from "./shots";
import { useWorkspace } from "./state";
import type { Generation } from "./types";

/**
 * The composer's live wiring. It owns nothing the shell owns: the project it
 * files into is the one the shell has open, and progress is published to the
 * shell's own GenerationStrip through `state.gen`.
 *
 * Money, in one sentence: this workspace's credits — GET
 * /api/workbench/engines for the live figure on the button, then the shared
 * dispatch (lib/workspace/generate-submit.ts) re-quotes POST
 * /api/generate/quote with the exact body and submits POST /api/generate with
 * `maxCredits` + `quoteFingerprint`. (The catalogue of a signed-in Higgsfield
 * account went with that sign-in.)
 *
 * Sound is quoted and submitted through the existing audio admission
 * (POST /api/audio, `quoteOnly` then `maxCredits`).
 *
 * A take on this workspace's credits needs a shot to live in. It is added to
 * the draft exactly as the server holds it at that moment — read fresh, never
 * the copy the page opened with — and saved at that draft's revision; when
 * another save lands first, the draft is read again and the same shot laid
 * over it. Each take carries the saved draft on to the next. Sound files on its
 * lane's node, as Edit & Sound does, never on a video shot.
 *
 * A take whose paid request is not confirmed (the reply was lost, the page
 * closed) is remembered in this browser, with the take it was in its batch —
 * one record per take, named by its settings and prompt, so other takes made
 * meanwhile (here or in another tab) leave it be. The next Generate of that
 * same take takes it up again — the same shot, its claimed request checked on
 * the server (followed if it landed, never re-sent) — and goes on from there,
 * never paying for it twice. A different prompt or settings is a new take at
 * the price on the button.
 *
 * Two to four takes of one Generate go as ONE priced batch
 * (lib/workspace/take-batch.ts): every take is quoted before any is sent, the
 * sum is exactly the total on the button or none is sent, and a batch whose
 * reply was lost is checked (and fenced) before anything else is sent on the
 * project. Every take that went is followed here until it settles.
 */

const API = "/api/workbench";
const DONE_HOLD_MS = 1800;
const FAILED_HOLD_MS = 6000;
const QUOTE_DEBOUNCE_MS = 260;

type Run = {
  name: string;
  meta: string;
  /** The media job id, once accepted. */
  jobId: string | null;
  /** The project it files into. */
  projectId?: string;
};

/** Takes 2–4 of one Generate (lib/workspace/take-batch.ts): every take that went is followed until it settles. */
type BatchRun = {
  id: string;
  projectId: string;
  name: string;
  model: string;
  takes: BatchTake[];
};
/** A batch as Gen's Results and the shell's strip show it: its takes, each in its own words. */
export type BatchView = BatchRun & { views: TakeView[]; phase: ReturnType<typeof batchPhase> };

/** A draft exactly as the server holds it, with its revision. */
type SavedDraft = { project: Project; revision: number };

/** What this composer is still following for a scope, so leaving Gen and coming back picks it up again. */
const FOLLOW_KEY = (scope: string) => `particl:composer-follow:v1:${scope}`;
type Following = { run: Run | null };
/**
 * A take on the retired Higgsfield account's catalogue a browser still names
 * here (`source: "connected"`, with its account jobs beside it) is let go: it
 * is not this workspace's job to read, and its result, if any, is in the Library.
 */
function readFollowing(scope: string): Following {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(FOLLOW_KEY(scope)) ?? "null") as { run?: (Run & { source?: unknown }) | null } | null;
    const run = value?.run;
    if (!run?.jobId || run.source === "connected") return { run: null };
    return { run: { name: run.name, meta: run.meta, jobId: run.jobId, ...(run.projectId ? { projectId: run.projectId } : {}) } };
  } catch {
    return { run: null };
  }
}
function writeFollowing(scope: string, value: Following) {
  try {
    if (!value.run) window.sessionStorage.removeItem(FOLLOW_KEY(scope));
    else window.sessionStorage.setItem(FOLLOW_KEY(scope), JSON.stringify(value));
  } catch { /* following is a convenience; the takes still land */ }
}

/** A take a Generate left unconfirmed, or the next take of a batch that stopped part way; where it is in its batch (see the note above). */
type ResumeRecord = { kind: "workspace"; projectId: string; take: number; node: CanvasNode | null };
/* One record per project and take — the take named by its settings and prompt — so a take made meanwhile, here or in another tab, never replaces it. */
const RESUME_PREFIX = "particl:composer-resume:v2:";
const RESUME_KEY = (scope: string, projectId: string, take: string) => `${RESUME_PREFIX}${JSON.stringify([scope, projectId, stableId("take", take)])}`;
/** A record nobody took up in a week is let go (its claimed request is still settled by the dispatch: checked, never re-sent). */
const RESUME_MS = 7 * 24 * 60 * 60 * 1000;
function readResume(scope: string, projectId: string, take: string): ResumeRecord | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(RESUME_KEY(scope, projectId, take)) ?? "null") as (ResumeRecord & { at?: number }) | null;
    if (!value || value.projectId !== projectId || !Number.isInteger(value.take) || value.take < 0 || typeof value.at !== "number" || Date.now() - value.at > RESUME_MS) return null;
    /* A record of a take on the retired account's catalogue (`kind: "connected"`) is not taken up: nothing is sent there now. */
    if (value.kind !== "workspace") return null;
    return value.node === null || (value.node && typeof value.node.id === "string") ? value : null;
  } catch {
    return null;
  }
}
function writeResume(scope: string, projectId: string, take: string, value: ResumeRecord | null) {
  try {
    if (value) window.localStorage.setItem(RESUME_KEY(scope, projectId, take), JSON.stringify({ ...value, at: Date.now() }));
    else window.localStorage.removeItem(RESUME_KEY(scope, projectId, take));
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(RESUME_PREFIX)) continue;
      const at = (JSON.parse(window.localStorage.getItem(key) ?? "null") as { at?: number } | null)?.at;
      if (typeof at !== "number" || Date.now() - at > RESUME_MS) window.localStorage.removeItem(key);
    }
  } catch { /* without storage, a lost take is not taken up again after a reload: its claimed request still is */ }
}

function validMapping(value: unknown): value is { shotId: string; productionProjectId: string } {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return [m.shotId, m.productionProjectId].every((v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v));
}

/** A picked reference as the quote and request helpers read it: an Asset citing its saved id. */
function referenceAsset(reference: ComposerReference): Asset {
  return {
    id: reference.key,
    name: reference.name,
    url: reference.url,
    kind: reference.kind,
    ...(reference.origin === "upload" ? { uploadId: reference.id } : { generationId: reference.id }),
    status: "Draft",
    version: 1,
    locked: false,
    refs: [],
  } as unknown as Asset;
}

export type ComposerHost = {
  state: ComposerState;
  dispatch: (action: ComposerAction) => void;
  /** Models of every type this workspace offers. */
  models: ComposerModel[];
  /** Models of the current type, in catalogue order. */
  offered: ComposerModel[];
  model: ComposerModel | null;
  quote: ComposerQuote | null;
  quoteKey: string;
  /** The exact settings the engine would render with (ratio, resolution, duration). */
  settings: ComposerSettings;
  credits: number | null;
  buttonLabel: string;
  /** The same label in its two parts, what it does and what it costs, for a button that lays them out apart. */
  buttonParts: { action: string; price: string | null };
  blocked: string | null;
  submitting: boolean;
  /** Which credits will be charged, said plainly. */
  wording: string;
  /** The audio setup, for the voice row. */
  audio: NodeAudioSetup | null;
  /** A speech model's voices (each model its own vendor's, composerVoices), and the one the line is read in: the pick, else the first. */
  voices: { id: string; name: string }[];
  voice: { id: string; name: string } | null;
  /** A sound effect's or music's length as billed: the seconds held to the model's range. */
  seconds: number;
  /** The project the composer files into; null until one is open or created. */
  project: Project | null;
  /** One line about a project the composer had to create. */
  projectNotice: string | null;
  generate: () => void;
  /** Read the engine list again after a failed read (Gen's model sheet › Try again). */
  retryEngines: () => void;
  scope: string;
  /** Batches of takes 2–4 still being followed, newest last: Gen's Results show each as one strip. */
  batches: BatchView[];
};

export function useComposer(options: {
  scope: string;
  open: boolean;
  /** The project the shell has open. */
  project: Project | null;
  /** The shell must finish reading its projects before this composer may generate. */
  projects?: "loading" | "ready" | "error";
  /** Adopt a project the composer created, so the shell opens it. */
  onProject: (projectId: string) => void;
  /** The workspace's own name, for the billing line. */
  workspaceName: string | null;
  /**
   * The output type the composer opens on. The desktop overlay opens on Image
   * (the cheapest first render); the phone's wall opens on Video, because the
   * wall it is docked to is a video wall. It is the same control either way —
   * only where it starts differs.
   */
  initialType?: ComposerType;
  /**
   * How the words go out with the composer's `shot` (Gen's film vocabulary, lib/workspace/film-vocabulary.ts
   * › composeForSend). Handed in by the one composer that has the chips, so the camera bank stays out of
   * the others; without it the words go as typed.
   */
  compose?: (prompt: string, shot: Record<string, string>, type: ComposerType) => { prompt: string; shotSpec: Record<string, string> | null };
}): ComposerHost {
  const { scope, open, project } = options;
  const ws = useWorkspace();
  const [state, dispatch] = useReducer(
    composerReducer,
    options.initialType,
    (type) => (type ? { ...INITIAL_COMPOSER, type } : INITIAL_COMPOSER),
  );
  const [engines, setEngines] = useState<{ rows: EngineRow[]; error: string | null; loading: boolean }>({ rows: [], error: null, loading: true });
  const [enginesRead, setEnginesRead] = useState(0);
  const [audio, setAudio] = useState<NodeAudioSetup | null>(null);
  const [quoteAnswer, setQuoteAnswer] = useState<{ scope: string; quote: ComposerQuote | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  /** Every batch sent here, followed take by take until each settles; the latest read of each workspace take's job. */
  const [batches, setBatches] = useState<BatchRun[]>([]);
  const [takeReads, setTakeReads] = useState<Record<string, TakeRead>>({});
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<Project | null>(null);

  /* The project the composer files into: the shell's, or the one it created
     before the shell's own read has caught up. */
  const target = project ?? created;

  /* ── The models this account offers ─────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    studioRequest<{ models: EngineRow[] }>(`${API}/engines`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
      .then((data) => { if (!controller.signal.aborted) setEngines({ rows: data.models ?? [], error: null, loading: false }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setEngines({ rows: [], loading: false, error: neutralCopy(error instanceof Error ? error.message : "The available models could not be read.", "The available models could not be read.") });
      });
    return () => controller.abort();
  }, [open, scope, enginesRead]);
  const retryEngines = useCallback(() => { setEngines({ rows: [], error: null, loading: true }); setEnginesRead((n) => n + 1); }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    studioRequest<NodeAudioSetup>("/api/audio", { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
      .then((data) => { if (!controller.signal.aborted) setAudio(data); })
      .catch(() => { if (!controller.signal.aborted) setAudio({ configured: false, speechModels: [], defaultSpeechModel: "", voices: [], voicesError: null }); })
    return () => controller.abort();
  }, [open, scope]);

  const quote = quoteAnswer?.scope === scope ? quoteAnswer.quote : null;
  const setQuote = useCallback((value: ComposerQuote | null) => setQuoteAnswer({ scope, quote: value }), [scope]);

  const models = useMemo(() => workspaceModels(engines.rows, audio), [engines.rows, audio]);
  const offered = useMemo(() => offeredModels(state, models), [state, models]);
  const model = useMemo(() => activeModel(state, models), [state, models]);
  const settings = useMemo(() => composerSettings(model, target?.aspect, state.picks), [model, target?.aspect, state.picks]);
  /* The words as sent: Gen's film vocabulary written in, and the setup itself as data (lib/workspace/film-vocabulary.ts). */
  const compose = options.compose;
  const sent = useMemo(() => (compose ? compose(state.prompt, state.shot, state.type) : { prompt: state.prompt, shotSpec: null }), [compose, state.prompt, state.shot, state.type]);

  /* Sound as it is billed: the length held to the model's range, and the voice a line is read in — the one picked
     while this model has it, else the model's first (each speech model reads in its own vendor's voices). The picker,
     the price on the button and the request all read these, so what is shown is what is sent. */
  const seconds = audioSeconds(model?.audioTask, state.seconds);
  const voices = useMemo(() => (model?.audioTask === "speech" ? composerVoices(audio, model.id) : []), [audio, model]);
  const voice = speechVoiceFor(voices, state.voiceId);
  const voiceId = voice?.id ?? "";

  const quoteKey = quoteKeyFor({
    type: state.type, modelId: model?.id ?? "", settings,
    references: state.references, prompt: sent.prompt.trim(), seconds,
    instrumental: state.instrumental, voiceId,
  });

  /* ── The live price on the button ───────────────────────────────────── */
  const audioBody = model?.audioTask
    ? nodeAudioBody({ task: model.audioTask, text: state.prompt, seconds, instrumental: state.instrumental, voiceId, modelId: model.id })
    : null;

  const blockedForQuote = !open || !model || !state.prompt.trim() || (options.projects != null && options.projects !== "ready");

  useEffect(() => {
    /* A figure for other inputs is already stale by its key; nothing is reset here. */
    if (blockedForQuote) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const ask = async (): Promise<ComposerQuote> => {
        if (audioBody) {
          const result = await studioRequest<{ estimatedCredits?: number }>("/api/audio", {
            method: "POST", signal: controller.signal,
            headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify({ ...audioBody, quoteOnly: true }),
          });
          const credits = result.estimatedCredits;
          if (typeof credits !== "number" || !Number.isFinite(credits))
            return { key: quoteKey, credits: null, state: "unavailable", reason: "Sound cannot be priced with these settings." };
          return { key: quoteKey, credits, state: "ready", reason: null };
        }
        const query = new URLSearchParams({ model: model!.id, resolution: settings.resolution, ratio: settings.ratio, duration: String(settings.duration) });
        const references = state.references.length ? mediaQuoteReferences(state.references.map(referenceAsset)) : "";
        const result = await studioRequest<{ credits: number | null; approximate?: boolean }>(`${API}/engines?${query}${references ? `&${references}` : ""}`, {
          signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store",
        });
        if (typeof result.credits !== "number" || !Number.isFinite(result.credits))
          return { key: quoteKey, credits: null, state: "unavailable", reason: "This model cannot be priced with these settings." };
        return { key: quoteKey, credits: result.credits, state: "ready", reason: null, ...(result.approximate === true ? { approximate: true } : {}) };
      };
      void ask()
        .then((value) => { if (!controller.signal.aborted) setQuote(value); })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setQuote({ key: quoteKey, credits: null, state: "unavailable",
            reason: neutralCopy(error instanceof Error ? error.message : "The price is unavailable right now.", "The price is unavailable right now.") });
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
    /* `quoteKey` names every input the figure prices. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedForQuote, quoteKey, scope, target?.id]);

  const credits = liveCredits(quote, quoteKey);
  /* The price on Generate — the button's own total, every take — in this workspace's credits, is the header's last quote
     (lib/workspace/last-quote.ts): recorded, never asked for. */
  /* A draft goes one take at a time (lib/draftFinal.ts), whatever the takes stepper held before it was switched on. */
  const buttonTotal = shownTotal(quote, quoteKey, settings.draft ? 1 : Math.max(1, state.count));
  useEffect(() => {
    if (buttonTotal != null) rememberWorkspaceQuote(scope, buttonTotal);
  }, [scope, buttonTotal]);
  const blocked = composerBlock({
    projects: options.projects,
    state: { ...state, voiceId }, model, quote, quoteKey, submitting,
    catalogue: { loading: engines.loading, error: engines.error },
  });

  /* ── Generate ───────────────────────────────────────────────────────── */
  const live = useRef({ state, model, settings, credits, blocked, target, audioBody, quoteKey, quote, sent });
  useEffect(() => { live.current = { state, model, settings, credits, blocked, target, audioBody, quoteKey, quote, sent }; });
  const busy = useRef(false);

  /** The project to file into: the open one, or a new "Untitled" through the ordinary creation path. */
  const ensureProject = useCallback(async (): Promise<Project> => {
    const open = live.current.target;
    if (open) return open;
    /* Exactly what the workbench's New project does: a new draft saved through
       the tenant-scoped, revision-checked save, which mints the production
       project server-side. No id is invented here. */
    const fresh = newProject("Untitled");
    const receipt = await writeDraft(API, scope, { project: fresh, revision: 0 });
    const saved: Project = { ...fresh, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings };
    setCreated(saved);
    setProjectNotice("No project was open, so this went into a new project called “Untitled”.");
    options.onProject(saved.id);
    return saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  /** This composer's saves of the draft the takes file into: a save whose reply was lost is checked, never guessed at. */
  const writer = useRef<{ projectId: string; writer: DraftWriter } | null>(null);

  /** Follow a batch: every take that went is read until it settles (below). A batch that sent nothing has nothing to follow. */
  const followBatch = useCallback((run: BatchRun) => {
    if (!run.takes.some((take) => take.jobId || take.state === "unconfirmed")) return;
    setBatches((list) => [...list.filter((item) => item.id !== run.id), run]);
  }, []);

  /* The shot a batch whose price moved had already filed: the next press of the same batch goes on it, not on another empty shot. */
  const batchShot = useRef<{ key: string; projectId: string; node: CanvasNode; mapping: { shotId: string; productionProjectId: string } } | null>(null);

  /**
   * Before anything is sent on a project: a batch there whose reply was lost is
   * asked about (lib/workspace/take-batch.ts; the server's check fences what
   * never arrived). Whatever the answer, this press sends nothing new: what had
   * landed is followed, what never arrived is said to have cost nothing, and an
   * answer not yet known leaves it to be asked again. The next press sends what
   * is on screen at the price on the button.
   */
  const settleEarlier = useCallback(async (projectId: string): Promise<{ proceed: boolean; notice: string | null }> => {
    const settled = await settleWorkspaceBatch({ scope, projectId });
    if (settled.state === "none") return { proceed: true, notice: null };
    if (settled.state === "unknown") return { proceed: false, notice: settled.reason };
    const lost = settled.lost.length ? `${takesPhrase(settled.lost).replace(/^t/, "T")} of your last batch never arrived; nothing was charged for ${settled.lost.length === 1 ? "it" : "them"}.` : "";
    /* Never arrived, and fenced now: said before anything new is spent — the next press sends a whole new batch, not the missing take. */
    if (!settled.landed.length) return { proceed: false, notice: `${lost} Nothing new was sent: press Generate again to send this.` };
    const found = settled.landed.map((take): BatchTake => ({ variation: take.variation, state: "queued", jobId: take.jobId, credits: take.credits }));
    setBatches((list) => {
      const known = list.find((item) => item.id === settled.batchId);
      const takes = known ? [...known.takes.filter((take) => !found.some((item) => item.variation === take.variation)), ...found].sort((a, b) => a.variation - b.variation) : found;
      return [...list.filter((item) => item.id !== settled.batchId), { id: settled.batchId, projectId, name: settled.name, model: settled.model, takes }];
    });
    const landed = settled.landed.length === 1;
    return { proceed: false, notice: `${lost ? `${lost} ` : ""}${takesPhrase(settled.landed.map((take) => take.variation)).replace(/^t/, "T")} of your last batch ${landed ? "is" : "are"} on the server, followed until ${landed ? "it lands" : "they land"}. Nothing new was sent.` };
  }, [scope]);

  const generate = useCallback(() => {
    const now = live.current;
    if (busy.current) return;
    if (now.blocked) { dispatch({ type: "notice", value: now.blocked }); return; }
    if (!now.model) return;
    const model = now.model, composer = now.state;
    /* Two to four takes go as ONE batch at the total on the button (lib/workspace/take-batch.ts). */
    /* A draft goes one at a time (lib/draftFinal.ts): its final is made from it, take by take. */
    const count = now.settings.draft ? 1 : Math.max(1, composer.count);
    /* What the button shows is what this press approves: one take's price, or the batch's total. */
    const shown = count > 1 ? shownTotal(now.quote, now.quoteKey, count) : now.credits;
    busy.current = true;
    setSubmitting(true);
    dispatch({ type: "notice", value: null });
    void (async () => {
      try {
        const project = await ensureProject();
        const settings = now.settings;
        const base = composer.prompt.trim().slice(0, 60) || `${model.label} take`;
        /* A batch on this project whose reply was lost is asked about before anything else is sent: never twice. */
        const earlier = await settleEarlier(project.id);
        if (!earlier.proceed) { dispatch({ type: "notice", value: earlier.notice }); return; }
        const before = earlier.notice ? `${earlier.notice} ` : "";
        if (earlier.notice) dispatch({ type: "notice", value: earlier.notice });
        if (count > 1) {
          const batchId = newBatchId();
          /* This workspace's credits: ONE shot for the whole batch (sound: its lane's node), added to the draft as the
             server holds it; the same batch again after its price moved goes on the shot it already filed. */
          const reuse = batchShot.current && batchShot.current.key === now.quoteKey && batchShot.current.projectId === project.id ? batchShot.current : null;
          batchShot.current = null;
          if (writer.current?.projectId !== project.id) writer.current = { projectId: project.id, writer: draftWriter() };
          let made: CanvasNode | null = reuse?.node ?? null;
          const filed = await saveOnLatest(scope, project.id, null, (latest) => {
            if (model.audioTask) {
              const lane = findSoundNode(latest, model.audioTask);
              if (lane) { made = lane; return latest; }
              if (made?.type !== "audio") made = createSoundNode(latest, model.audioTask);
              return { ...latest, nodes: [...latest.nodes, made] };
            }
            const shot = made;
            if (shot) return latest.nodes.some((n) => n.id === shot.id) ? latest : { ...latest, nodes: [...latest.nodes, shot] };
            const withShot = addShotNode(latest);
            const named = shotPatch(withShot.project, withShot.id, {
              name: `${base} · ${count} takes`,
              note: composer.prompt.trim(),
              engine: model.id, ratio: settings.ratio, resolution: settings.resolution, ...(model.durations?.length ? { durationS: settings.duration } : {}),
            });
            made = named.nodes.find((n) => n.id === withShot.id) ?? null;
            return named;
          }, writer.current.writer);
          const node = made as CanvasNode | null;
          if (!node) throw new Error("This batch could not be filed. Nothing was submitted.");
          setCreated(filed.project);
          const mapping = reuse && reuse.node.id === node.id ? reuse.mapping : await studioRequest<unknown>(`${API}/projects`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify({ action: "map-shot", projectId: filed.project.id, nodeId: node.id }),
          });
          if (!validMapping(mapping)) throw new Error("The project mapping could not be verified. Nothing was submitted.");
          const shotNow = { key: now.quoteKey, projectId: filed.project.id, node, mapping };
          /* Each take's own recovery key, never another batch's: the batch id is in it (sound takes share their lane). */
          const storageId = (variation: number) => pendingGenerationKey(scope, filed.project.id, `${node.id}:${batchId}:take-${variation}`);
          const references = () => composer.references.map((reference) => {
            const identity = mediaReferenceIdentity(referenceAsset(reference));
            if (!identity) throw new Error(`${reference.name} cannot be used as a reference.`);
            return { ...identity, role: referenceRole({ kind: reference.kind }) };
          });
          const request = (variation: number): DispatchRequest => model.audioTask
            ? {
                endpoint: "/api/audio",
                quoteBody: { ...now.audioBody!, batchId, variation },
                body: { ...now.audioBody!, projectId: mapping.productionProjectId, shotId: mapping.shotId, batchId, variation },
              }
            : {
                endpoint: "/api/generate",
                input: {
                  /* Every take of the batch goes in the words as sent: the film vocabulary written in, the setup as data. */
                  prompt: now.sent.prompt.trim(), kind: model.type === "video" ? "video" : "image", model: { id: model.id }, mapping,
                  ratio: settings.ratio, resolution: settings.resolution, duration: settings.duration, references: references(), firstFrameAssetId: "",
                  batch: { id: batchId, variation }, shotSpec: now.sent.shotSpec,
                },
              };
          const outcome = await sendWorkspaceBatch({ scope, shown, count, storageId, request });
          if (outcome.state === "repriced") {
            batchShot.current = shotNow;
            setQuote({ key: now.quoteKey, credits: outcome.takes[0], state: "ready", reason: null, takes: outcome.takes });
            dispatch({ type: "notice", value: `${before}${outcome.reason}` });
            return;
          }
          if (outcome.state === "refused") { batchShot.current = shotNow; dispatch({ type: "notice", value: `${before}${outcome.reason}` }); return; }
          const unconfirmed = outcome.takes.filter((take) => take.state === "unconfirmed");
          if (unconfirmed.length)
            rememberWorkspaceBatch(window.localStorage, scope, {
              projectId: filed.project.id, batchId, name: base, model: model.label,
              takes: unconfirmed.map((take) => ({ variation: take.variation, storageId: storageId(take.variation), credits: take.credits })),
            });
          followBatch({ id: batchId, projectId: filed.project.id, name: base, model: model.label, takes: outcome.takes });
          dispatch({ type: "notice", value: `${before}${batchNotice(outcome.takes)}` });
          return;
        }
        /* This take — these settings and this prompt — as the resume records name it (the third place, once the retired
           account's request body, stays empty so a record already kept is still found). */
        const takeKey = JSON.stringify([now.quoteKey, composer.prompt.trim(), ""]);
        /* The same take left unconfirmed, or a batch of it that stopped part way: taken up again, and the batch goes on from it. */
        const again = readResume(scope, project.id, takeKey);
        const start = again ? again.take : 0;
        const end = again ? Math.max(count, again.take + 1) : count;
        /* The draft the takes file into: read fresh for the first, then carried from each save to the next. */
        let draft: SavedDraft | null = null;
        if (writer.current?.projectId !== project.id) writer.current = { projectId: project.id, writer: draftWriter() };
        const saves = writer.current.writer;
        for (let take = start; take < end; take++) {
        const name = end > 1 ? `${base} · take ${take + 1}` : base;
        /* This workspace's credits: the take needs a shot to live in, so the
           composer adds one to the draft the way Rig does (sound: its lane's
           node, as Edit & Sound does) and maps it. */
        let made: CanvasNode | null = take === start && again ? again.node : null;
        const remember = () => {
          const node = made as CanvasNode | null;
          /* Until the server confirms the job, the next Generate of this take takes this shot up again. */
          if (node) writeResume(scope, project.id, takeKey, { kind: "workspace", projectId: project.id, take, node });
        };
        const filed = await saveOnLatest(scope, project.id, draft, (latest) => {
          /* Sound files on its lane: the one the draft has now (Edit & Sound may have made it meanwhile), else one made here, once. */
          if (model.audioTask) {
            const lane = findSoundNode(latest, model.audioTask);
            if (lane) { made = lane; return latest; }
            if (made?.type !== "audio") made = createSoundNode(latest, model.audioTask);
            return { ...latest, nodes: [...latest.nodes, made] };
          }
          const shot = made;
          if (shot) return latest.nodes.some((n) => n.id === shot.id) ? latest : { ...latest, nodes: [...latest.nodes, shot] };
          const withShot = addShotNode(latest);
          const named = shotPatch(withShot.project, withShot.id, {
            name,
            note: composer.prompt.trim(),
            engine: model.id, ratio: settings.ratio, resolution: settings.resolution, ...(model.durations?.length ? { durationS: settings.duration } : {}),
          });
          made = named.nodes.find((n) => n.id === withShot.id) ?? null;
          return named;
        }, saves).finally(remember);
        const shot = made as CanvasNode | null;
        if (!shot) throw new Error("This take could not be filed. Nothing was submitted.");
        draft = filed;
        setCreated(filed.project);
        const mapping = await studioRequest<unknown>(`${API}/projects`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
          body: JSON.stringify({ action: "map-shot", projectId: filed.project.id, nodeId: shot.id }),
        });
        if (!validMapping(mapping)) throw new Error("The project mapping could not be verified. Nothing was submitted.");
        const references = composer.references.map((reference) => {
          const identity = mediaReferenceIdentity(referenceAsset(reference));
          if (!identity) throw new Error(`${reference.name} cannot be used as a reference.`);
          return { ...identity, role: referenceRole({ kind: reference.kind }) };
        });
        /* The take's own recovery key: a claimed request left unconfirmed is checked on the server, never re-sent. Sound
           takes share their lane, so theirs is the lane's and these settings': a new prompt is a new request. */
        const storageId = pendingGenerationKey(scope, filed.project.id, model.audioTask ? `${shot.id}:${stableId("take", now.quoteKey)}` : shot.id);
        const outcome = await dispatchGeneration({
          scope,
          storageId,
          shown,
          /* The button's whole figure is this composer's last quote (recorded above), not one take's. */
          remember: false,
          request: model.audioTask
            ? {
                endpoint: "/api/audio",
                quoteBody: { ...now.audioBody! },
                body: { ...now.audioBody!, projectId: mapping.productionProjectId, shotId: mapping.shotId },
              }
            : {
                endpoint: "/api/generate",
                input: {
                  prompt: now.sent.prompt.trim(),
                  kind: model.type === "video" ? "video" : "image",
                  model: { id: model.id },
                  mapping,
                  ratio: settings.ratio,
                  resolution: settings.resolution,
                  duration: settings.duration,
                  references,
                  firstFrameAssetId: "",
                  shotSpec: now.sent.shotSpec,
                  ...(settings.draft ? { draft: true } : {}),
                },
              },
          onClaim: (approved) => setRun({ name, meta: [name, model.label, formatCredits(approved)].join(" · "), jobId: null, projectId: project.id }),
        });
        if (outcome.state === "repriced") {
          setQuote({ key: now.quoteKey, credits: outcome.credits, state: "ready", reason: null });
          setRun(null);
          dispatch({ type: "notice", value: `${before}${outcome.reason}` });
          return;
        }
        if (outcome.state === "refused") { setRun(null); dispatch({ type: "notice", value: `${before}${outcome.reason}` }); return; }
        /* Taken: the next Generate of this batch goes on from the take after it. */
        writeResume(scope, project.id, takeKey, take + 1 < end ? { kind: "workspace", projectId: project.id, take: take + 1, node: null } : null);
        setRun({ name, meta: [name, model.label, formatCredits(outcome.credits)].join(" · "), jobId: outcome.jobId, projectId: project.id });
        }
        if (end > 1) dispatch({ type: "notice", value: start === 0 ? `${end} takes submitted, each at the price shown. They file into Takes as they land.`
          : start + 1 === end ? `Take ${end} submitted at the price shown. It files into Takes as it lands.`
          : `Takes ${start + 1}–${end} submitted, each at the price shown. They file into Takes as they land.` });
      } catch (error) {
        setRun(null);
        dispatch({ type: "notice", value: neutralCopy(error instanceof Error ? error.message : "This generation could not be submitted.") });
      } finally {
        busy.current = false;
        setSubmitting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, ensureProject, followBatch, settleEarlier, settings.ratio, settings.resolution, settings.duration, setQuote]);

  /* ── Progress, from the real job ────────────────────────────────────── */
  const [read, setRead] = useState<{ id: string; job: MediaJob } | null>(null);
  const workspaceJobId = run?.jobId ?? null;
  const mediaJob = read && read.id === workspaceJobId ? read.job : null;
  /* Read at lib/poll's pace until the job is in its terminal set; a changed status starts the pace over,
     a missed read backs off. */
  useEffect(() => {
    if (!workspaceJobId) return;
    const moved = movedOn();
    const poller = poll({
      immediate: true,
      read: (signal) => studioRequest<{ generation: MediaJob }>(`/api/jobs/${encodeURIComponent(workspaceJobId)}`, { signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" }),
      moved: (data) => moved(workspaceJobId, data.generation.status),
      done: (data) => !activeMediaJob(data.generation),
      onValue: (data) => setRead({ id: workspaceJobId, job: data.generation }),
    });
    return () => poller.stop();
  }, [workspaceJobId, scope]);

  /* ── A batch's takes, each followed until it settles ─────────────────── */
  const batchViews = useMemo<BatchView[]>(() => batches.map((run) => {
    /* Each take reads as its own job's latest read (below). */
    const views = run.takes.map((take) => takeView(take, take.jobId ? takeReads[take.jobId] : undefined));
    return { ...run, views, phase: batchPhase(views) };
  }), [batches, takeReads]);
  /* The takes still in flight, as one key: the poll below restarts only when that set changes. */
  const inflight = JSON.stringify(batchViews.flatMap((run) => run.views.filter((view) => view.jobId && !view.done).map((view) => view.jobId)));
  useEffect(() => {
    const ids = JSON.parse(inflight) as string[];
    if (!ids.length) return;
    /* Each take at lib/poll's pace, like the single take above, until it is in its terminal set; a changed status starts its pace over. */
    const moved = movedOn();
    const pollers = ids.map((id) => poll({
      immediate: true,
      read: (signal) => studioRequest<{ generation: MediaJob }>(`/api/jobs/${encodeURIComponent(id)}`, { signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" }),
      moved: (data) => moved(id, data.generation.status),
      done: (data) => !activeMediaJob(data.generation),
      onValue: (data) => setTakeReads((reads) => ({ ...reads, [id]: { media: data.generation } })),
    }));
    return () => { for (const poller of pollers) poller.stop(); };
  }, [inflight, scope]);

  /* What is still being followed survives leaving Gen: it is picked up again when the composer is back. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const following = readFollowing(scope);
    if (!following.run) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- Browser-only session state, read once after mounting. */
    setRun((current) => current ?? following.run);
  }, [scope]);
  useEffect(() => {
    if (!restored.current) return;
    writeFollowing(scope, { run: run?.jobId ? run : null });
  }, [scope, run]);

  /* ── The shell's strip ──────────────────────────────────────────────── */
  const shown = useRef<string>("");
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announced = useRef<string | null>(null);
  const { dispatch: shellDispatch, toast } = ws;
  /* A batch still on screen: the newest one, until it has settled and been announced. */
  const batch = batchViews.length ? batchViews[batchViews.length - 1] : null;
  const announcedBatches = useRef(new Set<string>());
  useEffect(() => {
    /* The strip shows the newest batch while it is followed, else the single take. */
    const phase = batch ? null : !run ? null : generationPhase(run.jobId ? mediaJob ?? { status: "queued" } : null);
    const went = batch ? batch.takes.filter((take) => take.state !== "refused" && take.state !== "not-sent").reduce((sum, take) => sum + take.credits, 0) : 0;
    const gen: Generation | null = batch
      ? {
          id: `batch:${batch.id}`, pct: batch.phase.pct, name: `${batch.name} · ${batch.takes.length} takes`, label: batch.phase.label, tone: batch.phase.tone,
          meta: [batch.model, formatCredits(went)].filter(Boolean).join(" · "),
        }
      : run && phase
      ? { id: run.jobId ?? "pending:composer", pct: phase.pct, name: run.name, meta: run.meta, label: phase.label, tone: phase.tone }
      : null;
    const key = JSON.stringify(gen);
    if (key !== shown.current) {
      shown.current = key;
      shellDispatch({ type: "patch", patch: { gen } });
    }
    /* Every batch that is over is announced once, then let go of: its strip in Takes carries it from there. */
    for (const done of batchViews.filter((item) => item.phase.done && !announcedBatches.current.has(item.id))) {
      announcedBatches.current.add(done.id);
      toast(batchSettledText(done.name, done.views));
      void refreshProjectLibrary(scope, done.projectId);
      const id = done.id;
      setTimeout(() => setBatches((list) => list.filter((item) => item.id !== id)), done.phase.tone === "green" ? DONE_HOLD_MS : FAILED_HOLD_MS);
    }
    if (batch) return;
    if (run?.jobId && phase?.done && announced.current !== run.jobId) {
      announced.current = run.jobId;
      if (phase.tone === "green") {
        /* The run's name is its prompt cut at 60 characters: never the subject of a sentence ("…lamp in rendered."). */
        toast("Your take rendered. Filed in Takes for review.");
        /* Takes and the Library sidebar may already be loaded; re-read so the new take shows. */
        const id = run.projectId ?? target?.id;
        if (id) void refreshProjectLibrary(scope, id);
      }
      if (holdTimer.current) clearTimeout(holdTimer.current);
      const id = run.jobId;
      holdTimer.current = setTimeout(() => setRun((r) => (r?.jobId === id ? null : r)), phase.tone === "green" ? DONE_HOLD_MS : FAILED_HOLD_MS);
    }
  }, [run, mediaJob, batch, batchViews, shellDispatch, toast, scope, target?.id]);
  /* Leaving the composer (Gen is closed) never leaves its progress frozen on every page; the take is
     still followed when the composer is back (above), and lands in Takes either way. */
  const strip = useRef(ws.state.gen);
  useEffect(() => { strip.current = ws.state.gen; });
  useEffect(() => () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (strip.current && JSON.stringify(strip.current) === shown.current) shellDispatch({ type: "patch", patch: { gen: null } });
  }, [shellDispatch]);

  return {
    state, dispatch, models, offered, model, quote, quoteKey, settings, credits,
    buttonLabel: composerButtonLabel({ quote, quoteKey, submitting, count: state.count, draft: Boolean(settings.draft) }),
    buttonParts: composerButtonParts({ quote, quoteKey, submitting, count: state.count, draft: Boolean(settings.draft) }),
    blocked, submitting,
    wording: billingWording({ workspaceName: options.workspaceName }),
    audio, voices, voice, seconds, project: target, projectNotice, generate, retryEngines, scope,
    batches: batchViews,
  };
}

/** The draft and its revision together, exactly as the server holds them now. */
async function readSaved(scope: string, projectId: string): Promise<SavedDraft> {
  const data = await draftRequest<{ project: Project | null; revision: number }>(`${API}/projects?id=${encodeURIComponent(projectId)}`, scope);
  if (!data.project || data.project.id !== projectId) throw new Error("This project could not be read. Nothing was submitted.");
  return { project: data.project, revision: data.revision };
}

/**
 * Saves one change on the draft as the server holds it — never on the copy the
 * page opened with, and never a newer revision paired with an older body.
 * `from` is the draft this composer saved last (carried from take to take);
 * without one, or when another save lands first, the latest is read and the
 * change made on it again. A change that leaves the draft as it is writes nothing.
 *
 * `edit` must add only what is missing, by id (the composer's shot, a take's
 * asset): a write whose reply was lost is then checked the same way — read
 * again, made again — and a write that did land is never applied twice.
 */
async function saveOnLatest(scope: string, projectId: string, from: SavedDraft | null, edit: (project: Project) => Project, writer: DraftWriter = draftWriter()): Promise<SavedDraft> {
  let draft = from ?? (await readSaved(scope, projectId));
  for (let attempt = 0; ; attempt++) {
    const project = edit(draft.project);
    if (project === draft.project) return draft;
    try {
      /* Tagged: a write whose reply was lost is checked on the server. One that landed is done — never made again
         over what another window did since (deleting the shot, say); one that did not is made again on the latest. */
      const receipt = await writeDraft(API, scope, { project, revision: draft.revision }, writer);
      return { project: { ...project, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings }, revision: receipt.revision };
    } catch (error) {
      const again = isDraftConflict(error) || (error instanceof DraftRequestError && error.retryable && !error.uncertain);
      /* An unconfirmed write that cannot be checked stays unconfirmed: that is what the person is told. */
      if (attempt >= MERGE_TRIES || !again) throw error;
      draft = await readSaved(scope, projectId);
    }
  }
}
