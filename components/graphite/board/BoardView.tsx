"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ReactFlowProvider, useReactFlow, useStoreApi, type Viewport } from "@xyflow/react";
import { useRig } from "@/components/workspace/rig/RigProvider";
import { markBoardOpen } from "@/lib/board/active";
import { GLIDE_MS, glideEase } from "@/lib/board/ease";
import { frameDrawer, frameRegion } from "@/lib/board/frames";
import { DOCK_WIDTH, MAKE_WIDTH } from "@/lib/board/geometry";
import { boardKindOf } from "@/lib/board/kind";
import { useOnline } from "@/lib/board/online";
import { railStatus } from "@/lib/board/regions";
import { addFreeCard, moveFreeCards, removeFreeCards, restoreFreeCards, type FreeMove } from "@/lib/board/snap";
import { isBoardKind, type BoardBox, type BoardKind, type BoardPoint, type BoardSource, type RegionId } from "@/lib/board/types";
import { readBoardView, saveBoardView } from "@/lib/board/view";
import { useMadeOnBoard } from "@/lib/board/made";
import { rigUndoSink } from "@/lib/shell/rig-commands";
import { useShell } from "@/lib/shell/state";
import { useCompact } from "@/lib/shell/use-compact";
import { uploadFilesToProject, type LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { uid, type Project } from "@/lib/workbench/studio";
import type { RoomPeer } from "@/lib/workbench/team-canvas-model";
import { withBoardText } from "@/lib/workspace/rig-board";
import { BoardAgentDock, DOCK_PANEL } from "./agent";
import { BoardCanvas } from "./BoardCanvas";
import { BoardInternalsProvider, BoardSeams, type BoardInternals } from "./BoardContext";
import { buildRegistry } from "./cards";
import { ShotList } from "./cards/board/ShotList";
import type { BoardCtx, BoardSelection } from "./cards/types";
import { EmptyBoard } from "./EmptyBoard";
import { HoverCluster } from "./HoverCluster";
import { BoardInspector } from "./inspector";
import { BOARD_MODULES } from "./kinds";
import { placeBoard } from "./layout-cards";
import { Rail, type BoardDrawer } from "./Rail";
import { BoardReview } from "./review";
import { ToolPill, type BoardTool } from "./ToolPill";
import { PeerCursors, WhoIsHere } from "./Presence";
import { HistoryDrawer, LibraryDrawer } from "./drawers/Drawers";
import { addInput } from "@/lib/production/rig-build";
import { entryAsset } from "@/lib/production/sequence";
import "./board.css";

/*
 * The board (`?view=board`, README § 1.1, § 3.1): one per project, the same
 * canvas whichever template started it (Studio, or stream 11's Ads and
 * Social). The outline rail at the left; the canvas with its tool pill and
 * the hover cluster (minimap, zoom, Board | List); the docked Atomik panel at
 * the right (stream 7); the Inspector over the right edge on a selection
 * (stream 5); Make's panel beside the dock when open, the canvas clear of it.
 *
 * It renders through the Rig's provider (components/workspace/rig/RigProvider):
 * the draft with the team canvas folded in, its shots, jobs and masters.
 * Opening a board writes nothing; what a person does on it (a note, a move,
 * a label) is their own draft edit, free, with ⌘Z.
 *
 * Phones (the compact layout) show the project's Record (stream 10); until
 * that lands, the board's List view, never the canvas.
 */
export type BoardViewProps = {
  scope: string;
  /** The shell's project (the board reads the Rig's live draft of it). */
  project: Project | null;
  /** The project's Library entries. */
  items: readonly LibraryEntry[];
  /** The project's Library state (lib/workspace/library useProjectLibrary), for the Library drawer. */
  library: unknown;
  /** `kind=` from the address; null when it names none, and the project's own kind is used (lib/board/kind.ts). */
  kind: BoardKind | null;
  /** A design frame letter from a design or old link (lib/board/frames.ts), or null. */
  frame: string | null;
  /** `region=` from an old Studio stage link, or null. */
  region?: string | null;
};

export function BoardView(props: BoardViewProps) {
  return (
    <ReactFlowProvider>
      <Board {...props} />
    </ReactFlowProvider>
  );
}

const NO_SELECTION: BoardSelection = { primary: null, ids: new Set() };
/** Where a glide leaves a region's top-left on screen. */
const INSET = 24;
const inField = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

function Board({ scope, items, kind: asked, frame, region }: BoardViewProps) {
  useEffect(() => markBoardOpen(), []);
  const rig = useRig();
  const ws = useWorkspace();
  const shell = useShell();
  const flow = useReactFlow();
  const store = useStoreApi();
  const compact = useCompact();
  const online = useOnline();
  const offline = !online;
  const project = rig.project;
  const kind: BoardKind = asked && isBoardKind(asked) ? asked : boardKindOf(project);
  const board = BOARD_MODULES[kind] ?? BOARD_MODULES.studio;
  const registry = useMemo(() => buildRegistry(board.sets), [board]);
  const [now] = useState(() => Date.now());

  const src = useMemo<BoardSource | null>(() => (project ? {
    kind, project, shots: rig.shots, jobs: rig.jobs, library: items, masters: rig.masters, agent: null, now,
  } : null), [kind, project, rig.shots, rig.jobs, items, rig.masters, now]);
  const cards = useMemo(() => (src ? registry.derive(src) : []), [registry, src]);
  const placed = useMemo(() => placeBoard(cards, registry.defs, board.bands, project?.aspect ?? "16:9"), [cards, registry.defs, board.bands, project?.aspect]);
  const status = useMemo(() => railStatus(board.rail, placed.cards), [board.rail, placed.cards]);
  const empty = !!project && placed.cards.length === 0;

  /* ── Selection: the board's own; a card that draws a canvas node is the workspace's selection too ── */
  const [selection, setSelection] = useState<BoardSelection>(NO_SELECTION);
  const pick = useCallback((ids: ReadonlySet<string>, primary: string | null) => {
    setSelection(ids.size ? { primary, ids } : NO_SELECTION);
    const card = primary ? placed.byId.get(primary) : undefined;
    if (card?.nodeId) rig.select(card.nodeId);
  }, [placed.byId, rig]);
  const select = useCallback((id: string | null, opts?: { add?: boolean }) => {
    if (!id) { pick(new Set(), null); return; }
    pick(opts?.add ? new Set([...selection.ids, id]) : new Set([id]), id);
  }, [pick, selection.ids]);

  /* ── Glides: a region's top-left to the canvas's top-left at this zoom, or a card to its middle ── */
  const viewportFor = useCallback((box: BoardBox, zoom: number, centre = false): Viewport => {
    const { width, height } = store.getState();
    return centre
      ? { x: width / 2 - (box.x + box.w / 2) * zoom, y: height / 2 - (box.y + box.h / 2) * zoom, zoom }
      : { x: INSET - box.x * zoom, y: INSET - box.y * zoom, zoom };
  }, [store]);
  const [inView, setInView] = useState<RegionId | null>(null);
  const measureInView = useCallback((viewport: Viewport) => {
    const { width, height } = store.getState();
    const view = { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, w: width / viewport.zoom, h: height / viewport.zoom };
    let best: RegionId | null = null, area = 0;
    for (const entry of board.rail) {
      const box = placed.regions.get(entry.id);
      if (!box) continue;
      const w = Math.min(box.x + box.w, view.x + view.w) - Math.max(box.x, view.x), h = Math.min(box.y + box.h, view.y + view.h) - Math.max(box.y, view.y);
      if (w > 0 && h > 0 && w * h > area) { area = w * h; best = entry.id; }
    }
    setInView(best);
  }, [board.rail, placed.regions, store]);
  const [list, setList] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("list") === "1");
  const glide = useCallback((to: RegionId | { card: string }) => {
    if (list) setList(false);
    const zoom = flow.getZoom();
    const box = typeof to === "string" ? placed.regions.get(to) ?? placed.slots.get(to) : placed.boxes.get(to.card);
    if (!box) return;
    const next = viewportFor(box, zoom, typeof to !== "string");
    void flow.setViewport(next, { duration: GLIDE_MS, ease: glideEase }).then(() => measureInView(next));
  }, [flow, list, measureInView, placed.boxes, placed.regions, placed.slots, viewportFor]);

  /* ── The first view: an old link's region; where this device left it; the first section that needs you; the top at 100 % ── */
  const projectId = project?.id ?? null;
  const opened = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready || !projectId || opened.current === projectId || !placed.bounds) return;
    opened.current = projectId;
    const linked = (region && board.rail.some((entry) => entry.id === region) ? region as RegionId : null) ?? frameRegion(frame);
    const saved = linked ? null : readBoardView(scope, projectId);
    const needs = board.rail.find((entry) => status.get(entry.id)?.state === "needs" && placed.regions.has(entry.id));
    const target = linked ? placed.regions.get(linked) ?? placed.slots.get(linked) : needs ? placed.regions.get(needs.id) : null;
    const first = saved ?? viewportFor(target ?? placed.arranged ?? placed.bounds, 1);
    void flow.setViewport(first).then(() => measureInView(first));
  }, [board.rail, flow, frame, measureInView, placed.arranged, placed.bounds, placed.regions, placed.slots, projectId, ready, region, scope, status, viewportFor]);
  const onMoveEnd = useCallback((viewport: Viewport) => {
    if (projectId) saveBoardView(scope, projectId, viewport);
    measureInView(viewport);
  }, [measureInView, projectId, scope]);

  /* ── Edits a person makes on the board: each one draft edit, free, with ⌘Z ── */
  const undoable = useCallback((label: string, undo: () => void) => {
    if (project) rigUndoSink()?.({ label, projectId: project.id, undo });
  }, [project]);
  const onFreeMoved = useCallback((moves: FreeMove[]) => {
    const current = rig.project;
    if (!current) return;
    const before = moves.flatMap((move) => {
      const node = current.nodes.find((n) => n.id === move.id);
      return node ? [{ id: node.id, x: node.x, y: node.y }] : [];
    });
    const refusal = rig.apply((p) => moveFreeCards(p, moves));
    if (refusal) { ws.toast(refusal); return; }
    undoable("The card is back where it was", () => { rig.apply((p) => moveFreeCards(p, before)); });
  }, [rig, undoable, ws]);
  const [editing, setEditing] = useState<string | null>(null);
  const finishEdit = useCallback((id: string, value: string | null) => {
    setEditing(null);
    if (value === null) return;
    const card = placed.byId.get(id);
    const refusal = rig.apply((p) => withBoardText(p, id, card?.kind === "label" ? "title" : "text", value));
    if (refusal) ws.toast(refusal);
  }, [placed.byId, rig, ws]);
  const [tool, setTool] = useState<BoardTool>("select");
  const files = useRef<HTMLInputElement>(null);
  const place = useCallback((at: BoardPoint) => {
    if (tool !== "note" && tool !== "text") return;
    const id = uid("node");
    const refusal = rig.apply((p) => addFreeCard(p, tool === "note" ? "note" : "label", at, id));
    setTool("select");
    if (refusal) { ws.toast(refusal); return; }
    pick(new Set([id]), id);
    setEditing(id);
  }, [pick, rig, tool, ws]);
  const remove = useCallback(() => {
    const current = rig.project;
    if (!current || !selection.ids.size) return;
    const chosen = [...selection.ids].map((id) => placed.byId.get(id)).filter((card) => card?.nodeId);
    const shots = chosen.filter((card) => card!.kind === "take").map((card) => card!.nodeId!);
    const free = chosen.filter((card) => !card!.region).map((card) => card!.nodeId!);
    for (const id of shots) { const why = rig.removeShot(id); if (why) ws.toast(why); }
    if (free.length) {
      const out = removeFreeCards(current, free);
      if (!out.removed.length) { ws.toast("Another card still takes an input from this one, so it stays on the board."); return; }
      rig.apply(() => out.project);
      undoable("The cards are back on the board", () => { rig.apply((p) => restoreFreeCards(p, out.removed)); });
      ws.toast(`${out.removed.length === 1 ? "1 card" : `${out.removed.length} cards`} taken off the board · ⌘Z brings ${out.removed.length === 1 ? "it" : "them"} back`);
    }
    pick(new Set(), null);
  }, [pick, placed.byId, rig, selection.ids, undoable, ws]);
  const upload = useCallback(async (list: FileList | null) => {
    if (!list?.length || !project) return;
    try {
      const { ids, notes } = await uploadFilesToProject(scope, project.id, [...list]);
      ws.toast(notes.length ? notes.join(" ") : `${ids.length === 1 ? "1 file" : `${ids.length} files`} added to the Library`);
    } catch (error) {
      ws.toast(error instanceof Error ? error.message : "The files could not be uploaded.");
    } finally {
      if (files.current) files.current.value = "";
    }
  }, [project, scope, ws]);
  const chooseTool = useCallback((next: BoardTool) => {
    if (next === "image" || next === "video" || next === "audio") { shell.openMake(next); setTool("select"); return; }
    if (next === "upload") { files.current?.click(); setTool("select"); return; }
    if (next === "frame") return;
    setTool(next);
  }, [shell]);

  /* ── The board's keys (README § 6): V F N T I ⇧V ⇧A U, 0 (fit), L (list), ⌫, Esc; never while typing ── */
  const [drawer, setDrawer] = useState<BoardDrawer | null>(() => frameDrawer(frame));
  useEffect(() => {
    if (compact) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || inField(event.target) || document.querySelector(".gx-veil")) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      let handled = true;
      if ((key === "0" && !event.altKey) && (mod || !event.shiftKey)) void flow.fitView({ padding: 0.08, duration: GLIDE_MS, ease: glideEase });
      else if (mod || event.altKey) handled = false;
      else if (event.key === "Escape") { if (tool !== "select") setTool("select"); else if (drawer) setDrawer(null); else if (selection.ids.size) pick(new Set(), null); else handled = false; }
      else if (event.key === "Backspace" || event.key === "Delete") { if (offline || !selection.ids.size) handled = false; else remove(); }
      else if (key === "l" && !event.shiftKey) setList((was) => !was);
      else if (offline && key !== "v") handled = false;
      else if (key === "v") chooseTool(event.shiftKey ? "video" : "select");
      else if (key === "a" && event.shiftKey) chooseTool("audio");
      else if (event.shiftKey) handled = false;
      else if (key === "n") chooseTool("note");
      else if (key === "t") chooseTool("text");
      else if (key === "i") chooseTool("image");
      else if (key === "u") chooseTool("upload");
      else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact, drawer, flow, offline, pick, remove, selection.ids.size, tool, chooseTool]);

  /* ── A Make result landing (README § 3.2 made): glide to its card, light it for a moment, the Library open on it ── */
  const [lit, setLit] = useState<string | null>(null);
  const litTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [landing, setLanding] = useState<string | null>(null);
  useMadeOnBoard(projectId, (made) => { setLanding(made.nodeId); setDrawer("library"); });
  useEffect(() => {
    if (!landing || !placed.boxes.has(landing)) return;
    const id = landing;
    /* Once the card is on the board: the glide, the light (off again after about 2.6 s, the master's), done. */
    const on = setTimeout(() => {
      glide({ card: id });
      setLit(id);
      setLanding((was) => (was === id ? null : was));
      if (litTimer.current) clearTimeout(litTimer.current);
      litTimer.current = setTimeout(() => setLit((was) => (was === id ? null : was)), 2600);
    }, 0);
    return () => clearTimeout(on);
  }, [glide, landing, placed.boxes]);
  useEffect(() => () => { if (litTimer.current) clearTimeout(litTimer.current); }, []);

  /* ── The seams other streams provide (review mode: 5; Atomik's panel: 7) ── */
  const [seams] = useState(() => new BoardSeams());
  const [dockOpen, setDockOpen] = useState(false);
  const ctx = useMemo<BoardCtx | null>(() => (project ? {
    kind, scope, project, productionId: project.productionProjectId ?? null, offline, selection, select, glide,
    openInspector: (id: string) => select(id),
    openReview: (takeId?: string) => seams.call("review", takeId),
    askAtomik: (words: string) => seams.call("atomik", words),
    openMake: (type) => shell.openMake(type),
    toast: (text, undo) => { if (undo) undoable(undo.label, undo.run); ws.toast(text); },
    rig,
  } : null), [glide, kind, offline, project, rig, scope, seams, select, selection, shell, undoable, ws]);

  const watchers = useMemo(() => {
    const out = new Map<string, RoomPeer>();
    for (const peer of rig.team.peers) if (!peer.agent && peer.selected && !out.has(peer.selected)) out.set(peer.selected, peer);
    return out;
  }, [rig.team.peers]);
  const atomik = useMemo(() => {
    const peer = rig.team.peers.find((p) => p.agent && p.selected);
    return peer?.selected && placed.byId.has(peer.selected) ? { card: peer.selected, doing: (peer.doing ?? "working on the board").replace(/^./, (c) => c.toLowerCase()), color: peer.color } : null;
  }, [placed.byId, rig.team.peers]);

  /* Live presence (the team canvas's room): my cursor, selection and drags out; theirs in. Only in a live room. */
  const { presence, peers, mode } = rig.team;
  const live = mode === "live";
  const frame0 = useRef(0);
  const onPresence = useCallback((patch: { cursor?: BoardPoint | null; drag?: { id: string; dx: number; dy: number } | null }) => {
    if (!live) return;
    if (patch.cursor === undefined) { presence(patch); return; }
    cancelAnimationFrame(frame0.current);
    frame0.current = requestAnimationFrame(() => presence({ cursor: patch.cursor ? { x: Math.round(patch.cursor.x), y: Math.round(patch.cursor.y) } : null }));
  }, [live, presence]);
  const selectedNode = selection.primary ? placed.byId.get(selection.primary)?.nodeId ?? selection.primary : null;
  useEffect(() => { if (live) presence({ selected: selectedNode }); }, [live, presence, selectedNode]);
  const peerDrags = useMemo(() => new Map(peers.filter((p) => !p.agent && p.drag).map((p) => [p.drag!.id, { dx: p.drag!.dx, dy: p.drag!.dy }])), [peers]);

  const dockWidth = DOCK_PANEL && dockOpen ? DOCK_WIDTH.open : DOCK_WIDTH.closed;
  const style = { "--board-dock": `${dockWidth}px`, "--board-make": shell.make ? `${MAKE_WIDTH}px` : "0px" } as CSSProperties;
  const List = registry.List ?? ShotList;

  if (!project || !ctx) {
    const failed = rig.status === "error";
    return (
      <div className="bd" style={style} data-testid="board" data-state={failed ? "error" : "loading"}>
        {compact ? null : <Rail rail={board.rail} status={status} inView={null} drawer={null} onGlide={() => {}} onDrawer={() => {}} />}
        <div className="bd-main"><DotGrid />
          {failed ? (
            <div className="bd-note" role="alert">The board could not be read.<button type="button" className="gx-hbtn" onClick={() => window.location.reload()}>Try again</button></div>
          ) : <p className="bd-note" role="status">Opening the board…</p>}
        </div>
      </div>
    );
  }

  const takesDrops = (cardId: string) => { const card = placed.byId.get(cardId); return !offline && !!card && !!registry.defs.get(card.kind)?.accepts; };
  const dropOn = (cardId: string, data: DataTransfer) => {
    const card = placed.byId.get(cardId);
    const def = card ? registry.defs.get(card.kind) : undefined;
    let key = "";
    try { key = data.getData("text/plain"); } catch { /* unreadable */ }
    const entry = items.find((e) => e.take.id === key);
    if (!card || !def?.accepts || !entry) return;
    const action = def.accepts({ type: "asset", assetId: entry.take.id, media: entry.media }, card);
    if (!action) { ws.toast("That card does not take this file."); return; }
    const shot = project.nodes.find((n) => n.id === action.shotId);
    const refusal = rig.apply((p) => addInput(p, action.shotId, entryAsset(entry)));
    ws.toast(refusal ?? `${entry.take.name} is a reference for ${shot?.title ?? "the shot"}`);
  };
  const internals: BoardInternals = { placed, defs: registry.defs, ctx, watchers, atomik, seams, editing, finishEdit, takesDrops, dropOn, lit };
  if (compact) {
    return (
      <BoardInternalsProvider value={internals}>
        <div className="bd bd--compact" data-testid="board" data-board-kind={kind}><List ctx={ctx} cards={placed.cards} /></div>
      </BoardInternalsProvider>
    );
  }
  const primary = selection.primary ? placed.byId.get(selection.primary) ?? null : null;
  const regionBoxes = board.rail.flatMap((entry) => { const box = placed.regions.get(entry.id); return box ? [box] : []; });
  return (
    <BoardInternalsProvider value={internals}>
      <div className="bd" style={style} data-testid="board" data-board-kind={kind} data-tool={tool} data-offline={offline || undefined}>
        <Rail rail={board.rail} status={status} inView={list ? null : inView} drawer={drawer} onGlide={glide} onDrawer={setDrawer} />
        <div className="bd-main" data-testid="board-canvas">
          {list ? <List ctx={ctx} cards={placed.cards} /> : (
            <BoardCanvas placed={placed} selection={selection} onSelect={pick} onFreeMoved={onFreeMoved} readOnly={offline} onMoveEnd={onMoveEnd}
              placing={tool === "note" || tool === "text"} onPlace={place}
              onOpen={(id) => {
                const card = placed.byId.get(id);
                if (!card) return;
                if ((card.kind === "note" || card.kind === "label") && !offline) { setEditing(id); return; }
                registry.defs.get(card.kind)?.onOpen?.(card, ctx);
              }}
              onReady={() => setReady(true)} onPresence={live ? onPresence : undefined} peerDrags={peerDrags}>
              <PeerCursors peers={peers} />
            </BoardCanvas>
          )}
          {empty && !list && board.Empty ? <board.Empty ctx={ctx} /> : empty && !list && kind === "studio" ? <EmptyBoard ctx={ctx} /> : null}
          {list ? null : <ToolPill tool={tool} readOnly={offline} onTool={chooseTool} />}
          <HoverCluster regions={regionBoxes} bounds={placed.bounds} list={list} onList={setList} />
          {offline ? <p className="bd-offline" role="status">Offline · changes queue</p> : null}
          {live ? <WhoIsHere peers={peers} /> : null}
          <input ref={files} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
        </div>
        {drawer === "library" ? <LibraryDrawer items={items} project={project} onClose={() => setDrawer(null)} />
          : drawer === "history" ? <HistoryDrawer scope={scope} productionId={project.productionProjectId ?? null} jobs={rig.jobs} project={project} onClose={() => setDrawer(null)} onOpen={(nodeId) => { glide({ card: nodeId }); select(nodeId); }} /> : null}
        <BoardAgentDock ctx={ctx} open={dockOpen} onOpenChange={setDockOpen} />
        <BoardInspector ctx={ctx} card={primary} def={primary ? registry.defs.get(primary.kind) ?? null : null} right={dockWidth} onClose={() => select(null)} />
        <BoardReview ctx={ctx} />
      </div>
    </BoardInternalsProvider>
  );
}

/** The dot grid before the canvas is up (loading, a read failure): the same SVG pattern React Flow draws. */
function DotGrid() {
  return (
    <svg className="bd-dots" aria-hidden="true">
      <defs><pattern id="bd-dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1" fill="var(--gx-hair-soft)" /></pattern></defs>
      <rect width="100%" height="100%" fill="url(#bd-dots)" />
    </svg>
  );
}
