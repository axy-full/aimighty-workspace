"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ReactFlowProvider, useReactFlow, useStoreApi, type Viewport } from "@xyflow/react";
import { useRig } from "@/components/workspace/rig/RigProvider";
import { markBoardOpen } from "@/lib/board/active";
import { GLIDE_MS, glideEase } from "@/lib/board/ease";
import { frameDrawer, frameRegion } from "@/lib/board/frames";
import { adsSocialRegion } from "@/lib/shell/ads-social";
import { DOCK_WIDTH, MAKE_WIDTH } from "@/lib/board/geometry";
import { boardKindOf } from "@/lib/board/kind";
import { useOnline } from "@/lib/board/online";
import { railStatus } from "@/lib/board/regions";
import { useBoardCommands } from "@/lib/board/commands";
import { canReorder, moved, reorderNodes, reorderSlot, siblingsOf, type ReorderSlot } from "@/lib/board/reorder";
import { addFreeCard, addFreeMedia, FREE_MEDIA_WIDTH, moveFreeCards, removeFreeCards, restoreFreeCards, type FreeMove } from "@/lib/board/snap";
import { tidyFree } from "@/lib/board/tidy";
import { isBoardKind, type BoardBox, type BoardKind, type BoardPoint, type BoardSource, type RegionId } from "@/lib/board/types";
import { readBoardView, saveBoardView } from "@/lib/board/view";
import { useMadeOnBoard } from "@/lib/board/made";
import { rigUndoSink } from "@/lib/shell/rig-commands";
import { withUndoHint } from "@/lib/shell/undo";
import { useShell } from "@/lib/shell/state";
import { useCompact } from "@/lib/shell/use-compact";
import { findProjectTake, libraryEntries, projectLibraryState, uploadFilesToProject, type LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { uid, type Asset, type Project } from "@/lib/workbench/studio";
import { assetFromUpload } from "@/lib/workspace/draft-editor";
import type { RoomPeer } from "@/lib/workbench/team-canvas-model";
import { withBoardText } from "@/lib/workspace/rig-board";
import { BoardAgentDock, DOCK_PANEL, useBoardAgent } from "./agent";
import { BoardCanvas } from "./BoardCanvas";
import { BoardInternalsProvider, BoardSeams, type BoardInternals } from "./BoardContext";
import { buildRegistry } from "./cards";
import { madeCards, type MadeEntry } from "./cards/set-board";
import { ShotList } from "./cards/board/ShotList";
import type { BoardCtx, BoardSelection } from "./cards/types";
import { EmptyBoard } from "./EmptyBoard";
import { HoverCluster } from "./HoverCluster";
import { BoardInspector } from "./inspector";
import { GapOverlays } from "./GapOverlays";
import { BOARD_MODULES, useKindExtra } from "./kinds";
import { placeBoard } from "./layout-cards";
import { Rail, type BoardDrawer } from "./Rail";
import { BoardReview } from "./review";
import { ToolPill, type BoardTool } from "./ToolPill";
import { PeerCursors, WhoIsHere } from "./Presence";
import { HistoryDrawer, LibraryDrawer, RenderDrawer } from "./drawers/Drawers";
import { addInput } from "@/lib/production/rig-build";
import { entryAsset } from "@/lib/production/sequence";
import { useSampleBoard, useSampleLift, useSampleWorkspace } from "@/lib/demo/use-sample";
import { CHECK_LINE, isSampleDraftId, LIFT_LINE } from "@/lib/demo/sample";
import { CheckAgain } from "../CheckAgain";
import { sampleGate } from "@/lib/demo/sample";
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
/** The rail's drawers are this wide (board.css `.bd-drawer`). */
const DRAWER_WIDTH = 280;
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
  /* Atomik's run on this production, for the plan card: stream 7's seam (the docked panel's one read of the board agent). */
  const agent = useBoardAgent().run;
  /* The explore-only sample (stream 12): its recorded prices, and the line every paid control carries. */
  const { board: sampleBoard } = useSampleBoard();
  const onSample = useMemo(() => sampleGate(project, sampleBoard?.sample ?? null), [project, sampleBoard]);
  /* In the sample workspace nothing spends on any board (the owner's switch): every paid control carries the line. */
  const spendOff = useSampleWorkspace();
  /* Save where the viewer lifted the mark for one run (lib/demo/lift.server.ts): their board may ask Atomik and approve
     that run's plan, on the run's own production. The server lets only that run through; everything else still refuses. */
  const lift = useSampleLift();
  const liftedHere = !!lift?.mine && !!project && !isSampleDraftId(project.id)
    && (lift.productionId == null || lift.productionId === (project.productionProjectId ?? null));
  const gate = useMemo(() => ({ exploreOnly: liftedHere ? null : onSample.exploreOnly ?? spendOff, readOnly: onSample.readOnly }), [liftedHere, onSample, spendOff]);
  /* While it is lifted the board's line says so (for anyone else its paid controls stay closed in the sample's words). */
  const pill = lift?.lifted && gate.exploreOnly !== CHECK_LINE ? LIFT_LINE : gate.exploreOnly;
  const sample = onSample.exploreOnly ? sampleBoard : null;

  /* An Ads or Social board's own session data (stream 11): pending site reads, the agent's runs. */
  const extra = useKindExtra(kind, project);
  const src = useMemo<BoardSource | null>(() => (project ? {
    kind, project, shots: rig.shots, jobs: rig.jobs, library: items, masters: rig.masters, extra, agent, sample, now,
  } : null), [kind, project, rig.shots, rig.jobs, items, rig.masters, extra, agent, sample, now]);
  /* What Make filed while this board was open (the "Made in Make" band; session only, never saved). */
  const [madeNow, setMadeNow] = useState<{ projectId: string; nodeId: string }[]>([]);
  const madeHere = useMemo<MadeEntry[]>(() => madeNow.filter((m) => m.projectId === project?.id).map((m) => ({ nodeId: m.nodeId })), [madeNow, project?.id]);
  const cards = useMemo(() => (src ? [...registry.derive(src), ...madeCards(src, madeHere)] : []), [madeHere, registry, src]);
  const placed = useMemo(() => placeBoard(cards, registry.defs, board.bands, project?.aspect ?? "16:9"), [cards, registry.defs, board.bands, project?.aspect]);
  const status = useMemo(() => railStatus(board.rail, placed.cards), [board.rail, placed.cards]);
  const empty = !!project && placed.cards.length === 0;

  /* A drawer opens from the design's frame letter, or from `drawer=` (Viral's History page is the Social board's History drawer: lib/shell/ads-social.ts). */
  const [drawer, setDrawer] = useState<BoardDrawer | null>(() => frameDrawer(frame) ?? (shell.params.drawer === "history" || shell.params.drawer === "library" || shell.params.drawer === "render" ? shell.params.drawer : null));
  /* ── Glides: a region's top-left to the canvas's top-left at this zoom, or a card to its middle ── */
  const viewportFor = useCallback((box: BoardBox, zoom: number, centre = false): Viewport => {
    const { width, height } = store.getState();
    /* A drawer lies over the canvas's left edge: what a glide brings into view stays clear of it. */
    const left = drawer ? DRAWER_WIDTH : 0;
    return centre
      ? { x: left + (width - left) / 2 - (box.x + box.w / 2) * zoom, y: height / 2 - (box.y + box.h / 2) * zoom, zoom }
      : { x: left + INSET - box.x * zoom, y: INSET - box.y * zoom, zoom };
  }, [drawer, store]);
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

  /* ── Selection: the board's own; a card that draws a canvas node is the workspace's selection too ── */
  const [selection, setSelection] = useState<BoardSelection>(NO_SELECTION);
  const pick = useCallback((ids: ReadonlySet<string>, primary: string | null) => {
    /* A card in the Made in Make band stands for its shot: pressing it goes to the shot, which is the card that opens. */
    const made = primary ? placed.byId.get(primary) : undefined;
    const shot = made?.kind === "made" && made.nodeId && placed.byId.has(made.nodeId) ? made.nodeId : null;
    if (shot) { glide({ card: shot }); ids = new Set([shot]); primary = shot; }
    setSelection(ids.size ? { primary, ids } : NO_SELECTION);
    const card = primary ? placed.byId.get(primary) : undefined;
    if (card?.nodeId) rig.select(card.nodeId);
  }, [glide, placed.byId, rig]);
  const select = useCallback((id: string | null, opts?: { add?: boolean }) => {
    if (!id) { pick(new Set(), null); return; }
    pick(opts?.add ? new Set([...selection.ids, id]) : new Set([id]), id);
  }, [pick, selection.ids]);

  /* ── The first view: an old link's region; where this device left it; the first section that needs you; the top at 100 % ── */
  const projectId = project?.id ?? null;
  const opened = useRef<string | null>(null);
  /* The take the address named when the board opened (the Workspace's selection, which a later list read may clear). */
  const asset = useRef<string | null>(shell.asset);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready || !projectId || opened.current === projectId || !placed.bounds) return;
    opened.current = projectId;
    const kindRegion = adsSocialRegion(kind, frame, shell.params.card);
    const linked = (region && board.rail.some((entry) => entry.id === region) ? region as RegionId : null) ?? frameRegion(frame) ?? (kindRegion && board.rail.some((entry) => entry.id === kindRegion) ? kindRegion as RegionId : null);
    const saved = linked ? null : readBoardView(scope, projectId);
    const needs = board.rail.find((entry) => status.get(entry.id)?.state === "needs" && placed.regions.has(entry.id));
    const target = linked ? placed.regions.get(linked) ?? placed.slots.get(linked) : needs ? placed.regions.get(needs.id) : null;
    /* A link to a take (`asset=`: a copied link, Open in Takes, a jobs-tray Open): the shot card holding that take opens first and is selected. */
    const linkedTake = asset.current ? placed.cards.find((c) => c.kind === "take" && (c.data as { row?: { versions?: { id: string }[] } } | undefined)?.row?.versions?.some((v) => v.id === asset.current)) : undefined;
    const box = linkedTake ? placed.boxes.get(linkedTake.id) : null;
    const first = box ? viewportFor(box, 1, true) : saved ?? viewportFor(target ?? placed.arranged ?? placed.bounds, 1);
    void flow.setViewport(first).then(() => { measureInView(first); if (linkedTake) select(linkedTake.id); });
  }, [board.rail, flow, frame, kind, measureInView, placed.arranged, placed.bounds, placed.boxes, placed.cards, placed.regions, placed.slots, projectId, ready, region, scope, select, shell.params.card, status, viewportFor]);
  const onMoveEnd = useCallback((viewport: Viewport) => {
    if (projectId) saveBoardView(scope, projectId, viewport);
    measureInView(viewport);
  }, [measureInView, projectId, scope]);

  /* ── Edits a person makes on the board: each one draft edit, free, with ⌘Z ── */
  const undoable = useCallback((label: string, undo: () => void, say?: string) => {
    if (project) rigUndoSink()?.({ label, projectId: project.id, undo, ...(say ? { say } : {}) });
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
  /* Tidy: the free cards in one block, in canvas order, on the dots; one edit, with Undo. Arranged cards are always in order. */
  const freeCards = useMemo(() => placed.cards.filter((card) => !card.region && card.nodeId), [placed.cards]);
  const tidy = useCallback((): boolean => {
    const current = rig.project;
    if (!current || offline) return false;
    const order = new Map(current.nodes.map((node, i) => [node.id, i]));
    const nodes = new Map(current.nodes.map((node) => [node.id, node]));
    const sized = freeCards
      .map((card) => ({ card, node: nodes.get(card.nodeId!), box: placed.boxes.get(card.id) }))
      .filter((entry): entry is { card: typeof entry.card; node: NonNullable<typeof entry.node>; box: NonNullable<typeof entry.box> } => !!entry.node && !!entry.box)
      .sort((a, b) => (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0));
    const moves = tidyFree(sized.map(({ node, box }) => ({ id: node.id, w: box.w, h: box.h, x: node.x, y: node.y, locked: !!node.locked })));
    if (!moves.length) { ws.toast(sized.length ? "Nothing to tidy · the free cards are already in order" : "Nothing to tidy · there are no free cards"); return true; }
    const before = moves.flatMap((move) => { const node = nodes.get(move.id); return node ? [{ id: node.id, x: node.x, y: node.y }] : []; });
    const refusal = rig.apply((p) => moveFreeCards(p, moves));
    if (refusal) { ws.toast(refusal); return true; }
    undoable("The cards are back where they were", () => { rig.apply((p) => moveFreeCards(p, before)); });
    /* The block lands right of the bands: if it is not in view, the board goes to it. */
    const sizes = new Map(sized.map(({ node, box }) => [node.id, box]));
    const block = moves.reduce<BoardBox | null>((acc, move) => {
      const box = sizes.get(move.id)!;
      const at = { x: move.x, y: move.y, w: box.w, h: box.h };
      if (!acc) return at;
      const x = Math.min(acc.x, at.x), y = Math.min(acc.y, at.y);
      return { x, y, w: Math.max(acc.x + acc.w, at.x + at.w) - x, h: Math.max(acc.y + acc.h, at.y + at.h) - y };
    }, null);
    if (block) {
      const { width, height, transform } = store.getState();
      const [vx, vy, zoom] = transform;
      const seen = block.x * zoom + vx >= 0 && block.y * zoom + vy >= 0 && (block.x + block.w) * zoom + vx <= width && (block.y + block.h) * zoom + vy <= height;
      if (!seen) {
        const next = viewportFor(block, zoom, block.w * zoom <= width && block.h * zoom <= height);
        void flow.setViewport(next, { duration: GLIDE_MS, ease: glideEase }).then(() => measureInView(next));
      }
    }
    ws.toast(`Tidied · ${moves.length === 1 ? "1 card" : `${moves.length} cards`} moved · free`);
    return true;
  }, [flow, freeCards, measureInView, offline, placed.boxes, rig, store, undoable, viewportFor, ws]);

  /* Reorder: a shot or a reference dragged to a new place in its frame is one edit to the draft's order (shot order is draft order). */
  const reorder = useMemo(() => offline ? undefined : {
    can: (id: string) => { const card = placed.byId.get(id); return !!card && canReorder(card); },
    slot: (id: string, point: BoardPoint): ReorderSlot | null => {
      const card = placed.byId.get(id);
      if (!card || !canReorder(card)) return null;
      const siblings = siblingsOf(placed.cards, card).flatMap((s) => { const box = placed.boxes.get(s.id); return box ? [{ id: s.id, box }] : []; });
      return reorderSlot(siblings, id, point);
    },
    commit: (id: string, slot: ReorderSlot) => {
      const current = rig.project, card = placed.byId.get(id);
      if (!current || !card?.nodeId) return;
      const group = siblingsOf(placed.cards, card).map((s) => s.nodeId!);
      const was = [...group].sort((a, b) => current.nodes.findIndex((n) => n.id === a) - current.nodes.findIndex((n) => n.id === b));
      const next = moved(was, card.nodeId, slot.index);
      const refusal = rig.apply((p) => reorderNodes(p, next));
      if (refusal) { ws.toast(refusal); return; }
      undoable("The order is back as it was", () => { rig.apply((p) => reorderNodes(p, was)); });
    },
  }, [offline, placed.boxes, placed.byId, placed.cards, rig, undoable, ws]);
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
  /* Free media cards: pictures and videos added with Upload or let go on the canvas; one edit, with Undo. Other files stay in the Library. */
  const addMedia = useCallback((assets: Asset[], at: BoardPoint): number => {
    const current = rig.project;
    const wanted = assets.filter((a) => a.kind === "image" || a.kind === "video");
    if (!current || !wanted.length) return 0;
    const ids = wanted.map(() => uid("node"));
    const refusal = rig.apply((p) => wanted.reduce((acc, asset, i) => addFreeMedia(acc, asset, { x: at.x + i * 24, y: at.y + i * 24 }, ids[i]), p));
    if (refusal) { ws.toast(refusal); return 0; }
    undoable("The cards are off the board", () => { rig.apply((p) => removeFreeCards(p, ids).project); });
    pick(new Set([ids[ids.length - 1]]), ids[ids.length - 1]);
    return wanted.length;
  }, [pick, rig, undoable, ws]);
  /* A dropped take this board's loaded Library does not hold yet (a search hit past the loaded pages): loaded by id first
     (lib/workspace/library.ts findProjectTake). One that is not this board's at all says so instead of doing nothing. */
  const entryFor = useCallback(async (key: string): Promise<LibraryEntry | null> => {
    const found = items.find((e) => e.take.id === key);
    if (found || !projectId) return found ?? null;
    if (!(await findProjectTake(scope, projectId, key))) return null;
    return libraryEntries(projectLibraryState(scope, projectId)).find((e) => e.take.id === key) ?? null;
  }, [items, projectId, scope]);
  const NOT_HERE = "That file is not in this board's Library. Open its own board to use it, or upload it here.";
  const dropFile = useCallback(async (key: string, at: BoardPoint) => {
    const entry = await entryFor(key);
    if (!entry) { ws.toast(NOT_HERE); return; }
    if (entry.media !== "image" && entry.media !== "video") { ws.toast("Only pictures and videos go on the board. Other files stay in the Library."); return; }
    addMedia([entryAsset(entry)], { x: at.x - FREE_MEDIA_WIDTH / 2, y: at.y - 114 });
  }, [addMedia, entryFor, ws]);
  const upload = useCallback(async (list: FileList | null) => {
    if (!list?.length || !project) return;
    const picked = [...list];
    try {
      const { ids, uploads, notes } = await uploadFilesToProject(scope, project.id, picked);
      /* Each picture or video lands on the board at the middle of what is in view. */
      const { width, height, transform } = store.getState();
      const [vx, vy, zoom] = transform;
      const centre = { x: (width / 2 - vx) / zoom - FREE_MEDIA_WIDTH / 2, y: (height / 2 - vy) / zoom - 114 };
      const assets = uploads.flatMap((stored) => { const file = picked.find((f) => f.name === stored.filename) ?? picked[0]; return file ? [assetFromUpload(file, stored, "Take")] : []; });
      const placed = addMedia(assets, centre);
      ws.toast(notes.length ? notes.join(" ") : `${ids.length === 1 ? "1 file" : `${ids.length} files`} added to the Library${placed ? ` · ${placed === 1 ? "1 card" : `${placed} cards`} on the board` : ""}`);
    } catch (error) {
      ws.toast(error instanceof Error ? error.message : "The files could not be uploaded.");
    } finally {
      if (files.current) files.current.value = "";
    }
  }, [addMedia, project, scope, store, ws]);
  const chooseTool = useCallback((next: BoardTool) => {
    if (next === "image" || next === "video" || next === "audio") { shell.openMake(next); setTool("select"); return; }
    if (next === "upload") { files.current?.click(); setTool("select"); return; }
    if (next === "frame") return;
    setTool(next);
  }, [shell]);

  /* ── The board's keys (README § 6): V F N T I ⇧V ⇧A U, 0 (fit), L (list), ⌫, Esc; never while typing ── */
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

  /* ── The same, said by name (⌘K, Atomik's palette): each runs the code its button runs ── */
  useBoardCommands((command) => {
    if (compact) return false;
    switch (command.name) {
      case "tidy": return tidy();
      case "fit": void flow.fitView({ padding: 0.08, duration: GLIDE_MS, ease: glideEase }); return true;
      case "list": setList(true); return true;
      case "board": setList(false); return true;
      case "glide": glide(command.to); return true;
      case "library": setDrawer("library"); return true;
    }
  });

  /* ── A Make result landing (README § 3.2 made): glide to its card, light it for a moment, the Library open on it ── */
  const [lit, setLit] = useState<string | null>(null);
  const litTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [landing, setLanding] = useState<string | null>(null);
  useMadeOnBoard(projectId, (made) => {
    setMadeNow((was) => (was.some((m) => m.projectId === made.projectId && m.nodeId === made.nodeId) ? was : [...was, { projectId: made.projectId, nodeId: made.nodeId }]));
    setLanding(`made:${made.nodeId}`);
    setDrawer("library");
  });
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
    kind, scope, project, productionId: project.productionProjectId ?? null, offline, readOnly: gate.readOnly, exploreOnly: gate.exploreOnly, selection, select, glide,
    openInspector: (id: string) => select(id),
    openReview: (takeId?: string) => seams.call("review", takeId),
    askAtomik: (words: string) => seams.call("atomik", words),
    openMake: (type) => shell.openMake(type),
    /* A step a person can take back is said with its Undo (the shell's toast, top right), and ⌘Z does the same. */
    toast: (text, undo) => { if (undo) undoable(undo.label, undo.run, withUndoHint(text)); else ws.toast(text); },
    rig,
  } : null), [gate.exploreOnly, gate.readOnly, glide, kind, offline, project, rig, scope, seams, select, selection, shell, undoable, ws]);

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
  const dropOn = async (cardId: string, data: DataTransfer) => {
    const card = placed.byId.get(cardId);
    const def = card ? registry.defs.get(card.kind) : undefined;
    let key = "";
    try { key = data.getData("text/plain"); } catch { /* unreadable */ }
    if (!card || !def?.accepts || !key) return;
    const entry = await entryFor(key);
    if (!entry) { ws.toast(NOT_HERE); return; }
    const action = def.accepts({ type: "asset", assetId: entry.take.id, media: entry.media }, card);
    if (!action) { ws.toast("That card does not take this file."); return; }
    const shot = project.nodes.find((n) => n.id === action.shotId);
    const refusal = rig.apply((p) => addInput(p, action.shotId, entryAsset(entry)));
    ws.toast(refusal ?? `${entry.take.name} is a reference for ${shot?.title ?? "the shot"}`);
  };
  const internals: BoardInternals = { placed, defs: registry.defs, ctx, watchers, atomik, seams, editing, finishEdit, takesDrops, dropOn, lit };
  /* A rail drawer: the Library, or History (Viral's History page opens here, on a phone too, where it covers the list). */
  const drawerEl = drawer === "library" ? <LibraryDrawer items={items} project={project} onClose={() => setDrawer(null)} />
          : drawer === "history" && board.HistoryDrawer ? <board.HistoryDrawer ctx={ctx} items={items} onClose={() => setDrawer(null)} />
          : drawer === "history" ? <HistoryDrawer scope={scope} productionId={project.productionProjectId ?? null} jobs={rig.jobs} project={project} onClose={() => setDrawer(null)} onOpen={(nodeId) => { glide({ card: nodeId }); select(nodeId); }} />
          : drawer === "render" && kind === "studio" ? <RenderDrawer scope={scope} project={project} save={rig.save} blocked={gate.readOnly ?? gate.exploreOnly ?? null} onClose={() => setDrawer(null)} /> : null;
  if (compact) {
    return (
      <BoardInternalsProvider value={internals}>
        <div className="bd bd--compact" data-testid="board" data-board-kind={kind} data-sample={gate.exploreOnly ? "1" : undefined}>
          {pill ? <p className="bd-sample bd-sample--list" role="status" data-testid="board-sample" data-lifted={pill === LIFT_LINE || undefined}>{pill}{pill === CHECK_LINE ? <> <CheckAgain className="bd-link" /></> : null}</p> : null}
          <List ctx={ctx} cards={placed.cards} />{drawerEl}
        </div>
      </BoardInternalsProvider>
    );
  }
  const primary = selection.primary ? placed.byId.get(selection.primary) ?? null : null;
  const regionBoxes = board.rail.flatMap((entry) => { const box = placed.regions.get(entry.id); return box ? [box] : []; });
  return (
    <BoardInternalsProvider value={internals}>
      <div className="bd" style={style} data-testid="board" data-board-kind={kind} data-tool={tool} data-offline={offline || undefined} data-sample={gate.exploreOnly ? "1" : undefined}>
        <Rail rail={board.rail} status={status} inView={list ? null : inView} drawer={drawer} onGlide={glide} onDrawer={setDrawer} render={kind === "studio"} />
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
              onReady={() => setReady(true)} onPresence={live ? onPresence : undefined} peerDrags={peerDrags} reorder={reorder} onDropFile={offline ? undefined : dropFile}>
              <PeerCursors peers={peers} />
            </BoardCanvas>
          )}
          {empty && !list && board.Empty ? <board.Empty ctx={ctx} /> : empty && !list && kind === "studio" ? <EmptyBoard ctx={ctx} /> : null}
          {list ? null : <ToolPill tool={tool} readOnly={offline} onTool={chooseTool} />}
          <HoverCluster regions={regionBoxes} bounds={placed.bounds} list={list} onList={setList} onTidy={freeCards.length && !offline ? tidy : undefined} />
          {offline ? <p className="bd-offline" role="status">Offline · changes queue</p> : null}
          {pill ? <p className="bd-sample" role="status" data-testid="board-sample" data-lifted={pill === LIFT_LINE || undefined}>{pill}{pill === CHECK_LINE ? <> <CheckAgain className="bd-link" /></> : null}</p> : null}
          {live ? <WhoIsHere peers={peers} /> : null}
          <input ref={files} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
        </div>
        {drawerEl}
        <BoardAgentDock ctx={ctx} open={dockOpen} onOpenChange={setDockOpen} />
        <BoardInspector ctx={ctx} card={primary} def={primary ? registry.defs.get(primary.kind) ?? null : null} right={dockWidth} onClose={() => select(null)} />
        <BoardReview ctx={ctx} />
        <GapOverlays ctx={ctx} />
        {board.Overlay ? <board.Overlay ctx={ctx} /> : null}
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
