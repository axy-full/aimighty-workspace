"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { useProductionJobs } from "@/components/workbench/use-production-jobs";
import { DraftRequestError, draftRequest, draftWriter, writeMergedDraft, type DraftWriter } from "@/lib/workbench/draft-request";
import { mergeDraft, rebaseProject } from "@/lib/workbench/draft-merge";
import { noteTakenOut, recordMade, sameJson, type MadeRecords } from "@/lib/workbench/merge";
import { resolveGenerationReferences } from "@/lib/workbench/generation-request";
import { pendingGenerationKey, readPendingGeneration } from "@/lib/workbench/pending-generation";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { newProject, type Asset, type CanvasNode, type Project } from "@/lib/workbench/studio";
import type { MediaJob } from "@/lib/workbench/job-recovery";
import { formatCredits } from "@/lib/workspace/cost";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { engineLabel, shotEngine, shotEngines } from "@/lib/workspace/engines";
import { connectNodes } from "@/lib/workspace/rig-graph";
import { rigPlanRequests, shotRequestInput, type NamedShotBody } from "@/lib/workspace/rig-requests";
import { addShotNode, dispatchQuoteQuery, generationPhase, neutralCopy, shotReferenceAssets, shotReferenceRole } from "@/lib/workspace/rig";
import { ENGINE_PROMPT_LIMIT, renderPromptFor } from "@/lib/production/rig-prompt";
import { RIG_INTENT_EVENT, RigBuildError, removeShots, restoreShots, shotFromAsset, takeRigIntent } from "@/lib/production/rig-build";
import { rigShots, ShotPatchError, shotPatch, type RigShot, type ShotPatch } from "@/lib/workspace/shots";
import { rigUndoSink, setRigDeleteHandler } from "@/lib/shell/rig-commands";
import { useShotEstimate, sharedShotEstimator } from "@/lib/workspace/use-shot-estimate";
import { useWorkspace } from "@/lib/workspace/state";
import type { Generation, SelectableItem } from "@/lib/workspace/types";
import type { ShellSeams } from "../WorkspaceShell";
import { videoReferenceProblem } from "@/lib/generationReferences";
import { useTeamCanvas, type TeamCanvasApi } from "./use-team-canvas";

/**
 * The Rig's live state, shared by the shot list, the node graph, the
 * Inspector and the shell's Generate seams:
 *
 *  - the project draft (GET /api/workbench/projects?id=), edited only through
 *    shotPatch / addShotNode and saved through the ordinary revision-checked
 *    draft save, debounced. When another save landed first (a Studio stage,
 *    another tab), the Rig's edits since the version it holds are merged into
 *    the newer one (writeMergedDraft, lib/workbench/draft-merge.ts) and saved;
 *    the Rig then shows the merged draft. What the other save brought in
 *    reaches the team canvas only where the canvas still holds what the Rig
 *    had (catchUpForTeam): the server carried that save there already, unless
 *    the canvas missed it, and a teammate's later edit always stands. Coming
 *    back to the Rig page catches up with what other pages of this tab saved
 *    meanwhile the same way. A save that is refused outright keeps the edits
 *    here and says so; edits to a project the person leaves before they are
 *    saved keep being saved, and coming back to it waits for the save in
 *    flight before saving again. A shot built from boards that an edit takes
 *    out is noted as taken out (Project.takenOut), so another window building
 *    it again from a stale copy does not bring it back;
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

/**
 * `base` is the project exactly as the server holds it at `revision`: what the Rig's edits are merged from.
 * `writer` tags this draft's saves, so one whose reply was lost is checked, never guessed at.
 * `ancestors`: shots an undo put back, as they were when deleted — merged from, if another window has them too.
 * `made`: what the Rig's builds made (shots from boards, inputs, filed takes), as made — merged from likewise.
 */
type Draft = { project: Project; revision: number; base: Project; writer: DraftWriter; ancestors: Map<string, CanvasNode>; made: MadeRecords };
/**
 * A project the person left with edits not saved yet: they keep being saved until they are, or the project is back.
 * `inflight` is the attempt out now (what it saved, or null); coming back waits for it.
 */
type Parked = { draft: Draft; stop: boolean; wake: () => void; inflight: Promise<{ project: Project; revision: number } | null> };
type Quote = { key: string; credits: number | null; state: "loading" | "ready" | "unavailable"; reason: string | null };
type Run = { shotId: string; name: string; meta: string; jobId: string | null; projectId: string };

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
  /** The production's shared canvas: who else is here, and presence to show them. */
  team: Pick<TeamCanvasApi, "mode" | "peers" | "presence">;
};

const Context = createContext<RigContext | null>(null);

export function useRig(): RigContext {
  const value = useContext(Context);
  if (!value) throw new Error("useRig must be used inside <RigProvider>.");
  return value;
}

const API = "/api/workbench";
const SAVE_DEBOUNCE_MS = 700;
/** A save whose outcome is unknown (the connection dropped) is tried again after this, then less often. */
const RETRY_MS = 4000;
const RETRY_MAX_MS = 60_000;
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
  /* The project the shell is on right now, on any page: an undo is only ever for it. */
  const shellProject = useRef(state.projectId);
  useEffect(() => { shellProject.current = state.projectId; }, [state.projectId]);

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

  const load = useCallback(async (id: string, signal?: AbortSignal): Promise<Draft | null> => {
    const data = await draftRequest<{ project?: Project | null; revision: number }>(`${API}/projects?id=${encodeURIComponent(id)}`, scope, { signal });
    return data.project ? { project: data.project, revision: data.revision, base: data.project, writer: draftWriter(), ancestors: new Map(), made: new Map() } : null;
  }, [scope]);

  /* Set once the team canvas hook exists below: its waiting edit goes out before the draft save. */
  const teamFlushRef = useRef<(() => Promise<void>) | null>(null);
  /* A local edit is also a team canvas edit; publishRef is set once the team canvas hook exists below. */
  const publishRef = useRef<((before: Project, after: Project) => void) | null>(null);
  /* What a merge brought in: onto the team canvas only where it still holds what the Rig had. */
  const catchUpRef = useRef<((before: Project, after: Project) => void) | null>(null);
  const retries = useRef(0);
  const flushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  const flush = useCallback((options: { force?: boolean } = {}): Promise<boolean> => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    /* One save at a time; a save that failed never stops the next. */
    chain.current = chain.current.catch(() => false).then(async () => {
      if (!draftRef.current) return false;
      if (!dirty.current && !options.force) return true;
      await teamFlushRef.current?.();
      /* Read after that wait, together: what is sent is exactly what counts as saved. */
      const current = draftRef.current;
      if (!current) return false;
      dirty.current = false;
      setSaveState("saving");
      try {
        const saved = await writeMergedDraft(API, scope, { base: current.base, mine: current.project, revision: current.revision, writer: current.writer, ancestors: current.ancestors, made: current.made });
        retries.current = 0;
        const now = draftRef.current;
        if (!now || now.project.id !== current.project.id) return false;
        /* Saved: a shot put back is in the base now, merged from there on. */
        for (const id of [...current.ancestors.keys()]) if (saved.project.nodes.some((n) => n.id === id)) current.ancestors.delete(id);
        /* What another save brought in joins the Rig; edits made meanwhile stay. The team canvas catches up only where it
           still holds what the Rig showed: that save carried it there already (saveDraft) unless the canvas missed it,
           and it never goes over a teammate's edit made since. */
        const project = rebaseProject(current.project, now.project, saved.project);
        setDraft({ ...now, project, revision: saved.revision, base: saved.project });
        if (project !== now.project) catchUpRef.current?.(now.project, project);
        setSaveState(dirty.current ? "saving" : "saved");
        setSaveError(null);
        if (saved.notes.length) toast(saved.notes.join(" "));
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "The project could not be saved.";
        if (err instanceof DraftRequestError && (err.retryable || err.uncertain)) {
          /* Unconfirmed or temporary: keep the edits and save again later; a save whose reply was lost is checked first, never guessed at. */
          dirty.current = true;
          setSaveState("error");
          setSaveError(message);
          if (!saveTimer.current) saveTimer.current = setTimeout(() => void flushRef.current(), Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** retries.current++));
          return false;
        }
        /* Refused (signed out, a draft the server will not take, a project that kept changing past every merge):
           never overwritten, never thrown away — the edits stay here, unsaved, it says so, and the next edit tries again. */
        dirty.current = true;
        setSaveState("error");
        setSaveError(message);
        return false;
      }
    });
    return chain.current;
  }, [scope, setDraft, toast]);
  useEffect(() => { flushRef.current = () => flush(); }, [flush]);

  /** `made`: the change builds records (shots from boards, inputs, a filed take) — noted as made, for the merge. */
  const write = useCallback((fn: (p: Project) => Project, publish: boolean, made = false) => {
    const current = draftRef.current;
    if (!current) return;
    const changed = fn(current.project);
    if (changed === current.project) return;
    /* A shot built from boards (or another record windows make alike) that this change took out is noted, for the merge. */
    const next = noteTakenOut(current.project, changed);
    if (made) recordMade(current.made, current.project, next);
    setDraft({ ...current, project: next });
    if (publish) publishRef.current?.(current.project, next);
    dirty.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [setDraft, flush]);
  const update = useCallback((fn: (p: Project) => Project) => write(fn, true), [write]);
  /** A build (lib/production/rig-build) or a filed take: what it made is noted, as made. */
  const make = useCallback((fn: (p: Project) => Project) => write(fn, true, true), [write]);
  /** A teammate's edit: into this draft, never sent back out. */
  const fold = useCallback((fn: (p: Project) => Project) => write(fn, false), [write]);

  /* Projects left with edits not saved yet (a save unconfirmed, or refused for now): saved on their own until they are. */
  const parked = useRef(new Map<string, Parked>());
  const park = useCallback((draft: Draft) => {
    const entry: Parked = { draft, stop: false, wake: () => {}, inflight: Promise.resolve(null) };
    parked.current.set(draft.project.id, entry);
    const name = draft.project.name || "the last project";
    void (async () => {
      for (let attempt = 0; !entry.stop; attempt++) {
        const step = writeMergedDraft(API, scope, { base: draft.base, mine: draft.project, revision: draft.revision, writer: draft.writer, ancestors: draft.ancestors, made: draft.made })
          .catch((err: unknown) => {
            if (!(err instanceof DraftRequestError && (err.retryable || err.uncertain))) {
              /* Kept as they are: opening the project again shows them, unsaved, with why. */
              entry.stop = true;
              toast(`Your latest edits to ${name} are not saved yet. Open it again to see them.`);
            }
            return null;
          });
        entry.inflight = step;
        if (await step) {
          if (parked.current.get(draft.project.id) === entry) parked.current.delete(draft.project.id);
          return;
        }
        if (entry.stop) return;
        await new Promise<void>((resolve) => {
          entry.wake = resolve;
          setTimeout(resolve, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** attempt));
        });
      }
    })();
  }, [scope, toast]);

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
        /* Edits to this project still being saved from when it was left: they are the draft again. */
        const back = parked.current.get(projectId);
        if (back) { back.stop = true; back.wake(); parked.current.delete(projectId); }
        const next = back ? back.draft : await load(projectId, controller.signal);
        if (controller.signal.aborted) return;
        /* Edits to the project being left that are not saved yet are never dropped: they keep being saved. */
        const leaving = draftRef.current;
        if (leaving && leaving.project.id !== projectId && dirty.current) park(leaving);
        dirty.current = !!back;
        retries.current = 0;
        setSaveState(back ? "saving" : "saved");
        setSaveError(null);
        setDraft(next);
        setStatus("ready");
        if (back) {
          /* The attempt still out for it ends first — it may land after anything sent now, over it. What it saved is
             the base from then on, with what was done since laid over it. */
          const shown = back.draft.project;
          chain.current = chain.current.catch(() => false).then(async () => {
            const saved = await back.inflight;
            const now = draftRef.current;
            if (!saved || !now || now.project.id !== shown.id) return true;
            const project = rebaseProject(shown, now.project, saved.project);
            setDraft({ ...now, project, base: saved.project, revision: saved.revision });
            if (project === saved.project || sameJson(project, saved.project)) { dirty.current = false; setSaveState("saved"); }
            return true;
          });
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => void flushRef.current(), SAVE_DEBOUNCE_MS);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "This project could not be loaded.");
      }
    })();
    return () => controller.abort();
  }, [projectId, load, flush, setDraft, park]);

  /* Back on the Rig after another page of this tab saved the draft (a Studio stage, Marketing): the Rig catches up
     with the saved version, its own edits laid over it, before anything is built from it — never its older copy
     until its next save. In turn with the saves, and never while a save's outcome is unknown. */
  const onRig = state.page === "rig";
  const wasOnRig = useRef(onRig);
  useEffect(() => {
    const came = onRig && !wasOnRig.current;
    wasOnRig.current = onRig;
    if (!came || !projectId) return;
    chain.current = chain.current.catch(() => false).then(async () => {
      const held = draftRef.current;
      if (!held || held.project.id !== projectId || held.writer.unconfirmed) return true;
      let data: { project?: Project | null; revision: number };
      try { data = await draftRequest(`${API}/projects?id=${encodeURIComponent(projectId)}`, scope); }
      catch { return true; }
      const now = draftRef.current;
      if (!data.project || !now || now.project.id !== projectId || !(data.revision > now.revision) || now.writer.unconfirmed) return true;
      const project = mergeDraft(now.base, now.project, data.project, { ancestors: now.ancestors, made: now.made });
      setDraft({ ...now, project, base: data.project, revision: data.revision });
      if (project !== now.project) catchUpRef.current?.(now.project, project);
      return true;
    });
  }, [onRig, projectId, scope, setDraft]);

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

  /* ── The production's team canvas (shared Rig nodes, live when Liveblocks is set up) ── */
  const readDraft = useCallback(() => draftRef.current?.project ?? null, []);
  const team = useTeamCanvas({ scope, productionId: project?.productionProjectId ?? null, current: readDraft, fold });
  useEffect(() => { publishRef.current = team.publish; catchUpRef.current = team.catchUp; teamFlushRef.current = team.flush; }, [team.publish, team.catchUp, team.flush]);

  /* ── Jobs (the Studio's own poller; it also files finished takes) ──── */
  const [run, setRun] = useState<Run | null>(null);
  const empty = useMemo(() => newProject(""), []);
  const jobsEnabled = !!project && (state.page === "rig" || run !== null);
  /* Takes the poller files are made from their job, the same in every window: noted as made. */
  const change = useCallback((fn: (p: Project) => Project) => make(fn), [make]);
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
    /* Compared with what the page actually holds, not only with what was sent last. */
    if (key === listed.current && state.lists.shots !== null && JSON.stringify(state.lists.shots.map((s) => ({ id: s.id, name: s.name, status: s.status }))) === JSON.stringify(items)) return;
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
  const live = useRef({ project, selected, selectedNode, refs, quote, blocked, model, run, mediaJobs });
  useEffect(() => { live.current = { project, selected, selectedNode, refs, quote, blocked, model, run, mediaJobs }; });
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
    let shot = now.selected, engine = now.model;
    const draftId = now.project.id;
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
          /* The shot as saved now: the save may have merged in another window's prompt or settings. The take is that
             shot — what the Rig shows — and the re-quote below prices it; a price that moved is asked again. */
          const node = current.nodes.find((n) => n.id === shot.id);
          const saved = rigShots(current, live.current.mediaJobs).find((s) => s.id === shot.id);
          if (!node || !saved) throw new Error("This shot is no longer in the project. Nothing was submitted.");
          const model = shotEngine(saved.engine);
          if (!model) throw new Error("Choose an available engine for this shot.");
          shot = saved;
          engine = model;
          const references = await resolveGenerationReferences(shotReferenceAssets(current, node), shotReferenceRole(node), {
            scope,
            onAsset: (id: string, fields: Partial<Asset>) => update((p) => ({ ...p, assets: p.assets.map((a) => (a.id === id ? { ...a, ...fields } : a)) })),
          });
          request = shotRequestInput(current, node, saved, mapping, references);
          if (!request) throw new Error("Choose an available engine for this shot.");
        }
        const outcome = await dispatchGeneration({
          scope,
          storageId,
          shown,
          /* A claimed attempt is replayed from storage; `input` is only read when there is none. */
          request: { endpoint: "/api/generate", input: request },
          onClaim: (credits) => setRun({ shotId: shot.id, name: shot.name, meta: [shot.name, engineLabel(engine.id).long, formatCredits(credits)].join(" · "), jobId: null, projectId: draftId }),
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
      setRun({ shotId: shot.id, name: shot.name, meta: [shot.name, engineLabel(engine.id).long, formatCredits(credits)].join(" · "), jobId, projectId: draftId });
      setRepriced(null);
      /* The node renders this kind now (GenerationDialog's onQueued does the same). */
      const kind = engine.kind;
      update((p) => ({ ...p, nodes: p.nodes.map((n) => (n.id === shot.id && !n.locked ? { ...n, mode: kind === "video" ? "Video" : "Image" } : n)) }));
      /* Takes and the Library show the take as rendering straight away. */
      void flush({ force: true }).then(() => { refreshJobs.current(); void refreshProjectLibrary(scope, draftId); });
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
        /* Takes and the Library may already be loaded; re-read so the take shows as it says. */
        void refreshProjectLibrary(scope, run.projectId);
      }
      if (holdTimer.current) clearTimeout(holdTimer.current);
      const id = run.jobId;
      holdTimer.current = setTimeout(() => setRun((r) => (r?.jobId === id ? null : r)), phase.tone === "green" ? DONE_HOLD_MS : FAILED_HOLD_MS);
    }
  }, [run, phase, runJob, dispatch, toast, scope]);
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
      make(() => next);
      if (pick && !("nodes" in out) && out.id) select(out.id);
      return null;
    } catch (err) {
      if (err instanceof RigBuildError || err instanceof ShotPatchError) return err.message;
      throw err;
    }
  }, [make, select]);
  const save = useCallback(() => flush({ force: true }), [flush]);
  const removeShot = useCallback((id: string): string | null => {
    const current = draftRef.current;
    if (!current) return "Open a project first.";
    let out: ReturnType<typeof removeShots>;
    try { out = removeShots(current.project, [id]); }
    catch (err) { if (err instanceof RigBuildError) return err.message; throw err; }
    const name = out.removed.removed.find((n) => n.id === id)?.title || "The shot";
    const draftId = current.project.id, draftName = current.project.name || "that project";
    update(() => out.project);
    if (state.selKind === "shot" && state.selId === id) dispatch({ type: "patch", patch: { selKind: "page", selId: null } });
    const sink = rigUndoSink();
    sink?.({
      label: `${name} is back in the Rig`,
      projectId: draftId,
      /* The shell's undo stack outlives a project switch: the shot only ever goes back into its own project,
         and only while the shell is on it (a project picked but still opening is not it any more). */
      undo: () => {
        const held = draftRef.current;
        if (shellProject.current !== draftId || held?.project.id !== draftId) throw new Error(`Open ${draftName} to bring ${name} back.`);
        /* What each shot was when it was taken out: if another window has it back since, its edits there stand. */
        for (const node of out.removed.removed) if (!held.project.nodes.some((n) => n.id === node.id)) held.ancestors.set(node.id, node);
        update((p) => restoreShots(p, out.removed));
      },
    });
    toast(`${name} deleted${sink ? " · ⌘Z brings it back" : ""}`);
    return null;
  }, [update, state.selKind, state.selId, dispatch, toast]);
  /* The shell's Delete (menu, ⌫) reaches the Rig through this slot while it is on screen. */
  useEffect(() => { setRigDeleteHandler(removeShot); return () => setRigDeleteHandler(null); }, [removeShot]);
  /* An asset sent from Astra or Edit ("Build a rig from this take") becomes a shot once the Rig is on
     screen with its project — every time one is sent, not only when the project first loads. */
  const [intents, setIntents] = useState(0);
  useEffect(() => {
    const waiting = () => setIntents((n) => n + 1);
    window.addEventListener(RIG_INTENT_EVENT, waiting);
    return () => window.removeEventListener(RIG_INTENT_EVENT, waiting);
  }, []);
  const openId = project?.id ?? null, onRigPage = state.page === "rig";
  useEffect(() => {
    if (!openId || !onRigPage) return;
    const asset = takeRigIntent(openId);
    if (!asset) return;
    const why = apply((p) => shotFromAsset(p, asset, shotEngines()[0].id), true);
    toast(why ?? `${asset.name} is a new shot in the Rig`);
  }, [openId, onRigPage, intents, apply, toast]);

  const teamView = useMemo(() => ({ mode: team.mode, peers: team.peers, presence: team.presence }), [team.mode, team.peers, team.presence]);
  const value = useMemo<RigContext>(() => ({
    status: projectId ? status : "idle", error, project, shots, jobs: mediaJobs, saveState, saveError, selected, selectedNode,
    select, patchShot, addShot, connect, quote, generate, blocked, notice, submitting, scope, planRequests, apply, save, removeShot, team: teamView,
  }), [projectId, status, error, project, shots, mediaJobs, saveState, saveError, selected, selectedNode, select, patchShot, addShot, connect, quote, generate, blocked, notice, submitting, scope, planRequests, apply, save, removeShot, teamView]);

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
