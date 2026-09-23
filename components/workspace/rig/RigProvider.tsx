"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { useProductionJobs } from "@/components/workbench/use-production-jobs";
import { DraftRequestError, draftRequest, writeDraft } from "@/lib/workbench/draft-request";
import { resolveGenerationReferences } from "@/lib/workbench/generation-request";
import { pendingGenerationKey, readPendingGeneration } from "@/lib/workbench/pending-generation";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { newProject, type Asset, type CanvasNode, type Project } from "@/lib/workbench/studio";
import type { MediaJob } from "@/lib/workbench/job-recovery";
import { formatCredits } from "@/lib/workspace/cost";
import { engineLabel, shotEngine, shotEngines } from "@/lib/workspace/engines";
import { connectNodes } from "@/lib/workspace/rig-graph";
import { rigPlanRequests, shotRequestInput, type NamedShotBody } from "@/lib/workspace/rig-requests";
import { addShotNode, dispatchQuoteQuery, generationPhase, neutralCopy, shotReferenceAssets, shotReferenceRole } from "@/lib/workspace/rig";
import { ENGINE_PROMPT_LIMIT, renderPromptFor } from "@/lib/production/rig-prompt";
import { RigBuildError, removeShots, restoreShots, shotFromAsset, takeRigIntent } from "@/lib/production/rig-build";
import { rigShots, ShotPatchError, shotPatch, type RigShot, type ShotPatch } from "@/lib/workspace/shots";
import { rigUndoSink, setRigDeleteHandler } from "@/lib/shell/rig-commands";
import { useShotEstimate, sharedShotEstimator } from "@/lib/workspace/use-shot-estimate";
import { useWorkspace } from "@/lib/workspace/state";
import type { Generation, SelectableItem } from "@/lib/workspace/types";
import type { ShellSeams } from "../WorkspaceShell";
import { videoReferenceProblem } from "@/lib/generationReferences";

/**
 * The Rig's live state, shared by the shot list, the node graph, the
 * Inspector and the shell's Generate seams:
 *
 *  - the project draft (GET /api/workbench/projects?id=), edited only through
 *    shotPatch / addShotNode and saved through the ordinary revision-checked
 *    draft save (writeDraft), debounced; a rejected save reloads the saved
 *    version instead of overwriting it;
 *  - the production jobs (useProductionJobs, the Studio's own poller), which
 *    also file finished takes into the draft;
 *  - live quotes (the shared ShotEstimator) so "ready" means priced;
 *  - generation: the exact live quote on the button, a fresh POST
 *    /api/generate/quote with GenerationDialog's own request body at submit,
 *    then POST /api/generate with maxCredits + quoteFingerprint.
 *
 * It lives above the shell so a render keeps being tracked while the person
 * is on another page, and so G works however Rig was reached.
 */

type Draft = { project: Project; revision: number };
type Quote = { key: string; credits: number | null; state: "loading" | "ready" | "unavailable"; reason: string | null };
type Run = { shotId: string; name: string; meta: string; jobId: string | null };

export type RigContext = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  project: Project | null;
  shots: RigShot[];
  jobs: MediaJob[];
  saveState: "saved" | "saving" | "error";
  saveError: string | null;
  selected: RigShot | null;
  selectedNode: CanvasNode | null;
  select: (id: string) => void;
  patchShot: (id: string, patch: ShotPatch) => string | null;
  addShot: () => void;
  /** Link `source` into `target` under the Studio graph's rules; returns the refusal, or null. */
  connect: (source: string, target: string) => string | null;
  /** The exact live quote for the selected shot, as shown on every Generate button. */
  quote: Quote | null;
  generate: () => void;
  /** Why Generate cannot run, or null. */
  blocked: string | null;
  /** The last thing Generate said (a changed price, a refusal). */
  notice: string | null;
  submitting: boolean;
  scope: string;
  /** /api/generate bodies for every ready, mapped shot — what the Atomik Rig plan dispatches. */
  planRequests: NamedShotBody[];
  /** Applies a pure Rig operation (lib/production/rig-build); returns its refusal, or null. `select` picks the shot it made. */
  apply: (fn: (project: Project) => Project | { project: Project; id?: string }, select?: boolean) => string | null;
  /** Saves pending edits; true once saved (an agent step reads the saved project). */
  save: () => Promise<boolean>;
  /** Deletes a shot (with the inputs only it used); returns the refusal, or null. ⌘Z brings it back in the Suites. */
  removeShot: (id: string) => string | null;
};

const Context = createContext<RigContext | null>(null);

export function useRig(): RigContext {
  const value = useContext(Context);
  if (!value) throw new Error("useRig must be used inside <RigProvider>.");
  return value;
}

const API = "/api/workbench";
const SAVE_DEBOUNCE_MS = 700;
const DONE_HOLD_MS = 1400;
const FAILED_HOLD_MS = 6000;

function validMapping(value: unknown): value is { shotId: string; productionProjectId: string } {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return [m.shotId, m.productionProjectId].every((v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v));
}

/** A live GET /api/workbench/engines quote for a shot with bound references. */
function useReferenceQuote(scope: string, query: string | null): Quote | null {
  const [result, setResult] = useState<Quote | null>(null);
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      studioRequest<{ credits: number | null }>(`${API}/engines?${query}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
        .then((value) => {
          if (controller.signal.aborted) return;
          const ok = typeof value.credits === "number" && Number.isFinite(value.credits);
          setResult({ key: query, credits: ok ? value.credits : null, state: ok ? "ready" : "unavailable", reason: ok ? null : "This engine cannot be priced with these settings." });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setResult({ key: query, credits: null, state: "unavailable", reason: neutralCopy(error instanceof Error ? error.message : "The estimate is unavailable right now.", "The estimate is unavailable right now.") });
        });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [scope, query]);
  if (!query) return null;
  return result?.key === query ? result : { key: query, credits: null, state: "loading", reason: null };
}

export function RigProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const ws = useWorkspace();
  const { state, dispatch, toast } = ws;
  const projectId = state.view === "studio" ? state.projectId : null;

  /* ── Draft ─────────────────────────────────────────────────────────── */
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [status, setStatus] = useState<RigContext["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<RigContext["saveState"]>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));

  const setDraft = useCallback((next: Draft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    const data = await draftRequest<{ project?: Project | null; revision: number }>(`${API}/projects?id=${encodeURIComponent(id)}`, scope, { signal });
    return data.project ? { project: data.project, revision: data.revision } : null;
  }, [scope]);

  /** Reload the saved version (after a rejected save). Local edits since the last save are dropped, never pushed over it. */
  const reload = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    const fresh = await load(current.project.id).catch(() => null);
    if (fresh && draftRef.current?.project.id === current.project.id) {
      dirty.current = false;
      setDraft(fresh);
    }
  }, [load, setDraft]);

  const flush = useCallback((options: { force?: boolean } = {}): Promise<boolean> => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    chain.current = chain.current.then(async () => {
      const current = draftRef.current;
      if (!current) return false;
      if (!dirty.current && !options.force) return true;
      dirty.current = false;
      setSaveState("saving");
      try {
        const receipt = await writeDraft(API, scope, { project: current.project, revision: current.revision });
        const now = draftRef.current;
        if (!now || now.project.id !== current.project.id) return false;
        setDraft({ project: { ...now.project, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings }, revision: receipt.revision });
        setSaveState(dirty.current ? "saving" : "saved");
        setSaveError(null);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "The project could not be saved.";
        if (err instanceof DraftRequestError && (err.retryable || err.uncertain)) {
          /* Unconfirmed: keep the edits and try again on the next change. */
          dirty.current = true;
          setSaveState("error");
          setSaveError(message);
          return false;
        }
        /* Rejected (another window saved first, or the draft is invalid): reload, never overwrite. */
        setSaveState("saved");
        setSaveError(null);
        await reload();
        toast("This project changed elsewhere. Rig reloaded the saved version.");
        return false;
      }
    });
    return chain.current;
  }, [scope, setDraft, reload, toast]);

  const update = useCallback((fn: (p: Project) => Project) => {
    const current = draftRef.current;
    if (!current) return;
    const next = fn(current.project);
    if (next === current.project) return;
    setDraft({ ...current, project: next });
    dirty.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [setDraft, flush]);

  /* Open the project the shell is on; finish any pending save for the previous one first. */
  useEffect(() => {
    if (!projectId) return;
    if (draftRef.current?.project.id === projectId) return;
    const controller = new AbortController();
    void (async () => {
      await flush();
      if (controller.signal.aborted) return;
      setStatus("loading");
      setError(null);
      try {
        const next = await load(projectId, controller.signal);
        if (controller.signal.aborted) return;
        dirty.current = false;
        setDraft(next);
        setStatus("ready");
      } catch (err) {
        if (controller.signal.aborted) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "This project could not be loaded.");
      }
    })();
    return () => controller.abort();
  }, [projectId, load, flush, setDraft]);

  /* Best effort: a page being hidden sends the pending save now. */
  useEffect(() => {
    const onHide = () => { if (dirty.current) void flush(); };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [flush]);

  const project = draft && draft.project.id === projectId ? draft.project : null;

  /* ── Jobs (the Studio's own poller; it also files finished takes) ──── */
  const [run, setRun] = useState<Run | null>(null);
  const empty = useMemo(() => newProject(""), []);
  const jobsEnabled = !!project && (state.page === "rig" || run !== null);
  const change = useCallback((fn: (p: Project) => Project) => update(fn), [update]);
  const jobs = useProductionJobs(project ?? empty, jobsEnabled, change, scope);
  const refreshJobs = useRef(jobs.refresh);
  useEffect(() => { refreshJobs.current = jobs.refresh; });
  const mediaJobs = useMemo(() => (project ? jobs.mediaJobs : []), [project, jobs.mediaJobs]);

  /* ── Shots and live quotes ─────────────────────────────────────────── */
  const base = useMemo(() => (project ? rigShots(project, mediaJobs) : []), [project, mediaJobs]);
  const [quotes, setQuotes] = useState<Record<string, number | null>>({});
  const priced = useMemo(() => {
    const byKey = new Map<string, { engine: string; durationS?: number; ratio: string; resolution: string }>();
    for (const s of base) if (s.estimateKey) byKey.set(s.estimateKey, { engine: s.engine, durationS: s.durationS, ratio: s.ratio, resolution: s.resolution });
    return byKey;
  }, [base]);
  const pricedKey = [...priced.keys()].sort().join("\n");
  useEffect(() => {
    const cancels = [...priced.entries()].map(([key, settings]) =>
      sharedShotEstimator.request(settings, (value) => setQuotes((q) => (q[key] === value.credits ? q : { ...q, [key]: value.credits }))));
    return () => cancels.forEach((cancel) => cancel());
    // `pricedKey` names exactly the settings requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricedKey]);
  const shots = useMemo(() => (project ? rigShots(project, mediaJobs, { quotes }) : []), [project, mediaJobs, quotes]);

  /* Shots are the Rig's selectable list: go()'s selection repair and ←/→ walk it. */
  const listed = useRef<string>("");
  useEffect(() => {
    if (status !== "ready" || !projectId) return;
    if (draftRef.current && draftRef.current.project.id !== projectId) return;
    const items: SelectableItem[] = project ? shots.map((s) => ({ id: s.id, name: s.name, status: s.status })) : [];
    const key = projectId + ":" + JSON.stringify(items);
    if (key === listed.current && state.lists.shots !== null) return;
    listed.current = key;
    dispatch({ type: "lists", lists: { shots: items } });
  }, [status, projectId, project, shots, state.lists.shots, dispatch]);

  const selected = state.selKind === "shot" && state.selId ? shots.find((s) => s.id === state.selId) ?? null : null;
  const selectedNode = selected && project ? project.nodes.find((n) => n.id === selected.id) ?? null : null;

  /* ── The quote on the button ───────────────────────────────────────── */
  const refs = useMemo(() => (project && selectedNode ? shotReferenceAssets(project, selectedNode) : []), [project, selectedNode]);
  const settings = useMemo(
    () => (selected && selected.estimateKey ? { engine: selected.engine, durationS: selected.durationS, ratio: selected.ratio, resolution: selected.resolution } : null),
    [selected],
  );
  const estimate = useShotEstimate(settings ?? {});
  const refQuery = settings && refs.length ? dispatchQuoteQuery(settings, refs) : null;
  const refQuote = useReferenceQuote(scope, refQuery);
  const [repriced, setRepriced] = useState<{ key: string; credits: number } | null>(null);
  const quote: Quote | null = useMemo(() => {
    if (!selected || !settings) return null;
    const key = refQuery ?? selected.estimateKey!;
    const live: Quote = refQuery ? refQuote! : { key, credits: estimate.credits, state: estimate.state, reason: estimate.reason };
    if (repriced && repriced.key === key && live.state === "ready") return { ...live, credits: repriced.credits };
    return live;
  }, [selected, settings, refQuery, refQuote, estimate.credits, estimate.state, estimate.reason, repriced]);

  const model = selected ? shotEngine(selected.engine) : null;
  const referenceProblem = model && model.kind === "video"
    ? videoReferenceProblem({ ...model, label: engineLabel(model.id).long }, refs.map((a) => ({ kind: a.kind, role: shotReferenceRole(selectedNode)(a) })))
    : null;

  /* The render prompt's length over the engine's limit, when no pinned condensation covers it. */
  const promptOver = useMemo(() => { if (!project || !selectedNode) return null; const r = renderPromptFor(selectedNode, project); return r.prompt === null ? r.length : null; }, [project, selectedNode]);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const blocked = !project ? null
    : submitting ? "Submitting this take…"
    : !selected ? null
    : !model ? "Choose an available engine for this shot."
    : referenceProblem ? neutralCopy(referenceProblem)
    : promptOver ? `This shot sends ${promptOver.toLocaleString()} characters; engines take ${ENGINE_PROMPT_LIMIT.toLocaleString()}. Have the agent condense it, or shorten the prompt.`
    : !quote || quote.state === "loading" ? "Getting the live price…"
    : quote.state === "unavailable" || quote.credits === null ? neutralCopy(quote.reason ?? "This shot has no live price yet.", "This shot has no live price yet.")
    : run && run.shotId === selected.id && !run.jobId ? "Submitting this take…"
    : null;

  /* ── Generate ───────────────────────────────────────────────────────── */
  const live = useRef({ project, selected, selectedNode, refs, quote, blocked, model, run });
  useEffect(() => { live.current = { project, selected, selectedNode, refs, quote, blocked, model, run }; });
  const busy = useRef(false);

  const generate = useCallback(() => {
    const now = live.current;
    if (busy.current) return;
    if (!now.project || !now.selected || !now.selectedNode || !now.model) {
      setNotice(now.selected ? "Choose an available engine for this shot." : "Select a shot to generate.");
      return;
    }
    if (now.blocked) { setNotice(now.blocked); return; }
    const shown = now.quote?.credits ?? null;
    const shot = now.selected, node = now.selectedNode, engine = now.model, draftId = now.project.id;
    const kind = engine.kind;
    busy.current = true;
    setSubmitting(true);
    setNotice(null);
    const storageId = pendingGenerationKey(scope, draftId, shot.id);
    void (async () => {
      try {
        /* Mapping, references and the request body are the shot's; the re-quote,
           the gate and the paid POST are the shared dispatch (generate-submit). */
        let request: ReturnType<typeof shotRequestInput> = null;
        if (!readPendingGeneration(window.localStorage, storageId)) {
          if (!(await flush()) || draftRef.current?.project.id !== draftId) throw new Error("Save your latest work before generating.");
          const mapping = await studioRequest<unknown>(`${API}/projects`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify({ action: "map-shot", projectId: draftId, nodeId: shot.id }),
          });
          if (!validMapping(mapping)) throw new Error("The project mapping could not be verified. Nothing was submitted.");
          update((p) => ({ ...p, productionProjectId: mapping.productionProjectId, shotMappings: { ...(p.shotMappings ?? {}), [shot.id]: mapping.shotId } }));
          const current = draftRef.current!.project;
          const references = await resolveGenerationReferences(now.refs, shotReferenceRole(now.selectedNode), {
            scope,
            onAsset: (id: string, fields: Partial<Asset>) => update((p) => ({ ...p, assets: p.assets.map((a) => (a.id === id ? { ...a, ...fields } : a)) })),
          });
          request = shotRequestInput(current, node, shot, mapping, references);
          if (!request) throw new Error("Choose an available engine for this shot.");
        }
        const outcome = await dispatchGeneration({
          scope,
          storageId,
          shown,
          /* A claimed attempt is replayed from storage; `input` is only read when there is none. */
          request: { endpoint: "/api/generate", input: request },
          onClaim: (credits) => setRun({ shotId: shot.id, name: shot.name, meta: [shot.name, engineLabel(engine.id).long, formatCredits(credits)].join(" · "), jobId: null }),
        });
        if (outcome.state === "repriced") {
          setRepriced({ key: live.current.quote?.key ?? "", credits: outcome.credits });
          setNotice(outcome.reason);
          return;
        }
        if (outcome.state === "refused") {
          setRun((r) => (r && r.shotId === shot.id && !r.jobId ? null : r));
          setNotice(outcome.reason);
          return;
        }
        accepted(outcome.jobId, outcome.credits);
      } catch (err) {
        setRun((r) => (r && r.shotId === shot.id && !r.jobId ? null : r));
        setNotice(neutralCopy(err instanceof Error ? err.message : "Generation could not be submitted."));
      } finally {
        busy.current = false;
        setSubmitting(false);
      }
    })();

    function accepted(jobId: string, credits: number) {
      setRun({ shotId: shot.id, name: shot.name, meta: [shot.name, engineLabel(engine.id).long, formatCredits(credits)].join(" · "), jobId });
      setRepriced(null);
      /* The node renders this kind now (GenerationDialog's onQueued does the same). */
      update((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === shot.id && !n.locked ? { ...n, mode: kind === "video" ? "Video" : "Image" } : n)) }));
      void flush({ force: true }).then(() => refreshJobs.current());
    }
  }, [scope, flush, update]);

  /* ── Progress from the real job ────────────────────────────────────── */
  const runJob = run?.jobId ? mediaJobs.find((j) => j.id === run.jobId) ?? null : null;
  const phase = run ? generationPhase(run.jobId ? runJob ?? { status: "queued" } : null) : null;
  const shownGen = useRef<string>("");
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announced = useRef<string | null>(null);
  useEffect(() => {
    const gen: Generation | null = run && phase
      ? { id: run.jobId ?? "pending:" + run.shotId, pct: phase.pct, name: run.name, meta: run.meta, label: phase.label, tone: phase.tone }
      : null;
    const key = JSON.stringify(gen);
    if (key !== shownGen.current) {
      shownGen.current = key;
      dispatch({ type: "patch", patch: { gen } });
    }
    if (run?.jobId && phase?.done && announced.current !== run.jobId) {
      announced.current = run.jobId;
      if (phase.tone === "green") {
        const billed = runJob?.creditsBilled;
        toast(`${run.name} rendered${typeof billed === "number" ? ` · ${formatCredits(billed)} settled` : ""}. Filed in Takes for review.`);
      }
      if (holdTimer.current) clearTimeout(holdTimer.current);
      const id = run.jobId;
      holdTimer.current = setTimeout(() => setRun((r) => (r?.jobId === id ? null : r)), phase.tone === "green" ? DONE_HOLD_MS : FAILED_HOLD_MS);
    }
  }, [run, phase, runJob, dispatch, toast]);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  /* ── Selection and editing ─────────────────────────────────────────── */
  const select = useCallback((id: string) => {
    dispatch({ type: "patch", patch: { selKind: "shot", selId: id, inspector: true } });
    ws.syncUrl();
    setNotice(null);
  }, [dispatch, ws, setNotice]);

  const patchShot = useCallback((id: string, patch: ShotPatch): string | null => {
    const current = draftRef.current;
    if (!current) return "Open a project first.";
    try {
      const next = shotPatch(current.project, id, patch);
      update(() => next);
      return null;
    } catch (err) {
      if (err instanceof ShotPatchError) return err.message;
      throw err;
    }
  }, [update]);

  const addShot = useCallback(() => {
    const current = draftRef.current;
    if (!current) return;
    try {
      const { project: next, id } = addShotNode(current.project);
      update(() => next);
      select(id);
    } catch (err) {
      if (err instanceof ShotPatchError) setNotice(err.message);
      else throw err;
    }
  }, [update, select, setNotice]);

  const connect = useCallback((source: string, target: string): string | null => {
    const current = draftRef.current;
    if (!current) return "Open a project first.";
    const result = connectNodes(current.project, source, target);
    if ("error" in result) return result.error;
    update(() => result.project);
    return null;
  }, [update]);

  const planRequests = useMemo(() => (project ? rigPlanRequests(project, shots) : []), [project, shots]);

  const apply = useCallback((fn: (project: Project) => Project | { project: Project; id?: string }, pick?: boolean): string | null => {
    const current = draftRef.current;
    if (!current) return "Open a project first.";
    try {
      const out = fn(current.project);
      const next = "nodes" in out ? out : out.project;
      update(() => next);
      if (pick && !("nodes" in out) && out.id) select(out.id);
      return null;
    } catch (err) {
      if (err instanceof RigBuildError || err instanceof ShotPatchError) return err.message;
      throw err;
    }
  }, [update, select]);
  const save = useCallback(() => flush({ force: true }), [flush]);
  const removeShot = useCallback((id: string): string | null => {
    const current = draftRef.current;
    if (!current) return "Open a project first.";
    let out: ReturnType<typeof removeShots>;
    try { out = removeShots(current.project, [id]); }
    catch (err) { if (err instanceof RigBuildError) return err.message; throw err; }
    const name = out.removed.removed.find((n) => n.id === id)?.title || "The shot";
    update(() => out.project);
    if (state.selKind === "shot" && state.selId === id) dispatch({ type: "patch", patch: { selKind: "page", selId: null } });
    const sink = rigUndoSink();
    sink?.({ label: `${name} is back in the Rig`, undo: () => update((p) => restoreShots(p, out.removed)) });
    toast(`${name} deleted${sink ? " · ⌘Z brings it back" : ""}`);
    return null;
  }, [update, state.selKind, state.selId, dispatch, toast]);
  /* The shell's Delete (menu, ⌫) reaches the Rig through this slot while it is on screen. */
  useEffect(() => { setRigDeleteHandler(removeShot); return () => setRigDeleteHandler(null); }, [removeShot]);
  /* An asset sent from Astra or Edit becomes a shot here, once, when the Rig has the project. */
  const intentDone = useRef<string | null>(null);
  useEffect(() => {
    if (!project || intentDone.current === project.id) return;
    intentDone.current = project.id;
    const asset = takeRigIntent(project.id);
    if (!asset) return;
    const why = apply((p) => shotFromAsset(p, asset, shotEngines()[0].id), true);
    toast(why ?? `${asset.name} is a new shot in the Rig`);
  }, [project, apply, toast]);

  const value = useMemo<RigContext>(() => ({
    status: projectId ? status : "idle", error, project, shots, jobs: mediaJobs, saveState, saveError, selected, selectedNode,
    select, patchShot, addShot, connect, quote, generate, blocked, notice, submitting, scope, planRequests, apply, save, removeShot,
  }), [projectId, status, error, project, shots, mediaJobs, saveState, saveError, selected, selectedNode, select, patchShot, addShot, connect, quote, generate, blocked, notice, submitting, scope, planRequests, apply, save, removeShot]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The shell's Generate seams, fed by the Rig. */
export function RigSeams({ children }: { children: (seams: ShellSeams) => ReactNode }) {
  const { generate, quote: live, blocked, notice } = useRig();
  const { state, dispatch } = useWorkspace();
  /* G, ← / → and Space are the shell's one keymap (#233); the Rig only feeds its seams. */
  const onTogglePlay = useCallback(() => dispatch({ type: "patch", patch: { playing: !state.playing } }), [dispatch, state.playing]);
  const quote = live?.state === "ready" && live.credits !== null ? formatCredits(live.credits) : null;
  return <>{children({ onGenerate: generate, onTogglePlay, generate: { quote, blocked, notice } })}</>;
}
