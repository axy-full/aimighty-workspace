/**
 * Where a chip's menu goes (the hidden-picker fix).
 *
 * The menu is rendered at the top of the document, not beside its chip: the
 * composer's sheet is a transformed, overflow-hidden box, and a transformed
 * ancestor becomes the containing block for anything fixed inside it — so a
 * menu positioned there was pinned to the sheet and clipped by it. Placed
 * from the chip's own rectangle instead: above when there is room, below
 * when there is not, and never past either edge. Pure.
 */
export type Rect = { top: number; bottom: number; left: number; right: number };
export type Viewport = { width: number; height: number };
export type Placement = { left: number; top?: number; bottom?: number; maxHeight: number; above: boolean };

export const MENU_GAP = 10;
export const MENU_EDGE = 12;
export const MENU_MIN_HEIGHT = 180;

export function menuPlacement(chip: Rect, view: Viewport, width: number): Placement {
  const above = chip.top - MENU_GAP;
  const below = view.height - chip.bottom - MENU_GAP;
  /* Above is where these menus have always opened, and where the chip's own
     row is not covered; below only when there is more room there. */
  const goAbove = above >= MENU_MIN_HEIGHT || above >= below;
  const left = Math.max(MENU_EDGE, Math.min(chip.left, view.width - width - MENU_EDGE));
  const room = Math.max(MENU_MIN_HEIGHT, goAbove ? above : below) - MENU_EDGE;
  return goAbove
    ? { left, bottom: Math.max(MENU_EDGE, view.height - chip.top + MENU_GAP), maxHeight: room, above: true }
    : { left, top: chip.bottom + MENU_GAP, maxHeight: room, above: false };
}
