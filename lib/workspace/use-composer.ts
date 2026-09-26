"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { draftRequest, writeDraft } from "../workbench/draft-request";
import { nodeAudioBody, type NodeAudioSetup } from "../workbench/generation-audio";
import { mediaQuoteReferences, mediaReferenceIdentity } from "../workbench/media-reference-input";
import { pendingGenerationKey } from "../workbench/pending-generation";
import { newProject, type Asset, type Project } from "../workbench/studio";
import type { MediaJob } from "../workbench/job-recovery";
import {
  CONNECTED_GENERATION_ENDPOINT,
  connectedEnhancedPrompt, connectedOriginal,
  connectedQuoteRequest,
  connectedRecoverable,
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
  shownTotal,
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
import { dispatchGeneration, type DispatchRequest } from "./generate-submit";
import {
  batchNotice, batchPhase, batchSettledText, rememberWorkspaceBatch, sendConnectedBatch, sendWorkspaceBatch,
  settleConnectedBatch, settleWorkspaceBatch, takesPhrase, takeView,
  type BatchTake, type TakeRead, type TakeView,
} from "./take-batch";
import { newBatchId } from "../variations";
import { releaseConnectedJob, watchConnectedJob } from "../shell/connected-collector";
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
};

/** Takes 2–4 of one Generate (lib/workspace/take-batch.ts): every take that was sent is followed here until it settles. */
type BatchRun = {
  id: string;
  source: "workspace" | "connected";
  projectId: string;
  name: string;
  model: string;
  takes: BatchTake[];
};
/** A batch as Gen's Results and the shell's strip show it: its takes, each in its own words. */
export type BatchView = BatchRun & { views: TakeView[]; phase: ReturnType<typeof batchPhase> };

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
  /** Read the engine list again after a failed read (Gen's model sheet › Try again). */
  retryEngines: () => void;
  scope: string;
  /** Batches of takes 2–4 still being followed, newest last: Gen's Results show each as one strip. */
  batches: BatchView[];
  /** Every connected job a batch here is following: no other list shows them while it does. */
  batchJobIds: string[];
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
  const [enginesRead, setEnginesRead] = useState(0);
  const [audio, setAudio] = useState<NodeAudioSetup | null>(null);
  const [capability, setCapability] = useState<ConnectedCapability | null>(null);
  const [catalogue, setCatalogue] = useState<{ rows: { id: string; name: string; outputType: string; medias?: { roles: string[] }[] }[]; error: string | null } | null>(null);
  const [quote, setQuote] = useState<ComposerQuote | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [connectedJob, setConnectedJob] = useState<ConnectedJob | null>(null);
  /** Every batch sent here, followed take by take until each settles; and the latest read of each take's job. */
  const [batches, setBatches] = useState<BatchRun[]>([]);
  const [takeReads, setTakeReads] = useState<Record<string, TakeRead>>({});
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
  /* A connected quote is a call to the account. One is asked per project and exact body and held
     until it expires, so coming back to the same body (the model sheet's catalogue switched away
     and back) shows the figure already given instead of asking again. Generate re-quotes anyway. */
  const heldQuotes = useRef(new Map<string, { credits: number; expiresAt: number }>());

  useEffect(() => {
    /* A figure for other inputs is already stale by its key; nothing is reset here. */
    if (blockedForQuote) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const ask = async (): Promise<ComposerQuote> => {
        if (state.billing === "connected") {
          if (!connectedInput || !target) throw new Error("Open or create a project before pricing this generation.");
          const heldKey = `${target.id}\n${connectedKey}`;
          const held = heldQuotes.current.get(heldKey);
          if (held && held.expiresAt > Date.now()) return { key: quoteKey, credits: held.credits, state: "ready", reason: null };
          const result = await studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
            method: "POST", signal: controller.signal,
            headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify(connectedQuoteRequest(target.id, connectedInput)),
          });
          const job = parseConnectedJob(result.job, target.id);
          heldQuotes.current.set(heldKey, { credits: job.quoteCredits, expiresAt: job.quoteExpiresAt });
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
  const live = useRef({ state, model, settings, credits, blocked, target, audioBody, connectedInput, connectedKey, quoteKey, quote });
  useEffect(() => { live.current = { state, model, settings, credits, blocked, target, audioBody, connectedInput, connectedKey, quoteKey, quote }; });
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

  /** Follow a batch: every take that was sent is read until it settles (below). A batch that sent nothing has nothing to follow. */
  const followBatch = useCallback((run: BatchRun, jobs: readonly ConnectedJob[] = []) => {
    if (!run.takes.some((take) => take.jobId || take.state === "unconfirmed")) return;
    setBatches((list) => [...list.filter((item) => item.id !== run.id), run]);
    if (jobs.length) setTakeReads((reads) => ({ ...reads, ...Object.fromEntries(jobs.map((job) => [job.id, { connected: job }])) }));
  }, []);

  /* The shot a batch whose price moved had already filed: the next press of the same batch goes on it, not on another empty shot. */
  const batchShot = useRef<{ key: string; projectId: string; nodeId: string; mapping: { shotId: string; productionProjectId: string } } | null>(null);

  /**
   * Before anything is sent on a project: a batch there whose reply was lost is
   * asked about (lib/workspace/take-batch.ts). What had landed is followed and
   * nothing new is sent; what never arrived is let go, with nothing charged; while
   * the answer is not known, nothing new is sent.
   */
  const settleEarlier = useCallback(async (projectId: string, billing: "workspace" | "connected"): Promise<{ proceed: boolean; notice: string | null }> => {
    if (billing === "connected") {
      const settled = await settleConnectedBatch({ scope, draftId: projectId });
      if (settled.state === "none") return { proceed: true, notice: null };
      if (settled.state === "lost") return { proceed: true, notice: "Your last batch never reached the connected account; nothing was charged for it." };
      if (settled.state === "unknown") return { proceed: false, notice: settled.reason };
      const first = settled.jobs[0];
      followBatch({
        id: first?.batch?.id ?? newBatchId(), source: "connected", projectId,
        name: first ? first.input.prompt.trim().slice(0, 60) || `${first.model.name} take` : "Your last batch", model: first?.model.name ?? "",
        takes: settled.jobs.map((job, i) => ({ variation: job.batch?.variation ?? i + 1, state: "queued", jobId: job.id, credits: job.quoteCredits })),
      }, settled.jobs);
      return { proceed: false, notice: `Your last batch had reached the connected account: its ${settled.jobs.length} takes are followed until they land. Nothing new was sent.` };
    }
    const settled = await settleWorkspaceBatch({ scope, projectId });
    if (settled.state === "none") return { proceed: true, notice: null };
    if (settled.state === "unknown") return { proceed: false, notice: settled.reason };
    const lost = settled.lost.length ? `${takesPhrase(settled.lost).replace(/^t/, "T")} of your last batch never arrived; nothing was charged for ${settled.lost.length === 1 ? "it" : "them"}.` : "";
    if (!settled.landed.length) return { proceed: true, notice: lost || null };
    const found = settled.landed.map((take): BatchTake => ({ variation: take.variation, state: "queued", jobId: take.jobId, credits: take.credits }));
    setBatches((list) => {
      const known = list.find((item) => item.id === settled.batchId);
      const takes = known ? [...known.takes.filter((take) => !found.some((item) => item.variation === take.variation)), ...found].sort((a, b) => a.variation - b.variation) : found;
      return [...list.filter((item) => item.id !== settled.batchId), { id: settled.batchId, source: "workspace", projectId, name: settled.name, model: settled.model, takes }];
    });
    return { proceed: false, notice: `${lost ? `${lost} ` : ""}${takesPhrase(settled.landed.map((take) => take.variation)).replace(/^t/, "T")} of your last batch had reached the server: followed until ${settled.landed.length === 1 ? "it lands" : "they land"}. Nothing new was sent.` };
  }, [scope, followBatch]);

  const generate = useCallback(() => {
    const now = live.current;
    if (busy.current) return;
    if (now.blocked) { dispatch({ type: "notice", value: now.blocked }); return; }
    if (!now.model) return;
    const model = now.model, composer = now.state;
    /* Two to four takes go as ONE batch at the total on the button (lib/workspace/take-batch.ts). */
    const count = Math.max(1, composer.count);
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
        const earlier = await settleEarlier(project.id, composer.billing);
        if (!earlier.proceed) { dispatch({ type: "notice", value: earlier.notice }); return; }
        const before = earlier.notice ? `${earlier.notice} ` : "";
        if (earlier.notice) dispatch({ type: "notice", value: earlier.notice });

        /* This workspace's credits: a take needs a shot to live in, so the composer adds one to the draft the way
           Rig does and maps it. A batch's takes are siblings under one shot. */
        const fileShot = async (name: string) => {
          const withShot = addShotNode(project);
          const named = shotPatch(withShot.project, withShot.id, {
            name,
            note: composer.prompt.trim(),
            ...(model.audioTask ? {} : { engine: model.id, ratio: settings.ratio, resolution: settings.resolution, ...(model.durations?.length ? { durationS: settings.duration } : {}) }),
          });
          const receipt = await writeDraft(API, scope, { project: named, revision: await currentRevision(scope, project.id) });
          const stored: Project = { ...named, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings };
          setCreated(stored);
          const mapping = await studioRequest<unknown>(`${API}/projects`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify({ action: "map-shot", projectId: stored.id, nodeId: withShot.id }),
          });
          if (!validMapping(mapping)) throw new Error("The project mapping could not be verified. Nothing was submitted.");
          return { projectId: stored.id, nodeId: withShot.id, mapping };
        };
        const references = () => composer.references.map((reference) => {
          const identity = mediaReferenceIdentity(referenceAsset(reference));
          if (!identity) throw new Error(`${reference.name} cannot be used as a reference.`);
          return { ...identity, role: referenceRole({ kind: reference.kind }) };
        });
        const request = (mapping: { shotId: string; productionProjectId: string }, batch?: { id: string; variation: number }): DispatchRequest => model.audioTask
          ? {
              endpoint: "/api/audio",
              quoteBody: { ...now.audioBody!, ...(batch ? { batchId: batch.id, variation: batch.variation } : {}) },
              body: { ...now.audioBody!, projectId: mapping.productionProjectId, shotId: mapping.shotId, ...(batch ? { batchId: batch.id, variation: batch.variation } : {}) },
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
                references: references(),
                firstFrameAssetId: "",
                ...(batch ? { batch } : {}),
              },
            };

        if (count > 1) {
          const batchId = newBatchId();
          if (composer.billing === "connected") {
            const input = now.connectedInput;
            if (!input) throw new Error("This request could not be prepared. Nothing was submitted.");
            const outcome = await sendConnectedBatch({
              scope, draftId: project.id, input, count, shown, batchId, composer: "gen",
              /* The figure this press was given is the one held for this body from now on. */
              onQuoted: (jobs) => {
                if (jobs.every((job) => job.quoteCredits === jobs[0].quoteCredits))
                  heldQuotes.current.set(`${project.id}\n${now.connectedKey}`, { credits: jobs[0].quoteCredits, expiresAt: Math.min(...jobs.map((job) => job.quoteExpiresAt)) });
              },
            });
            if (outcome.state === "repriced") {
              setQuote({ key: now.quoteKey, credits: outcome.takes[0], state: "ready", reason: null, takes: outcome.takes });
              dispatch({ type: "notice", value: `${before}${outcome.reason}` });
              return;
            }
            if (outcome.state !== "sent") { dispatch({ type: "notice", value: `${before}${outcome.reason}` }); return; }
            followBatch({
              id: batchId, source: "connected", projectId: project.id, name: base, model: model.label,
              takes: outcome.jobs.map((job, i) => ({ variation: job.batch?.variation ?? i + 1, state: "queued", jobId: job.id, credits: job.quoteCredits })),
            }, outcome.jobs);
            const told = outcome.jobs.map((job, i): BatchTake => job.status === "failed"
              ? { variation: job.batch?.variation ?? i + 1, state: "refused", jobId: job.id, credits: job.quoteCredits, reason: "the connected account refused it" }
              : { variation: job.batch?.variation ?? i + 1, state: "queued", jobId: job.id, credits: job.quoteCredits });
            dispatch({ type: "notice", value: `${before}${outcome.note ? `${outcome.note} ` : ""}${batchNotice(told, "connected cr")}` });
            return;
          }
          /* The same batch again after its price moved goes on the shot it already filed; anything else gets its own. */
          const reuse = batchShot.current && batchShot.current.key === now.quoteKey && batchShot.current.projectId === project.id ? batchShot.current : null;
          const shot = reuse ?? { key: now.quoteKey, ...(await fileShot(`${base} · ${count} takes`)) };
          batchShot.current = null;
          const storageId = (variation: number) => pendingGenerationKey(scope, shot.projectId, `${shot.nodeId}:take-${variation}`);
          const outcome = await sendWorkspaceBatch({
            scope, shown, count, storageId,
            request: (variation) => request(shot.mapping, { id: batchId, variation }),
          });
          if (outcome.state === "repriced") {
            batchShot.current = shot;
            setQuote({ key: now.quoteKey, credits: outcome.takes[0], state: "ready", reason: null, takes: outcome.takes });
            dispatch({ type: "notice", value: `${before}${outcome.reason}` });
            return;
          }
          if (outcome.state === "refused") { batchShot.current = shot; dispatch({ type: "notice", value: `${before}${outcome.reason}` }); return; }
          const unconfirmed = outcome.takes.filter((take) => take.state === "unconfirmed");
          if (unconfirmed.length)
            rememberWorkspaceBatch(window.localStorage, scope, {
              projectId: shot.projectId, batchId, name: base, model: model.label,
              takes: unconfirmed.map((take) => ({ variation: take.variation, storageId: storageId(take.variation), credits: take.credits })),
            });
          followBatch({ id: batchId, source: "workspace", projectId: shot.projectId, name: base, model: model.label, takes: outcome.takes });
          dispatch({ type: "notice", value: `${before}${batchNotice(outcome.takes, "cr")}` });
          return;
        }

        const name = base;
        if (composer.billing === "connected") {
          /* Re-quote on click; a moved price is shown and nothing is sent. */
          const input = now.connectedInput;
          if (!input) throw new Error("This request could not be prepared. Nothing was submitted.");
          const quoted = await studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify(connectedQuoteRequest(project.id, input, { composer: "gen" })),
          });
          const job = parseConnectedJob(quoted.job, project.id);
          /* The figure this click was given is the one held for this body from now on. */
          heldQuotes.current.set(`${project.id}\n${now.connectedKey}`, { credits: job.quoteCredits, expiresAt: job.quoteExpiresAt });
          if (shown === null || job.quoteCredits !== shown) {
            setQuote({ key: now.quoteKey, credits: job.quoteCredits, state: "ready", reason: null });
            dispatch({ type: "notice", value: `${before}The price is now ${job.quoteCredits.toLocaleString("en-US")} connected cr. Press Generate again to approve it.` });
            return;
          }
          if (job.quoteExpiresAt <= Date.now()) { dispatch({ type: "notice", value: `${before}That price expired. Press Generate again for a fresh one.` }); return; }
          setRun({ source: "connected", name, meta: [name, model.label, `${job.quoteCredits.toLocaleString("en-US")} connected cr`].join(" · "), jobId: null });
          const sent = await studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify(connectedSubmitRequest(project.id, job)),
          });
          const accepted = parseConnectedJob(sent.job, project.id);
          setConnectedJob(accepted);
          setRun({ source: "connected", name, meta: [name, model.label, `${accepted.quoteCredits.toLocaleString("en-US")} connected cr`].join(" · "), jobId: accepted.id });
          return;
        }

        const shot = await fileShot(name);
        const outcome = await dispatchGeneration({
          scope,
          storageId: pendingGenerationKey(scope, shot.projectId, shot.nodeId),
          shown,
          request: request(shot.mapping),
          onClaim: (approved) => setRun({ source: "workspace", name, meta: [name, model.label, formatCredits(approved)].join(" · "), jobId: null }),
        });
        if (outcome.state === "repriced") {
          setQuote({ key: now.quoteKey, credits: outcome.credits, state: "ready", reason: null });
          setRun(null);
          dispatch({ type: "notice", value: `${before}${outcome.reason}` });
          return;
        }
        if (outcome.state === "refused") { setRun(null); dispatch({ type: "notice", value: `${before}${outcome.reason}` }); return; }
        setRun({ source: "workspace", name, meta: [name, model.label, formatCredits(outcome.credits)].join(" · "), jobId: outcome.jobId });
      } catch (error) {
        setRun(null);
        dispatch({ type: "notice", value: neutralCopy(error instanceof Error ? error.message : "This generation could not be submitted.") });
      } finally {
        busy.current = false;
        setSubmitting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, ensureProject, followBatch, settleEarlier, settings.ratio, settings.resolution, settings.duration]);

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

  const connectedJobId = run?.source === "connected" ? run.jobId : null;
  /* The connected take this composer reads is its alone: the shell's collector leaves it be (even when a batch takes
     the strip), and takes it up from here when the composer moves on to another take or is closed mid-render. */
  const polledJob = useRef<ConnectedJob | null>(null);
  useEffect(() => { polledJob.current = connectedJob; });
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (!connectedJobId || !targetId) return;
    watchConnectedJob(connectedJobId);
    return () => {
      const last = polledJob.current;
      releaseConnectedJob(targetId, last && last.id === connectedJobId ? last : { id: connectedJobId, status: "uncertain" });
    };
  }, [connectedJobId, targetId]);
  useEffect(() => {
    if (!connectedJobId || !target) return;
    if (connectedJob && (connectedJob.status === "completed" || connectedJob.status === "failed")) return;
    let live = true;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
        body: JSON.stringify(connectedStatusRequest(target.id, connectedJobId)),
      })
        .then((data) => { if (live) setConnectedJob(parseConnectedJob(data.job, target.id)); })
        .catch(() => {});
    }, CONNECTED_POLL_MS);
    return () => { live = false; clearInterval(timer); controller.abort(); };
  }, [connectedJobId, connectedJob, scope, target]);

  /* ── A batch's takes, each followed until it settles ─────────────────── */
  const batchViews = useMemo<BatchView[]>(() => batches.map((run) => {
    const views = run.takes.map((take) => takeView(take, run.source, take.jobId ? takeReads[take.jobId] : undefined));
    return { ...run, views, phase: batchPhase(views) };
  }), [batches, takeReads]);
  /* The jobs still in flight, as one key: the poll below restarts only when that set changes. */
  const following = JSON.stringify(batchViews.flatMap((run) => run.views.filter((view) => view.jobId && !view.done).map((view) => [run.source, run.projectId, view.jobId])));
  useEffect(() => {
    const jobs = JSON.parse(following) as ["workspace" | "connected", string, string][];
    if (!jobs.length) return;
    let live = true;
    const controller = new AbortController();
    const headers = { "Content-Type": "application/json", "X-Workbench-Scope": scope };
    /* While it reads them, the shell's collector leaves them be: one reader per job. */
    for (const [source, , id] of jobs) if (source === "connected") watchConnectedJob(id);
    const tick = () => {
      for (const [source, projectId, id] of jobs) {
        const read: Promise<TakeRead> = source === "connected"
          ? studioRequest<{ job?: unknown }>(CONNECTED_GENERATION_ENDPOINT, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(connectedStatusRequest(projectId, id)) })
            .then((data) => ({ connected: parseConnectedJob(data.job, projectId) }))
          : studioRequest<{ generation: MediaJob }>(`/api/jobs/${encodeURIComponent(id)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
            .then((data) => ({ media: data.generation }));
        void read.then((value) => {
          if (!live) return;
          setTakeReads((reads) => ({ ...reads, [id]: value }));
          /* Settled here: nothing is left for the collector to pick up. */
          if (value.connected && !connectedRecoverable(value.connected)) releaseConnectedJob(projectId, value.connected);
        }).catch(() => {});
      }
    };
    tick();
    /* Status reads are rate limited per person: a batch of connected takes is read at a pace that stays inside it. */
    const connected = jobs.filter(([source]) => source === "connected").length;
    const timer = setInterval(tick, CONNECTED_POLL_MS * Math.max(1, Math.ceil(connected / 2)));
    return () => { live = false; clearInterval(timer); controller.abort(); };
  }, [following, scope]);

  /* Leaving the composer mid-batch: each connected take still in flight is handed to the shell's collector, which follows it to the end. */
  const batchesNow = useRef({ views: batchViews, reads: takeReads });
  useEffect(() => { batchesNow.current = { views: batchViews, reads: takeReads }; });
  useEffect(() => () => {
    const { views, reads } = batchesNow.current;
    for (const run of views) {
      if (run.source !== "connected") continue;
      for (const view of run.views)
        if (view.jobId && !view.done) releaseConnectedJob(run.projectId, reads[view.jobId]?.connected ?? { id: view.jobId, status: "uncertain" });
    }
  }, []);

  /* Each completed connected original is filed into its project, once, so it reaches Takes. One filing at a time,
     each on the draft as the server holds it right then, so two takes landing together never overwrite each other. */
  const filed = useRef(new Set<string>());
  const filing = useRef<Promise<unknown>>(Promise.resolve());
  const fileOriginal = useCallback((job: ConnectedJob) => {
    const original = connectedOriginal(job);
    if (!original || filed.current.has(original.generationId)) return;
    filed.current.add(original.generationId);
    filing.current = filing.current.then(async () => {
      const latest = await draftRequest<{ project: Project | null; revision: number }>(`${API}/projects?id=${encodeURIComponent(job.draftId)}`, scope).catch(() => null);
      if (!latest?.project || latest.project.id !== job.draftId) return;
      if (latest.project.assets.some((asset) => asset.generationId === original.generationId)) return;
      const enhanced = connectedEnhancedPrompt(job);
      const asset = {
        id: original.generationId, generationId: original.generationId, url: original.url,
        kind: original.kind === "model" ? "document" : original.kind, mime: original.mime,
        name: `${job.model.name} · ${job.input.prompt.slice(0, 80)}`, category: "Generate",
        description: `${job.model.name} · ${original.credits} connected credits${enhanced ? " · enhanced on the account" : ""}`, prompt: job.input.prompt,
        status: "Draft", version: 1, locked: false, refs: [],
      } as unknown as Asset;
      await writeDraft(API, scope, { project: { ...latest.project, assets: [...latest.project.assets, asset] }, revision: latest.revision });
    }).catch(() => undefined);
  }, [scope]);
  useEffect(() => { if (connectedJob && target && connectedJob.draftId === target.id) fileOriginal(connectedJob); }, [connectedJob, target, fileOriginal]);
  useEffect(() => { for (const read of Object.values(takeReads)) if (read.connected) fileOriginal(read.connected); }, [takeReads, fileOriginal]);

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
    const phase = batch ? null : !run ? null
      : run.source === "connected" ? connectedPhase(run.jobId ? connectedJob : null)
      : generationPhase(run.jobId ? mediaJob ?? { status: "queued" } : null);
    const gen: Generation | null = batch
      ? {
          id: `batch:${batch.id}`, pct: batch.phase.pct, name: `${batch.name} · ${batch.takes.length} takes`, label: batch.phase.label, tone: batch.phase.tone,
          meta: [batch.model, batch.source === "connected"
            ? `${batch.takes.reduce((sum, take) => sum + take.credits, 0).toLocaleString("en-US")} connected cr`
            : formatCredits(batch.takes.reduce((sum, take) => sum + take.credits, 0))].filter(Boolean).join(" · "),
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
        toast(`${run.name} rendered. Filed in Takes for review.`);
        /* Takes and the Library sidebar may already be loaded; re-read so the new take shows. */
        const id = target?.id;
        if (id) void refreshProjectLibrary(scope, id);
      }
      if (holdTimer.current) clearTimeout(holdTimer.current);
      const id = run.jobId;
      holdTimer.current = setTimeout(() => setRun((r) => (r?.jobId === id ? null : r)), phase.tone === "green" ? DONE_HOLD_MS : FAILED_HOLD_MS);
    }
  }, [run, mediaJob, connectedJob, batch, batchViews, shellDispatch, toast, scope, target?.id]);
  /* Leaving the composer never leaves its progress frozen on every page: the strip it drew is cleared, and the
     takes still land in Takes (a connected one through the shell's collector). */
  const stripNow = useRef(ws.state.gen);
  useEffect(() => { stripNow.current = ws.state.gen; });
  useEffect(() => () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (stripNow.current?.id.startsWith("batch:") && JSON.stringify(stripNow.current) === shown.current) shellDispatch({ type: "patch", patch: { gen: null } });
  }, [shellDispatch]);

  return {
    state, dispatch, models, offered, model, quote, quoteKey, settings, credits,
    /** What the account says it rendered for the last connected take, once it completed. */
    connectedEnhanced: run?.source === "connected" && connectedJob ? connectedEnhancedPrompt(connectedJob) : null,
    buttonLabel: composerButtonLabel({ billing: state.billing, quote, quoteKey, submitting, count: state.count }),
    blocked, submitting,
    wording: billingWording(state.billing, { workspaceName: options.workspaceName, walletName }),
    audio, capability, project: target, projectNotice, generate, retryEngines, scope,
    batches: batchViews,
    batchJobIds: batchViews.flatMap((run) => (run.source === "connected" ? run.takes.flatMap((take) => (take.jobId ? [take.jobId] : [])) : [])),
  };
}

/** The saved revision, read right before a save so the composer never overwrites another window. */
async function currentRevision(scope: string, projectId: string): Promise<number> {
  const data = await draftRequest<{ revision: number }>(`${API}/projects?id=${encodeURIComponent(projectId)}`, scope);
  return data.revision;
}
