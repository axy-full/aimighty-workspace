/*
 * Where a board was left, per project, on this device only (the old Rig kept its graph's view the same way,
 * lib/viewport.ts). A convenience: the first view without it is computed (components/graphite/board/BoardView.tsx).
 */
export type SavedView = { x: number; y: number; zoom: number };
const key = (scope: string, projectId: string) => `particl:board-view:${scope}:${projectId}`;

export function readBoardView(scope: string, projectId: string): SavedView | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(scope, projectId)) ?? "null") as Partial<SavedView> | null;
    if (!value || ![value.x, value.y, value.zoom].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return { x: value.x!, y: value.y!, zoom: Math.min(2, Math.max(0.25, value.zoom!)) };
  } catch { return null; }
}

export function saveBoardView(scope: string, projectId: string, view: SavedView) {
  try { localStorage.setItem(key(scope, projectId), JSON.stringify({ x: Math.round(view.x), y: Math.round(view.y), zoom: Math.round(view.zoom * 1000) / 1000 })); } catch { /* the next visit computes its first view */ }
}
