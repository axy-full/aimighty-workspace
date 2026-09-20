import { NODE_DEFS, canConnect } from "../workbench/node-graph";
import type { CanvasNode, Project } from "../workbench/studio";

/**
 * The Rig's node graph view (03, "Rig — node graph") over the real draft
 * graph: the same nodes, positions and links the Studio's production graph
 * edits (components/workbench/production-graph.tsx), restyled. Positions are
 * the saved graph positions, shifted so the top-left node sits at the canvas
 * padding; edges are drawn from the rendered cards' real boxes.
 */

export const GRAPH_PAD = 20;
/** The design's canvas floor (1050×520); larger graphs grow it and the pane scrolls. */
export const GRAPH_MIN = { width: 1050, height: 520 };

/** Card width by node shape: 238 scene, 220 references, 254 direction/finishing — never wider than the saved node. */
export function cardWidth(node: Pick<CanvasNode, "type" | "width">): number {
  const shape = NODE_DEFS[node.type].shape;
  if (shape === "scene") return 238;
  if (shape === "reference") return 220;
  return Math.min(254, Math.max(180, node.width || 254));
}

export type GraphCard = { id: string; left: number; top: number; width: number };
export type GraphLayout = { cards: GraphCard[]; width: number; height: number };

/** Saved positions, shifted to the padding. Height grows from the last card's top; the real bottom is measured. */
export function graphLayout(nodes: readonly CanvasNode[]): GraphLayout {
  if (!nodes.length) return { cards: [], ...GRAPH_MIN };
  const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y));
  const cards = nodes.map((n) => ({ id: n.id, left: Math.round(n.x - minX) + GRAPH_PAD, top: Math.round(n.y - minY) + GRAPH_PAD, width: cardWidth(n) }));
  return {
    cards,
    width: Math.max(GRAPH_MIN.width, ...cards.map((c) => c.left + c.width + GRAPH_PAD)),
    height: Math.max(GRAPH_MIN.height, ...cards.map((c) => c.top + 260)),
  };
}

export type GraphEdge = { id: string; source: string; target: string };

/** One edge per link whose source is on the canvas (a link is stored on its target, like the Studio graph). */
export function graphEdges(nodes: readonly CanvasNode[]): GraphEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.flatMap((n) => n.linked.filter((s) => ids.has(s)).map((source) => ({ id: `${source}->${n.id}`, source, target: n.id })));
}

export type Box = { left: number; top: number; width: number; height: number };

/**
 * A cubic from the source card's right edge to the target card's left edge,
 * both at the card's vertical middle, with the control points half-way
 * across — the prototype's `M240 96 C326 96, 326 250, 412 250` shape.
 */
export function edgePath(from: Box, to: Box): string {
  const x1 = from.left + from.width, y1 = from.top + from.height / 2;
  const x2 = to.left, y2 = to.top + to.height / 2;
  const mid = x1 + (x2 - x1) / 2;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M${r(x1)} ${r(y1)} C${r(mid)} ${r(y1)}, ${r(mid)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
}

/**
 * Connect `source` into `target` under the Studio graph's own rules
 * (canConnect: no self links, no duplicates, input limits, media-only
 * inputs, no cycles, locked targets refuse). Returns the new draft or the reason.
 */
export function connectNodes(project: Project, source: string, target: string): { project: Project } | { error: string } {
  const problem = canConnect(project.nodes, source, target);
  if (problem) return { error: problem };
  return { project: { ...project, nodes: project.nodes.map((n) => (n.id === target ? { ...n, linked: [...n.linked, source] } : n)) } };
}
