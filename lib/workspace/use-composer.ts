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
  connectedOriginal,
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
  const [connectedJob, setConnectedJob] = useState<ConnectedJob | null>(null);
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
    studioRequest<{ catalogue?: { models?: { id: string; name: string; outputType: string; medias?: { roles: string[] }[] }[] } }>(CONNECTED_GENERATION_ENDPOINT, {
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
  const settings = useMemo(() => composerSettings(model, target?.aspect), [model, target?.aspect]);

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
    return {
      type: state.type, model: model.id, prompt: state.prompt.trim(), parameters: {},
      medias: roles.length
        ? state.references.map((r) => ({ role: roles[0], source: r.origin === "upload" ? { uploadId: r.id } : { genId: r.id } }))
        : [],
    } as ConsumerGenerationInput;
  }, [state.billing, state.type, state.prompt, state.references, model]);

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
        const name = composer.prompt.trim().slice(0, 60) || `${model.label} take`;
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

        /* This workspace's credits: the take needs a shot to live in, so the
           composer adds one to the draft the way Rig does and maps it. */
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
        const references = composer.references.map((reference) => {
          const identity = mediaReferenceIdentity(referenceAsset(reference));
          if (!identity) throw new Error(`${reference.name} cannot be used as a reference.`);
          return { ...identity, role: referenceRole({ kind: reference.kind }) };
        });
        const storageId = pendingGenerationKey(scope, stored.id, withShot.id);
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
          onClaim: (approved) => setRun({ source: "workspace", name, meta: [name, model.label, formatCredits(approved)].join(" · "), jobId: null }),
        });
        if (outcome.state === "repriced") {
          setQuote({ key: now.quoteKey, credits: outcome.credits, state: "ready", reason: null });
          setRun(null);
          dispatch({ type: "notice", value: outcome.reason });
          return;
        }
        if (outcome.state === "refused") { setRun(null); dispatch({ type: "notice", value: outcome.reason }); return; }
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

  const connectedJobId = run?.source === "connected" ? run.jobId : null;
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

  /* A completed connected original is filed into the project so it reaches Takes. */
  const filed = useRef<string>("");
  useEffect(() => {
    if (!connectedJob || !target) return;
    const original = connectedOriginal(connectedJob);
    if (!original || filed.current === original.generationId) return;
    filed.current = original.generationId;
    void (async () => {
      const latest = await draftRequest<{ project: Project | null; revision: number }>(`${API}/projects?id=${encodeURIComponent(target.id)}`, scope).catch(() => null);
      if (!latest?.project || latest.project.id !== target.id) return;
      if (latest.project.assets.some((asset) => asset.generationId === original.generationId)) return;
      const asset = {
        id: original.generationId, generationId: original.generationId, url: original.url,
        kind: original.kind === "model" ? "document" : original.kind, mime: original.mime,
        name: `${connectedJob.model.name} · ${connectedJob.input.prompt.slice(0, 80)}`, category: "Generate",
        description: `${connectedJob.model.name} · ${original.credits} connected credits`, prompt: connectedJob.input.prompt,
        status: "Draft", version: 1, locked: false, refs: [],
      } as unknown as Asset;
      await writeDraft(API, scope, { project: { ...latest.project, assets: [...latest.project.assets, asset] }, revision: latest.revision }).catch(() => undefined);
    })();
  }, [connectedJob, target, scope]);

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
        const id = target?.id;
        if (id) void refreshProjectLibrary(scope, id);
      }
      if (holdTimer.current) clearTimeout(holdTimer.current);
      const id = run.jobId;
      holdTimer.current = setTimeout(() => setRun((r) => (r?.jobId === id ? null : r)), phase.tone === "green" ? DONE_HOLD_MS : FAILED_HOLD_MS);
    }
  }, [run, mediaJob, connectedJob, shellDispatch, toast, scope, target?.id]);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  return {
    state, dispatch, models, offered, model, quote, quoteKey, settings, credits,
    buttonLabel: composerButtonLabel({ billing: state.billing, quote, quoteKey, submitting }),
    blocked, submitting,
    wording: billingWording(state.billing, { workspaceName: options.workspaceName, walletName }),
    audio, capability, project: target, projectNotice, generate, scope,
  };
}

/** The saved revision, read right before a save so the composer never overwrites another window. */
async function currentRevision(scope: string, projectId: string): Promise<number> {
  const data = await draftRequest<{ revision: number }>(`${API}/projects?id=${encodeURIComponent(projectId)}`, scope);
  return data.revision;
}
