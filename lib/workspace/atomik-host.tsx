"use client";

/**
 * The Atomik host: one run engine per open project, bound to the shell.
 *
 * It builds the PlanContext from real project data (draft id, production id,
 * the page-provided request bodies, a workspace-scoped fetch), runs the
 * gated plan registry through the engine from #222, mirrors the engine's
 * run / completed / activity into the workspace state (so every surface and
 * the other tracks read one truth), and reads the ACTIVITY feeds.
 *
 * All run machinery stays on the engine instance; nothing here runs inside
 * a state updater.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Project } from "../workbench/studio";
import { loadActivity, mergeActivity } from "./activity";
import { projectChanged } from "./data";
import { priceText } from "./atomik-view";
import { stableKey } from "./plan-helpers";
import { mergeRequests, projectRequests, withRequestGate, type RequestKey } from "./plan-requests";
import type { PlanSource, PlanSummary } from "./plan-source";
import type { Plan, PlanContext, PlanRequest, Runnable } from "./plan-types";
import { PLANS, planFor } from "./plans";
import { AtomikRunEngine, formatCredits, type ActivityEntry, type EngineState, type RunView } from "./run-engine";
import { useWorkspace } from "./state";
import type { PageId, Run } from "./types";

/* ── The plan-source bridge ─────────────────────────────────────────────
   WorkspaceProvider takes a PlanSource before any project is loaded; the
   host fills it once the engine exists, so `useWorkspace().plans(page)`
   answers with the live plan everywhere. */

export class PlanBridge {
  private current: PlanSource | null = null;
  /** Stable identity: WorkspaceProvider keeps this for the life of the page. */
  readonly source: PlanSource = (page) => (this.current ? this.current(page) : null);
  attach(source: PlanSource) {
    this.current = source;
  }
  detach(source: PlanSource) {
    if (this.current === source) this.current = null;
  }
}

export function createPlanBridge(): PlanBridge {
  return new PlanBridge();
}

/** The request keys something currently provides; read by the plans' runnable check at start time. */
class ProvidedKeys {
  private keys: ReadonlySet<RequestKey> = new Set();
  set(keys: ReadonlySet<RequestKey>) {
    this.keys = keys;
  }
  get = (): ReadonlySet<RequestKey> => this.keys;
}

/* ── Context ───────────────────────────────────────────────────────────── */

export type AtomikHostValue = {
  state: EngineState;
  /** The context every plan step reads (also used for step details). */
  ctx: PlanContext;
  /** The gated plan for a page (the registry's, plus the request check). */
  plan: (page: string) => Plan | null;
  runnable: (page: string) => Runnable;
  /** The run shown on `page` (the engine runs one plan at a time). */
  runFor: (page: string) => RunView | null;
  /** Open the panel and start / pause / resume the page's plan. */
  start: (page?: string) => void;
  approve: () => Promise<void>;
  decline: () => void;
  /** Clear a refusal once it has been read (the engine also clears it on a page change). */
  dismissNotice: () => void;
  activity: ActivityEntry[];
  rendering: { name: string } | null;
  /** A page body publishes its current request (usePlanRequest). */
  publish: (key: RequestKey, value: unknown) => void;
};

const AtomikContext = createContext<AtomikHostValue | null>(null);

export function useAtomik(): AtomikHostValue {
  const value = useContext(AtomikContext);
  if (!value) throw new Error("useAtomik must be used inside <AtomikHost>.");
  return value;
}

/**
 * For page bodies: publish what the page's own form holds, in the exact
 * shape the existing route takes (see PlanRequest). Withdrawn on unmount.
 * Pass `undefined` while the page cannot build a body yet.
 */
export function usePlanRequest<K extends RequestKey>(key: K, value: PlanRequest[K] | undefined) {
  const host = useContext(AtomikContext);
  const publish = host?.publish;
  /* A new value replaces the old one in place (publish ignores an equal one). Withdrawing on
     every change would make two state updates per render, and a caller that builds its value
     afresh on each render would then re-render the host, and itself, without end. */
  useEffect(() => {
    if (publish) publish(key, value);
  }, [publish, key, value]);
  useEffect(() => {
    if (!publish) return;
    return () => publish(key, undefined);
  }, [publish, key]);
}

const ACTIVITY_POLL_MS = 20_000;

function mirrorRun(run: RunView | null): Run | null {
  if (!run) return null;
  return { page: run.page as PageId, i: run.i, status: run.status, approved: run.approved };
}

export function AtomikHost({
  scope,
  project,
  bridge,
  children,
}: {
  scope: string;
  project: Project | null;
  bridge?: PlanBridge;
  children: ReactNode;
}) {
  const { state: ws, dispatch, toast } = useWorkspace();
  const projectId = ws.projectId;
  const productionId = project && project.id === projectId ? project.productionProjectId ?? null : null;

  /* A workspace-scoped fetch: the workbench routes resolve the owner from this header. */
  const fetcher = useMemo<typeof fetch>(
    () => (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("X-Workbench-Scope", scope);
      return fetch(input, { ...init, headers });
    },
    [scope],
  );

  /* Requests: project-derived, then page-published over them. */
  const [derived, setDerived] = useState<{ request: PlanRequest; provided: RequestKey[] }>({ request: {}, provided: [] });
  useEffect(() => {
    let live = true;
    void projectRequests(project && project.id === projectId ? project : null).then((next) => {
      if (live) setDerived(next);
    });
    return () => {
      live = false;
    };
  }, [project, projectId]);
  const [published, setPublished] = useState<Partial<Record<RequestKey, unknown>>>({});
  const publish = useCallback((key: RequestKey, value: unknown) => {
    setPublished((prev) => {
      if (stableKey(prev[key]) === stableKey(value)) return prev;
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);
  const request = useMemo(() => mergeRequests(derived.request, published), [derived.request, published]);
  const provided = useMemo(
    () => new Set<RequestKey>([...derived.provided, ...(Object.keys(published) as RequestKey[])]),
    [derived.provided, published],
  );
  const [providedKeys] = useState(() => new ProvidedKeys());
  useEffect(() => {
    providedKeys.set(provided);
  }, [providedKeys, provided]);

  const ctx = useMemo<PlanContext>(
    () => ({
      projectId,
      productionId,
      request,
      fetch: fetcher,
      data: {
        projectName: project?.name ?? null,
        hasScript: Boolean(project?.script?.trim()),
        ...(ws.lists.shots ? { shots: ws.lists.shots.map((s) => ({ id: s.id, name: s.name, status: s.status ?? "draft" })) } : {}),
        ...(ws.lists.takes ? { takes: ws.lists.takes.length } : {}),
      },
    }),
    [projectId, productionId, request, fetcher, project?.name, project?.script, ws.lists.shots, ws.lists.takes],
  );

  const plans = useMemo(() => withRequestGate(PLANS, providedKeys.get), [providedKeys]);
  /* One engine per project: a run never outlives its project into another one's context. */
  const engine = useMemo(
    () => new AtomikRunEngine({ plans, context: () => ({ projectId: null, data: {}, fetch: fetcher }) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new project gets a new engine; the context follows below
    [plans, projectId],
  );
  useEffect(() => {
    engine.setContext(() => ctx);
  }, [engine, ctx]);
  const state = useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);

  /* One truth: surfaces and other tracks read the run from the workspace state. */
  useEffect(() => {
    dispatch({ type: "patch", patch: { run: mirrorRun(state.run), completed: state.completed as Record<PageId, true> } });
  }, [dispatch, state.run, state.completed]);

  /* Engine toasts (decline, completion) go through the shell's toast. */
  useEffect(() => {
    if (!state.toast) return;
    toast(state.toast);
    engine.clearToast();
  }, [state.toast, toast, engine]);

  /* A refusal belongs to the page it was made on. */
  useEffect(() => {
    engine.clearNotice();
  }, [engine, ws.page]);

  /* ACTIVITY: the real feeds, merged with this session's completed runs. */
  const [feed, setFeed] = useState<{ entries: ActivityEntry[][]; rendering: { name: string } | null; at: number }>({ entries: [], rendering: null, at: 0 });
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    const read = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const at = Date.now();
      void loadActivity(fetcher, { projectId, productionId }, at).then((loaded) => {
        if (live) setFeed({ entries: loaded.entries, rendering: loaded.rendering, at });
      });
    };
    read();
    const timer = setInterval(read, ACTIVITY_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [fetcher, projectId, productionId, state.session.length]);
  /* Ages are measured at the last read; a session line newer than it reads "just now". */
  const activity = useMemo(() => mergeActivity(state.session, feed.entries, feed.at), [state.session, feed]);
  useEffect(() => {
    dispatch({ type: "patch", patch: { activity: activity.map(({ label, meta }) => ({ label, meta })) } });
  }, [activity, dispatch]);

  const plan = useCallback((page: string) => {
    const base = planFor(page);
    return base ? plans[base.page] ?? null : null;
  }, [plans]);
  const runnable = useCallback((page: string): Runnable => {
    const item = plan(page);
    return item ? item.runnable(ctx) : { ok: false, reason: "Nothing to run on this page." };
  }, [plan, ctx]);
  const runFor = useCallback((page: string) => {
    const item = plan(page);
    return item && state.run && state.run.page === item.page ? state.run : null;
  }, [plan, state.run]);

  const start = useCallback((page?: string) => {
    dispatch({ type: "patch", patch: { agentOpen: true } });
    engine.start(page ?? ws.page);
  }, [dispatch, engine, ws.page]);
  const approve = useCallback(async () => {
    await engine.approve();
  }, [engine]);
  const decline = useCallback(() => {
    engine.decline();
  }, [engine]);
  const dismissNotice = useCallback(() => {
    engine.clearNotice();
  }, [engine]);

  /* A finished run may have written the draft (a script, beats, a plan): the shell's copy re-reads it. */
  const finished = state.run?.status === "done" ? state.run.id : null;
  useEffect(() => {
    if (finished) projectChanged(projectId);
  }, [finished, projectId]);

  /* The live PlanSource other surfaces read through useWorkspace().plans. */
  useEffect(() => {
    if (!bridge) return;
    const source: PlanSource = (page): PlanSummary | null => {
      const item = plan(page);
      if (!item) return null;
      const run = state.run && state.run.page === item.page ? state.run : null;
      return {
        title: item.title,
        price: priceText(item, run),
        gatePrice: run?.quote ? formatCredits(run.quote.credits, run.quote.unit) : null,
        steps: item.steps.map((s) => s.label),
        runnable: item.runnable(ctx).ok,
      };
    };
    bridge.attach(source);
    return () => bridge.detach(source);
  }, [bridge, plan, state.run, ctx]);

  const value = useMemo<AtomikHostValue>(
    () => ({ state, ctx, plan, runnable, runFor, start, approve, decline, dismissNotice, activity, rendering: feed.rendering, publish }),
    [state, ctx, plan, runnable, runFor, start, approve, decline, dismissNotice, activity, feed.rendering, publish],
  );
  return <AtomikContext.Provider value={value}>{children}</AtomikContext.Provider>;
}
