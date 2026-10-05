import type { Project } from "@/lib/workbench/studio";
import type { BoardBox, BoardCard, BoardPoint } from "./types";

/*
 * Reordering on the board (README § 3.1, plan § 2): an arranged card that draws a node can be dragged to a new place
 * in its frame: a shot among the shots, a reference among its kind. Shot order is draft order (the order of
 * Project.nodes, lib/workspace/shots.ts), so a reorder is one edit to that order and nothing else: no card is moved,
 * and every place on the board is computed again from it. Pure; the canvas passes the boxes it laid out.
 */

/** The kinds of arranged card that can be dragged to a new place in their frame. */
export const REORDERABLE_KINDS: ReadonlySet<string> = new Set(["take", "cast", "media"]);

export const canReorder = (card: BoardCard) => !!card.region && !!card.nodeId && REORDERABLE_KINDS.has(card.kind);

/** The cards a card is ordered among: those of its kind in its frame (or its band, with no frame), in board order. */
export function siblingsOf(cards: readonly BoardCard[], card: BoardCard): BoardCard[] {
  return cards
    .filter((other) => canReorder(other) && other.kind === card.kind && other.region === card.region && (other.group ?? null) === (card.group ?? null))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/** Whether a card's box comes before a point in reading order: a row above it, or the same row and left of it. */
const before = (box: BoardBox, point: BoardPoint) => (point.y > box.y + box.h ? true : point.y < box.y ? false : box.x + box.w / 2 < point.x);

export type ReorderSlot = {
  /** The dragged card's new place among its siblings (0 = first). */
  index: number;
  /** Where the line that shows it goes, in board units. */
  line: BoardBox;
};

/**
 * Where a card let go at `point` would land among `siblings` (its siblings in board order, itself included, each with
 * its box). Null when it would stay where it is, or there is nothing to move among.
 */
export function reorderSlot(siblings: readonly { id: string; box: BoardBox }[], draggedId: string, point: BoardPoint): ReorderSlot | null {
  const others = siblings.filter((s) => s.id !== draggedId);
  if (!others.length || others.length === siblings.length) return null;
  let index = others.findIndex((s) => !before(s.box, point));
  if (index < 0) index = others.length;
  const current = siblings.findIndex((s) => s.id === draggedId);
  if (index === current) return null;
  const next = others[index];
  const line: BoardBox = next
    ? { x: next.box.x - 8, y: next.box.y, w: 4, h: next.box.h }
    : { x: others[others.length - 1].box.x + others[others.length - 1].box.w + 4, y: others[others.length - 1].box.y, w: 4, h: others[others.length - 1].box.h };
  return { index, line };
}

/** `ids` with `id` taken out and put at `index` (counted without it). */
export function moved(ids: readonly string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(rest.length, index)), 0, id);
  return rest;
}

/**
 * The draft with these nodes in this order, each in a place one of them held before, so every other node keeps its
 * own place in the order. An id the draft no longer holds, or a set that has changed, leaves the draft as it is.
 */
export function reorderNodes(project: Project, ids: readonly string[]): Project {
  const wanted = new Set(ids);
  const held: number[] = [];
  project.nodes.forEach((node, i) => { if (wanted.has(node.id)) held.push(i); });
  if (held.length !== ids.length || wanted.size !== ids.length) return project;
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const nodes = [...project.nodes];
  ids.forEach((id, k) => { nodes[held[k]] = byId.get(id)!; });
  return nodes.every((node, i) => node === project.nodes[i]) ? project : { ...project, nodes };
}
