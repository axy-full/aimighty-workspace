/**
 * The stage grid (docs/redesign/inventory.md § 6.6; FIX § 13.2; redesign P2-b): a stage's cards 4 across at 1440, 3 and
 * 2 on narrower canvases, one 24 px gap for rows and columns, each row as tall as its tallest card, cards at its top.
 *
 * The prototype placed Shots cards on a fixed 296 px row step (332 while anything rendered), which left about 100 px
 * of empty canvas under a finished card in a row with a rendering one. Here a row is sized by its cards, and every shot
 * card on a stage has one outer height (the tallest shot card's), so finished and rendering shots line up with no gap.
 *
 * Today's board lays its cards out in groups (lib/board/layout.ts › packGroup: rows sized to their tallest child). The
 * grid reuses that: it says how many columns a stage's groups get, the gap, and each shot card's size. Pure.
 */

/** Prototype L556: a 260 px card, a 24 px gap, so a 284 px step; 2 to 4 across. */
export const GRID_GAP = 24;
export const GRID_CARD = 260;
export const GRID_STEP = GRID_CARD + GRID_GAP;
/** Where the first card sits from the stage column's top-left (prototype L556: x and y 60). */
export const GRID_ORIGIN = 60;
export const GRID_MIN = 2;
export const GRID_MAX = 4;
/** What the stage column keeps clear beside the cards (prototype: the 60 px origin, the right toolbar's 72 px). */
const GRID_SIDES = 132;

/** How many cards across a canvas `width` px wide holds: floor((w − 132 + 24) / 284), clamped to 2…4 (L556). */
export function gridColumns(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return GRID_MAX;
  return Math.max(GRID_MIN, Math.min(GRID_MAX, Math.floor((width - GRID_SIDES + GRID_GAP) / GRID_STEP)));
}

/** The stages laid out on the grid: Storyboard, Shots and Elements. */
export const GRID_STAGES: ReadonlySet<string> = new Set(["storyboard", "shots", "elements"]);

/** The row under a shot card's pictures and words: Approve · Reject on a finished take, the status line on one that has something to say. */
export const GRID_ACTIONS = 40;

export type GridSize = { w: number; h: number };

/** One outer height for every card of a kind on the stage: the tallest one's (a finished card's actions, a rendering card's status line). */
export function evenHeights(sizes: ReadonlyMap<string, GridSize>): Map<string, GridSize> {
  const tallest = Math.max(0, ...[...sizes.values()].map((s) => s.h));
  return new Map([...sizes].map(([id, s]) => [id, { w: s.w, h: tallest }]));
}

/**
 * Rows as CSS grid makes them (`align-items: start`): the top of each card in a row of `columns`, every row as tall as
 * its tallest card, `gap` between rows and columns. For tests and for anything that lays cards out on its own.
 */
export function gridPlaces(sizes: readonly GridSize[], columns: number, gap = GRID_GAP, column = GRID_CARD): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let y = 0;
  for (let start = 0; start < sizes.length; start += columns) {
    const row = sizes.slice(start, start + columns);
    row.forEach((_, i) => out.push({ x: i * (column + gap), y }));
    y += Math.max(...row.map((s) => s.h)) + gap;
  }
  return out;
}
