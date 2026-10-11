import { BOARD_DOTS, BAND_TOP, snapToDots } from "./layout";
import type { FreeMove } from "./snap";

/*
 * Tidy (README § 3.1, plan § 2): lays out the board's free cards (notes, labels, uploads) in one block to the right of
 * the band area, in canvas order, rows wrapping at a width, every place on the 24 px dots. Arranged cards are never
 * touched (they are always in order); a locked card stays where it is. Pure: the canvas passes the free cards with
 * the sizes it drew them at and saves the moves as one person's edit.
 */

/** The block starts at the band area's right edge (x = 0; the bands sit left of it). */
export const TIDY_LEFT = 0;
export const TIDY_TOP = BAND_TOP;
/** Rows wrap at this width: as wide as the master's board. */
export const TIDY_WIDTH = 1008;

export type TidyCard = { id: string; w: number; h: number; x: number; y: number; locked?: boolean };

const up = (n: number) => Math.ceil(n / BOARD_DOTS) * BOARD_DOTS;

/** The moves that tidy `cards` (in canvas order); a card already in its place is not among them. */
export function tidyFree(cards: readonly TidyCard[]): FreeMove[] {
  const moves: FreeMove[] = [];
  let x = TIDY_LEFT, y = snapToDots(TIDY_TOP), row = 0;
  for (const card of cards) {
    if (card.locked) continue;
    const step = up(card.w + BOARD_DOTS);
    if (x > TIDY_LEFT && x + card.w > TIDY_LEFT + TIDY_WIDTH) { x = TIDY_LEFT; y += row; row = 0; }
    if (card.x !== x || card.y !== y) moves.push({ id: card.id, x, y });
    x += step;
    row = Math.max(row, up(card.h + BOARD_DOTS));
  }
  return moves;
}
