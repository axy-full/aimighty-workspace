"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "@/lib/workspace/state";
import { firstShellPage, isCrewPage, pageAlias, pageOfLegacy, redirectFor, restorePage, shellPage, shellSuite, suiteOfLegacy, type CrewPageId, type ShellPage, type ShellSuite, type ShellSuiteId, type ShellView, type WorkspaceTabId, WORKSPACE_TABS } from "./ia";
import { canUndo, popUndo, pushUndo, undoneLabel, type UndoEntry } from "./undo";
import { libraryHasTools } from "./production-tools";
import { findRequested, withoutFind } from "./fault";
import type { CtxCommand, CtxTarget } from "./context-menu";
import { useSession } from "@/lib/session";
import { projectChanged } from "@/lib/workspace/data";
import { pageKind } from "@/lib/workspace/pages";
import { validAssetId } from "@/lib/preview";
import { ASSET_PARAM, LINK_PARAMS, assetParam, readAssetLink, selectHistory, withAsset, withoutLink, type AssetLink, type SelectReason } from "./asset-link";
import { useConnectedCollector } from "./use-connected-collector";
import { IMPORT_PARAM } from "@/lib/workspace/rig-import";
import { CARRIED_PARAMS } from "@/lib/workspace/navigation";
import type { ComposerType } from "@/lib/workspace/composer";
import { MAKE_PARAM, fromMakeLink, isMakeTool, makeType, readMake, viralTool, type MakeTab } from "./make";
import { sendGenPreset } from "./gen-preset";
import type { GenPreset } from "./recipe";

/**
 * The Suites shell's own state (README › State), layered over the workspace
 * state layer rather than beside it: suite, page, project, selection and lists
 * stay in lib/workspace/state.tsx — the shell adds what is new (the Workspace
 * and Crew views, the Make panel over any of them, each suite's remembered
 * page, the Library tab and the overlay panels, the palette, the context menu,
 * the clipboard and undo).
 *
 * The shell owns its search params at its route — `view`, `tab`, `sp`, `cp`,
 * `make` (the Make panel and its quick tools, lib/shell/make.ts),
 * `room`, the selected take (`asset`), a link's own `ws` and `production`
 * (lib/shell/asset-link.ts), and an old board the Rig is bringing across
 * (`import`, lib/workspace/rig-import.ts) — and the workspace provider carries
 * them across its own URL writes.
 */
export const SUITES_PATH = "/suites";
/* …and an old link's `account` (lib/workspace/navigation.ts › CARRIED_PARAMS), which nothing here reads but the address keeps. */
export const SHELL_PARAMS = ["view", "tab", "sp", "cp", "room", MAKE_PARAM, ASSET_PARAM, ...LINK_PARAMS, IMPORT_PARAM, ...CARRIED_PARAMS] as const;
/** Three columns from here up; overlays below (README › Responsive). */
export const WIDE_FROM = 1280;

export type LibTab = "tools" | "assets";
export type Clip = { mode: "copy" | "cut"; target: Exclude<CtxTarget, { kind: "empty" }>; name: string; /** What the paste needs to know about it (lib/shell/use-asset-actions). */ payload?: unknown };
export type CtxState = { x: number; y: number; target: CtxTarget; title: string };

export type Shell = {
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
  /** `closeMake`: the page is where the person is going from Make (Viral History from a quick tool), so Make closes. */
  goSuite: (suite: ShellSuiteId, page?: string, opts?: { closeMake?: boolean }) => void;
  /** The header's project segment: the Studio page last shown (never the overview or the phone's Home), else Brief. */
  goProject: () => void;
  /** Make's panel as the address carries it (`make=`): its type, Recent or a quick tool, or null while it is closed. */
  make: MakeTab | null;
  /** The type Make opened on last (`make=1`, and an Open with no type). */
  lastMake: ComposerType;
  /**
   * Opens Make over whatever is on screen: on a type, on Recent, on a quick tool (Motion transfer, Object swap), or
   * with a preset handed over (its type, when it names one; the words, engine and settings go through Gen's letterbox,
   * lib/shell/gen-preset.ts). With nothing, where it is (a quick tool stays one), else on the last type.
   */
  openMake: (preset?: MakeTab | GenPreset) => void;
  closeMake: () => void;
  /** Make's own tab or type changed inside the panel: the address follows, in the same history entry. */
  setMake: (tab: MakeTab) => void;
  /** Gen is Make's panel now: kept for the header, which calls it until it calls openMake. It opens Make. */
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
  /** Records an inverse. With `say`, the shell toasts it with an Undo (a phone has no ⌘Z), shown while this step is the one ⌘Z would undo. */
  pushUndo: (entry: UndoEntry, say?: string) => void;
  /** The shell's command path (SuitesShell registers it), so panels never grow a second one. */
  runCommand: ((command: CtxCommand, target: CtxTarget) => void) | null;
  setRunCommand: (run: ((command: CtxCommand, target: CtxTarget) => void) | null) => void;
  undo: () => Promise<void>;
  /** The shell as it is now, for work that finishes after the component that started it has gone (a toast's Open). */
  live: () => Shell;
  /** The selected take as the address bar carries it (`asset`), or null. */
  asset: string | null;
  /**
   * The one way a surface selects a take (the Takes desk, the viewer's arrows, a link): the Workspace
   * selection and the URL (`asset`, `sel`) move together; `reason` decides whether it is a history entry
   * (lib/shell/asset-link.ts › selectHistory). It never opens the phone's Inspector. `ifCurrent` clears
   * or replaces only while that take is still the selected one; a malformed id is refused.
   */
  selectAsset: (id: string | null, opts?: { reason?: SelectReason; ifCurrent?: string }) => void;
  /** The link the page was opened with (a take, and where it belongs), until it resolves or is dismissed. */
  link: AssetLink | null;
  /** The link has resolved (its own params leave the address bar) or was dismissed (`drop`: the take leaves too). */
  endLink: (drop: boolean) => void;
};

const ShellContext = createContext<Shell | null>(null);
export function useShell(): Shell {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <ShellProvider>.");
  return value;
}

type Params = { view: ShellView; tab: WorkspaceTabId; sp: string | null; cp: CrewPageId; make: MakeTab | null; asset: string | null };
/** The old Gen page (`view=gen`) and Viral's two tools read as Make open over a page (lib/shell/make.ts › fromMakeLink). */
function readParams(search: string, last: ComposerType = "video"): Params {
  const q = new URLSearchParams(fromMakeLink(search) ?? search);
  const view = q.get("view");
  const tab = q.get("tab");
  const make = readMake(q);
  return {
    view: view === "workspace" || view === "crew" ? view : "suite",
    tab: WORKSPACE_TABS.some((t) => t.id === tab) ? (tab as WorkspaceTabId) : "general",
    sp: q.get("sp"),
    cp: isCrewPage(q.get("cp")) ? (q.get("cp") as CrewPageId) : "room",
    make: make === "last" ? last : make,
    asset: assetParam(q),
  };
}
function writeParams(params: Params, mode: "push" | "replace") {
  const q = new URLSearchParams(window.location.search);
  if (params.view === "suite") q.delete("view"); else q.set("view", params.view);
  if (params.view === "workspace") q.set("tab", params.tab); else q.delete("tab");
  if (params.sp) q.set("sp", params.sp); else q.delete("sp");
  if (params.view === "crew") q.set("cp", params.cp); else q.delete("cp");
  if (params.make) q.set(MAKE_PARAM, params.make); else q.delete(MAKE_PARAM);
  const asset = validAssetId(params.asset);
  if (asset) q.set(ASSET_PARAM, asset); else q.delete(ASSET_PARAM);
  const text = q.toString();
  const url = window.location.pathname + (text ? "?" + text : "") + window.location.hash;
  if (url === window.location.pathname + window.location.search + window.location.hash) return;
  if (mode === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
}
/** Rewrite (or add) the entry with only the search changed — only while the address bar is the shell's (a navigation away may already have moved it). */
function writeSearch(search: string, mode: "push" | "replace") {
  if (window.location.pathname !== SUITES_PATH) return;
  const url = window.location.pathname + search + window.location.hash;
  if (url === window.location.pathname + window.location.search + window.location.hash) return;
  if (mode === "push") window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
}

/** Make over a page someone moves to: kept, except on a phone, where the panel is the whole screen. */
const stayMake = (make: MakeTab | null) => (make && typeof window !== "undefined" && window.innerWidth < PHONE_BELOW ? null : make);
/** Below this, Make is full width (components/graphite/make.css). */
export const PHONE_BELOW = 768;

export function ShellProvider({ children, initialSearch }: { children: ReactNode; initialSearch?: string }) {
  const ws = useWorkspace();
  const [params, setParams] = useState<Params>(() => readParams(initialSearch ?? (typeof window === "undefined" ? "" : window.location.search)));
  const [memory, setMemory] = useState<Partial<Record<ShellSuiteId, string>>>({});
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= WIDE_FROM));
  /* The type Make was last on (`make=1` reopens it), followed from the address whenever Make is on a type. */
  const [lastMake, setLastMake] = useState<ComposerType>(() => makeType(params.make) ?? "video");
  const lastMakeRef = useRef(lastMake);
  const madeType = makeType(params.make);
  if (madeType && madeType !== lastMake) { setLastMake(madeType); }
  useEffect(() => { lastMakeRef.current = lastMake; }, [lastMake]);
  const [libTab, setLibTab] = useState<LibTab>("tools");
  const [libOpen, setLibOpen] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  /* `?find=1` (the 404's and the error page's Search) lands with ⌘K open — read from the opening URL, like the params above. */
  const [palette, setPaletteOpen] = useState(() => findRequested(initialSearch ?? (typeof window === "undefined" ? "" : window.location.search)));
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [undoStack, setUndoState] = useState<UndoEntry[]>([]);
  const runRef = useRef<((command: CtxCommand, target: CtxTarget) => void) | null>(null);
  /* The stack as of the last change, written with the state so two quick ⌘Z presses never pop one step twice. */
  const undoRef = useRef(undoStack);
  const setUndoStack = useCallback((next: (stack: UndoEntry[]) => UndoEntry[]) => {
    undoRef.current = next(undoRef.current);
    setUndoState(undoRef.current);
  }, []);
  /* Every step remembers the project it was made in (lib/shell/undo.ts). */
  const projectRef = useRef(ws.state.projectId);
  useEffect(() => { projectRef.current = ws.state.projectId; }, [ws.state.projectId]);
  const liveRef = useRef<Shell | null>(null);
  const live = useCallback(() => liveRef.current!, []);

  /* The selected take, as the URL carries it: the Workspace selection is the one source, `asset` (and `sel`) follow it. */
  const take = ws.state.selKind === "take" ? validAssetId(ws.state.selId) : null;
  /* The Workspace's own latest state, not the rendered one: a child's effect in the same commit (a link landing) must see the
     selection a parent's transition just made. `latest` and `dispatch` read the provider's ref, whichever render they came from. */
  const latestWs = useRef(ws);
  useEffect(() => { latestWs.current = ws; }, [ws]);
  /* How the next selection change enters history (selectAsset says); anything else rewrites the entry it is on. */
  const nextEntry = useRef<"push" | "replace" | null>(null);
  useEffect(() => {
    const mode = nextEntry.current ?? "replace";
    nextEntry.current = null;
    if (window.location.pathname !== SUITES_PATH) return;
    /* Exactly this take, or none: a malformed or repeated `asset` is rewritten too, never left in the address bar. */
    const named = new URLSearchParams(window.location.search).getAll(ASSET_PARAM);
    if (take ? named.length === 1 && named[0] === take : named.length === 0) return;
    writeSearch(withAsset(window.location.search, take), mode);
    /* The state layer's own `sel` follows in the same entry, so the two never disagree. */
    latestWs.current.syncUrl();
  }, [take]);

  /* A link to a take (lib/shell/asset-link.ts), read once from the URL the page opened with. */
  const [link, setLink] = useState<AssetLink | null>(() => readAssetLink(initialSearch ?? (typeof window === "undefined" ? "" : window.location.search)));

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE_FROM);
    const onPop = () => {
      /* An entry with an old Gen or Viral tool address reads as Make, and says so; a Viral tool over the page on screen. */
      const moved = fromMakeLink(window.location.search);
      if (moved !== null) {
        const q = new URLSearchParams(moved);
        const now = latestWs.current.latest(), at = liveRef.current, tool = viralTool(window.location.search);
        if (tool && q.get(MAKE_PARAM) === tool && now.view === "studio" && at?.view === "suite") {
          q.set("suite", now.suite); q.set("page", now.page); q.set("sp", at.page.id);
        }
        const text = q.toString();
        window.history.replaceState(null, "", window.location.pathname + (text ? "?" + text : "") + window.location.hash);
      }
      setParams(readParams(window.location.search, lastMakeRef.current));
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("popstate", onPop);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("popstate", onPop); };
  }, []);

  const suiteId = suiteOfLegacy(ws.state.suite);
  const suite = shellSuite(suiteId);
  const mapped = pageOfLegacy(ws.state.suite, ws.state.page, params.sp ?? memory[suiteId]);
  const page = mapped ?? suite.pages[0];

  /* The take in the URL is always the live selection's, whatever else the write changes. */
  const apply = useCallback((next: Omit<Params, "asset"> & { asset?: string | null }, mode: "push" | "replace") => {
    const s = latestWs.current.latest();
    const withTake = { ...next, asset: s.selKind === "take" ? validAssetId(s.selId) : null };
    setParams(withTake); writeParams(withTake, mode);
  }, []);

  const openMake = useCallback((preset?: MakeTab | GenPreset) => {
    if (preset && typeof preset === "object") sendGenPreset(preset);
    const asked = typeof preset === "string" ? preset : preset?.type;
    /* A preset is for the composer: from a quick tool it goes to the type Make was last on. */
    const tab: MakeTab = asked ?? (preset ? makeType(params.make) ?? lastMakeRef.current : params.make && params.make !== "recent" ? params.make : lastMakeRef.current);
    setLibOpen(false); setInspOpen(false); setPaletteOpen(false);
    if (params.make === tab) return;
    apply({ ...params, make: tab }, params.make ? "replace" : "push");
  }, [params, apply]);

  const goSuite = useCallback((id: ShellSuiteId, pageId?: string, opts?: { closeMake?: boolean }) => {
    /* Motion Transfer and Object Swap are Make's quick tools (README § 1.2): they open over the page on screen. The
       suite on its own opened on Motion Transfer, and still does until History is the page it remembers. */
    const tool = id !== "viral" ? null : pageId !== undefined ? (isMakeTool(pageId) ? pageId : null) : memory.viral ? null : "motion";
    if (tool) { openMake(tool); return; }
    const target = pageId ? restorePage(id, pageId) : restorePage(id, memory[id]);
    setMemory((m) => ({ ...m, [id]: target.id }));
    setLibOpen(false); setInspOpen(false); setPaletteOpen(false); setCtx(null);
    const before = window.location.pathname + window.location.search;
    ws.go(target.legacy.suite, target.legacy.page);
    const pushed = before !== window.location.pathname + window.location.search;
    /* The state layer pushed the entry when its own page changed; when two shell
       pages share one backing page it did not, and the shell pushes instead. */
    /* Make stays open over the page it moved to; on a phone, where it is the whole screen, going somewhere closes it. */
    apply({ view: "suite", tab: "general", sp: target.id, cp: "room", make: opts?.closeMake ? null : stayMake(params.make) }, pushed ? "replace" : "push");
  }, [ws, memory, apply, params.make, openMake]);

  /* The Studio page the project segment returns to: the last one shown that is a stage, not the overview or the phone's Home. */
  const lastStage = useRef<string | null>(null);
  useEffect(() => {
    if (params.view === "suite" && suiteId === "studio" && !page.phoneOnly) lastStage.current = page.id;
  }, [params.view, suiteId, page]);
  const goProject = useCallback(() => {
    const stage = shellPage("studio", lastStage.current ?? memory.studio);
    goSuite("studio", stage && !stage.phoneOnly ? stage.id : firstShellPage("studio").id);
  }, [goSuite, memory]);

  /* A page the new IA has no tab for (an old deep link) opens its suite's first page. */
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    /* An old link in the design file's spelling (lib/shell/ia.ts › normalize): the server already rewrote it on the
       way in, so this only meets one the client reached by itself. The address names the app's form from here on;
       the providers above were handed that form too (components/graphite/SuitesApp.tsx). */
    const fixed = redirectFor(window.location.pathname, window.location.search);
    if (fixed) window.history.replaceState(null, "", fixed + window.location.hash);
    /* The old Gen page's address (`view=gen`, `mode=`, `sheet=1`) and Viral's two tools become Make's own before anything else writes it. */
    const moved = fromMakeLink(window.location.search);
    if (moved !== null) window.history.replaceState(null, "", window.location.pathname + (moved ? "?" + moved : "") + window.location.hash);
    /* `make=1` names the type it opened on from here on. */
    else if (readMake(window.location.search) === "last") writeParams(params, "replace");
    if (ws.state.view !== "studio" || !mapped) {
      const target = mapped ?? suite.pages[0];
      /* The landing replaces the entry URL: Back leaves /suites instead of re-opening the same page. */
      ws.go(target.legacy.suite, target.legacy.page, { replace: true });
      writeParams({ ...params, sp: target.id }, "replace");
    } else if (pageAlias(suiteId, params.sp)) {
      /* An old link to a page that left the strip (Business › Ads): the address names the page it landed on, from here on. */
      const renamed = { ...params, sp: mapped.id };
      // eslint-disable-next-line react-hooks/set-state-in-effect -- One shot on landing: the retired id leaves the shell's params with the URL, so no later write puts it back.
      setParams(renamed);
      writeParams(renamed, "replace");
    }
    /* One shot: a reload of this URL should not reopen search. */
    if (findRequested(window.location.search)) window.history.replaceState(null, "", window.location.pathname + withoutFind(window.location.search) + window.location.hash);
    // Run once, against the URL the page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Leaving a page is when a composer that polled its own connected job lets go of it, and when an
     editor that is not a stage (the Rig) has saved: the collector lists the project's jobs, and the
     shell's copy of the project is read again. */
  const session = useSession();
  /* Make counts as a place of its own: closing it is leaving the composer, as leaving Gen was. */
  const place = `${params.view}:${page.id}${params.make ? ":make" : ""}`;
  const strip = ws.state.gen;
  useConnectedCollector({
    scope: session.requestScope ?? null, owner: session.owner, projectId: ws.state.projectId, place, toast: ws.toast,
    strip: strip ? { id: strip.id, done: strip.tone === "green" || strip.tone === "red" } : null,
  });
  const placed = useRef(place);
  useEffect(() => {
    if (placed.current === place) return;
    placed.current = place;
    projectChanged(ws.state.projectId);
  }, [place, ws.state.projectId]);

  const value = useMemo<Shell>(() => ({
    /* Where a page has no tools of its own (Make open over it, the Business and Viral composers, the phone's
       Home) the Library is what you can drag in, however you arrived (tab, palette or a link). */
    view: params.view, suite, page, wsTab: params.tab, crewPage: params.cp, wide, libTab: libraryHasTools(params.make ? "make" : params.view, suite.id, page.id) ? libTab : "assets", libOpen, inspOpen,
    inspector: ws.state.inspector, palette, ctx, clip, canUndo: canUndo(undoStack, ws.state.projectId),
    goSuite,
    goProject,
    make: params.make,
    lastMake,
    openMake,
    closeMake: () => { if (params.make) apply({ ...params, make: null }, "push"); },
    setMake: (tab) => { if (params.make && params.make !== tab) apply({ ...params, make: tab }, "replace"); },
    goGen: () => openMake(),
    goCrew: (page) => { setLibOpen(false); setInspOpen(false); setPaletteOpen(false); apply({ ...params, view: "crew", cp: page ?? params.cp, make: stayMake(params.make) }, "push"); },
    goWorkspace: (tab) => { setLibOpen(false); setInspOpen(false); setPaletteOpen(false); apply({ ...params, view: "workspace", tab: tab ?? params.tab, make: stayMake(params.make) }, "push"); },
    setLibTab,
    toggleLibrary: () => { setLibOpen((v) => !v); setInspOpen(false); },
    toggleInspector: () => {
      if (window.innerWidth >= WIDE_FROM) ws.dispatch({ type: "toggleInspector" });
      else { setInspOpen((v) => !v); setLibOpen(false); }
    },
    openLibrary: (tab) => {
      if (tab) setLibTab(tab);
      /* Crew and Workspace have no Library: the suite page they were opened over hosts it. */
      if (params.view === "crew" || params.view === "workspace") { setPaletteOpen(false); apply({ ...params, view: "suite" }, "push"); }
      if (window.innerWidth < WIDE_FROM) { setLibOpen(true); setInspOpen(false); }
    },
    openInspector: () => {
      if (window.innerWidth >= WIDE_FROM) { if (!ws.state.inspector) ws.dispatch({ type: "toggleInspector" }); }
      else { setInspOpen(true); setLibOpen(false); }
    },
    closePanels: () => { setLibOpen(false); setInspOpen(false); },
    setPalette: (open) => { setPaletteOpen(open); if (open) setCtx(null); },
    openCtx: (next) => setCtx(next),
    closeCtx: () => setCtx(null),
    setClip,
    pushUndo: (entry, say) => {
      const stamped = { ...entry, projectId: entry.projectId ?? projectRef.current };
      setUndoStack((stack) => pushUndo(stack, stamped));
      /* The toast's Undo (lib/workspace/state › ToastAction) stays as long as an Open does, long enough to reach on a phone, and
         shows only while this step is still the one ⌘Z would undo in this project. */
      if (say) ws.toast(say, { label: "Undo", kind: "undo", run: () => void live().undo(), live: () => popUndo(undoRef.current, projectRef.current)?.entry === stamped });
    },
    runCommand: (command, target) => runRef.current?.(command, target),
    setRunCommand: (run) => { runRef.current = run; },
    asset: take,
    selectAsset: (id, opts = {}) => {
      const now = latestWs.current.latest();
      const current = now.selKind === "take" ? now.selId : null;
      if (opts.ifCurrent !== undefined && current !== opts.ifCurrent) return;
      const next = id === null ? null : validAssetId(id);
      /* A malformed id is refused; clearing when no take is selected leaves a shot or a page selection alone. */
      if ((id !== null && !next) || next === current) return;
      nextEntry.current = selectHistory(opts.reason ?? "pick");
      /* Leaving a take on Takes keeps Takes' own kind (nothing selected in its grid); elsewhere the page is selected again. */
      const cleared = pageKind(now.page) === "take" ? { selKind: "take" as const, selId: null } : { selKind: "page" as const, selId: now.page };
      latestWs.current.dispatch({ type: "patch", patch: next ? { selKind: "take", selId: next } : cleared });
    },
    link,
    endLink: (drop) => {
      setLink(null);
      writeSearch(withoutLink(window.location.search, drop), "replace");
      const now = latestWs.current.latest();
      if (drop && now.selKind === "take" && now.selId) live().selectAsset(null, { reason: "link" });
    },
    undo: async () => {
      const popped = popUndo(undoRef.current, ws.state.projectId);
      if (!popped) { ws.toast(undoRef.current.length ? "Nothing to undo in this project." : "Nothing to undo."); return; }
      setUndoStack((stack) => stack.filter((entry) => entry !== popped.entry));
      try {
        ws.toast(undoneLabel(popped.entry, await popped.entry.undo()));
      } catch (error) {
        /* The step is still owed: it goes back on the stack, and the toast says why it did not happen. */
        setUndoStack((stack) => pushUndo(stack, popped.entry));
        ws.toast(`Could not undo: ${error instanceof Error && error.message ? error.message : "try again."}`);
      }
    },
    live,
  }), [params, lastMake, openMake, suite, page, wide, libTab, libOpen, inspOpen, palette, ctx, clip, undoStack, goSuite, goProject, apply, ws, setUndoStack, live, link, take]);
  useEffect(() => { liveRef.current = value; }, [value]);

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
