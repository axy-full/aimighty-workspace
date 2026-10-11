/*
 * The board's chrome, in px (design/particl-graphite/README.md § 1.1, § 3.1; the master's board):
 * the outline rail, its drawers, the docked Atomik panel (open or collapsed), the Inspector and Make's panel.
 */
export const RAIL_WIDTH = 88;
export const DRAWER_WIDTH = 280;
export const DOCK_WIDTH = { open: 340, closed: 56 } as const;
export const INSPECTOR_WIDTH = 340;
export const MAKE_WIDTH = 440;
/** Under this canvas width the tool pill shows icons only (the master's 660). */
export const PILL_LABELS_FROM = 660;
