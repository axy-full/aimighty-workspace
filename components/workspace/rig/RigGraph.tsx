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

/** A take's or reference's preview, else the flat bands that stand in for media. */
function Media({ id, asset, height, badge }: { id: string; asset: Asset | undefined; height: number; badge?: boolean }) {
  const [c1, c2] = mediaBands(id);
  const preview = asset?.generationId ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset?.uploadId ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}`
    : asset?.kind === "image" ? asset.url : null;
  return (
    <span className="pxw-graph-media" style={{ height }}>
      <span style={{ flex: 1, background: c1 }} />
      <span style={{ flex: 1.1, background: c2 }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview ? <img src={preview} alt="" loading="lazy" decoding="async" /> : null}
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
        <div className="pxw-graph-canvas" ref={canvas} style={{ width: layout.width, height: layout.height }}>
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
                role="group"
                aria-label={`${NODE_DEFS[node.type].label}: ${node.title}`}
                style={{ left: card.left, top: card.top, width: card.width }}
                onDragOver={dropAsset ? (e) => { if (e.dataTransfer.types.includes("text/plain")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropOver(card.id); } } : undefined}
                onDragLeave={dropAsset ? () => setDropOver((v) => (v === card.id ? null : v)) : undefined}
                onDrop={dropAsset && shot ? (e) => { e.preventDefault(); setDropOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) dropAsset(id, { nodeId: shot.id, name: shot.name }); } : undefined}
              >
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
        </div>
        <p className="pxw-graph-note">
          The graph is the advanced view of the same {shotCount.toLocaleString("en-US")} {shotCount === 1 ? "shot" : "shots"}. Everything here can be done from the shot list.
        </p>
      </div>
    </div>
  );
}
