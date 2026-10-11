/**
 * Where a floating box (a tooltip, a menu, a popover) goes beside its anchor so it stays on screen: on the preferred
 * side if it fits, else the opposite side, else whichever side has more room; then slid along the edge to stay at least
 * `margin` px inside the viewport. Pure, so it is unit-tested with plain rectangles.
 */
export type Side = "top" | "bottom" | "left" | "right";
export type Rect = { left: number; top: number; width: number; height: number };
export type Placement = { left: number; top: number; side: Side };

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

export function place(anchor: Rect, box: { width: number; height: number }, view: { width: number; height: number }, prefer: Side = "bottom", gap = 8, margin = 8): Placement {
  const room: Record<Side, number> = {
    top: anchor.top - gap - margin,
    bottom: view.height - (anchor.top + anchor.height) - gap - margin,
    left: anchor.left - gap - margin,
    right: view.width - (anchor.left + anchor.width) - gap - margin,
  };
  const need = (side: Side) => (side === "top" || side === "bottom" ? box.height : box.width);
  let side = prefer;
  if (room[side] < need(side)) {
    const other = OPPOSITE[side];
    side = room[other] >= need(other) ? other : room[other] > room[side] ? other : side;
  }
  let left: number;
  let top: number;
  if (side === "top" || side === "bottom") {
    left = anchor.left + anchor.width / 2 - box.width / 2;
    top = side === "bottom" ? anchor.top + anchor.height + gap : anchor.top - gap - box.height;
  } else {
    top = anchor.top + anchor.height / 2 - box.height / 2;
    left = side === "right" ? anchor.left + anchor.width + gap : anchor.left - gap - box.width;
  }
  const clamp = (value: number, size: number, limit: number) => Math.max(margin, Math.min(value, limit - margin - size));
  return { left: Math.round(clamp(left, box.width, view.width)), top: Math.round(clamp(top, box.height, view.height)), side };
}

/** For a menu that opens under its control and lines up with its start edge rather than its centre. */
export function placeStart(anchor: Rect, box: { width: number; height: number }, view: { width: number; height: number }, gap = 6, margin = 8): Placement {
  const below = view.height - (anchor.top + anchor.height) - gap - margin >= box.height || anchor.top < view.height / 2;
  const top = below ? anchor.top + anchor.height + gap : anchor.top - gap - box.height;
  const left = Math.max(margin, Math.min(anchor.left, view.width - margin - box.width));
  return { left: Math.round(left), top: Math.round(Math.max(margin, Math.min(top, view.height - margin - box.height))), side: below ? "bottom" : "top" };
}
