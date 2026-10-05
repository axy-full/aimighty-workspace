import { RigBuildError } from "@/lib/production/rig-build";
import { createNode } from "@/lib/workbench/node-graph";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import type { CanvasNode, Project } from "@/lib/workbench/studio";
import { clampPosition, SECTION_MODE } from "@/lib/workspace/rig-board";
import { snapToDots } from "./layout";
import type { BoardPoint } from "./types";

/*
 * Free cards (notes, labels, uploads) keep their saved place on the board.
 * Let go, a card lands on the nearest dot (README § 2: a 24 px grid); with
 * Alt held, exactly where it was let go. The move is the person's own edit,
 * through the Rig's draft and the team canvas like any other.
 */

/** Where a free card let go at `at` lands. */
export function dropPlace(at: BoardPoint, free = false): BoardPoint {
  return free
    ? { x: clampPosition(Math.round(at.x)), y: clampPosition(Math.round(at.y)) }
    : { x: clampPosition(snapToDots(at.x)), y: clampPosition(snapToDots(at.y)) };
}

export type FreeMove = { id: string; x: number; y: number };

/** The draft with these cards at these places; a locked card refuses, and nothing moves. */
export function moveFreeCards(project: Project, moves: readonly FreeMove[]): Project {
  const byId = new Map(moves.map((move) => [move.id, move]));
  const locked = project.nodes.find((node) => byId.has(node.id) && node.locked);
  if (locked) throw new RigBuildError(`Unlock ${locked.title || "this card"} before moving it.`);
  let changed = false;
  const nodes = project.nodes.map((node) => {
    const move = byId.get(node.id);
    if (!move) return node;
    const x = clampPosition(move.x), y = clampPosition(move.y);
    if (x === node.x && y === node.y) return node;
    changed = true;
    return { ...node, x, y };
  });
  return changed ? { ...project, nodes } : project;
}

/* ── Adding and taking off free cards (the tool pill's Note and Text; ⌫) ── */

/** A free card's size when made: a note, or a one-line label (the old Rig's section title card). */
export const FREE_CARD = { note: { width: 254 }, label: { width: 260 } } as const;

/** The draft with a new note or label at `at` (its top-left, on the dots). Free, like every edit on the canvas. */
export function addFreeCard(project: Project, kind: "note" | "label", at: BoardPoint, id: string): Project {
  if (project.nodes.some((n) => n.id === id)) return project;
  if (project.nodes.length >= PROJECT_LIMITS.nodes) throw new RigBuildError(`A board holds at most ${PROJECT_LIMITS.nodes.toLocaleString("en-US")} cards.`);
  const place = dropPlace(at);
  const card: CanvasNode = kind === "label"
    ? { id, title: "Text", type: "note", mode: SECTION_MODE, x: place.x, y: place.y, width: FREE_CARD.label.width, linked: [] }
    : { ...createNode("note", project.nodes.length, place), id, title: "Note", text: "", width: FREE_CARD.note.width };
  return { ...project, nodes: [...project.nodes, card] };
}

/**
 * The draft without these free cards (a person's ⌫). On the team canvas a
 * removal is soft: the card is kept whole in the canvas's own record. A card
 * another card still takes an input from stays. Returns what was taken off,
 * for the Undo.
 */
export function removeFreeCards(project: Project, ids: readonly string[]): { project: Project; removed: CanvasNode[] } {
  const wanted = new Set(ids);
  const removed = project.nodes.filter((n) => wanted.has(n.id) && !n.locked && !project.nodes.some((other) => other.linked.includes(n.id)));
  if (!removed.length) return { project, removed };
  const gone = new Set(removed.map((n) => n.id));
  return { project: { ...project, nodes: project.nodes.filter((n) => !gone.has(n.id)) }, removed };
}

/** The Undo of removeFreeCards: the cards back where they were (one already back is left as it is). */
export function restoreFreeCards(project: Project, removed: readonly CanvasNode[]): Project {
  const present = new Set(project.nodes.map((n) => n.id));
  const back = removed.filter((n) => !present.has(n.id));
  return back.length ? { ...project, nodes: [...project.nodes, ...back] } : project;
}
