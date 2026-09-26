"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  INITIAL_STATE,
  applyUrl,
  fromSearch,
  go as navigate,
  goHome,
  switchSuite,
  toSearch,
  withLibFilter,
  withLists,
  WORKSPACE_PATH,
  type UrlState,
} from "./navigation";
import { mobileBack, withLevel } from "./mobile";
import { NO_PLANS, type PlanSource } from "./plan-source";
import type { AppState, LibFilter, MobileLevel, MobileSheetId, SelectableLists, Suite } from "./types";

export type Action =
  | { type: "replace"; state: AppState }
  | { type: "url"; url: UrlState }
  | { type: "patch"; patch: Partial<Omit<AppState, "lists" | "libFilter">> }
  | { type: "lists"; lists: Partial<SelectableLists> }
  | { type: "libFilter"; libFilter: LibFilter }
  | { type: "toggleInspector" }
  | { type: "toast"; text: string };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "replace":
      return action.state;
    case "url":
      return applyUrl(state, action.url);
    case "patch":
      return { ...state, ...action.patch };
    case "lists":
      return withLists(state, action.lists);
    case "libFilter":
      return withLibFilter(state, action.libFilter);
    case "toggleInspector":
      return { ...state, inspector: !state.inspector };
    case "toast":
      return { ...state, toast: action.text };
  }
}

type Workspace = {
  state: AppState;
  dispatch: (action: Action) => void;
  /** The single navigation entry point: repairs selection and pushes the URL. */
  go: (suite: Suite, page: string) => void;
  home: (suite?: Suite) => void;
  switchSuite: (suite: Suite) => void;
  selectProject: (projectId: string, opts?: { replace?: boolean }) => void;
  /** Choose a project and enter a page in one history entry. */
  openProject: (projectId: string, suite: Suite, page: string) => void;
  setLibFilter: (filter: LibFilter) => void;
  /** Phone: move to a drill-down level (Projects / Suite / Make / Settings). */
  setLevel: (level: MobileLevel) => void;
  /** Phone: the back chevron — one level up. */
  back: () => void;
  /** Phone: open a bottom sheet, close it, or toggle the one the dock owns. */
  setSheet: (sheet: MobileSheetId | null) => void;
  /** Replaces the URL (no new history entry), e.g. after a selection repair. */
  syncUrl: () => void;
  /** A confirmation; with an action it carries one button (an Open to where the result is) and stays longer. */
  toast: (text: string, action?: ToastAction) => void;
  /** The action of the toast on screen, for the text it was given with. */
  toastAction: { text: string; action: ToastAction } | null;
  /** Hovering or focusing an actionable toast holds it on screen; leaving lets it go. */
  holdToast: (hold: boolean) => void;
  plans: PlanSource;
};

export type ToastAction = { label: string; run: () => void };
const TOAST_MS = 2600;
const ACTION_TOAST_MS = 6000;

const NO_KEEP: readonly string[] = [];
const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>.");
  return value;
}

/**
 * Where this provider writes the URL. The Suites shell mounts the same state
 * layer at its own path and owns a few search params of its own (`keep`),
 * which a navigation here must carry across rather than drop.
 */
type UrlTarget = { path: string; keep: readonly string[] };
const DEFAULT_TARGET: UrlTarget = { path: WORKSPACE_PATH, keep: [] };

function writeUrl(state: AppState, mode: "push" | "replace", target: UrlTarget = DEFAULT_TARGET) {
  if (typeof window === "undefined") return;
  let search = toSearch(state);
  if (target.keep.length) {
    const next = new URLSearchParams(search);
    const current = new URLSearchParams(window.location.search);
    for (const key of target.keep) { const v = current.get(key); if (v != null) next.set(key, v); }
    const text = next.toString();
    search = text ? "?" + text : "";
  }
  if (window.location.pathname === target.path && window.location.search === search) return;
  const url = target.path + search + window.location.hash;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

export function WorkspaceProvider({
  children,
  initialSearch,
  plans = NO_PLANS,
  path = WORKSPACE_PATH,
  keep = NO_KEEP,
}: {
  children: ReactNode;
  /** The search string the page was opened with. */
  initialSearch: string;
  plans?: PlanSource;
  /** The route this provider lives at; /workspace unless the Suites shell says otherwise. */
  path?: string;
  /** Search params another layer owns at that route; carried across every URL write. */
  keep?: readonly string[];
}) {
  const target = useMemo<UrlTarget>(() => ({ path, keep }), [path, keep]);
  const [state, rawDispatch] = useReducer(reducer, initialSearch, (search) => applyUrl(INITIAL_STATE, fromSearch(search)));
  /* The latest state, always ahead of or equal to the rendered one: commit and
     dispatch set it before React renders. It is never copied back from `state`
     in an effect — a child's effect that dispatches runs before this
     provider's effects in the same commit, so copying the rendered state back
     would roll that newer state back (a Rig list arriving then being undone). */
  const ref = useRef(state);

  /* Every transition that changes the URL computes its next state from the
     latest one, writes it, and then dispatches — so the URL and the state
     cannot disagree. */
  const commit = useCallback((next: AppState, mode: "push" | "replace") => {
    ref.current = next;
    rawDispatch({ type: "replace", state: next });
    writeUrl(next, mode, target);
  }, [target]);

  const dispatch = useCallback((action: Action) => {
    const next = reducer(ref.current, action);
    ref.current = next;
    rawDispatch({ type: "replace", state: next });
    /* A list arriving or a filter changing can repair the selection; the
       URL follows without adding a history entry. */
    if (action.type === "lists" || action.type === "libFilter") writeUrl(next, "replace", target);
  }, [target]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toastAction, setToastAction] = useState<{ text: string; action: ToastAction } | null>(null);
  const clearToast = useCallback(() => { dispatch({ type: "toast", text: "" }); setToastAction(null); }, [dispatch]);
  const toast = useCallback((text: string, action?: ToastAction) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const open = action && typeof action.label === "string" && typeof action.run === "function" ? action : null;
    dispatch({ type: "toast", text });
    setToastAction(open && text ? { text, action: { label: open.label, run: () => { clearToast(); open.run(); } } } : null);
    toastTimer.current = setTimeout(clearToast, open ? ACTION_TOAST_MS : TOAST_MS);
  }, [dispatch, clearToast]);
  const holdToast = useCallback((hold: boolean) => {
    if (!ref.current.toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = hold ? null : setTimeout(clearToast, TOAST_MS);
  }, [clearToast]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  /* Canonicalise the opening URL (aliases, a page implying its suite), then
     follow the back and forward buttons. */
  useEffect(() => {
    writeUrl(ref.current, "replace", target);
    const onPop = () => {
      const next = applyUrl(ref.current, fromSearch(window.location.search));
      ref.current = next;
      rawDispatch({ type: "replace", state: next });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [target]);

  const value = useMemo<Workspace>(() => ({
    state,
    dispatch,
    go: (suite, page) => commit(navigate(ref.current, suite, page), "push"),
    home: (suite) => commit(goHome(ref.current, suite), "push"),
    switchSuite: (suite) => commit(switchSuite(ref.current, suite), "push"),
    selectProject: (projectId, opts) => {
      if (ref.current.projectId === projectId) return;
      /* A different project brings different lists; selection waits for them. */
      commit({ ...ref.current, projectId, lists: { shots: null, takes: null, cast: null }, selId: null }, opts?.replace ? "replace" : "push");
    },
    openProject: (projectId, suite, page) => {
      const base = ref.current.projectId === projectId
        ? ref.current
        : { ...ref.current, projectId, lists: { shots: null, takes: null, cast: null }, selId: null };
      commit(navigate(base, suite, page), "push");
    },
    setLibFilter: (libFilter) => dispatch({ type: "libFilter", libFilter }),
    /* A level is a place, so it gets a history entry; a sheet is not, so it
       does not touch the URL at all. */
    setLevel: (level) => commit(withLevel(ref.current, level), "push"),
    back: () => commit(mobileBack(ref.current), "push"),
    setSheet: (sheet) => dispatch({ type: "patch", patch: { sheet } }),
    syncUrl: () => writeUrl(ref.current, "replace", target),
    toast,
    toastAction,
    holdToast,
    plans,
  }), [state, dispatch, commit, toast, toastAction, holdToast, plans, target]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
