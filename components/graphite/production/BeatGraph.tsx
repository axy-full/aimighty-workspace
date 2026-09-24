"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { beatGraphLayout, dropScene, GRAPH, type BeatGraph as Layout } from "@/lib/production/beat-graph";
import type { BeatScene, BeatSheet } from "@/lib/production/beats";
import { DEFAULT_VIEW, distance, fitView, loadView, midpoint, panBy, pinchView, resetZoom, saveView, stepZoom, viewKey, wheelFactor, zoomAround, type View } from "@/lib/viewport";

const ACT_NAME = { 1: "Act One", 2: "Act Two", 3: "Act Three" } as const;
/** The zoom cluster's strip along the bottom: Fit keeps every node above it. */
const ZOOM_STRIP = 56;

/**
 * Production › Beats as a graph (owner, 24 September): the same beat sheet as
 * the board, as a node graph — act lanes, scenes along the story spine, beats
 * beneath each. Pinch or ⌘-wheel zooms, wheel or drag on the empty board pans
 * (the Rig's gestures, lib/viewport). Drag a scene to another lane or place to
 * move it in the story; click or Enter opens it to edit.
 */
export function BeatGraph({ sheet, projectId, openId, onOpen, onReorder, panel }: {
  sheet: BeatSheet; projectId: string; openId: string | null;
  onOpen: (id: string) => void; onReorder: (scenes: BeatScene[]) => void;
  /** The open scene's editor, floated over the graph's right side like a properties panel. */
  panel?: React.ReactNode;
}) {
  const graph: Layout = useMemo(() => beatGraphLayout(sheet), [sheet]);
  const byId = useMemo(() => new Map(sheet.scenes.map((s) => [s.id, s])), [sheet.scenes]);
  const surface = useRef<HTMLDivElement | null>(null);
  const storeKey = viewKey("beats", projectId);
  const [view, setViewRaw] = useState<View>(() => loadView(storeKey) ?? DEFAULT_VIEW);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; saveView(storeKey, view); }, [view, storeKey]);
  const setView = useCallback((next: View | ((v: View) => View)) => setViewRaw((cur) => (typeof next === "function" ? next(cur) : next)), []);
  const centre = () => { const b = surface.current?.getBoundingClientRect(); return b ? { x: b.width / 2, y: b.height / 2 } : { x: 0, y: 0 }; };
  const at = (e: { clientX: number; clientY: number }) => { const b = surface.current?.getBoundingClientRect(); return b ? { x: e.clientX - b.left, y: e.clientY - b.top } : { x: 0, y: 0 }; };
  const fit = useCallback(() => {
    const b = surface.current?.getBoundingClientRect();
    if (!b) return;
    /* Fit clear of the zoom cluster along the bottom (a phone's cluster sits under the board, so it keeps the whole board). */
    setView(fitView([{ x: 0, y: 0, w: graph.width, h: graph.height }], { w: b.width, h: b.height - (b.width < 760 ? 0 : ZOOM_STRIP) }, 24));
  }, [graph.width, graph.height, setView]);
  /* First open on this device: fit the whole story. */
  const fitted = useRef(false);
  useLayoutEffect(() => { if (!fitted.current) { fitted.current = true; if (!loadView(storeKey)) fit(); } }, [fit, storeKey]);

  /* Native wheel (React's is passive): pinch / ⌘-wheel zooms about the cursor, a plain wheel pans. */
  const attach = useCallback((el: HTMLDivElement | null) => {
    const prev = surface.current as (HTMLDivElement & { __wheel?: (e: WheelEvent) => void }) | null;
    if (prev?.__wheel) prev.removeEventListener("wheel", prev.__wheel);
    surface.current = el;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const p = { x: e.clientX - box.left, y: e.clientY - box.top };
      if (e.ctrlKey || e.metaKey) { setView((v) => zoomAround(v, p, wheelFactor(e.deltaY, e.deltaMode))); return; }
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.height : 1;
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k, dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
      setView((v) => panBy(v, dx, dy));
    };
    (el as HTMLDivElement & { __wheel?: (e: WheelEvent) => void }).__wheel = onWheel;
    el.addEventListener("wheel", onWheel, { passive: false });
  }, [setView]);

  /* Drag the empty board to pan; two fingers pinch. A press on a scene is the scene's own. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "pan"; from: { x: number; y: number }; view: View } | { kind: "pinch"; view: View; dist: number; mid: { x: number; y: number } } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const onNode = !!(e.target as HTMLElement).closest(".pd-graph-scene, .pd-graph-beat, .pd-graph-zoom");
    pointers.current.set(e.pointerId, at(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = null; setMoving(null);
      gesture.current = { kind: "pinch", view: viewRef.current, dist: distance(a, b), mid: midpoint(a, b) };
      return;
    }
    if (onNode || (e.button !== 0 && e.button !== 1)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gesture.current = { kind: "pan", from: at(e), view: viewRef.current };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, at(e));
    const g = gesture.current;
    if (g?.kind === "pinch" && pointers.current.size >= 2) { const [a, b] = [...pointers.current.values()]; setView(pinchView(g, distance(a, b), midpoint(a, b))); }
    else if (g?.kind === "pan") { const p = at(e); setView({ ...g.view, pan: { x: g.view.pan.x + p.x - g.from.x, y: g.view.pan.y + p.y - g.from.y } }); }
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2 && gesture.current?.kind === "pinch") gesture.current = null;
    if (!pointers.current.size) gesture.current = null;
  };

  /* A scene dragged past 4px moves by what the pointer travelled on the board; released, it lands in that lane and place. */
  const drag = useRef<{ id: string; from: { x: number; y: number }; moved: boolean } | null>(null);
  const [moving, setMoving] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const sceneDown = (id: string, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || pointers.current.size > 1) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id, from: { x: e.clientX, y: e.clientY }, moved: false };
  };
  const sceneMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.from.x) / viewRef.current.zoom, dy = (e.clientY - d.from.y) / viewRef.current.zoom;
    if (!d.moved && Math.hypot(e.clientX - d.from.x, e.clientY - d.from.y) < 4) return;
    d.moved = true;
    setMoving({ id: d.id, dx, dy });
  };
  const sceneUp = (id: string) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== id) return;
    if (!d.moved) { onOpen(id); return; }
    const node = graph.scenes.find((s) => s.id === id);
    const m = moving;
    setMoving(null);
    if (!node || !m) return;
    const next = dropScene(sheet, graph, id, { x: node.x + m.dx + GRAPH.sceneW / 2, y: node.y + m.dy + GRAPH.sceneH / 2 });
    const same = next.length === sheet.scenes.length && next.every((s, i) => s.id === sheet.scenes[i].id && s.act === sheet.scenes[i].act);
    if (!same) onReorder(next);
  };

  /* A scene opened to edit is panned clear of the panel (and of the zoom strip) if it sits under either. */
  const hasPanel = Boolean(panel);
  const scenesRef = useRef(graph.scenes);
  useEffect(() => { scenesRef.current = graph.scenes; }, [graph.scenes]);
  useLayoutEffect(() => {
    const node = openId ? scenesRef.current.find((s) => s.id === openId) : null;
    const box = surface.current?.getBoundingClientRect();
    if (!node || !box) return;
    const reserve = hasPanel && box.width >= 720 ? Math.min(456, box.width / 2) : 0;
    const v = viewRef.current, right = box.width - reserve - 16, bottom = box.height - ZOOM_STRIP;
    const x0 = v.pan.x + node.x * v.zoom, x1 = x0 + GRAPH.sceneW * v.zoom, y0 = v.pan.y + node.y * v.zoom, y1 = y0 + GRAPH.sceneH * v.zoom;
    const dx = x1 > right ? Math.max(right - x1, 16 - x0) : x0 < 16 ? 16 - x0 : 0;
    const dy = y1 > bottom ? Math.max(bottom - y1, 16 - y0) : y0 < 16 ? 16 - y0 : 0;
    if (dx || dy) setView((cur) => ({ ...cur, pan: { x: cur.pan.x + dx, y: cur.pan.y + dy } }));
  }, [openId, hasPanel, setView]);

  /* ⌘0 fits, ⌘= / ⌘- step, while this graph is on screen; fields keep the browser's own keys. */
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

  const pos = (id: string) => { const s = graph.scenes.find((x) => x.id === id)!; return moving?.id === id ? { x: s.x + moving.dx, y: s.y + moving.dy } : s; };
  const spine = graph.edges.filter((e) => e.kind === "story").map((e) => {
    const a = pos(e.from), b = pos(e.to);
    const x1 = a.x + GRAPH.sceneW, y1 = a.y + GRAPH.sceneH / 2, x2 = b.x, y2 = b.y + GRAPH.sceneH / 2, c = Math.max(24, (x2 - x1) / 2);
    return { id: e.id, d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}` };
  });
  const chains = graph.beats.map((b) => {
    const s = pos(b.sceneId), node = graph.scenes.find((x) => x.id === b.sceneId)!;
    const dx = s.x - node.x, dy = s.y - node.y, cx = b.x + dx + GRAPH.beatW / 2;
    const top = b.index === 0 ? s.y + GRAPH.sceneH : b.y + dy - GRAPH.gapY;
    return { id: `${b.sceneId}>${b.id}`, d: `M${cx},${top} L${cx},${b.y + dy}` };
  });

  return (
    <div className="pd-graph" data-testid="beat-graph">
      <div className="pd-graph-frame">
      <div className="pd-graph-surface" ref={attach} data-testid="beat-graph-surface" data-zoom={Math.round(view.zoom * 100)}
        style={{ backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`, backgroundPosition: `${view.pan.x}px ${view.pan.y}px` }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="pd-graph-canvas" style={{ width: graph.width, height: graph.height, transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})` }}>
          {graph.lanes.map((lane) => (
            <div key={lane.act} className="pd-graph-lane" data-testid="beat-graph-lane" data-act={lane.act} style={{ top: lane.y, height: lane.h, width: graph.width }}>
              <span className="pd-graph-lane-name">{ACT_NAME[lane.act]}</span>
            </div>
          ))}
          <svg className="pd-graph-edges" width={graph.width} height={graph.height} aria-hidden="true">
            {spine.map((e) => <path key={e.id} data-edge={e.id} d={e.d} className="pd-graph-spine" />)}
            {chains.map((e) => <path key={e.id} d={e.d} className="pd-graph-chain" />)}
          </svg>
          {graph.scenes.map((node) => {
            const scene = byId.get(node.id)!;
            const p = pos(node.id);
            return (
              <button key={node.id} type="button" className="pd-graph-scene" data-testid="beat-graph-scene" data-scene-id={node.id} data-act={node.act}
                data-open={openId === node.id || undefined} data-moving={moving?.id === node.id || undefined}
                aria-label={`Scene ${node.index + 1}: ${scene.heading || "untitled"} · ${ACT_NAME[node.act]}`}
                style={{ left: p.x, top: p.y, width: GRAPH.sceneW, height: GRAPH.sceneH }}
                onPointerDown={(e) => sceneDown(node.id, e)} onPointerMove={sceneMove} onPointerUp={() => sceneUp(node.id)}
                onPointerCancel={() => { drag.current = null; setMoving(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(node.id); } }}>
                <span className="pd-graph-scene-head"><span className="pd-scene-n">{String(node.index + 1).padStart(2, "0")}</span><span className="pd-graph-scene-title">{scene.heading || `Scene ${node.index + 1}`}</span></span>
                {scene.summary ? <span className="pd-graph-scene-text">{scene.summary}</span> : null}
                <span className="pd-graph-scene-foot">{scene.beats.length} {scene.beats.length === 1 ? "beat" : "beats"} · {scene.shots.length} {scene.shots.length === 1 ? "shot" : "shots"}</span>
              </button>
            );
          })}
          {graph.beats.map((b) => {
            const node = graph.scenes.find((x) => x.id === b.sceneId)!, s = pos(b.sceneId);
            const text = b.more ? `+${b.more} more` : byId.get(b.sceneId)!.beats[b.index]?.text || "Empty beat";
            return (
              <div key={b.id} className="pd-graph-beat" data-testid="beat-graph-beat" data-more={b.more ? true : undefined}
                style={{ left: b.x + s.x - node.x, top: b.y + s.y - node.y, width: GRAPH.beatW, height: GRAPH.beatH }}
                onClick={() => onOpen(b.sceneId)}>
                {text}
              </div>
            );
          })}
        </div>
      </div>
      <div className="pd-graph-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" data-testid="beat-zoom-out" onClick={() => setView((v) => stepZoom(v, -1, centre()))}>−</button>
          <button type="button" aria-label="Reset zoom to 100%" data-testid="beat-zoom-level" onClick={() => setView((v) => resetZoom(v, centre()))}>{Math.round(view.zoom * 100)}%</button>
          <button type="button" aria-label="Zoom in" data-testid="beat-zoom-in" onClick={() => setView((v) => stepZoom(v, 1, centre()))}>+</button>
          <button type="button" aria-label="Fit the whole story" data-testid="beat-zoom-fit" onClick={fit}>Fit</button>
      </div>
      {panel ? <div className="pd-graph-panel" data-testid="beat-graph-panel">{panel}</div> : null}
      </div>
      <p className="gx-hint pd-graph-note">Drag a scene to another act or place in the story. Pinch or ⌘-scroll to zoom; scroll or drag the board to pan.</p>
    </div>
  );
}
