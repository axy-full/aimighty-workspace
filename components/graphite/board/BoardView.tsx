"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ReactFlowProvider, useReactFlow, useStoreApi, type Viewport } from "@xyflow/react";
import { useRig } from "@/components/workspace/rig/RigProvider";
import { markBoardOpen } from "@/lib/board/active";
import { GLIDE_MS, glideEase } from "@/lib/board/ease";
import { DOCK_WIDTH, MAKE_WIDTH } from "@/lib/board/geometry";
import { railStatus } from "@/lib/board/regions";
import { moveFreeCards, type FreeMove } from "@/lib/board/snap";
import type { BoardBox, BoardKind, BoardSource, RegionId } from "@/lib/board/types";
import { readBoardView, saveBoardView } from "@/lib/board/view";
import { rigUndoSink } from "@/lib/shell/rig-commands";
import { useShell } from "@/lib/shell/state";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import type { Project } from "@/lib/workbench/studio";
import type { RoomPeer } from "@/lib/workbench/team-canvas-model";
import { BoardAgentDock, DOCK_PANEL, useBoardAgent } from "./agent";
import { BoardCanvas } from "./BoardCanvas";
import { BoardInternalsProvider, BoardSeams, type BoardInternals } from "./BoardContext";
import { buildRegistry } from "./cards";
import type { BoardCtx, BoardSelection } from "./cards/types";
import { BoardInspector } from "./inspector";
import { BOARD_MODULES } from "./kinds";
import { placeBoard } from "./layout-cards";
import { Rail, type BoardDrawer } from "./Rail";
import { BoardReview } from "./review";
import "./board.css";

/*
 * The board (`?view=board`, README § 1.1, § 3.1): one per project, the same
 * canvas whichever template started it (Studio, or stream 11's Ads and
 * Social through `kind`). The outline rail at the left; the canvas; the
 * docked Atomik panel at the right (stream 7); the Inspector over the right
 * edge on a selection (stream 5); Make's panel beside the dock when it is
 * open (the canvas keeps clear of it).
 *
 * It renders through the Rig's provider (components/workspace/rig/RigProvider):
 * the project draft with the team canvas folded in, its shots, jobs and
 * masters. Opening a board writes nothing.
 */
export type BoardViewProps = {
  scope: string;
  /** The shell's project (the board reads the Rig's live draft of it). */
  project: Project | null;
  /** The project's Library entries. */
  items: readonly LibraryEntry[];
  /** The project's Library state (lib/workspace/library useProjectLibrary), for the Library drawer. */
  library: unknown;
  kind: BoardKind;
  /** A design frame letter from an old or design link (lib/board/frames.ts), or null. */
  frame: string | null;
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

function Board({ scope, items, kind }: BoardViewProps) {
  useEffect(() => markBoardOpen(), []);
  const rig = useRig();
  const ws = useWorkspace();
  const shell = useShell();
  const flow = useReactFlow();
  const store = useStoreApi();
  const board = BOARD_MODULES[kind] ?? BOARD_MODULES.studio;
  const registry = useMemo(() => buildRegistry(board.sets), [board]);
  const agent = useBoardAgent();
  const project = rig.project;
  const [now] = useState(() => Date.now());

  const src = useMemo<BoardSource | null>(() => (project ? {
    kind, project, shots: rig.shots, jobs: rig.jobs, library: items, masters: rig.masters, agent: agent.run, now,
  } : null), [kind, project, rig.shots, rig.jobs, items, rig.masters, agent.run, now]);
  const cards = useMemo(() => (src ? registry.derive(src) : []), [registry, src]);
  const placed = useMemo(() => placeBoard(cards, registry.defs, board.bands, project?.aspect ?? "16:9"), [cards, registry.defs, board.bands, project?.aspect]);
  const status = useMemo(() => railStatus(board.rail, placed.cards), [board.rail, placed.cards]);

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
  const glide = useCallback((to: RegionId | { card: string }) => {
    const zoom = flow.getZoom();
    const box = typeof to === "string" ? placed.regions.get(to) ?? placed.slots.get(to) : placed.boxes.get(to.card);
    if (!box) return;
    const next = viewportFor(box, zoom, typeof to !== "string");
    void flow.setViewport(next, { duration: GLIDE_MS, ease: glideEase }).then(() => measureInView(next));
  }, [flow, measureInView, placed.boxes, placed.regions, placed.slots, viewportFor]);

  /* ── The first view: where this device left it, else the first section that needs you, else the top at 100 % ── */
  const projectId = project?.id ?? null;
  const opened = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready || !projectId || opened.current === projectId || !placed.bounds) return;
    opened.current = projectId;
    const saved = readBoardView(scope, projectId);
    const needs = board.rail.find((entry) => status.get(entry.id)?.state === "needs" && placed.regions.has(entry.id));
    const box = needs ? placed.regions.get(needs.id)! : placed.arranged ?? placed.bounds;
    const first = saved ?? viewportFor(box, 1);
    void flow.setViewport(first).then(() => measureInView(first));
  }, [flow, measureInView, board.rail, placed.arranged, placed.bounds, placed.regions, projectId, ready, scope, status, viewportFor]);
  const onMoveEnd = useCallback((viewport: Viewport) => {
    if (projectId) saveBoardView(scope, projectId, viewport);
    measureInView(viewport);
  }, [measureInView, projectId, scope]);

  /* ── Free cards let go: one edit through the Rig's draft, with ⌘Z ── */
  const onFreeMoved = useCallback((moves: FreeMove[]) => {
    const current = rig.project;
    if (!current) return;
    const before = moves.flatMap((move) => {
      const node = current.nodes.find((n) => n.id === move.id);
      return node ? [{ id: node.id, x: node.x, y: node.y }] : [];
    });
    const refusal = rig.apply((p) => moveFreeCards(p, moves));
    if (refusal) { ws.toast(refusal); return; }
    rigUndoSink()?.({ label: "The card is back where it was", projectId: current.id, undo: () => { rig.apply((p) => moveFreeCards(p, before)); } });
  }, [rig, ws]);

  /* ── The seams other streams provide (review mode: 5; Atomik's panel: 7) ── */
  const [seams] = useState(() => new BoardSeams());
  const [drawer, setDrawer] = useState<BoardDrawer | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const offline = false;

  const ctx = useMemo<BoardCtx | null>(() => (project ? {
    kind, scope, project, productionId: project.productionProjectId ?? null, offline, selection, select, glide,
    openInspector: (id: string) => select(id),
    openReview: (takeId?: string) => seams.call("review", takeId),
    askAtomik: (words: string) => seams.call("atomik", words),
    openMake: (type) => shell.openMake(type),
    toast: (text, undo) => {
      if (undo) rigUndoSink()?.({ label: undo.label, projectId: project.id, undo: undo.run });
      ws.toast(text);
    },
    rig,
  } : null), [glide, kind, offline, project, rig, scope, seams, select, selection, shell, ws]);

  const watchers = useMemo(() => {
    const out = new Map<string, RoomPeer>();
    for (const peer of rig.team.peers) if (!peer.agent && peer.selected && !out.has(peer.selected)) out.set(peer.selected, peer);
    return out;
  }, [rig.team.peers]);
  const atomik = useMemo(() => {
    const peer = rig.team.peers.find((p) => p.agent && p.selected);
    return peer?.selected && placed.byId.has(peer.selected) ? { card: peer.selected, doing: (peer.doing ?? "working on the board").replace(/^./, (c) => c.toLowerCase()), color: peer.color } : null;
  }, [placed.byId, rig.team.peers]);

  const dockWidth = DOCK_PANEL && dockOpen ? DOCK_WIDTH.open : DOCK_WIDTH.closed;
  const style = { "--board-dock": `${dockWidth}px`, "--board-make": shell.make ? `${MAKE_WIDTH}px` : "0px" } as CSSProperties;

  if (!project || !ctx) {
    const failed = rig.status === "error";
    return (
      <div className="bd" style={style} data-testid="board" data-state={failed ? "error" : "loading"}>
        <Rail rail={board.rail} status={status} inView={null} drawer={null} onGlide={() => {}} onDrawer={() => {}} />
        <div className="bd-main"><div className="bd-dots" aria-hidden="true" />
          {failed ? (
            <div className="bd-note" role="alert">The board could not be read.<button type="button" className="gx-hbtn" onClick={() => window.location.reload()}>Try again</button></div>
          ) : <p className="bd-note" role="status">Opening the board…</p>}
        </div>
      </div>
    );
  }

  const internals: BoardInternals = { placed, defs: registry.defs, ctx, watchers, atomik, seams };
  const primary = selection.primary ? placed.byId.get(selection.primary) ?? null : null;
  return (
    <BoardInternalsProvider value={internals}>
      <div className="bd" style={style} data-testid="board" data-board-kind={kind}>
        <Rail rail={board.rail} status={status} inView={inView} drawer={drawer} onGlide={glide} onDrawer={setDrawer} />
        <div className="bd-main" data-testid="board-canvas">
          <BoardCanvas placed={placed} selection={selection} onSelect={pick} onFreeMoved={onFreeMoved} readOnly={offline} onMoveEnd={onMoveEnd}
            onOpen={(id) => { const card = placed.byId.get(id); if (card) registry.defs.get(card.kind)?.onOpen?.(card, ctx); }}
            onReady={() => setReady(true)} />
        </div>
        <BoardAgentDock ctx={ctx} open={dockOpen} onOpenChange={setDockOpen} />
        <BoardInspector ctx={ctx} card={primary} def={primary ? registry.defs.get(primary.kind) ?? null : null} right={dockWidth} onClose={() => select(null)} />
        <BoardReview ctx={ctx} />
      </div>
    </BoardInternalsProvider>
  );
}
