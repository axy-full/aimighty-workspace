"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "@/lib/workspace/state";
import { isCrewPage, pageOfLegacy, restorePage, shellSuite, suiteOfLegacy, type CrewPageId, type ShellPage, type ShellSuite, type ShellSuiteId, type ShellView, type WorkspaceTabId, WORKSPACE_TABS } from "./ia";
import { popUndo, pushUndo, type UndoEntry } from "./undo";
import { findRequested, withoutFind } from "./fault";
import type { CtxCommand, CtxTarget } from "./context-menu";

/**
 * The Suites shell's own state (README › State), layered over the workspace
 * state layer rather than beside it: suite, page, project, selection and lists
 * stay in lib/workspace/state.tsx — the shell adds what is new (the Gen and
 * Workspace views, each suite's remembered page, the Library tab and the
 * overlay panels, the palette, the context menu, the clipboard and undo).
 *
 * The shell owns three search params at its route — `view`, `tab`, `sp` — and
 * the workspace provider carries them across its own URL writes.
 */
export const SUITES_PATH = "/suites";
export const SHELL_PARAMS = ["view", "tab", "sp", "cp", "room"] as const;
/** Three columns from here up; overlays below (README › Responsive). */
export const WIDE_FROM = 1280;

export type LibTab = "tools" | "assets";
export type Clip = { mode: "copy" | "cut"; target: Exclude<CtxTarget, { kind: "empty" }>; name: string; /** What the paste needs to know about it (lib/shell/use-asset-actions). */ payload?: unknown };
export type CtxState = { x: number; y: number; target: CtxTarget; title: string };

type Shell = {
  view: ShellView;
  suite: ShellSuite;
  page: ShellPage;
  wsTab: WorkspaceTabId;
  crewPage: CrewPageId;
  wide: boolean;
  libTab: LibTab;
  /** Below 1280 the panels are overlays, one at a time. */
  libOpen: boolean;
  inspOpen: boolean;
  /** At 1280 and up the Inspector is a column that ⌘J shows and hides. */
  inspector: boolean;
  palette: boolean;
  ctx: CtxState | null;
  clip: Clip | null;
  canUndo: boolean;
  goSuite: (suite: ShellSuiteId, page?: string) => void;
  goGen: () => void;
  goCrew: (page?: CrewPageId) => void;
  goWorkspace: (tab?: WorkspaceTabId) => void;
  setLibTab: (tab: LibTab) => void;
  toggleLibrary: () => void;
  toggleInspector: () => void;
  openLibrary: (tab?: LibTab) => void;
  openInspector: () => void;
  closePanels: () => void;
  setPalette: (open: boolean) => void;
  openCtx: (ctx: CtxState) => void;
  closeCtx: () => void;
  setClip: (clip: Clip | null) => void;
  pushUndo: (entry: UndoEntry) => void;
  /** The shell's command path (SuitesShell registers it), so panels never grow a second one. */
  runCommand: ((command: CtxCommand, target: CtxTarget) => void) | null;
  setRunCommand: (run: ((command: CtxCommand, target: CtxTarget) => void) | null) => void;
  undo: () => Promise<void>;
};

const ShellContext = createContext<Shell | null>(null);
export function useShell(): Shell {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <ShellProvider>.");
  return value;
}

type Params = { view: ShellView; tab: WorkspaceTabId; sp: string | null; cp: CrewPageId };
function readParams(search: string): Params {
  const q = new URLSearchParams(search);
  const view = q.get("view");
  const tab = q.get("tab");
  return {
    view: view === "gen" || view === "workspace" || view === "crew" ? view : "suite",
    tab: WORKSPACE_TABS.some((t) => t.id === tab) ? (tab as WorkspaceTabId) : "general",
    sp: q.get("sp"),
    cp: isCrewPage(q.get("cp")) ? (q.get("cp") as CrewPageId) : "room",
  };
}
function writeParams(params: Params, mode: "push" | "replace") {
  const q = new URLSearchParams(window.location.search);
  if (params.view === "suite") q.delete("view"); else q.set("view", params.view);
  if (params.view === "workspace") q.set("tab", params.tab); else q.delete("tab");
  if (params.sp) q.set("sp", params.sp); else q.delete("sp");
  if (params.view === "crew") q.set("cp", params.cp); else q.delete("cp");
  const text = q.toString();
  const url = window.location.pathname + (text ? "?" + text : "") + window.location.hash;
  if (url === window.location.pathname + window.location.search + window.location.hash) return;
  if (mode === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const [params, setParams] = useState<Params>(() => readParams(typeof window === "undefined" ? "" : window.location.search));
  const [memory, setMemory] = useState<Partial<Record<ShellSuiteId, string>>>({});
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= WIDE_FROM));
  const [libTab, setLibTab] = useState<LibTab>("tools");
  const [libOpen, setLibOpen] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  /* `?find=1` (the 404's and the error page's Search) lands with ⌘K open. */
  const [palette, setPaletteOpen] = useState(() => typeof window !== "undefined" && findRequested(window.location.search));
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const runRef = useRef<((command: CtxCommand, target: CtxTarget) => void) | null>(null);
  const undoRef = useRef(undoStack);
  useEffect(() => { undoRef.current = undoStack; }, [undoStack]);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE_FROM);
    const onPop = () => setParams(readParams(window.location.search));
    window.addEventListener("resize", onResize);
    window.addEventListener("popstate", onPop);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("popstate", onPop); };
  }, []);

  const suiteId = suiteOfLegacy(ws.state.suite);
  const suite = shellSuite(suiteId);
  const mapped = pageOfLegacy(ws.state.suite, ws.state.page, params.sp ?? memory[suiteId]);
  const page = mapped ?? suite.pages[0];

  const apply = useCallback((next: Params, mode: "push" | "replace") => { setParams(next); writeParams(next, mode); }, []);

  const goSuite = useCallback((id: ShellSuiteId, pageId?: string) => {
    const target = pageId ? restorePage(id, pageId) : restorePage(id, memory[id]);
    setMemory((m) => ({ ...m, [id]: target.id }));
    setLibOpen(false); setInspOpen(false); setPaletteOpen(false); setCtx(null);
    const before = window.location.pathname + window.location.search;
    ws.go(target.legacy.suite, target.legacy.page);
    const pushed = before !== window.location.pathname + window.location.search;
    /* The state layer pushed the entry when its own page changed; when two shell
       pages share one backing page it did not, and the shell pushes instead. */
    apply({ view: "suite", tab: "general", sp: target.id, cp: "room" }, pushed ? "replace" : "push");
  }, [ws, memory, apply]);

  /* A page the new IA has no tab for (an old deep link) opens its suite's first page. */
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    if (ws.state.view !== "studio" || !mapped) {
      const target = mapped ?? suite.pages[0];
      ws.go(target.legacy.suite, target.legacy.page);
      writeParams({ ...params, sp: target.id }, "replace");
    }
    /* One shot: a reload of this URL should not reopen search. */
    if (findRequested(window.location.search)) window.history.replaceState(null, "", window.location.pathname + withoutFind(window.location.search) + window.location.hash);
    // Run once, against the URL the page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<Shell>(() => ({
    /* Gen is not a stage and has no tools of its own: there the Library is
       what you can drag in, however you arrived (tab, palette or a link). */
    view: params.view, suite, page, wsTab: params.tab, crewPage: params.cp, wide, libTab: params.view === "gen" ? "assets" : libTab, libOpen, inspOpen,
    inspector: ws.state.inspector, palette, ctx, clip, canUndo: undoStack.length > 0,
    goSuite,
    goGen: () => { setLibOpen(false); setInspOpen(false); setPaletteOpen(false); apply({ ...params, view: "gen" }, "push"); },
    goCrew: (page) => { setLibOpen(false); setInspOpen(false); setPaletteOpen(false); apply({ ...params, view: "crew", cp: page ?? params.cp }, "push"); },
    goWorkspace: (tab) => { setLibOpen(false); setInspOpen(false); setPaletteOpen(false); apply({ ...params, view: "workspace", tab: tab ?? params.tab }, "push"); },
    setLibTab,
    toggleLibrary: () => { setLibOpen((v) => !v); setInspOpen(false); },
    toggleInspector: () => {
      if (window.innerWidth >= WIDE_FROM) ws.dispatch({ type: "toggleInspector" });
      else { setInspOpen((v) => !v); setLibOpen(false); }
    },
    openLibrary: (tab) => { if (tab) setLibTab(tab); if (window.innerWidth < WIDE_FROM) { setLibOpen(true); setInspOpen(false); } },
    openInspector: () => {
      if (window.innerWidth >= WIDE_FROM) { if (!ws.state.inspector) ws.dispatch({ type: "toggleInspector" }); }
      else { setInspOpen(true); setLibOpen(false); }
    },
    closePanels: () => { setLibOpen(false); setInspOpen(false); },
    setPalette: (open) => { setPaletteOpen(open); if (open) setCtx(null); },
    openCtx: (next) => setCtx(next),
    closeCtx: () => setCtx(null),
    setClip,
    pushUndo: (entry) => setUndoStack((stack) => pushUndo(stack, entry)),
    runCommand: (command, target) => runRef.current?.(command, target),
    setRunCommand: (run) => { runRef.current = run; },
    undo: async () => {
      const popped = popUndo(undoRef.current);
      if (!popped) { ws.toast("Nothing to undo."); return; }
      setUndoStack(popped.rest);
      await popped.entry.undo();
      ws.toast(popped.entry.label);
    },
  }), [params, suite, page, wide, libTab, libOpen, inspOpen, palette, ctx, clip, undoStack.length, goSuite, apply, ws]);

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
