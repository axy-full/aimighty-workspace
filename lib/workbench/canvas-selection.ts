import { type CanvasNode, uid } from "./studio";
import { nodeHeight } from "./node-graph";

export type CanvasPoint = { x: number; y: number };
export const CANVAS_ZOOM_MIN = 0.25;
export const CANVAS_ZOOM_MAX = 1.6;
/**
 * One zoom domain for every gesture. An overview fit may sit below the manual floor; from there
 * a step, pinch or wheel moves relative to the current zoom instead of jumping to the floor.
 */
export function clampCanvasZoom(next: number, current = CANVAS_ZOOM_MIN) {
  const floor = Math.min(CANVAS_ZOOM_MIN, Number.isFinite(current) && current > 0 ? current : CANVAS_ZOOM_MIN);
  if (!Number.isFinite(next) || next <= 0) return Math.max(floor, Math.min(CANVAS_ZOOM_MAX, current));
  return Math.max(floor, Math.min(CANVAS_ZOOM_MAX, next));
}
/** Keep the world point under `anchor` (viewport px) fixed while the zoom changes. */
export function zoomAround(
  anchor: CanvasPoint,
  pan: CanvasPoint,
  zoom: number,
  next: number,
) {
  return {
    zoom: next,
    pan: {
      x: anchor.x - ((anchor.x - pan.x) * next) / zoom,
      y: anchor.y - ((anchor.y - pan.y) * next) / zoom,
    },
  };
}
/** Overview fit can go below the manual zoom floor on short or large canvases. */
export function fitCanvasNodes(
  nodes: CanvasNode[],
  viewport: { width: number; height: number },
  padding: { top: number; bottom: number },
  maxZoom = 1,
) {
  if (!nodes.length) return { zoom: .82, pan: { x: 35, y: padding.top } };
  const left = Math.min(...nodes.map(n => n.x));
  const top = Math.min(...nodes.map(n => n.y));
  const width = Math.max(...nodes.map(n => n.x + n.width)) - left;
  const height = Math.max(...nodes.map(n => n.y + nodeHeight(n))) - top;
  const zoom = Math.min(maxZoom,
    Math.max(1, viewport.width - 70) / Math.max(1, width),
    Math.max(1, viewport.height - padding.top - padding.bottom) / Math.max(1, height));
  return { zoom, pan: { x: 35 - left * zoom, y: padding.top - top * zoom } };
}
export function selectionRect(start: CanvasPoint, end: CanvasPoint) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}
/** Intersection selection uses world coordinates and the rendered node box; touching edges do not select. */
export function marqueeSelection(
  nodes: CanvasNode[],
  start: CanvasPoint,
  end: CanvasPoint,
  additive: string[] = [],
) {
  const rect = selectionRect(start, end);
  const hits = nodes
    .filter(
      (n) =>
        n.x < rect.x + rect.width &&
        n.x + n.width > rect.x &&
        n.y < rect.y + rect.height &&
        n.y + nodeHeight(n) > rect.y,
    )
    .map((n) => n.id);
  return [
    ...new Set([
      ...additive.filter((id) => nodes.some((n) => n.id === id)),
      ...hits,
    ]),
  ];
}
export function toggleNodeSelection(
  ids: string[],
  id: string,
  additive: boolean,
) {
  return additive
    ? ids.includes(id)
      ? ids.filter((value) => value !== id)
      : [...ids, id]
    : [id];
}
/** Clamp one delta for the entire group, retaining spacing at the canvas limits. */
export function moveSelectedNodes(
  nodes: CanvasNode[],
  ids: string[],
  delta: CanvasPoint,
) {
  const movable = nodes.filter((n) => ids.includes(n.id) && !n.locked);
  if (!movable.length || !Number.isFinite(delta.x) || !Number.isFinite(delta.y))
    return nodes;
  const x = Math.max(
    -10000 - Math.min(...movable.map((n) => n.x)),
    Math.min(20000 - Math.max(...movable.map((n) => n.x)), delta.x),
  );
  const y = Math.max(
    -10000 - Math.min(...movable.map((n) => n.y)),
    Math.min(20000 - Math.max(...movable.map((n) => n.y)), delta.y),
  );
  if (!x && !y) return nodes;
  const moving = new Set(movable.map((n) => n.id));
  return nodes.map((n) =>
    moving.has(n.id) ? { ...n, x: n.x + x, y: n.y + y } : n,
  );
}
/** A locked consumer's inputs cannot be changed indirectly by deleting its source. */
export function removableNodeIds(nodes: CanvasNode[], ids: string[]) {
  const protectedIds = new Set(
    nodes.filter((n) => n.locked).flatMap((n) => n.linked),
  );
  return nodes
    .filter((n) => ids.includes(n.id) && !n.locked && !protectedIds.has(n.id))
    .map((n) => n.id);
}
/** Why each selected node stays: it is locked, or a locked node depends on it. */
export function removalBlockers(nodes: CanvasNode[], ids: string[]) {
  const removable = new Set(removableNodeIds(nodes, ids));
  return nodes
    .filter((n) => ids.includes(n.id) && !removable.has(n.id))
    .map((n) => ({
      node: n,
      lockedBy: n.locked
        ? []
        : nodes.filter((other) => other.locked && other.linked.includes(n.id)),
    }));
}
/** One honest sentence for the removal outcome of a selection. */
export function describeRemoval(nodes: CanvasNode[], ids: string[]) {
  const removable = removableNodeIds(nodes, ids);
  const blockers = removalBlockers(nodes, ids);
  const reason = (b: { node: CanvasNode; lockedBy: CanvasNode[] }) =>
    b.node.locked
      ? b.node.title + " is locked."
      : b.node.title +
        " feeds locked " +
        b.lockedBy.map((n) => n.title).join(" and ") +
        ".";
  if (!removable.length)
    return {
      removable,
      message:
        (blockers.length === 1
          ? reason(blockers[0])
          : blockers.map(reason).join(" ")) + " Unlock first to remove.",
    };
  if (!blockers.length)
    return {
      removable,
      message:
        (removable.length === 1 ? "Node removed." : "Nodes removed.") +
        " Use Undo to restore.",
    };
  return {
    removable,
    message:
      removable.length +
      " of " +
      ids.length +
      " nodes removed. " +
      blockers.map(reason).join(" ") +
      " Use Undo to restore.",
  };
}
export function removeSelectedNodes(nodes: CanvasNode[], ids: string[]) {
  const remove = new Set(removableNodeIds(nodes, ids));
  if (!remove.size) return nodes;
  return nodes
    .filter((n) => !remove.has(n.id))
    .map((n) =>
      n.linked.some((id) => remove.has(id)) ||
      (n.activeInput && remove.has(n.activeInput))
        ? {
            ...n,
            linked: n.linked.filter((id) => !remove.has(id)),
            activeInput:
              n.activeInput && remove.has(n.activeInput)
                ? undefined
                : n.activeInput,
          }
        : n,
    );
}
/** Copy internal edges to their copies, retaining references from outside the selection. */
export function duplicateSelectedNodes(nodes: CanvasNode[], ids: string[], offset = 40) {
  const originals = nodes.filter((n) => ids.includes(n.id) && !n.locked);
  if (!originals.length || nodes.length + originals.length > 250)
    return { nodes, ids: [] as string[] };
  const mapping = new Map(originals.map((n) => [n.id, uid("node")]));
  const copies = originals.map((n) => ({
    ...structuredClone(n),
    id: mapping.get(n.id)!,
    title: n.title + " / copy",
    x: Math.min(20000, n.x + offset),
    y: Math.min(20000, n.y + offset),
    locked: false,
    status: "draft" as const,
    versions: [],
    linked: n.linked.map((id) => mapping.get(id) || id),
    activeInput: n.activeInput
      ? mapping.get(n.activeInput) || n.activeInput
      : undefined,
  }));
  return { nodes: [...nodes, ...copies], ids: copies.map((n) => n.id) };
}
