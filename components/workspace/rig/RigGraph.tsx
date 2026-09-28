"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { nodeDef, operationsFor, resolveAsset } from "@/lib/workbench/node-graph";
import { REF_KIND_LABELS, refKindOf } from "@/lib/workbench/ref-kind";
import { uid, type Asset, type CanvasNode, type RefKind } from "@/lib/workbench/studio";
import { mediaBands } from "@/lib/workspace/format";
import { cardHeight, cardWidth, edgePath, graphEdges, graphLayout, GRAPH_PAD, type Box } from "@/lib/workspace/rig-graph";
import { addBoardCard, BOARD_GRID, boardSections, cardStatus, dragShown, dropCard, isSectionNode, withBoardText, type CardTone } from "@/lib/workspace/rig-board";
import { BoardEditor, BoardTools, EditButton, SectionCard, type BoardField } from "./RigBoard";
import { canDropOnShot, dropOnShot } from "@/lib/shell/drop-targets";
import { isShotNode, shotNote, type RigShot } from "@/lib/workspace/shots";
import { useWorkspace } from "@/lib/workspace/state";
import { useRig } from "./RigProvider";
import { rigLoadState } from "@/lib/workspace/rig-load-state";
import LazyMedia from "@/components/LazyMedia";
import { assetPreview, previewAttrs } from "@/lib/preview";
import type { Drag, Peer } from "./use-team-canvas";
import { DEFAULT_VIEW, boardHeight, distance, fitView, loadView, midpoint, panBy, pinchView, resetZoom, saveView, stepZoom, viewKey, wheelFactor, zoomAround, type View } from "@/lib/viewport";

/** A take's or reference's preview, else the flat bands that stand in for media. */
function Media({ id, asset, height, badge }: { id: string; asset: Asset | undefined; height: number; badge?: boolean }) {
  const [c1, c2] = mediaBands(id);
  const full = assetPreview(asset);
  const preview = full?.kind === "video" ? null : asset?.generationId ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset?.uploadId ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}`
    : asset?.kind === "image" ? asset.url : null;
  return (
    <span className="pxw-graph-media" style={{ height }} {...previewAttrs(full)}>
      <span style={{ flex: 1, background: c1 }} />
      <span style={{ flex: 1.1, background: c2 }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview ? <img src={preview} alt="" loading="lazy" decoding="async" /> : null}
      {full?.kind === "video" ? <span className="pxw-thumb-video"><LazyMedia url={full.url} kind="video" preview={false} /></span> : null}
      {badge ? <span className="pxw-graph-badge">SCENE PREVIEW</span> : null}
    </span>
  );
}

/** The preview well's height by card shape: a take, a source or what a finishing card works on, at a glance. */
const WELL = { scene: 96, reference: 72, operator: 56, flow: 56 } as const;
const TONE: Record<CardTone, string> = { green: "var(--pxw-green)", gold: "var(--pxw-atomik-gold)", red: "var(--pxw-red-ink)", blue: "var(--pxw-blue-ink)", floor: "var(--pxw-label-floor)" };

function Card({ node, kind, shot, asset, selected, wiring, editing, onSelect, onWireFrom, onWireInto, onEdit, onCommit, onCancel }: {
  node: CanvasNode; kind: RefKind | null; shot: RigShot | undefined; asset: Asset | undefined; selected: boolean; wiring: boolean; editing: boolean;
  onSelect: () => void; onWireFrom: () => void; onWireInto: () => void; onEdit: () => void; onCommit: (value: string) => void; onCancel: () => void;
}) {
  const def = nodeDef(node.type);
  const isShot = !!shot;
  /* A note is its words: edited right on the card. */
  const note = node.type === "note";
  const text = isShot ? shotNote(node) : (node.text ?? "").trim();
  const well = def.shape === "text" ? null : WELL[def.shape];
  const grade = node.type === "grade" ? operationsFor(node).find((op) => op.kind === "grade") : undefined;
  const status = cardStatus(node, shot?.status, !!asset);
  const version = asset ? `v${asset.version}` : `v${(node.versions?.length ?? 0) + 1}`;
  return (
    <>
      {/* Every card is picked (and dragged) by its face: a shot into the shot Inspector, any other card into the Card Inspector. */}
      <button type="button" className="pxw-graph-hit" aria-pressed={selected} aria-label={`Select ${node.title}`} onClick={onSelect} onDoubleClick={note && !node.locked ? onEdit : undefined} />
      {/* A reference says what it is to the production (Cast, Environment, Element or Ref); a shot, its type and number; any other card, its type. */}
      <span className="pxw-graph-kicker">
        <span className="pxw-graph-kicker-label">
          {kind ? <span className="pxw-graph-kind" data-functional-label="">{REF_KIND_LABELS[kind].toUpperCase()}</span> : <span>{def.label.toUpperCase()}</span>}
          {shot ? <span className="pxw-graph-code" data-functional-label="">{String(shot.index).padStart(2, "0")}</span> : null}
        </span>
        {note ? null : <span>{version}</span>}
      </span>
      {note && !editing && !node.locked ? <EditButton label={`Edit note ${node.title}`} onEdit={onEdit} /> : null}
      {well ? <Media id={node.id} asset={asset} height={well} badge={isShot && selected} /> : null}
      <span className="pxw-graph-title">{node.title}</span>
      {editing ? (
        <BoardEditor field="text" value={node.text ?? ""} label={`Note: ${node.title}`} onCommit={onCommit} onCancel={onCancel} />
      ) : grade ? (
        <span className="pxw-graph-readouts">
          {([["B", "brightness"], ["C", "contrast"], ["S", "saturation"]] as const).map(([k, v]) => (
            <span key={k}><span>{k}</span><span>{String(grade.values[v] ?? 100)}</span></span>
          ))}
        </span>
      ) : text ? <span className={note ? "pxw-graph-desc pxw-graph-note-text" : "pxw-graph-desc"}>{text}</span>
        : note ? <span className="pxw-graph-desc pxw-graph-note-text pxw-graph-placeholder">Nothing written yet.</span> : null}
      <span className="pxw-graph-foot">
        <span className="pxw-dot" style={{ width: 5, height: 5, background: TONE[status.tone] }} />
        {status.word ? <span className="pxw-graph-status" data-tone={status.tone} data-functional-label="">{status.word}</span> : null}
        {status.detail ? <span className="pxw-graph-detail">{status.detail}</span> : null}
      </span>
      <button type="button" className="pxw-graph-port pxw-graph-port--in" aria-label={`Connect into ${node.title}`} data-armed={wiring || undefined} onClick={onWireInto} />
      <button type="button" className="pxw-graph-port pxw-graph-port--out" aria-label={`Connect from ${node.title}`} onClick={onWireFrom} />
    </>
  );
}

/** The height of the zoom cluster's strip at the bottom of the board (cluster 44 + inset 12). */
const ZOOM_STRIP = 56;
/** The space Fit keeps around the fitted cards (lib/viewport.ts fitView's margin). */
const FIT_MARGIN = 48;

/** The pane the board scrolls in: the nearest ancestor that really scrolls (a wrapper that grows with its content computes overflow-y:auto too), else the outermost one that could. */
function boardPane(el: HTMLElement): HTMLElement | null {
  let outer: HTMLElement | null = null;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (node.scrollHeight > node.clientHeight + 1) return node;
    outer = node;
  }
  return outer;
}

/** Rig — node graph (the advanced view of the same shots). */
export function RigGraph() {
  const rig = useRig();
  const { state } = useWorkspace();
  const project = rig.project;
  const nodes = useMemo(() => project?.nodes ?? [], [project]);
  const layout = useMemo(() => graphLayout(nodes), [nodes]);
  const edges = useMemo(() => graphEdges(nodes), [nodes]);
  const shotsById = useMemo(() => new Map(rig.shots.map((s) => [s.id, s])), [rig.shots]);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const assets = useMemo(() => (project ? [...project.assets, ...(project.sharedAssets ?? [])] : []), [project]);
  /* The picked card: a shot, or any other card on the canvas. */
  const selId = state.selKind === "shot" || state.selKind === "node" ? state.selId : null;

  const [wireFrom, setWireFrom] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);

  /* ── The viewport: zoom about the cursor and pan, remembered per project on this device ── */
  const surface = useRef<HTMLDivElement | null>(null);
  const storeKey = project ? viewKey(rig.scope, project.id) : null;
  const [viewState, setViewState] = useState<{ key: string | null; view: View }>({ key: null, view: DEFAULT_VIEW });
  if (storeKey !== viewState.key) setViewState({ key: storeKey, view: (storeKey && loadView(storeKey)) || DEFAULT_VIEW });
  const view = viewState.key === storeKey ? viewState.view : DEFAULT_VIEW;
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const setView = useCallback((next: View | ((v: View) => View)) => {
    setViewState((cur) => {
      const v = typeof next === "function" ? next(cur.view) : next;
      return v === cur.view ? cur : { ...cur, view: v };
    });
  }, [setViewState]);
  useEffect(() => { if (storeKey) saveView(storeKey, view); }, [storeKey, view]);
  /* Positions are drawn relative to the top-left node; when that corner moves (a node dragged
     past it, one added beyond it) the pan absorbs the shift, so nothing jumps on screen. */
  const origin = useMemo(() => (nodes.length ? { x: Math.min(...nodes.map((n) => n.x)), y: Math.min(...nodes.map((n) => n.y)) } : null), [nodes]);
  const lastOrigin = useRef(origin);
  useEffect(() => {
    const before = lastOrigin.current;
    lastOrigin.current = origin;
    if (!before || !origin || (before.x === origin.x && before.y === origin.y)) return;
    setView((v) => ({ ...v, pan: { x: v.pan.x + (origin.x - before.x) * v.zoom, y: v.pan.y + (origin.y - before.y) * v.zoom } }));
  }, [origin, setView]);
  const surfacePoint = (e: { clientX: number; clientY: number }) => {
    const box = surface.current?.getBoundingClientRect();
    return box ? { x: e.clientX - box.left, y: e.clientY - box.top } : { x: 0, y: 0 };
  };
  const centre = () => {
    const box = surface.current?.getBoundingClientRect();
    return box ? { x: box.width / 2, y: box.height / 2 } : { x: 0, y: 0 };
  };
  const tools = useRef<HTMLDivElement | null>(null);
  const fit = useCallback(() => {
    const root = canvas.current, box = surface.current?.getBoundingClientRect();
    if (!root || !box) return;
    const boxes = Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]")).map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
    /* Fit into the board above the zoom cluster's strip, and below the add buttons at its top-left: the fit's own margin
       clears most of them, so only what reaches past it is kept free (a phone's board is short). No fitted node sits under either. */
    const top = tools.current ? Math.max(0, tools.current.offsetTop + tools.current.offsetHeight + 4 - FIT_MARGIN) : 0;
    const fitted = fitView(boxes, { w: box.width, h: box.height - ZOOM_STRIP - top }, FIT_MARGIN);
    setView({ ...fitted, pan: { x: fitted.pan.x, y: fitted.pan.y + top } });
  }, [setView]);
  /* A native wheel listener (React's is passive, so it could not stop the page zooming):
     pinch or ⌘/ctrl-wheel zooms about the cursor, a plain wheel pans. */
  const attachSurface = useCallback((el: HTMLDivElement | null) => {
    const prev = surface.current as (HTMLDivElement & { __wheel?: (e: WheelEvent) => void }) | null;
    if (prev?.__wheel) prev.removeEventListener("wheel", prev.__wheel);
    surface.current = el;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      /* A note being written scrolls its own words. */
      if ((e.target as HTMLElement | null)?.closest?.(".pxw-graph-editor")) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const at = { x: e.clientX - box.left, y: e.clientY - box.top };
      if (e.ctrlKey || e.metaKey) { setView((v) => zoomAround(v, at, wheelFactor(e.deltaY, e.deltaMode))); return; }
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.height : 1;
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * scale, dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * scale;
      setView((v) => panBy(v, dx, dy));
    };
    (el as HTMLDivElement & { __wheel?: (e: WheelEvent) => void }).__wheel = onWheel;
    el.addEventListener("wheel", onWheel, { passive: false });
  }, [setView]);
  /* Drag the empty board to pan; two fingers pinch. A press on a card is the card's own. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "pan"; from: { x: number; y: number }; view: View } | { kind: "pinch"; view: View; dist: number; mid: { x: number; y: number } } | null>(null);
  const onSurfaceDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const onCard = !!target.closest(".pxw-graph-node, .pxw-graph-zoom, .pxw-graph-tools");
    pointers.current.set(e.pointerId, surfacePoint(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      /* A second finger turns a take's drag into a pinch: the take goes back where it was, for teammates too. */
      if (press.current?.moved) { setDrag(null); presence({ drag: null }); }
      press.current = null;
      gesture.current = { kind: "pinch", view: viewRef.current, dist: distance(a, b), mid: midpoint(a, b) };
      return;
    }
    if (onCard || (e.button !== 0 && e.button !== 1)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gesture.current = { kind: "pan", from: surfacePoint(e), view: viewRef.current };
  };
  const onSurfaceMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, surfacePoint(e));
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      setView(pinchView(g, distance(a, b), midpoint(a, b)));
    } else if (g.kind === "pan") {
      const at = surfacePoint(e);
      setView({ ...g.view, pan: { x: g.view.pan.x + at.x - g.from.x, y: g.view.pan.y + at.y - g.from.y } });
    }
  };
  const onSurfaceUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2 && gesture.current?.kind === "pinch") gesture.current = null;
    if (!pointers.current.size) gesture.current = null;
  };
  /* The board fills what is left of its pane below it, and no more than the pane shows above a phone's tab
     bar (lib/viewport.ts boardHeight). The pane keeps that bar clear with bottom padding, which does not
     scroll content that overflows the page's own wrapper, so the graph carries the same clearance under
     itself: the zoom controls always scroll clear of the bar. */
  const [sized, setSized] = useState<{ height: number; clearance: number } | null>(null);
  const statusShown = Boolean(wireFrom || message);
  useLayoutEffect(() => {
    const size = () => {
      const el = surface.current;
      if (!el) return;
      const pane = boardPane(el);
      const box = pane?.getBoundingClientRect();
      const clearance = pane ? Number.parseFloat(getComputedStyle(pane).paddingBottom) || 0 : 0;
      const height = boardHeight(
        box ? { top: box.top, bottom: box.bottom, padBottom: clearance } : { top: 0, bottom: window.innerHeight, padBottom: 0 },
        el.getBoundingClientRect().top + (pane ? pane.scrollTop : window.scrollY),
        window.innerHeight,
      );
      setSized((was) => (was && was.height === height && was.clearance === clearance ? was : { height, clearance }));
    };
    size();
    window.addEventListener("resize", size);
    /* The pane moves and resizes as the rows above it settle (a price arriving in the page head). */
    const pane = surface.current ? boardPane(surface.current) : null;
    const observer = pane && typeof ResizeObserver !== "undefined" ? new ResizeObserver(size) : null;
    if (pane) observer?.observe(pane);
    return () => { window.removeEventListener("resize", size); observer?.disconnect(); };
  }, [project?.id, statusShown]);
  /* ⌘0 fits every node, ⌘= / ⌘- step; typing in a field keeps the browser's own keys. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !surface.current) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === "0") { e.preventDefault(); fit(); }
      else if (e.key === "=" || e.key === "+") { e.preventDefault(); setView((v) => stepZoom(v, 1, centre())); }
      else if (e.key === "-") { e.preventDefault(); setView((v) => stepZoom(v, -1, centre())); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fit, setView]);

  /* ── The team on the canvas: cursors, selections and drags (live rooms only) ── */
  const { presence, peers } = rig.team;
  useEffect(() => { presence({ selected: selId }); }, [presence, selId]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const press = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  /* A pointer in canvas units: the canvas box already carries the pan, so only the zoom is divided out. */
  const point = (e: { clientX: number; clientY: number }) => {
    const box = canvas.current?.getBoundingClientRect();
    const z = viewRef.current.zoom;
    return box ? { x: Math.round((e.clientX - box.left) / z), y: Math.round((e.clientY - box.top) / z) } : null;
  };
  /* Move a node by dragging its card; a press that does not travel stays a click. */
  const startDrag = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0 || !(e.target as HTMLElement).closest(".pxw-graph-hit")) return;
    press.current = { id, x: e.clientX, y: e.clientY, moved: false };
  };
  /* The cards as drawn now, for a drag to measure from. */
  const placed = useRef(new Map<string, CanvasNode>());
  useEffect(() => { placed.current = new Map(nodes.map((n) => [n.id, n])); }, [nodes]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      const z = viewRef.current.zoom;
      if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
      const travel = { dx: Math.round((e.clientX - p.x) / z), dy: Math.round((e.clientY - p.y) / z) };
      p.moved = true;
      /* The card shows where it will land: on the 20 px grid, or exactly under the pointer with Alt held. */
      const from = placed.current.get(p.id);
      const next = { id: p.id, ...(from ? dragShown(from, travel, e.altKey) : travel) };
      setDrag(next);
      presence({ drag: next });
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p?.moved) return;
      const z = viewRef.current.zoom;
      const dx = Math.round((e.clientX - p.x) / z), dy = Math.round((e.clientY - p.y) / z);
      /* The click the browser fires for this release is the drag's own; a release off the card (or a finger's)
         fires none on it, so the flag goes after this task and the next click is the person's. */
      justDragged.current = true;
      window.setTimeout(() => { justDragged.current = false; }, 0);
      setDrag(null);
      presence({ drag: null });
      /* It lands on the grid (Alt: where it was let go), and let go under a section's title it joins that section. */
      const refusal = rig.apply((proj) => dropCard(proj, p.id, { dx, dy }, e.altKey));
      if (refusal) setMessage(refusal);
    };
    /* A touch that turns into a scroll cancels the press; nothing moves. */
    const cancel = () => { if (press.current?.moved) { setDrag(null); presence({ drag: null }); } press.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); };
  }, [presence, rig]);
  const peerDrags = useMemo(() => new Map(peers.filter((p) => p.drag).map((p) => [p.drag!.id, p.drag!])), [peers]);
  const peerSelections = useMemo(() => {
    const out = new Map<string, Peer>();
    for (const p of peers) if (p.selected && !out.has(p.selected)) out.set(p.selected, p);
    return out;
  }, [peers]);

  /* Edges from the cards' real boxes: offsets inside the canvas, measured after layout and on every resize. */
  const measure = useCallback(() => {
    const root = canvas.current, overlay = svg.current;
    if (!root || !overlay) return;
    const boxes = new Map<string, Box>();
    let bottom = 0;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]"))) {
      const box = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
      boxes.set(el.dataset.nodeId!, box);
      bottom = Math.max(bottom, box.top + box.height);
    }
    const height = Math.max(layout.height, bottom + GRAPH_PAD);
    root.style.height = `${height}px`;
    overlay.setAttribute("height", String(height));
    for (const path of Array.from(overlay.querySelectorAll<SVGPathElement>("path[data-edge]"))) {
      const from = boxes.get(path.dataset.source!), to = boxes.get(path.dataset.target!);
      if (from && to) path.setAttribute("d", edgePath(from, to));
    }
  }, [layout.height]);

  useLayoutEffect(() => { measure(); }, [measure, nodes, edges, selId]);
  useEffect(() => {
    const root = canvas.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    for (const el of Array.from(root.querySelectorAll("[data-node-id]"))) observer.observe(el);
    return () => observer.disconnect();
  }, [measure, nodes]);

  /* ── Tidy: the server lays the board out for everyone at once (free) ── */
  const [tidying, setTidying] = useState(false);
  const tidy = async () => {
    if (tidying) return;
    setTidying(true);
    setWireFrom(null);
    setMessage(null);
    const outcome = await rig.team.tidy();
    setTidying(false);
    if (!outcome.ok) { setMessage(outcome.error); return; }
    const done = [
      outcome.moved ? `${outcome.moved.toLocaleString("en-US")} ${outcome.moved === 1 ? "card" : "cards"} moved` : null,
      outcome.sections ? `${outcome.sections.toLocaleString("en-US")} ${outcome.sections === 1 ? "section" : "sections"} added` : null,
    ].filter(Boolean);
    setMessage(done.length ? `Tidied for everyone · ${done.join(" · ")} · free` : "Already tidy · nothing moved");
    /* The tidied board, in view: once the moved cards have been laid out. */
    if (done.length) requestAnimationFrame(() => requestAnimationFrame(fit));
  };

  /* ── The board's own cards: sections and notes, added and edited right on the canvas (free) ── */
  const [editing, setEditing] = useState<{ id: string; field: BoardField } | null>(null);
  const counts = useMemo(() => new Map(boardSections(nodes, { assets }).map((s) => [s.id, s.members.length])), [nodes, assets]);
  /** A note or a section title where the board is looked at now, ready to type into. */
  const addCard = (kind: "note" | "section") => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return;
    const v = viewRef.current;
    const size = kind === "section" ? { w: 260, h: cardHeight({ type: "note", mode: "section" }) } : { w: cardWidth({ type: "note", width: 254 }), h: cardHeight({ type: "note" }) };
    /* The middle of what the board shows, in the canvas's own units (cards are drawn from the top-left card, at the padding). */
    const at = {
      x: (box.width / 2 - v.pan.x) / v.zoom - GRAPH_PAD + (origin?.x ?? 0) - size.w / 2,
      y: (box.height / 2 - v.pan.y) / v.zoom - GRAPH_PAD + (origin?.y ?? 0) - size.h / 2,
    };
    const id = uid("node");
    setWireFrom(null);
    const refusal = rig.apply((p) => addBoardCard(p, kind, at, id));
    setMessage(refusal);
    if (!refusal) setEditing({ id, field: kind === "section" ? "title" : "text" });
  };
  const commitEdit = (value: string) => {
    const at = editing;
    setEditing(null);
    if (!at) return;
    setMessage(rig.apply((p) => withBoardText(p, at.id, at.field, value)));
  };

  useEffect(() => {
    if (!wireFrom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setWireFrom(null); setMessage(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wireFrom]);

  if (!project) {
    const load = rigLoadState({ status: rig.status, hasProject: false, projectId: state.projectId });
    return load === "error"
      ? <p className="pxw-rig-empty" role="alert" style={{ margin: 24 }}>{rig.error}</p>
      : <p className="pxw-rig-empty" role="status" style={{ margin: 24 }}>{load === "loading" ? "Loading the graph…" : "Open or create a project to see its graph."}</p>;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shotCount = rig.shots.length;
  /* The dots are the snap grid: on the board's own multiples of 20, wherever the top-left card sits. */
  const offset = (v: number) => (((GRAPH_PAD - v) % BOARD_GRID) + BOARD_GRID) % BOARD_GRID;
  const grid = { x: offset(origin?.x ?? 0), y: offset(origin?.y ?? 0) };
  const wireInto = (target: string) => {
    if (!wireFrom) { setMessage("Choose the node to connect from first: its right-hand port."); return; }
    const refusal = rig.connect(wireFrom, target);
    setMessage(refusal);
    if (!refusal) setWireFrom(null);
  };

  return (
    /* contain: inline-size keeps the wide canvas out of main's min-content: the content pane scrolls, the shell does not widen. */
    <div className="pxw-graph-scroll">
      <div className="pxw-graph-wrap" data-testid="rig-graph" style={sized?.clearance ? { paddingBottom: 24 + sized.clearance } : undefined}>
        {wireFrom || message ? (
          <p className="pxw-graph-status" role="status">
            {message ?? `Connecting from ${byId.get(wireFrom!)?.title ?? "a node"}. Choose an input port, or press Esc.`}
          </p>
        ) : null}
        <div
          className="pxw-graph-surface"
          ref={attachSurface}
          data-testid="rig-graph-surface"
          data-zoom={Math.round(view.zoom * 100)}
          style={{ height: sized?.height ?? undefined, backgroundSize: `${BOARD_GRID * view.zoom}px ${BOARD_GRID * view.zoom}px`, backgroundPosition: `${view.pan.x + grid.x * view.zoom}px ${view.pan.y + grid.y * view.zoom}px` }}
          onPointerDown={onSurfaceDown}
          onPointerMove={onSurfaceMove}
          onPointerUp={onSurfaceUp}
          onPointerCancel={onSurfaceUp}
        >
        <div
          className="pxw-graph-canvas"
          ref={canvas}
          style={{ width: layout.width, height: layout.height, transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})` }}
          onPointerMove={peers.length ? (e) => presence({ cursor: point(e) }) : undefined}
          onPointerLeave={peers.length ? () => presence({ cursor: null }) : undefined}
        >
          <svg ref={svg} className="pxw-graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {edges.map((edge) => {
              const active = edge.target === selId;
              return (
                <path
                  key={edge.id}
                  data-edge={edge.id}
                  data-source={edge.source}
                  data-target={edge.target}
                  data-active={active || undefined}
                  stroke={active ? "#0A84FF" : "#2E2E34"}
                  strokeWidth={1.5}
                  fill="none"
                  opacity={active ? 0.85 : 1}
                />
              );
            })}
          </svg>
          {layout.cards.map((card) => {
            const node = byId.get(card.id)!;
            const shot = isShotNode(node) ? shotsById.get(node.id) : undefined;
            const kind = refKindOf(node, project);
            const def = nodeDef(node.type);
            const section = isSectionNode(node);
            const selected = card.id === selId && (state.selKind === "node" ? !shot : !!shot);
            const edit = editing?.id === card.id ? editing.field : null;
            /* A Library asset dropped on a shot node is filed on that shot, as on the list's row (text/plain = asset id). */
            const dropAsset = Boolean(shot);
            /* Mine while I drag it; a teammate's while they drag it. */
            const moving = drag?.id === card.id ? drag : peerDrags.get(card.id) ?? null;
            const watcher = peerSelections.get(card.id);
            return (
              <div
                key={card.id}
                className="pxw-graph-node"
                data-node-id={card.id}
                data-ctx={`node:${card.id}`}
                data-shape={def.shape}
                data-section={section || undefined}
                data-editing={edit || undefined}
                data-ref-kind={kind ?? undefined}
                data-selected={selected || undefined}
                data-wiring={wireFrom === card.id || undefined}
                data-drop={dropOver === card.id || undefined}
                data-moving={moving ? true : undefined}
                data-peer={watcher ? watcher.name : undefined}
                role="group"
                aria-label={`${kind ? REF_KIND_LABELS[kind] : section ? "Section" : def.label}: ${node.title}`}
                style={{ left: card.left + (moving?.dx ?? 0), top: card.top + (moving?.dy ?? 0), width: card.width, height: cardHeight(node), ...(watcher ? { outline: `2px solid ${watcher.color}`, outlineOffset: 3 } : {}) }}
                onPointerDown={node.locked ? undefined : (e) => startDrag(card.id, e)}
                onClickCapture={(e) => { if (justDragged.current) { justDragged.current = false; e.stopPropagation(); e.preventDefault(); } }}
                onDragOver={dropAsset ? (e) => { if (canDropOnShot(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropOver(card.id); } } : undefined}
                onDragLeave={dropAsset ? () => setDropOver((v) => (v === card.id ? null : v)) : undefined}
                onDrop={dropAsset && shot ? (e) => { setDropOver(null); if (dropOnShot(e.dataTransfer, { nodeId: shot.id, name: shot.name })) e.preventDefault(); } : undefined}
              >
                {watcher ? <span className="pxw-graph-peer" style={{ background: watcher.color }}>{watcher.name}</span> : null}
                {section ? (
                  <SectionCard
                    node={node}
                    count={counts.get(node.id) ?? 0}
                    selected={selected}
                    editing={edit === "title"}
                    onSelect={() => rig.select(node.id)}
                    onEdit={() => { setWireFrom(null); setEditing({ id: node.id, field: "title" }); }}
                    onCommit={commitEdit}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <Card
                    node={node}
                    kind={kind}
                    shot={shot}
                    asset={resolveAsset(node, nodes, assets)}
                    selected={selected}
                    wiring={!!wireFrom && wireFrom !== card.id}
                    editing={edit === "text"}
                    onSelect={() => rig.select(node.id)}
                    onWireFrom={() => { setWireFrom(card.id); setMessage(null); }}
                    onWireInto={() => wireInto(card.id)}
                    onEdit={() => { setWireFrom(null); setEditing({ id: node.id, field: "text" }); }}
                    onCommit={commitEdit}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </div>
            );
          })}
          {peers.filter((p) => p.cursor).map((p) => (
            <span key={p.id} className="pxw-graph-cursor" style={{ left: p.cursor!.x, top: p.cursor!.y, color: p.color, transform: `scale(${1 / view.zoom})`, transformOrigin: "0 0" }} aria-hidden="true">
              <svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1l12 9-5.5 1L5 17z" fill="currentColor" stroke="#fff" strokeWidth="1" /></svg>
              <span style={{ background: p.color }}>{p.name}</span>
            </span>
          ))}
        </div>
        <div ref={tools} className="pxw-graph-tools-strip">
          <BoardTools onAdd={addCard} />
        </div>
        <div className="pxw-graph-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" data-testid="rig-zoom-out" onClick={() => setView((v) => stepZoom(v, -1, centre()))}>−</button>
          <button type="button" aria-label="Reset zoom to 100%" data-testid="rig-zoom-level" onClick={() => setView((v) => resetZoom(v, centre()))}>{Math.round(view.zoom * 100)}%</button>
          <button type="button" aria-label="Zoom in" data-testid="rig-zoom-in" onClick={() => setView((v) => stepZoom(v, 1, centre()))}>+</button>
          <button type="button" aria-label="Fit every node" data-testid="rig-zoom-fit" onClick={fit}>Fit</button>
          <button type="button" aria-label="Tidy the board for everyone, free" title="Lay the board out for everyone · free" data-testid="rig-tidy" disabled={tidying || rig.team.mode === "off"} onClick={() => void tidy()}>{tidying ? "Tidying…" : "Tidy"}</button>
        </div>
        </div>
        <p className="pxw-graph-note">
          The graph is the advanced view of the same {shotCount.toLocaleString("en-US")} {shotCount === 1 ? "shot" : "shots"}. Everything here can be done from the shot list.
        </p>
      </div>
    </div>
  );
}
