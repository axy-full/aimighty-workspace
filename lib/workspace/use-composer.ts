"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import { DraftRequestError, draftRequest, draftWriter, isDraftConflict, MERGE_TRIES, writeDraft, type DraftWriter } from "../workbench/draft-request";
import { nodeAudioBody, type NodeAudioSetup } from "../workbench/generation-audio";
import { mediaQuoteReferences, mediaReferenceIdentity } from "../workbench/media-reference-input";
import { pendingGenerationKey } from "../workbench/pending-generation";
import { createSoundNode, findSoundNode } from "../workbench/sound-generate";
import { stableId } from "../workbench/stable-id";
import { newProject, type Asset, type CanvasNode, type Project } from "../workbench/studio";
import type { MediaJob } from "../workbench/job-recovery";
import {
  CONNECTED_GENERATION_ENDPOINT,
  connectedEnhancedPrompt, connectedOriginal,
  connectedQuoteRequest,
  connectedStatusRequest,
  connectedSubmitRequest,
  parseConnectedJob,
  type ConnectedJob,
} from "../higgsfield-consumer/generation-client";
import type { ConsumerGenerationInput } from "../higgsfield-consumer/generation-contract";
import {
  activeModel,
  billingWording,
  composerBlock,
  composerButtonLabel,
  composerReducer,
  composerSettings,
  type ConnectedRow,
  connectedModels,
  INITIAL_COMPOSER,
  liveCredits,
  offeredModels,
  quoteKeyFor,
  workspaceModels,
  type ComposerAction,
  type ComposerModel,
  type ComposerQuote,
  type ComposerReference,
  type ComposerSettings,
  type ComposerState,
  type ComposerType,
  type ConnectedCapability,
  type EngineRow,
} from "./composer";
import { formatCredits } from "./cost";
import { refreshProjectLibrary } from "./library";
import { dispatchGeneration } from "./generate-submit";
import { addShotNode, generationPhase, neutralCopy, referenceRole } from "./rig";
import { shotPatch } from "./shots";
import { useWorkspace } from "./state";
import type { Generation } from "./types";

/**
 * The composer's live wiring. It owns nothing the shell owns: the project it
 * files into is the one the shell has open, and progress is published to the
 * shell's own GenerationStrip through `state.gen`.
 *
 * Money, in one sentence per path:
 *  - this workspace's credits: GET /api/workbench/engines for the live figure
 *    on the button, then the shared dispatch (lib/workspace/generate-submit.ts)
 *    re-quotes POST /api/generate/quote with the exact body and submits POST
 *    /api/generate with `maxCredits` + `quoteFingerprint`;
 *  - the connected account: POST /api/higgsfield/consumer/generation
 *    `action: "quote"` for the exact price and wallet, then `action: "submit"`
 *    with that wallet and those exact credits — the shapes in
 *    lib/higgsfield-consumer/generation-client.ts, which the Atomik Generate
 *    page uses too.
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
 * closed) is remembered in this browser, with the take it was in its batch:
 * the next Generate with the same settings takes it up again — the same shot
 * and claimed request, or the connected job it submitted, read back first —
 * and goes on from there, never paying for it twice. Different settings are a
 * new take at the price on the button.
 */

const API = "/api/workbench";
const DONE_HOLD_MS = 1800;
const FAILED_HOLD_MS = 6000;
const QUOTE_DEBOUNCE_MS = 260;
const CONNECTED_POLL_MS = 6000;

type Run = {
  source: "workspace" | "connected";
  name: string;
  meta: string;
  /** The media job id (workspace) or the connected job id, once accepted. */
  jobId: string | null;
  /** The project it files into. */
  projectId?: string;
};

/** A draft exactly as the server holds it, with its revision. */
type SavedDraft = { project: Project; revision: number };

/** What this composer is still following for a scope, so leaving Gen and coming back picks it up again. */
const FOLLOW_KEY = (scope: string) => `particl:composer-follow:v1:${scope}`;
type Following = { run: Run | null; connected: ConnectedJob[] };
function readFollowing(scope: string): Following {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(FOLLOW_KEY(scope)) ?? "null") as Following | null;
    return { run: value?.run?.jobId ? value.run : null, connected: Array.isArray(value?.connected) ? value.connected : [] };
  } catch {
    return { run: null, connected: [] };
  }
}
function writeFollowing(scope: string, value: Following) {
  try {
    if (!value.run && !value.connected.length) window.sessionStorage.removeItem(FOLLOW_KEY(scope));
    else window.sessionStorage.setItem(FOLLOW_KEY(scope), JSON.stringify(value));
  } catch { /* following is a convenience; the takes still land */ }
}
const finished = (job: ConnectedJob) => job.status === "completed" || job.status === "failed";

/**
 * Composers of one scope share what they follow: a connected take submitted by
 * a composer that has since closed (the person left Gen mid-batch) is written
 * where the next one reads it, and reaches one that is open now.
 */
const followers = new Map<string, Set<(job: ConnectedJob) => void>>();
function followConnected(scope: string, job: ConnectedJob) {
  const following = readFollowing(scope);
  writeFollowing(scope, { run: following.run, connected: [...following.connected.filter((item) => item.id !== job.id), job].filter((item) => !finished(item)) });
  followers.get(scope)?.forEach((listener) => listener(job));
}

/** The take a Generate left unconfirmed, and where it was in its batch (see the note above). */
type Resume =
  | { kind: "workspace"; projectId: string; quoteKey: string; take: number; node: CanvasNode }
  | { kind: "connected"; projectId: string; quoteKey: string; take: number; jobId: string };
/* Per project: a take left in one project waits for it, whatever is generated in another meanwhile. */
const RESUME_KEY = (scope: string, projectId: string) => `particl:composer-resume:v1:${JSON.stringify([scope, projectId])}`;
function readResume(scope: string, projectId: string): Resume | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(RESUME_KEY(scope, projectId)) ?? "null") as Resume | null;
    if (!value || value.projectId !== projectId || typeof value.quoteKey !== "string" || !Number.isInteger(value.take) || value.take < 0) return null;
    if (value.kind === "workspace") return value.node && typeof value.node.id === "string" ? value : null;
    return value.kind === "connected" && typeof value.jobId === "string" ? value : null;
  } catch {
    return null;
  }
}
function writeResume(scope: string, projectId: string, value: Resume | null) {
  try {
    if (value) window.localStorage.setItem(RESUME_KEY(scope, projectId), JSON.stringify(value));
    else window.localStorage.removeItem(RESUME_KEY(scope, projectId));
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

/** The connected job's phase, in the strip's own vocabulary. */
function connectedPhase(job: ConnectedJob | null): { label: string; pct: number; tone: "blue" | "green" | "red"; done: boolean } {
  if (!job) return { label: "Submitting", pct: 4, tone: "blue", done: false };
  if (job.status === "completed") return { label: "Complete", pct: 100, tone: "green", done: true };
  if (job.status === "failed") return { label: "Failed · not billed", pct: 100, tone: "red", done: true };
  if (job.status === "accepted") return { label: "Rendering", pct: 50, tone: "blue", done: false };
  return { label: "Queued", pct: 10, tone: "blue", done: false };
}

export type ComposerHost = {
  state: ComposerState;
  dispatch: (action: ComposerAction) => void;
  /** Models of every type the current billing source offers. */
  models: ComposerModel[];
  /** Models of the current type, in catalogue order. */
  offered: ComposerModel[];
  model: ComposerModel | null;
  quote: ComposerQuote | null;
  quoteKey: string;
  /** The exact settings the engine would render with (ratio, resolution, duration). */
  settings: ComposerSettings;
  credits: number | null;
  /** What the account says it rendered for the last connected take (`enhance_prompt`), once it completed; null otherwise. */
  connectedEnhanced: string | null;
  buttonLabel: string;
  blocked: string | null;
  submitting: boolean;
  /** Which credits will be charged, said plainly. */
  wording: string;
  /** The audio setup, for the voice row. */
  audio: NodeAudioSetup | null;
  capability: ConnectedCapability | null;
  /** The project the composer files into; null until one is open or created. */
  project: Project | null;
  /** One line about a project the composer had to create. */
  projectNotice: string | null;
  generate: () => void;
  scope: string;
};

export function useComposer(options: {
  scope: string;
  open: boolean;
  /** The project the shell has open. */
  project: Project | null;
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
}): ComposerHost {
  const { scope, open, project } = options;
  const ws = useWorkspace();
  const [state, dispatch] = useReducer(
    composerReducer,
    options.initialType,
    (type) => (type ? { ...INITIAL_COMPOSER, type } : INITIAL_COMPOSER),
  );
  const [engines, setEngines] = useState<{ rows: EngineRow[]; error: string | null; loading: boolean }>({ rows: [], error: null, loading: true });
  const [audio, setAudio] = useState<NodeAudioSetup | null>(null);
  const [capability, setCapability] = useState<ConnectedCapability | null>(null);
  const [catalogue, setCatalogue] = useState<{ rows: { id: string; name: string; outputType: string; medias?: { roles: string[] }[] }[]; error: string | null } | null>(null);
  const [quote, setQuote] = useState<ComposerQuote | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  /** Every connected take submitted here: each is followed and filed, not only the last. */
  const [connectedJobs, setConnectedJobs] = useState<ConnectedJob[]>([]);
  const track = useCallback((job: ConnectedJob) => setConnectedJobs((jobs) => [...jobs.filter((item) => item.id !== job.id), job]), []);
  /* A take followed by any composer of this scope (this one, or one closed since) is followed here too. */
  useEffect(() => {
    const set = followers.get(scope) ?? new Set();
    followers.set(scope, set);
    set.add(track);
    return () => { set.delete(track); };
  }, [scope, track]);
  const connectedJob = run?.source === "connected" && run.jobId ? connectedJobs.find((job) => job.id === run.jobId) ?? null : null;
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<Project | null>(null);
  /** The connected wallet the last quote named, for the billing line. */
  const [walletName, setWalletName] = useState<string | null>(null);

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
  }, [open, scope]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    studioRequest<NodeAudioSetup>("/api/audio", { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
      .then((data) => { if (!controller.signal.aborted) setAudio(data); })
      .catch(() => { if (!controller.signal.aborted) setAudio({ configured: false, speechModels: [], defaultSpeechModel: "", voices: [], voicesError: null }); })
    return () => controller.abort();
  }, [open, scope]);

  /* The connected account is only read when the switch is used. */
  const wantsConnected = open && state.billing === "connected";
  useEffect(() => {
    if (!wantsConnected || capability) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const me = await studioRequest<{ owner?: boolean; workspace?: { suspended?: boolean } }>("/api/me", { signal: controller.signal, cache: "no-store" });
        const connection = me.owner === true
          ? await studioRequest<{ connected?: boolean; requiresReconnect?: boolean }>("/api/higgsfield/consumer/connection", { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
          : { connected: false, requiresReconnect: false };
        if (controller.signal.aborted) return;
        setCapability({ owner: me.owner === true, connected: connection.connected === true && connection.requiresReconnect !== true, suspended: me.workspace?.suspended === true });
      } catch {
        if (!controller.signal.aborted) setCapability({ owner: false, connected: false, suspended: false });
      }
    })();
    return () => controller.abort();
  }, [wantsConnected, capability, scope]);

  const canReadCatalogue = wantsConnected && capability?.owner === true && capability.connected && !catalogue;
  useEffect(() => {
    if (!canReadCatalogue) return;
    const controller = new AbortController();
    studioRequest<{ catalogue?: { models?: ConnectedRow[] } }>(CONNECTED_GENERATION_ENDPOINT, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
      body: JSON.stringify({ action: "catalogue" }),
    })
      .then((data) => { if (!controller.signal.aborted) setCatalogue({ rows: data.catalogue?.models ?? [], error: null }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCatalogue({ rows: [], error: neutralCopy(error instanceof Error ? error.message : "The connected catalogue could not be read.", "The connected catalogue could not be read.") });
      });
    return () => controller.abort();
  }, [canReadCatalogue, scope]);

  const models = useMemo(
    () => (state.billing === "connected" ? connectedModels(catalogue?.rows ?? []) : workspaceModels(engines.rows, audio)),
    [state.billing, catalogue?.rows, engines.rows, audio],
  );
  const offered = useMemo(() => offeredModels(state, models), [state, models]);
  const model = useMemo(() => activeModel(state, models), [state, models]);
  const settings = useMemo(() => composerSettings(model, target?.aspect, state.picks), [model, target?.aspect, state.picks]);

  const quoteKey = quoteKeyFor({
    billing: state.billing, type: state.type, modelId: model?.id ?? "", settings,
    references: state.references, prompt: state.prompt.trim(), seconds: state.seconds,
    instrumental: state.instrumental, voiceId: state.voiceId,
  });

  /* ── The live price on the button ───────────────────────────────────── */
  const audioBody = model?.audioTask
    ? nodeAudioBody({
        task: model.audioTask,
        text: state.prompt,
        /* Music has a ten-second floor in the audio route; sound has none. */
        seconds: model.audioTask === "music" ? Math.max(10, state.seconds) : state.seconds,
        instrumental: state.instrumental,
        voiceId: state.voiceId || audio?.voices[0]?.id || "",
        modelId: model.id,
      })
    : null;

  /* The connected quote body, when it can be built at all. */
  const connectedInput = useMemo<ConsumerGenerationInput | null>(() => {
    if (state.billing !== "connected" || !model || !state.prompt.trim()) return null;
    const roles = model.referenceRoles ?? [];
    /* FINAL_SPEC §3–4: the settings the live catalogue entry declares, never
       invented; `enhance_prompt` only when the schema declares it — true on
       Auto, false for a raw: prompt, which is never rewritten. */
    const raw = /^\s*raw:/i.test(state.prompt);
    const parameters: Record<string, string | number | boolean> = {
      ...(model.ratios?.length ? { aspect_ratio: settings.ratio } : {}),
      ...(model.durations?.length ? { duration: settings.duration } : {}),
      ...(model.resolutions?.length ? { resolution: settings.resolution } : {}),
      ...(model.enhanceable ? { enhance_prompt: state.enhance && !raw } : {}),
      ...(model.soulId && settings.soulId ? { soul_id: settings.soulId } : {}),
    };
    return {
      type: state.type, model: model.id, prompt: raw ? state.prompt.replace(/^\s*raw:\s*/i, "").trim() : state.prompt.trim(), parameters,
      medias: roles.length
        ? state.references.map((r) => ({ role: r.role && roles.includes(r.role) ? r.role : roles[0], source: r.origin === "upload" ? { uploadId: r.id } : { genId: r.id } }))
        : [],
    } as ConsumerGenerationInput;
  }, [state.billing, state.type, state.prompt, state.references, state.enhance, model, settings.ratio, settings.duration, settings.resolution, settings.soulId]);

  const blockedForQuote = !open || !model || !state.prompt.trim()
    || (state.billing === "connected" && (!capability?.owner || !capability.connected || !target));
  const connectedKey = connectedInput ? JSON.stringify(connectedInput) : "";

  useEffect(() => {
    /* A figure for other inputs is already stale by its key; nothing is reset here. */
    if (blockedForQuote) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const ask = async (): Promise<ComposerQuote> => {
        if (state.billing === "connected") {
          if (!connectedInput || !target) throw new Error("Open or create a project before pricing this generation.");
          const result = await studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
            method: "POST", signal: controller.signal,
            headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify(connectedQuoteRequest(target.id, connectedInput)),
          });
          const job = parseConnectedJob(result.job, target.id);
          setWalletName(job.workspaceName);
          return { key: quoteKey, credits: job.quoteCredits, state: "ready", reason: null };
        }
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
        const result = await studioRequest<{ credits: number | null }>(`${API}/engines?${query}${references ? `&${references}` : ""}`, {
          signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store",
        });
        if (typeof result.credits !== "number" || !Number.isFinite(result.credits))
          return { key: quoteKey, credits: null, state: "unavailable", reason: "This model cannot be priced with these settings." };
        return { key: quoteKey, credits: result.credits, state: "ready", reason: null };
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
    /* `quoteKey` names every input the figure prices; `connectedKey` the exact connected body. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedForQuote, quoteKey, connectedKey, scope, target?.id]);

  const credits = liveCredits(quote, quoteKey);
  const blocked = composerBlock({
    state, model, quote, quoteKey, submitting, capability: state.billing === "connected" ? capability : null,
    catalogue: state.billing === "connected"
      ? { loading: catalogue === null, error: catalogue?.error ?? null }
      : { loading: engines.loading, error: engines.error },
  });

  /* ── Generate ───────────────────────────────────────────────────────── */
  const live = useRef({ state, model, settings, credits, blocked, target, audioBody, connectedInput, quoteKey });
  useEffect(() => { live.current = { state, model, settings, credits, blocked, target, audioBody, connectedInput, quoteKey }; });
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

  const generate = useCallback(() => {
    const now = live.current;
    if (busy.current) return;
    if (now.blocked) { dispatch({ type: "notice", value: now.blocked }); return; }
    if (!now.model) return;
    const model = now.model, shown = now.credits, composer = now.state;
    busy.current = true;
    setSubmitting(true);
    dispatch({ type: "notice", value: null });
    void (async () => {
      try {
        const project = await ensureProject();
        const settings = now.settings;
        const base = composer.prompt.trim().slice(0, 60) || `${model.label} take`;
        /* Takes: each is its own quoted job at the price shown; a price that moves stops the rest. */
        const count = Math.max(1, composer.count);
        const billing = composer.billing === "connected" ? "connected" : "workspace";
        /* A take left unconfirmed with these same settings: taken up again, and the batch goes on from it. */
        const resume = readResume(scope, project.id);
        const again = resume && resume.kind === billing && resume.quoteKey === now.quoteKey ? resume : null;
        let start = again ? again.take : 0;
        const end = again ? Math.max(count, again.take + 1) : count;
        if (again?.kind === "connected") {
          /* Read back before anything is priced: a job the account took is followed, never submitted again. */
          const read = await studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify(connectedStatusRequest(project.id, again.jobId)),
          }).catch(() => { throw new Error("Your last take could not be checked. Nothing was submitted; press Generate again in a moment."); });
          const job = parseConnectedJob(read.job, project.id);
          writeResume(scope, project.id, null);
          if (job.status !== "quoted") {
            followConnected(scope, job);
            start = again.take + 1;
            if (start >= end) {
              setRun({ source: "connected", name: count > 1 ? `${base} · take ${again.take + 1}` : base, meta: [base, model.label, `${job.quoteCredits.toLocaleString("en-US")} connected cr`].join(" · "), jobId: job.id, projectId: project.id });
              dispatch({ type: "notice", value: "That take reached the connected account. It files into Takes as it lands." });
              return;
            }
          }
        }
        /* The draft the takes file into: read fresh for the first, then carried from each save to the next. */
        let draft: SavedDraft | null = null;
        if (writer.current?.projectId !== project.id) writer.current = { projectId: project.id, writer: draftWriter() };
        const saves = writer.current.writer;
        for (let take = start; take < end; take++) {
        const name = end > 1 ? `${base} · take ${take + 1}` : base;
        if (composer.billing === "connected") {
          /* Re-quote on click; a moved price is shown and nothing is sent. */
          const input = now.connectedInput;
          if (!input) throw new Error("This request could not be prepared. Nothing was submitted.");
          const quoted = await studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify(connectedQuoteRequest(project.id, input)),
          });
          const job = parseConnectedJob(quoted.job, project.id);
          if (shown === null || job.quoteCredits !== shown) {
            setQuote({ key: now.quoteKey, credits: job.quoteCredits, state: "ready", reason: null });
            dispatch({ type: "notice", value: `The price is now ${job.quoteCredits.toLocaleString("en-US")} connected cr. Press Generate again to approve it.` });
            return;
          }
          if (job.quoteExpiresAt <= Date.now()) { dispatch({ type: "notice", value: "That price expired. Press Generate again for a fresh one." }); return; }
          setRun({ source: "connected", name, meta: [name, model.label, `${job.quoteCredits.toLocaleString("en-US")} connected cr`].join(" · "), jobId: null, projectId: project.id });
          /* Remembered before it is sent: a lost reply is read back on the next Generate, never submitted twice. */
          writeResume(scope, project.id, { kind: "connected", projectId: project.id, quoteKey: now.quoteKey, take, jobId: job.id });
          let sent: { job?: unknown };
          try {
            sent = await studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
              method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
              body: JSON.stringify(connectedSubmitRequest(project.id, job)),
            });
          } catch (error) {
            /* Refused before anything was sent: nothing to take up. Otherwise the account may have it: followed until its status says. */
            if (error instanceof StudioRequestError && error.status >= 400 && error.status < 500) writeResume(scope, project.id, null);
            else followConnected(scope, job);
            throw error;
          }
          writeResume(scope, project.id, null);
          const accepted = parseConnectedJob(sent.job, project.id);
          followConnected(scope, accepted);
          setRun({ source: "connected", name, meta: [name, model.label, `${accepted.quoteCredits.toLocaleString("en-US")} connected cr`].join(" · "), jobId: accepted.id, projectId: project.id });
          continue;
        }

        /* This workspace's credits: the take needs a shot to live in, so the
           composer adds one to the draft the way Rig does (sound: its lane's
           node, as Edit & Sound does) and maps it. */
        let made: CanvasNode | null = take === start && again?.kind === "workspace" ? again.node : null;
        const remember = () => {
          const node = made as CanvasNode | null;
          /* Until the server confirms the job, the next Generate with these settings takes this shot up again. */
          if (node) writeResume(scope, project.id, { kind: "workspace", projectId: project.id, quoteKey: now.quoteKey, take, node });
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
        /* The take's own recovery key: a claimed request left unconfirmed is replayed, never sent twice. Sound
           takes share their lane, so theirs is the lane's and these settings': a new prompt is a new request. */
        const storageId = pendingGenerationKey(scope, filed.project.id, model.audioTask ? `${shot.id}:${stableId("take", now.quoteKey)}` : shot.id);
        const outcome = await dispatchGeneration({
          scope,
          storageId,
          shown,
          request: model.audioTask
            ? {
                endpoint: "/api/audio",
                quoteBody: { ...now.audioBody! },
                body: { ...now.audioBody!, projectId: mapping.productionProjectId, shotId: mapping.shotId },
              }
            : {
                endpoint: "/api/generate",
                input: {
                  prompt: composer.prompt.trim(),
                  kind: model.type === "video" ? "video" : "image",
                  model: { id: model.id },
                  mapping,
                  ratio: settings.ratio,
                  resolution: settings.resolution,
                  duration: settings.duration,
                  references,
                  firstFrameAssetId: "",
                },
              },
          onClaim: (approved) => setRun({ source: "workspace", name, meta: [name, model.label, formatCredits(approved)].join(" · "), jobId: null, projectId: project.id }),
        });
        if (outcome.state === "repriced") {
          setQuote({ key: now.quoteKey, credits: outcome.credits, state: "ready", reason: null });
          setRun(null);
          dispatch({ type: "notice", value: outcome.reason });
          return;
        }
        if (outcome.state === "refused") { setRun(null); dispatch({ type: "notice", value: outcome.reason }); return; }
        writeResume(scope, project.id, null);
        setRun({ source: "workspace", name, meta: [name, model.label, formatCredits(outcome.credits)].join(" · "), jobId: outcome.jobId, projectId: project.id });
        }
        if (end > 1) dispatch({ type: "notice", value: start > 0 ? `Takes ${start + 1}–${end} submitted, each at the price shown. They file into Takes as they land.` : `${end} takes submitted, each at the price shown. They file into Takes as they land.` });
      } catch (error) {
        setRun(null);
        dispatch({ type: "notice", value: neutralCopy(error instanceof Error ? error.message : "This generation could not be submitted.") });
      } finally {
        busy.current = false;
        setSubmitting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, ensureProject, settings.ratio, settings.resolution, settings.duration]);

  /* ── Progress, from the real job ────────────────────────────────────── */
  const [read, setRead] = useState<{ id: string; job: MediaJob } | null>(null);
  const workspaceJobId = run?.source === "workspace" ? run.jobId : null;
  const mediaJob = read && read.id === workspaceJobId ? read.job : null;
  useEffect(() => {
    if (!workspaceJobId) return;
    let live = true;
    const controller = new AbortController();
    const read = () => studioRequest<{ generation: MediaJob }>(`/api/jobs/${encodeURIComponent(workspaceJobId)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
      .then((data) => { if (live) setRead({ id: workspaceJobId, job: data.generation }); })
      .catch(() => {});
    void read();
    const timer = setInterval(() => void read(), CONNECTED_POLL_MS);
    return () => { live = false; clearInterval(timer); controller.abort(); };
  }, [workspaceJobId, scope]);

  /* Every connected take still rendering is followed — each one, not only the last submitted. */
  const waiting = JSON.stringify(connectedJobs.filter((job) => !finished(job)).map((job) => [job.draftId, job.id]));
  useEffect(() => {
    const jobs = JSON.parse(waiting) as [string, string][];
    if (!jobs.length) return;
    let live = true;
    const controller = new AbortController();
    const timer = setInterval(() => {
      for (const [draftId, id] of jobs) {
        void studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
          body: JSON.stringify(connectedStatusRequest(draftId, id)),
        })
          .then((data) => { if (live) track(parseConnectedJob(data.job, draftId)); })
          .catch(() => {});
      }
    }, CONNECTED_POLL_MS);
    return () => { live = false; clearInterval(timer); controller.abort(); };
  }, [waiting, scope, track]);

  /* Each completed connected original is filed into its project, once, so it reaches Takes. One
     filing at a time, each on the draft as the server holds it then (a conflict reads it again). */
  const filed = useRef(new Set<string>());
  const filing = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    for (const job of connectedJobs) {
      const original = connectedOriginal(job);
      if (!original || filed.current.has(original.generationId)) continue;
      filed.current.add(original.generationId);
      const enhanced = connectedEnhancedPrompt(job);
      const asset = {
        id: original.generationId, generationId: original.generationId, url: original.url,
        kind: original.kind === "model" ? "document" : original.kind, mime: original.mime,
        name: `${job.model.name} · ${job.input.prompt.slice(0, 80)}`, category: "Generate",
        description: `${job.model.name} · ${original.credits} connected credits${enhanced ? " · enhanced on the account" : ""}`, prompt: job.input.prompt,
        status: "Draft", version: 1, locked: false, refs: [],
      } as unknown as Asset;
      filing.current = filing.current
        .then(() => saveOnLatest(scope, job.draftId, null, (latest) => (latest.assets.some((item) => item.generationId === original.generationId) ? latest : { ...latest, assets: [...latest.assets, asset] })))
        .catch(() => undefined);
    }
  }, [connectedJobs, scope]);

  /* What is still being followed survives leaving Gen: it is picked up again when the composer is back. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const following = readFollowing(scope);
    if (!following.run && !following.connected.length) return;
    /* eslint-disable react-hooks/set-state-in-effect -- Browser-only session state, read once after mounting. */
    if (following.run) setRun((current) => current ?? following.run);
    if (following.connected.length) setConnectedJobs((jobs) => [...following.connected.filter((job) => !jobs.some((item) => item.id === job.id)), ...jobs]);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [scope]);
  useEffect(() => {
    if (!restored.current) return;
    writeFollowing(scope, { run: run?.jobId ? run : null, connected: connectedJobs.filter((job) => !finished(job)) });
  }, [scope, run, connectedJobs]);

  /* ── The shell's strip ──────────────────────────────────────────────── */
  const shown = useRef<string>("");
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announced = useRef<string | null>(null);
  const { dispatch: shellDispatch, toast } = ws;
  useEffect(() => {
    const phase = !run ? null
      : run.source === "connected" ? connectedPhase(run.jobId ? connectedJob : null)
      : generationPhase(run.jobId ? mediaJob ?? { status: "queued" } : null);
    const gen: Generation | null = run && phase
      ? { id: run.jobId ?? "pending:composer", pct: phase.pct, name: run.name, meta: run.meta, label: phase.label, tone: phase.tone }
      : null;
    const key = JSON.stringify(gen);
    if (key !== shown.current) {
      shown.current = key;
      shellDispatch({ type: "patch", patch: { gen } });
    }
    if (run?.jobId && phase?.done && announced.current !== run.jobId) {
      announced.current = run.jobId;
      if (phase.tone === "green") {
        toast(`${run.name} rendered. Filed in Takes for review.`);
        /* Takes and the Library sidebar may already be loaded; re-read so the new take shows. */
        const id = run.projectId ?? target?.id;
        if (id) void refreshProjectLibrary(scope, id);
      }
      if (holdTimer.current) clearTimeout(holdTimer.current);
      const id = run.jobId;
      holdTimer.current = setTimeout(() => setRun((r) => (r?.jobId === id ? null : r)), phase.tone === "green" ? DONE_HOLD_MS : FAILED_HOLD_MS);
    }
  }, [run, mediaJob, connectedJob, shellDispatch, toast, scope, target?.id]);
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
    /** What the account says it rendered for the last connected take, once it completed. */
    connectedEnhanced: run?.source === "connected" && connectedJob ? connectedEnhancedPrompt(connectedJob) : null,
    buttonLabel: composerButtonLabel({ billing: state.billing, quote, quoteKey, submitting, count: state.count }),
    blocked, submitting,
    wording: billingWording(state.billing, { workspaceName: options.workspaceName, walletName }),
    audio, capability, project: target, projectNotice, generate, scope,
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
