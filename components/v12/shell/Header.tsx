"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { HeaderLogo } from "./Logo";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { isLanded } from "@/lib/shell/screens";
import { useJobsTray } from "@/lib/shell/use-jobs-tray";
import { useApprovals } from "@/lib/control-room/use-approvals";
import type { ProjectSummary, WorkspaceAccount } from "@/lib/workspace/data";
import type { Project } from "@/lib/workbench/studio";
import { IconButton, Tooltip, useToast, Menu, type MenuItem } from "../ui";
import { LowCreditChip } from "./LowCreditChip";
import { ActivityPill } from "./Activity";
import { AccountMenu } from "./AccountMenu";
import dynamic from "next/dynamic";
import { boardStates } from "./activity";
import { boardRings } from "@/lib/v12/boardRing";
import { useTick } from "../render/use-render";
import { MAX_BOARD_TABS, afterClose, closeOthers, closeTab, headerKey, openTab, restoreTab, tabInitial, visibleTabs } from "./tabs";
import { useTabFit } from "./use-tab-fit";
import { useBoardTabs } from "./use-board-tabs";
import { copyBoardLink } from "../menus/menu-items";
import { keyOf } from "@/lib/v12/keymap";
import { toggleAtomikDock } from "@/lib/v12/atomik-dock";
import "./header.css";
import "../render/render.css";

/** The "+" popover is drawn only once it has been opened: its code is fetched on first use, not with every screen (a v25 speed-budget cut, owner 15 Oct). */
const PlusPopover = dynamic(() => import("./PlusPopover").then((m) => m.PlusPopover), { ssr: false });

/** The most boards GET /api/workbench/projects returns (app/api/workbench/projects/route.ts). */
const PROJECTS_LIST_LIMIT = 100;

/**
 * The new interface's header (docs/redesign/inventory.md § 5.1; prototype L43–L56): 56 px, the logo, the tabs that
 * hug (Home · Make · up to four board tabs · +N ▾ · +), the merged Atomik field (⌘K) with its panel icon (⌘J), the
 * Activity pill, the low-credit chip only when low, and the avatar, whose menu holds the balance. There is no credits
 * pill. Every icon has its tooltip (§ 4.3); the keys are § 4.2's, with ⌘J for Atomik's panel (plan decision 3).
 *
 * It reuses today's flows: ⌘K is today's Palette, the panel today's Atomik panel, a new board today's create path
 * (the shell's createProject, as Home's templates), Activity the jobs tray and the approvals queue, Top up today's
 * Plan & credits, Sign out today's sign-out.
 */
export function V12Header({ account, project, projects, onPick }: {
  account: WorkspaceAccount | null;
  project: Project | null;
  projects: readonly ProjectSummary[];
  onPick: (id: string) => void;
}) {
  const shell = useShell();
  const session = useSession();
  const toast = useToast();
  const tray = useJobsTray();
  const approvals = useApprovals();
  /* The boards list stops at PROJECTS_LIST_LIMIT, so a full list can't say a board is gone: prune only from a shorter one. */
  const known = useMemo(() => (projects.length >= PROJECTS_LIST_LIMIT ? null : projects.length || project ? new Set(projects.map((p) => p.id)) : null), [projects, project]);
  const tabs = useBoardTabs(session.requestScope ?? null, known);

  const onBoard = shell.screen === "board" || shell.screen === "board-ads" || shell.screen === "board-social";
  /* "New board" (components/v12/board/NewBoard.tsx) is a tab of its own while it is open: the board tabs are not the active one. */
  const newBoardOpen = onBoard && shell.params.newboard === "1";
  const activeBoard = onBoard && !shell.make && !newBoardOpen && project ? project.id : null;
  /* A board that opens gets its tab. */
  const openId = onBoard && project ? project.id : null;
  const { update } = tabs;
  useEffect(() => { if (openId) update((now) => openTab(now, openId)); }, [openId, update]);

  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? (project?.id === id ? project.name : "Board");
  /* As many board tabs as really fit (prototype v14): the field shrinks to 280 first, then the rest go under "+N ▾". */
  const headerRef = useRef<HTMLElement>(null);
  const namesKnown = tabs.state.open.every((id) => projects.some((p) => p.id === id) || project?.id === id);
  const fit = useTabFit(headerRef, tabs.state.open, activeBoard, namesKnown);
  const { shown, hidden } = visibleTabs(tabs.state.open, activeBoard, fit ?? MAX_BOARD_TABS);
  const states = useMemo(() => boardStates(tray?.jobs ?? [], approvals.items), [tray?.jobs, approvals.items]);
  /* The ring on a board tab with work running (redesign P3): its share, and about how long is left. */
  const running = states.size > 0 && [...states.values()].includes("live");
  const ringNow = useTick(running, 5_000);
  const rings = useMemo(() => boardRings(tray?.jobs ?? [], ringNow), [tray?.jobs, ringNow]);

  /* Home as a tab shows Home: Make closes. The shell's goHome keeps Make over the page it moves to, so Make closes once
     Home is the screen (one address write each, never two from the same old address). */
  const closeMakeOnHome = useRef(false);
  const goHome = () => {
    if (shell.screen === "home") { if (shell.make) shell.closeMake(); return; }
    closeMakeOnHome.current = Boolean(shell.make);
    shell.goHome();
  };
  const { screen: shownScreen, make: makeOpen, closeMake } = shell;
  useEffect(() => {
    if (shownScreen !== "home" || !closeMakeOnHome.current) return;
    closeMakeOnHome.current = false;
    if (makeOpen) closeMake();
  }, [shownScreen, makeOpen, closeMake]);
  const goMake = () => shell.openMake();
  const goBoard = (id: string) => { if (id !== project?.id) onPick(id); shell.goBoard({ closeMake: true }); };
  /* Closing the New board tab makes nothing and loses nothing: back to the board that was open, or Home. */
  const closeNewBoard = () => {
    if (project) shell.setScreenParams({ newboard: null, pick: null }, "push");
    else goHome();
  };
  const atomikOpen = shell.atomik !== null;
  /* A board on screen has its own Atomik dock (the rail at its right edge), and ⌘J opens that; the bar's button is for the app's other screens (v25: none on the board). */
  const boardShown = activeBoard !== null;
  const toggleAtomik = () => {
    if (boardShown) { toggleAtomikDock(); return; }
    if (!isLanded("atomik")) { shell.goSuite("atomik"); return; }
    if (atomikOpen) shell.closeAtomik(); else shell.openAtomik();
  };

  const close = (id: string) => {
    const index = tabs.state.open.indexOf(id);
    /* The open board counts as active even with Make over it: closing its tab must not leave it on screen without one. */
    const wasActive = id === openId;
    const next = wasActive ? afterClose(tabs.state.open, id) : null;
    update((now) => closeTab(now, id));
    if (wasActive) { if (next) goBoard(next); else goHome(); }
    const name = nameOf(id);
    toast({ text: `${name} closed · the board is kept`, action: { label: "Undo", run: () => {
      update((now) => restoreTab(now, id, index));
      /* The latest goBoard: closing already moved to the neighbour, so this closure's project is no longer the open one. */
      if (wasActive) keys.current.goBoard(id);
    } } });
  };

  /* Keys: ⌘1 Home, ⌘2 Make, ⌘3… the board tabs shown, ⌘J the panel, G then H Home. Not while typing. */
  const keys = useRef({ shown, goHome, goMake, goBoard, toggleAtomik });
  useEffect(() => { keys.current = { shown, goHome, goMake, goBoard, toggleAtomik }; });
  useEffect(() => {
    let afterG = false;
    let clear: ReturnType<typeof setTimeout> | null = null;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      /* Not behind one of today's sheets (a .gx-veil), as BoardView's own keys: the page under a modal never moves. */
      if (document.querySelector(".gx-veil")) return;
      const command = headerKey(event, afterG);
      afterG = false;
      if (!command) return;
      if ("pending" in command) { afterG = true; if (clear) clearTimeout(clear); clear = setTimeout(() => { afterG = false; }, 1200); return; }
      const k = keys.current;
      if ("toggle" in command) k.toggleAtomik();
      else if (command.go === "home") k.goHome();
      else if (command.go === "make") k.goMake();
      else { const id = k.shown[command.index]; if (!id) return; k.goBoard(id); }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (clear) clearTimeout(clear); };
  }, []);

  /* The tab menu (right-click a board tab) and "+N ▾". */
  const tabAnchor = useRef<HTMLElement | null>(null);
  const [tabMenu, setTabMenu] = useState<string | null>(null);
  const moreAnchor = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState(false);
  const plusAnchor = useRef<HTMLButtonElement>(null);
  const [plus, setPlus] = useState(false);
  const [plusUsed, setPlusUsed] = useState(false);
  const openPlus = (open: boolean | ((was: boolean) => boolean)) => { setPlusUsed(true); setPlus(open); };

  const copyLink = (id: string) => copyBoardLink(id, toast);
  const tabItems: MenuItem[] = tabMenu ? [
    { id: "open", label: "Open", onSelect: () => goBoard(tabMenu) },
    { id: "copy", label: "Copy link", onSelect: () => copyLink(tabMenu), testId: "v12-tab-copy" },
    { id: "sep", separator: true },
    { id: "close", label: "Close", onSelect: () => close(tabMenu), testId: "v12-tab-close-item" },
    { id: "others", label: "Close others", disabled: tabs.state.open.length < 2, onSelect: () => { const keep = tabMenu; update((now) => closeOthers(now, keep)); if (openId && openId !== keep) goBoard(keep); }, testId: "v12-tab-close-others" },
  ] : [];
  const moreItems: MenuItem[] = [
    ...hidden.map((id) => ({ id, label: nameOf(id), onSelect: () => goBoard(id) })),
    { id: "sep", separator: true },
    { id: "new", label: "+ New project", onSelect: () => openPlus(true) },
  ];

  const ordinal = (i: number) => (i + 3 <= 9 ? keyOf(`tab-${i + 3}`) : undefined);
  return (
    <header ref={headerRef} className="v12-header" data-testid="v12-header" data-row="header">
      <HeaderLogo onClick={goHome} testId="v12-logo" shortcut={[keyOf("home-seq"), keyOf("home")]} />

      <nav className="v12-tabs" aria-label="Tabs" data-testid="v12-tabs">
        <div className="v12-tab" data-active={shell.screen === "home" && !shell.make ? "" : undefined} data-testid="v12-tab-home">
          <Tooltip name="Home" shortcut={[keyOf("home-seq"), keyOf("home")]}>
            <button type="button" className="v12-tab-main" onClick={goHome} aria-current={shell.screen === "home" && !shell.make ? "page" : undefined}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 8l6-5 6 5v6h-4v-4H6v4H2z" /></svg>
              <span className="v12-tab-label">Home</span>
            </button>
          </Tooltip>
        </div>
        <div className="v12-tab" data-active={shell.make ? "" : undefined} data-testid="v12-tab-make">
          <Tooltip name="Make" line="Single pieces." shortcut={keyOf("make")}>
            <button type="button" className="v12-tab-main" onClick={goMake} aria-current={shell.make ? "page" : undefined}>
              <span className="v12-tab-spark" aria-hidden="true">✦</span>
              <span className="v12-tab-label">Make</span>
            </button>
          </Tooltip>
        </div>
        {shown.map((id, i) => {
          const name = nameOf(id);
          const state = states.get(id);
          const ring = state === "live" ? rings.get(id) ?? null : null;
          const stateWord = state === "waiting" ? "waiting for you" : state === "live" ? "rendering" : "open";
          const active = id === activeBoard;
          return (
            <div key={id} className="v12-tab" data-board="" data-active={active ? "" : undefined} data-testid="v12-tab-board" data-id={id}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); tabAnchor.current = e.currentTarget; setTabMenu(id); }}>
              <Tooltip name={name} line={ring ? `${ring.words}.` : stateWord === "open" ? undefined : `${stateWord[0].toUpperCase()}${stateWord.slice(1)}.`} shortcut={ordinal(i)}>
                <button type="button" className="v12-tab-main" onClick={() => goBoard(id)} aria-current={active ? "page" : undefined}>
                  <span className="v12-tab-tile" aria-hidden="true">{tabInitial(name)}</span>
                  <span className="v12-tab-label">{name}</span>
                  {ring ? <span className="v12-tab-ring" style={{ "--p": `${Math.round(ring.pct * 100)}%` } as CSSProperties} data-testid="v12-tab-ring" aria-hidden="true" />
                    : <span className="v12-tab-dot" data-state={state ?? "idle"} aria-hidden="true" />}
                </button>
              </Tooltip>
              <IconButton tooltip={{ name: "Close tab" }} label={`Close ${name}`} size="sm" className="v12-tab-x" onClick={() => close(id)} data-testid="v12-tab-close">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              </IconButton>
            </div>
          );
        })}
        {newBoardOpen ? (
          <div className="v12-tab" data-board="" data-active={shell.make ? undefined : ""} data-testid="v12-tab-new-board">
            <Tooltip name="New project" line="Pick a kind and say what to make.">
              <button type="button" className="v12-tab-main" aria-current={shell.make ? undefined : "page"} onClick={() => shell.goBoard({ newBoard: shell.params.pick ?? true, closeMake: true })}>
                <span className="v12-tab-tile" aria-hidden="true">N</span>
                <span className="v12-tab-label">New project</span>
                <span className="v12-tab-dot" data-state="idle" aria-hidden="true" />
              </button>
            </Tooltip>
            <IconButton tooltip={{ name: "Close tab" }} label="Close New project" size="sm" className="v12-tab-x" onClick={closeNewBoard} data-testid="v12-tab-new-board-close">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </IconButton>
          </div>
        ) : null}
        {hidden.length ? (
          <Tooltip name="More boards">
            <button ref={moreAnchor} type="button" className="v12-tab-more" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((v) => !v)} data-testid="v12-tab-more">
              +{hidden.length} ▾
            </button>
          </Tooltip>
        ) : null}
        <IconButton ref={plusAnchor} tooltip={{ name: "New tab · boards and kinds" }} label="New tab" className="v12-tab-plus" pressed={plus} aria-haspopup="dialog" onClick={() => openPlus((v) => !v)} data-testid="v12-tab-plus">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </IconButton>
      </nav>

      <span className="v12-spacer" aria-hidden="true" />
      {/* The ⌘K bar: on the right, directly left of the Activity pill, a fixed width that widens on focus (v25). On app screens the Atomik panel's button is inside it; on a board there is none (owner, 15 Oct), the board's own dock rail is the visible control and ⌘J opens it. */}
      <div className="v12-field" data-open={atomikOpen ? "" : undefined} data-panel={boardShown ? undefined : ""} data-testid="v12-atomik-field">
        <Tooltip name="Ask Atomik, search or go to" line="Ask a question, find a board, stage, card or library item, or run an action." shortcut={keyOf("palette")}>
          <button type="button" className="v12-field-ask" onClick={() => shell.setPalette(true)} aria-keyshortcuts="Meta+K" data-testid="v12-ask">
            <span className="v12-field-mark" aria-hidden="true">◆</span>
            <span className="v12-field-text">Ask Atomik, search or go to</span>
            <span className="v12-field-key" aria-hidden="true">{keyOf("palette")}</span>
          </button>
        </Tooltip>
        {boardShown ? null : <IconButton className="v12-field-panel" pressed={atomikOpen} onClick={toggleAtomik} aria-keyshortcuts="Meta+J" data-testid="v12-atomik-panel"
          tooltip={{ name: "Atomik panel", line: atomikOpen ? "Close the conversation panel." : "Open the conversation: plans, questions and approvals.", shortcut: keyOf("atomik-panel") }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M10 3v10" /></svg>
        </IconButton>}
      </div>

      {/* The right group is pinned to the edge at every width: nothing in the header pushes it. */}
      <div className="v12-right" data-testid="v12-right">
        <ActivityPill approvals={approvals} draftId={onBoard && project ? project.id : null} onBoard={goBoard} />
        <LowCreditChip balance={account?.credits?.balance ?? null} />
        <AccountMenu account={account} />
      </div>
      {/* The board tabs as they would draw, unseen, so the header can tell how many fit. */}
      <div className="v12-tabs-measure" aria-hidden="true">
        {tabs.state.open.map((id) => (
          <div key={id} className="v12-tab" data-board="" data-m={id}>
            <span className="v12-tab-main"><span className="v12-tab-tile" /><span className="v12-tab-label">{nameOf(id)}</span><span className="v12-tab-dot" /></span>
            <span className="v12-tab-xspace" />
          </div>
        ))}
      </div>

      <Menu open={tabMenu !== null} onClose={() => setTabMenu(null)} anchor={tabAnchor} label="Tab" items={tabItems} width={200} testId="v12-tab-menu" />
      <Menu open={more} onClose={() => setMore(false)} anchor={moreAnchor} label="More boards" items={moreItems} width={280} testId="v12-more-menu" />
      {plusUsed ? (
        <PlusPopover open={plus} onClose={() => setPlus(false)} anchor={plusAnchor} projects={projects} closed={tabs.state.closed}
          onOpen={(id) => { setPlus(false); goBoard(id); }} />
      ) : null}
    </header>
  );
}
