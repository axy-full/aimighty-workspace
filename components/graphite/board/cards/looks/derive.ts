import { STUDIO_GROUP } from "@/lib/board/regions";
import type { BoardCard, GroupData } from "@/lib/board/types";
import type { Project } from "@/lib/workbench/studio";
import { looks, type LookTile } from "./model";

/*
 * The Looks group's cards (README § 3.1 c): one group frame and a tile per look made. The frame takes the id of
 * stream 3's fallback Looks group, so it stands in for it while the project has looks of its own; a Rig look
 * board (a "moodboard" node) still sits inside it. Pure.
 */

/** A look's tile width on the board: the same as a Rig look board's, so the two sit in one grid. */
export const LOOK_WIDTH = 462;
export type LookData = LookTile;

export function deriveLooks(project: Project): BoardCard[] {
  const board = looks(project);
  if (!board.tiles.length) return [];
  const group: GroupData = { title: board.title, meta: board.meta, columns: 2 };
  const cards: BoardCard[] = [{
    id: STUDIO_GROUP.looks, kind: "group", region: "looks", order: -1, state: board.state,
    ...(board.state === "needs" ? { needs: 1 } : {}), summary: board.summary, data: group,
  }];
  board.tiles.forEach((tile, i) => cards.push({
    id: `look:${tile.id}`, kind: "look", region: "looks", group: STUDIO_GROUP.looks, order: i,
    state: tile.rendering ? "working" : tile.genId ? "done" : "empty", data: tile satisfies LookData,
  }));
  return cards;
}
