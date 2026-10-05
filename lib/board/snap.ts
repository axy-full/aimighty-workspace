import { RigBuildError } from "@/lib/production/rig-build";
import type { Project } from "@/lib/workbench/studio";
import { clampPosition } from "@/lib/workspace/rig-board";
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
