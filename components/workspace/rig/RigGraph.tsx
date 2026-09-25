"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NODE_DEFS, operationsFor, resolveAsset } from "@/lib/workbench/node-graph";
import type { Asset, CanvasNode } from "@/lib/workbench/studio";
import { mediaBands } from "@/lib/workspace/format";
import { edgePath, graphEdges, graphLayout, GRAPH_PAD, type Box } from "@/lib/workspace/rig-graph";
import { shotDropHandler } from "@/lib/shell/drop-targets";
import { isShotNode, shotNote, type RigShot } from "@/lib/workspace/shots";
import { useWorkspace } from "@/lib/workspace/state";
import { useRig } from "./RigProvider";
import LazyMedia from "@/components/LazyMedia";
import { assetPreview, previewAttrs } from "@/lib/preview";
import type { Drag, Peer } from "./use-team-canvas";
import { DEFAULT_VIEW, distance, fitView, loadView, midpoint, panBy, pinchView, resetZoom, saveView, stepZoom, viewKey, wheelFactor, zoomAround, type View } from "@/lib/viewport";

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

function footer(node: CanvasNode, shot: RigShot | undefined) {
  if (node.type === "grade") {
    const active = operationsFor(node).filter((op) => op.enabled).length;
    return { dot: "var(--pxw-blue-ink)", label: `${active} active ${active === 1 ? "tool" : "tools"}` };
  }
  const status = shot?.status ?? node.status;
  const dot = status === "approved" ? "var(--pxw-green)" : status === "ready" || status === "queued" ? "var(--pxw-atomik-gold)" : "var(--pxw-label-floor)";
  return { dot, label: node.role || NODE_DEFS[node.type].role };
}

function Card({ node, shot, asset, selected, wiring, onSelect, onWireFrom, onWireInto }: {
  node: CanvasNode; shot: RigShot | undefined; asset: Asset | undefined; selected: boolean; wiring: boolean;
  onSelect: () => void; onWireFrom: () => void; onWireInto: () => void;
}) {
  const def = NODE_DEFS[node.type];
  const isShot = !!shot;
  const text = isShot ? shotNote(node) : (node.text ?? "").trim();
  const media = def.shape === "scene" || def.shape === "reference" || node.type === "media";
  const grade = node.type === "grade" ? operationsFor(node).find((op) => op.kind === "grade") : undefined;
  const f = footer(node, shot);
  const version = asset ? `v${asset.version}` : `v${(node.versions?.length ?? 0) + 1}`;
  return (
    <>
      {isShot ? (
        <button type="button" className="pxw-graph-hit" aria-pressed={selected} aria-label={`Select ${node.title}`} onClick={onSelect} />
      ) : null}
      <span className="pxw-graph-kicker"><span>{def.label.toUpperCase()}</span><span>{version}</span></span>
      {media ? <Media id={node.id} asset={asset} height={def.shape === "scene" ? 88 : 66} badge={isShot && selected} /> : null}
      <span className="pxw-graph-title">{node.title}</span>
      {grade ? (
        <span className="pxw-graph-readouts">
          {([["B", "brightness"], ["C", "contrast"], ["S", "saturation"]] as const).map(([k, v]) => (
            <span key={k}><span>{k}</span><span>{String(grade.values[v] ?? 100)}</span></span>
          ))}
        </span>
      ) : text ? <span className="pxw-graph-desc">{text}</span> : null}
      <span className="pxw-graph-foot"><span className="pxw-dot" style={{ width: 5, height: 5, background: f.dot }} /><span>{f.label}</span></span>
      <button type="button" className="pxw-graph-port pxw-graph-port--in" aria-label={`Connect into ${node.title}`} data-armed={wiring || undefined} onClick={onWireInto} />
      <button type="button" className="pxw-graph-port pxw-graph-port--out" aria-label={`Connect from ${node.title}`} onClick={onWireFrom} />
    </>
  );
}

/** The height of the zoom cluster's strip at the bottom of the board (cluster 44 + inset 12). */
const ZOOM_STRIP = 56;

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
  const selId = state.selKind === "shot" ? state.selId : null;

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
  const fit = useCallback(() => {
    const root = canvas.current, box = surface.current?.getBoundingClientRect();
    if (!root || !box) return;
    const boxes = Array.from(root.querySelectorAll<HTMLElement>("[data-node-id]")).map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
    /* Fit into the board above the zoom cluster's strip, so no fitted node sits under it. */
    setView(fitView(boxes, { w: box.width, h: box.height - ZOOM_STRIP }));
  }, [setView]);
  /* A native wheel listener (React's is passive, so it could not stop the page zooming):
     pinch or ⌘/ctrl-wheel zooms about the cursor, a plain wheel pans. */
  const attachSurface = useCallback((el: HTMLDivElement | null) => {
    const prev = surface.current as (HTMLDivElement & { __wheel?: (e: WheelEvent) => void }) | null;
    if (prev?.__wheel) prev.removeEventListener("wheel", prev.__wheel);
    surface.current = el;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
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
    const onCard = !!target.closest(".pxw-graph-node, .pxw-graph-zoom");
    pointers.current.set(e.pointerId, surfacePoint(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
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
  /* The board fills what is left of the window below it (never under 420px), so its bottom edge
     and the zoom cluster are on screen without scrolling the page first. */
  const [boardHeight, setBoardHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const size = () => {
      const el = surface.current;
      if (!el) return;
      let scroller: HTMLElement | null = el.parentElement;
      while (scroller && !(["auto", "scroll"].includes(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
      const top = el.getBoundingClientRect().top + (scroller ? scroller.scrollTop : window.scrollY);
      const next = Math.max(420, Math.round(window.innerHeight - top - 24));
      setBoardHeight((h) => (h === next ? h : next));
    };
    size();
    window.addEventListener("resize", size);
    return () => window.removeEventListener("resize", size);
  }, [project?.id]);
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
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      const z = viewRef.current.zoom;
      if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
      const dx = Math.round((e.clientX - p.x) / z), dy = Math.round((e.clientY - p.y) / z);
      p.moved = true;
      const next = { id: p.id, dx, dy };
      setDrag(next);
      presence({ drag: next });
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p?.moved) return;
      const z = viewRef.current.zoom;
      const dx = Math.round((e.clientX - p.x) / z), dy = Math.round((e.clientY - p.y) / z);
      justDragged.current = true;
      setDrag(null);
      presence({ drag: null });
      const refusal = rig.apply((proj) => ({ ...proj, nodes: proj.nodes.map((n) => (n.id === p.id ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }));
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

  useEffect(() => {
    if (!wireFrom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setWireFrom(null); setMessage(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wireFrom]);

  if (!project) return <p className="pxw-rig-empty" style={{ margin: 24 }}>{rig.status === "loading" ? "Loading the graph…" : "Open a project to see its graph."}</p>;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shotCount = rig.shots.length;
  const wireInto = (target: string) => {
    if (!wireFrom) { setMessage("Choose the node to connect from first: its right-hand port."); return; }
    const refusal = rig.connect(wireFrom, target);
    setMessage(refusal);
    if (!refusal) setWireFrom(null);
  };

  return (
    /* contain: inline-size keeps the wide canvas out of main's min-content: the content pane scrolls, the shell does not widen. */
    <div className="pxw-graph-scroll">
      <div className="pxw-graph-wrap" data-testid="rig-graph">
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
          style={{ height: boardHeight ?? undefined, backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`, backgroundPosition: `${view.pan.x}px ${view.pan.y}px` }}
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
            const selected = !!shot && shot.id === selId;
            /* A Library asset dropped on a shot node is filed on that shot, as on the list's row (text/plain = asset id). */
            const dropAsset = shot ? shotDropHandler() : null;
            /* Mine while I drag it; a teammate's while they drag it. */
            const moving = drag?.id === card.id ? drag : peerDrags.get(card.id) ?? null;
            const watcher = peerSelections.get(card.id);
            return (
              <div
                key={card.id}
                className="pxw-graph-node"
                data-node-id={card.id}
                data-ctx={`node:${card.id}`}
                data-shape={NODE_DEFS[node.type].shape}
                data-selected={selected || undefined}
                data-wiring={wireFrom === card.id || undefined}
                data-drop={dropOver === card.id || undefined}
                data-moving={moving ? true : undefined}
                data-peer={watcher ? watcher.name : undefined}
                role="group"
                aria-label={`${NODE_DEFS[node.type].label}: ${node.title}`}
                style={{ left: card.left + (moving?.dx ?? 0), top: card.top + (moving?.dy ?? 0), width: card.width, ...(watcher ? { outline: `2px solid ${watcher.color}`, outlineOffset: 3 } : {}) }}
                onPointerDown={node.locked ? undefined : (e) => startDrag(card.id, e)}
                onClickCapture={(e) => { if (justDragged.current) { justDragged.current = false; e.stopPropagation(); e.preventDefault(); } }}
                onDragOver={dropAsset ? (e) => { if (e.dataTransfer.types.includes("text/plain")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropOver(card.id); } } : undefined}
                onDragLeave={dropAsset ? () => setDropOver((v) => (v === card.id ? null : v)) : undefined}
                onDrop={dropAsset && shot ? (e) => { e.preventDefault(); setDropOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) dropAsset(id, { nodeId: shot.id, name: shot.name }); } : undefined}
              >
                {watcher ? <span className="pxw-graph-peer" style={{ background: watcher.color }}>{watcher.name}</span> : null}
                <Card
                  node={node}
                  shot={shot}
                  asset={resolveAsset(node, nodes, assets)}
                  selected={selected}
                  wiring={!!wireFrom && wireFrom !== card.id}
                  onSelect={() => rig.select(node.id)}
                  onWireFrom={() => { setWireFrom(card.id); setMessage(null); }}
                  onWireInto={() => wireInto(card.id)}
                />
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
        <div className="pxw-graph-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" data-testid="rig-zoom-out" onClick={() => setView((v) => stepZoom(v, -1, centre()))}>−</button>
          <button type="button" aria-label="Reset zoom to 100%" data-testid="rig-zoom-level" onClick={() => setView((v) => resetZoom(v, centre()))}>{Math.round(view.zoom * 100)}%</button>
          <button type="button" aria-label="Zoom in" data-testid="rig-zoom-in" onClick={() => setView((v) => stepZoom(v, 1, centre()))}>+</button>
          <button type="button" aria-label="Fit every node" data-testid="rig-zoom-fit" onClick={fit}>Fit</button>
        </div>
        </div>
        <p className="pxw-graph-note">
          The graph is the advanced view of the same {shotCount.toLocaleString("en-US")} {shotCount === 1 ? "shot" : "shots"}. Everything here can be done from the shot list.
        </p>
      </div>
    </div>
  );
}
